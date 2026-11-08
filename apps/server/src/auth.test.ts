import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { addOperator, TEST_PASSWORD } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { session } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { sha256Hex } from "./identity.ts";
import { createLoginLimit } from "./login-limit.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const logger = pino({ level: "silent" });
const ok = async () => {};
const ORIGIN = new URL(PUBLIC_URL).origin;
// Sign-in counts live for 15 minutes in the Valkey that every test file shares, so each run uses its
// own emails and addresses, and a run soon after another starts from zero.
const RUN = randomUUID().slice(0, 8);
const address = (n: number) => `2001:db8:${RUN.slice(0, 4)}:${RUN.slice(4)}::${n.toString(16)}`;
const email = (name: string) => `${name}-${RUN}@example.com`;

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
let valkey: Redis;
const mail: { to: string; url: string }[] = [];

function chat(...args: (string | Record<string, string>)[]) {
  const words = args.filter((arg): arg is string => typeof arg === "string");
  const env = args.find((arg): arg is Record<string, string> => typeof arg !== "string");
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...words], {
      env: {
        ...process.env,
        DATABASE_URL: database.url("app"),
        VALKEY_URL,
        AUTH_SECRET,
        PUBLIC_URL,
        ...env,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

/** In-process, since a new Node process per operator made this file slow. A test below keeps
 * `chat create-operator` covered. */
async function newOperator(email: string) {
  await addOperator({ auth, owner, email, name: "Anna" });
  return TEST_PASSWORD;
}

function signIn(email: string, password: string, target = app, origin = ORIGIN) {
  return target.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

const me = (cookie: string) => app.request("/v1/operator/me", { headers: { cookie } });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app").db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await new Promise((resolve) => valkey.once("ready", resolve));
  owner = database.connect("migrator").db;
  auth = createAuth({
    db,
    secret: AUTH_SECRET,
    baseURL: PUBLIC_URL,
    logger,
    sendResetPassword: async (to, url) => {
      mail.push({ to, url });
    },
    onPasswordReset: (email) => createLoginLimit(valkey, logger).clear(email),
  });
  app = createApp({ db, logger, valkey, checks: { postgres: ok, valkey: ok }, auth });
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await database.drop();
});

describe("signing in", () => {
  test("a valid password gives a session that is HttpOnly and not sent cross-site", async () => {
    const password = await newOperator(email("in"));
    const response = await signIn(email("in"), password);
    expect(response.status).toBe(200);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const body = (await (await me(cookieOf(response))).json()) as { email: string };
    expect(body.email).toBe(email("in"));
  });

  test("an operator lists its workspaces, with no other tenant's data", async () => {
    const { out } = await chat(
      "create-operator",
      email("owner"),
      "Owner",
      "--workspace",
      "Acme",
      "--origin",
      "https://acme.example.com",
    );
    const password = /password: (\S+)/.exec(out)?.[1] ?? "";
    const response = await signIn(email("owner"), password);
    const body = (await (await me(cookieOf(response))).json()) as {
      workspaces: { role: string }[];
    };
    expect(body.workspaces.map((w) => w.role)).toEqual(["owner"]);
  });

  test("a password is stored only as a hash", async () => {
    const password = await newOperator(email("hash"));
    const { rows } = await owner.execute<{ password: string }>(
      sql`select a.password from account a join operator o on o.id = a.user_id
          where o.email = ${email("hash")}`,
    );
    expect(rows[0]?.password).not.toContain(password);
    expect(rows[0]?.password.length).toBeGreaterThan(50);
  });

  test("a wrong password and an unknown email both fail the same way", async () => {
    await newOperator(email("same"));
    const wrong = await signIn(email("same"), "wrong-password-value");
    const unknown = await signIn(email("nobody"), "wrong-password-value");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
  });

  test("nobody can sign themselves up", async () => {
    const response = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: email("self"), password: "a-long-password", name: "S" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const { rows } = await owner.execute(
      sql`select 1 from operator where email = ${email("self")}`,
    );
    expect(rows).toEqual([]);
  });

  test("a sign-in from another origin is refused", async () => {
    const password = await newOperator(email("csrf"));
    const response = await signIn(email("csrf"), password, app, "https://evil.example.com");
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("a request with no session is refused", async () => {
    expect((await me("")).status).toBe(401);
    expect((await me("better-auth.session_token=forged.value")).status).toBe(401);
  });

  test("an oversized sign-in is refused before it is parsed", async () => {
    const response = await signIn(email("big"), "x".repeat(10_000));
    expect(response.status).toBe(413);
  });

  test("the worker role cannot read passwords", async () => {
    const { db: worker } = database.connect("worker");
    await expect(worker.execute(sql`select password from account`)).rejects.toThrow();
  });
});

describe("the login limit", () => {
  test("wrong passwords count, and the limit stops even the right one", async () => {
    const password = await newOperator(email("limit"));
    for (let i = 0; i < 5; i++) {
      expect((await signIn(email("limit"), "wrong-password-value")).status).toBe(401);
    }
    const blocked = await signIn(email("limit"), password);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
  });

  test("the limit ignores letter case and spaces in the email", async () => {
    await newOperator(email("case"));
    for (let i = 0; i < 5; i++)
      await signIn(`${email("case").toUpperCase()} `, "wrong-password-value");
    expect((await signIn(email("case"), "wrong-password-value")).status).toBe(429);
  });

  test("parallel guesses cannot pass the limit", async () => {
    await newOperator(email("parallel"));
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => signIn(email("parallel"), "wrong-password-value")),
    );
    expect(responses.filter((r) => r.status === 401)).toHaveLength(5);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(7);
  });

  test("a body that parses two ways cannot show the limit another email", async () => {
    const password = await newOperator(email("victim"));
    const guess = (decoy: string, value: string) =>
      app.request("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: `{"email":"${decoy}","a":"&email=${email("victim")}&password=${value}&b="}`,
      });
    expect((await guess(email("decoy1"), password)).status).toBe(415);
    expect((await guess(email("decoy2"), "wrong-password-value")).status).toBe(415);
    const plain = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: `email=${email("victim")}&password=${password}`,
    });
    expect(plain.status).toBe(415);
    expect(plain.headers.getSetCookie()).toEqual([]);
  });

  test("a counter always has an expiry", async () => {
    await newOperator(email("expiry"));
    await signIn(email("expiry"), "wrong-password-value");
    // Only this test's keys: another file can be counting sign-ins in the same Valkey.
    const key = `dinghy:login:${sha256Hex(email("expiry"))}`;
    const keys = [key, `${key}:total`];
    const ttls = await Promise.all(keys.map((name) => valkey.ttl(name)));
    expect(ttls.length).toBeGreaterThan(0);
    expect(ttls.every((ttl) => ttl > 0)).toBe(true);
  });

  test("chat reset-password makes the new password work at once, despite the limit", async () => {
    await newOperator(email("locked"));
    for (let i = 0; i < 6; i++) await signIn(email("locked"), "wrong-password-value");
    const { out } = await chat("reset-password", email("locked"));
    const next = /: (\S+)\n/.exec(out)?.[1] ?? "";
    expect((await signIn(email("locked"), next)).status).toBe(200);
  });

  test("a correct sign-in clears the count", async () => {
    const password = await newOperator(email("clear"));
    for (let i = 0; i < 4; i++) await signIn(email("clear"), "wrong-password-value");
    expect((await signIn(email("clear"), password)).status).toBe(200);
    expect((await signIn(email("clear"), "wrong-password-value")).status).toBe(401);
  });

  test("one account's limit does not touch another", async () => {
    const password = await newOperator(email("other"));
    for (let i = 0; i < 6; i++) await signIn(email("noisy"), "wrong-password-value");
    expect((await signIn(email("other"), password)).status).toBe(200);
  });

  test("guesses from many addresses stop at the account's total, and a reset clears it", async () => {
    const limit = createLoginLimit(valkey, logger);
    const target = email("spread");
    let allowed = 0;
    for (let n = 0; n < 50; n++) {
      for (let i = 0; i < 5; i++) if (await limit.attempt(target, address(n))) allowed++;
    }
    expect(allowed).toBe(200);
    expect(await limit.attempt(target, address(1000))).toBe(false);
    await limit.clear(target);
    expect(await limit.attempt(target, address(1000))).toBe(true);
  });

  test("one address that keeps guessing cannot use up the account's total", async () => {
    const limit = createLoginLimit(valkey, logger);
    const target = email("hammered");
    for (let i = 0; i < 300; i++) await limit.attempt(target, address(1001));
    expect(await limit.attempt(target, address(1002))).toBe(true);
  });

  test("sign-in still works with Valkey down", async () => {
    const password = await newOperator(email("down"));
    const down = new Redis("redis://127.0.0.1:1", {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    down.on("error", () => {});
    const offline = createApp({
      db,
      logger,
      valkey: down,
      checks: { postgres: ok, valkey: ok },
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger }),
    });
    expect((await signIn(email("down"), password, offline)).status).toBe(200);
    down.disconnect();
  });
});

describe("the logs", () => {
  test("a database failure during sign-in logs no email or parameters", async () => {
    const lines: string[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
    const printed: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => printed.push(args.map(String).join(" "));
    const failing = createApp({
      db,
      logger: capture,
      checks: { postgres: ok, valkey: ok },
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger: capture }),
    });
    await owner.execute(sql`alter table operator rename to operator_hidden`);
    try {
      const response = await signIn(email("private"), "a-private-password", failing);
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await owner.execute(sql`alter table operator_hidden rename to operator`);
      console.error = original;
    }
    const output = lines.join("") + printed.join("");
    expect(output).not.toContain(email("private"));
    expect(output).not.toContain("a-private-password");
  });
});

describe("the audit log", () => {
  test("a failed and a limited sign-in each write a line, with a hash and no email", async () => {
    const lines: Record<string, unknown>[] = [];
    const capture = pino(
      { level: "info" },
      { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const logged = createApp({
      db,
      logger: capture,
      valkey,
      checks: { postgres: ok, valkey: ok },
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger: capture }),
    });
    await newOperator(email("audited"));
    for (let i = 0; i < 6; i++) await signIn(email("audited"), "wrong-password-value", logged);
    const account = sha256Hex(email("audited")).slice(0, 16);
    const audits = lines.filter((line) => line.msg === "audit");
    expect(audits.filter((line) => line.event === "sign_in.failed")).toHaveLength(5);
    expect(audits.filter((line) => line.event === "sign_in.limited")).toHaveLength(1);
    expect(audits.every((line) => line.account === account)).toBe(true);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(email("audited"));
    expect(text).not.toContain("wrong-password-value");
  });
});

describe("failures", () => {
  test("a database failure during a session check keeps the session token out of the logs", async () => {
    const password = await newOperator(email("token-log"));
    const cookie = cookieOf(await signIn(email("token-log"), password));
    const token = decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";
    expect(token.length).toBeGreaterThan(10);
    const lines: string[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
    const failing = createApp({
      db,
      logger: capture,
      checks: { postgres: ok, valkey: ok },
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger: capture }),
    });
    await owner.execute(sql`alter table session rename to session_hidden`);
    try {
      await failing.request("/v1/operator/me", { headers: { cookie } });
    } finally {
      await owner.execute(sql`alter table session_hidden rename to session`);
    }
    const output = lines.join("");
    expect(output).toContain("unhandled error");
    expect(output).not.toContain(token);
  });

  test("a mail server failure answers normally and logs the failure", async () => {
    const lines: string[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
    await newOperator(email("no-mail"));
    const failing = createApp({
      db,
      logger: capture,
      checks: { postgres: ok, valkey: ok },
      auth: createAuth({
        db,
        secret: AUTH_SECRET,
        baseURL: PUBLIC_URL,
        logger: capture,
        sendResetPassword: async () => {
          throw new Error("The mail server refused the message");
        },
      }),
    });
    const response = await failing.request("/v1/auth/request-password-reset", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: email("no-mail"), redirectTo: "/" }),
    });
    expect(response.status).toBe(200);
    await expect.poll(() => lines.join("")).toContain("could not send a password reset email");
  });

  test("a Valkey that stops answering does not hold up a reset or lose its password", async () => {
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as net.AddressInfo;
    await newOperator(email("silent"));
    const started = Date.now();
    const { code, out } = await chat("reset-password", email("silent"), {
      VALKEY_URL: `redis://127.0.0.1:${port}`,
    });
    expect(code).toBe(0);
    expect(out).toContain(`New password for ${email("silent")}`);
    expect(Date.now() - started).toBeLessThan(8000);
    silent.close();
  }, 15_000);
});

describe("sessions", () => {
  test("an active operator's session renews and sends a new cookie", async () => {
    const password = await newOperator(email("renew"));
    const cookie = cookieOf(await signIn(email("renew"), password));
    // The session was last renewed two days ago, and it renews once a day.
    await owner.execute(sql`
      update session set updated_at = now() - interval '2 days',
        expires_at = now() + interval '5 days'
      where user_id = (select id from operator where email = ${email("renew")})
    `);
    const response = await me(cookie);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join("")).toContain("session_token");
  });

  test("signing out ends the session", async () => {
    const password = await newOperator(email("out"));
    const cookie = cookieOf(await signIn(email("out"), password));
    await app.request("/v1/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect((await me(cookie)).status).toBe(401);
  });

  test("a revoked session stops at the next request", async () => {
    const password = await newOperator(email("revoked"));
    const cookie = cookieOf(await signIn(email("revoked"), password));
    expect((await me(cookie)).status).toBe(200);
    await db.delete(session);
    expect((await me(cookie)).status).toBe(401);
  });
});

describe("resetting a password", () => {
  test("chat reset-password works with no mail server, and signs the operator out", async () => {
    const old = await newOperator(email("cli"));
    const cookie = cookieOf(await signIn(email("cli"), old));
    const { code, out } = await chat("reset-password", email("cli"));
    expect(code).toBe(0);
    const next = /: (\S+)\n/.exec(out)?.[1] ?? "";
    expect((await me(cookie)).status).toBe(401);
    expect((await signIn(email("cli"), old)).status).toBe(401);
    expect((await signIn(email("cli"), next)).status).toBe(200);
  });

  test("chat reset-password names an unknown email and changes nothing", async () => {
    const { code, err } = await chat("reset-password", email("nobody"));
    expect(code).toBe(1);
    expect(err).toContain(email("nobody"));
  });

  test("chat with no command prints usage", async () => {
    const { code, err } = await chat();
    expect(code).toBe(2);
    expect(err).toContain("Usage");
  });

  test("with a mail server, a reset link sets a new password and ends old sessions", async () => {
    const old = await newOperator(email("mail"));
    const cookie = cookieOf(await signIn(email("mail"), old));
    const request = await app.request("/v1/auth/request-password-reset", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: email("mail"), redirectTo: "/" }),
    });
    expect(request.status).toBe(200);
    await expect.poll(() => mail.some((m) => m.to === email("mail"))).toBe(true);
    const sent = mail.find((m) => m.to === email("mail"));
    const token = new URL(sent?.url ?? "http://x").pathname.split("/").at(-1);
    const reset = await app.request("/v1/auth/reset-password", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ newPassword: "a-brand-new-password", token }),
    });
    expect(reset.status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
    expect((await signIn(email("mail"), "a-brand-new-password")).status).toBe(200);
  });

  test("a reset link also clears the login limit", async () => {
    await newOperator(email("mail-limit"));
    for (let i = 0; i < 6; i++) await signIn(email("mail-limit"), "wrong-password-value");
    await app.request("/v1/auth/request-password-reset", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: email("mail-limit"), redirectTo: "/" }),
    });
    await expect.poll(() => mail.some((m) => m.to === email("mail-limit"))).toBe(true);
    const sent = mail.find((m) => m.to === email("mail-limit"));
    const token = new URL(sent?.url ?? "http://x").pathname.split("/").at(-1);
    await app.request("/v1/auth/reset-password", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ newPassword: "another-new-password", token }),
    });
    expect((await signIn(email("mail-limit"), "another-new-password")).status).toBe(200);
  });

  test("reset emails to one address are limited", async () => {
    await newOperator(email("flood"));
    const request = () =>
      app.request("/v1/auth/request-password-reset", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: email("flood"), redirectTo: "/" }),
      });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await request()).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    // The reset count lasts an hour, so the answer says to wait that long.
    expect((await request()).headers.get("retry-after")).toBe("3600");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mail.filter((m) => m.to === email("flood"))).toHaveLength(3);
  });

  test("verification emails to one address share the reset limit", async () => {
    const request = () =>
      app.request("/v1/auth/send-verification-email", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: email("verify-flood") }),
      });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await request()).status);
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);
  });

  test("reset requests do not lock anyone out of signing in", async () => {
    const password = await newOperator(email("calm"));
    for (let i = 0; i < 5; i++) {
      await app.request("/v1/auth/request-password-reset", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: email("calm"), redirectTo: "/" }),
      });
    }
    expect((await signIn(email("calm"), password)).status).toBe(200);
  });

  test("a reset request reveals nothing about an unknown email", async () => {
    const unknown = await app.request("/v1/auth/request-password-reset", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: email("nobody"), redirectTo: "/" }),
    });
    expect(unknown.status).toBe(200);
    expect(mail.some((m) => m.to === email("nobody"))).toBe(false);
  });
});
