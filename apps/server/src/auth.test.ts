import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import {
  addOperator,
  captureMail,
  cookieOf,
  openLink,
  openSignInLink,
  pressLinkButton,
  signIn,
} from "../test/operators.ts";
import { type App, createApp, openApiDocument } from "./app.ts";
import { type Auth, createAuth, signInLink } from "./auth.ts";
import { session } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { sha256Hex } from "./identity.ts";
import { createLinkLimit } from "./login-limit.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const logger = pino({ level: "silent" });
const ok = async () => {};
const ORIGIN = new URL(PUBLIC_URL).origin;
// Link counts live for an hour in the Valkey that every test file shares, so each run uses its own
// emails and addresses, and a run soon after another starts from zero.
const RUN = randomUUID().slice(0, 8);
// The limits count a whole IPv6 /64 as one address, so each number is its own /64.
const address = (n: number) => `2001:${RUN.slice(0, 4)}:${RUN.slice(4)}:${n.toString(16)}::1`;
let nextAddress = 0x1000;
const email = (name: string) => `${name}-${RUN}@example.com`;

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
let valkey: Redis;
let directory: string;
const mail = captureMail();

function chat(...args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        DATABASE_URL: database.url("app"),
        VALKEY_URL,
        AUTH_SECRET,
        PUBLIC_URL,
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

const newOperator = (to: string) => addOperator({ auth, owner, email: to, name: "Anna" });

/** Asks for a link on the sign-in page, from `ip`. */
function askLink(to: string, { target = app, origin = ORIGIN, ip = address(nextAddress++) } = {}) {
  return target.request("/v1/auth/sign-in/magic-link", {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email: to }),
  });
}

const me = (cookie: string) => app.request("/v1/operator/me", { headers: { cookie } });
const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app").db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await new Promise((resolve) => valkey.once("ready", resolve));
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  // The operator app's page, which every emailed link opens.
  directory = await mkdtemp(join(tmpdir(), "dinghy-auth-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Dinghy</title>");
  app = createApp({
    db,
    logger,
    valkey,
    mailer: mail,
    trustedProxyHops: 1,
    checks: { postgres: ok, valkey: ok },
    auth,
    operatorDirectory: directory,
  });
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

describe("asking for a link", () => {
  test("a known and an unknown email get the same answer, and only the known one an email", async () => {
    await newOperator(email("known"));
    const known = await askLink(email("known"));
    const unknown = await askLink(email("unknown"));
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.text()).toBe(await unknown.text());
    const link = await mail.linkTo(email("known"));
    expect(link.startsWith(`${ORIGIN}/link?for=sign-in&token=`)).toBe(true);
    // The unknown email's work runs after the answer, so give it the time the known one took.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mail.countTo(email("unknown"))).toBe(0);
    const [sent] = mail.sent.filter((one) => one.to === email("known"));
    expect(sent?.subject).toBe("Your Dinghy sign-in link");
    expect(sent?.text.startsWith("Hi,\n\n")).toBe(true);
    expect(sent?.text).toContain("15 minutes");
    expect(sent?.text.endsWith("Cheers,\nThe Dinghy team")).toBe(true);
  });

  test("opening the link shows a page and uses nothing, so a mail scanner cannot use it up", async () => {
    await newOperator(email("scan"));
    await askLink(email("scan"));
    const link = await mail.linkTo(email("scan"));
    for (let i = 0; i < 3; i++) {
      const page = await openLink(app, link);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.headers.getSetCookie()).toEqual([]);
    }
    // BetterAuth's own GET route, which used a link when fetched, is gone.
    const token = new URL(link).searchParams.get("token") ?? "";
    const bypass = await app.request(`/v1/auth/magic-link/verify?token=${token}&callbackURL=/`);
    expect(bypass.status).toBe(404);
    expect(bypass.headers.getSetCookie()).toEqual([]);
    expect(await openSignInLink(app, link)).not.toBe("");
  });

  test("the page's button signs in with a session that is HttpOnly and not sent cross-site", async () => {
    await newOperator(email("in"));
    await askLink(email("in"));
    const response = await pressLinkButton(app, await mail.linkTo(email("in")));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const body = (await (await me(cookieOf(response))).json()) as { email: string };
    expect(body.email).toBe(email("in"));
  });

  test("the email's letter case does not matter", async () => {
    await newOperator(email("case"));
    expect((await askLink(email("case").toUpperCase())).status).toBe(200);
    expect(await mail.linkTo(email("case"))).toContain("token=");
  });

  test("a link works once", async () => {
    await newOperator(email("once"));
    const link = await signInLink(auth, email("once"));
    expect(await openSignInLink(app, link)).not.toBe("");
    const again = await pressLinkButton(app, link);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: "link_invalid" } });
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  test("a link stops working after 15 minutes", async () => {
    await newOperator(email("old"));
    const link = await signInLink(auth, email("old"));
    const { rows } = await owner.execute<{ minutes: number }>(
      sql`select extract(epoch from expires_at - now()) / 60 as minutes from verification
          where identifier like 'magic-link:%' order by created_at desc limit 1`,
    );
    expect(Number(rows[0]?.minutes)).toBeGreaterThan(14);
    expect(Number(rows[0]?.minutes)).toBeLessThanOrEqual(15);
    await owner.execute(
      sql`update verification set expires_at = now() - interval '1 second'
          where identifier like 'magic-link:%'`,
    );
    const response = await pressLinkButton(app, link);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "link_invalid" } });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("the database holds only a hash of each link's token", async () => {
    await newOperator(email("hash"));
    const token = new URL(await signInLink(auth, email("hash"))).searchParams.get("token") ?? "";
    const { rows } = await owner.execute<{ identifier: string; value: string }>(
      sql`select identifier, value from verification`,
    );
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  test("a request from another origin, or a form body, is refused", async () => {
    await newOperator(email("csrf"));
    expect((await askLink(email("csrf"), { origin: "https://evil.example.com" })).status).toBe(403);
    const form = await app.request("/v1/auth/sign-in/magic-link", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: `email=${encodeURIComponent(email("csrf"))}`,
    });
    expect(form.status).toBe(415);
    // The same for the button's request, which uses a link.
    const link = await signInLink(auth, email("csrf"));
    const token = new URL(link).searchParams.get("token");
    const elsewhere = await app.request("/v1/auth/magic-link/verify", {
      method: "POST",
      headers: { origin: "https://evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.headers.getSetCookie()).toEqual([]);
    expect(await openSignInLink(app, link)).not.toBe("");
  });

  test("a client cannot pick where the link lands or name a new account", async () => {
    const response = await app.request("/v1/auth/sign-in/magic-link", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: email("pick"), callbackURL: "https://evil.example.com" }),
    });
    expect(response.status).toBe(400);
  });

  test("an oversized request is refused before it is parsed", async () => {
    const response = await app.request("/v1/auth/sign-in/magic-link", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: `${"x".repeat(10_000)}@example.com` }),
    });
    expect(response.status).toBe(413);
  });

  test("the API description names the sign-in route that sets the session cookie", async () => {
    const document = (await openApiDocument()) as {
      components: { securitySchemes: Record<string, { description: string }> };
    };
    const named = /POST (\/v1\/auth\/\S+)/.exec(
      document.components.securitySchemes.sessionCookie?.description ?? "",
    )?.[1];
    expect(named).toBeDefined();
    const answer = await app.request(named ?? "", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(answer.status).not.toBe(404);
  });

  test("a request with no session is refused", async () => {
    expect((await me("")).status).toBe(401);
    expect((await me("better-auth.session_token=forged.value")).status).toBe(401);
  });

  test("an account that never proved its email proves it with an emailed link, and loses old sessions", async () => {
    const [row] = await owner
      .execute<{ id: string }>(
        sql`insert into operator (name, email, email_verified) values ('Old', ${email("unproven")}, false)
          returning id`,
      )
      .then((result) => result.rows);
    await owner.execute(
      sql`insert into session (user_id, token, expires_at)
          values (${row?.id}, ${`planted-${RUN}`}, now() + interval '1 day')`,
    );
    // A link a command printed signs in, and proves nothing.
    expect(await signIn(app, auth, email("unproven"))).not.toBe("");
    const before = await owner.execute<{ email_verified: boolean }>(
      sql`select email_verified from operator where email = ${email("unproven")}`,
    );
    expect(before.rows[0]?.email_verified).toBe(false);
    expect((await askLink(email("unproven"))).status).toBe(200);
    expect(await openSignInLink(app, await mail.linkTo(email("unproven")))).not.toBe("");
    const { rows } = await owner.execute<{ email_verified: boolean; planted: number }>(
      sql`select email_verified, (select count(*)::int from session where token = ${`planted-${RUN}`})
          as planted from operator where email = ${email("unproven")}`,
    );
    expect(rows[0]).toEqual({ email_verified: true, planted: 0 });
  });
});

describe("with no mail server", () => {
  test("the sign-in route says so, for any email, and /v1/meta tells the app", async () => {
    const quiet = createApp({ db, logger, checks: { postgres: ok, valkey: ok }, auth });
    await newOperator(email("quiet"));
    const known = await askLink(email("quiet"), { target: quiet });
    const unknown = await askLink(email("quiet-unknown"), { target: quiet });
    expect(known.status).toBe(400);
    const answer = await known.text();
    expect(answer).toBe(await unknown.text());
    expect((JSON.parse(answer) as { error: { code: string } }).error.code).toBe(
      "email_unavailable",
    );
    expect(await (await quiet.request("/v1/meta")).json()).toMatchObject({ email: false });
    expect(await (await app.request("/v1/meta")).json()).toMatchObject({ email: true });
  });
});

describe("chat sign-in-link", () => {
  test("prints a link that signs the operator in once", async () => {
    await newOperator(email("cli"));
    const { code, out } = await chat("sign-in-link", email("cli").toUpperCase());
    expect(code).toBe(0);
    expect(out).toContain("It works once, for the next 15 minutes");
    expect(out).toContain(`chat sign-in-link ${email("cli")}`);
    const link = linkIn(out);
    const cookie = await openSignInLink(app, link);
    expect(((await (await me(cookie)).json()) as { email: string }).email).toBe(email("cli"));
    expect(link.startsWith(`${ORIGIN}/link?for=sign-in&token=`)).toBe(true);
    expect((await pressLinkButton(app, link)).status).toBe(400);
  });

  test("refuses an unknown email and makes no link", async () => {
    const { code, err, out } = await chat("sign-in-link", email("nobody"));
    expect(code).toBe(1);
    expect(err).toContain(`No operator has the email ${email("nobody")}`);
    expect(out).toBe("");
    const { rows } = await owner.execute(
      sql`select 1 from operator where email = ${email("nobody")}`,
    );
    expect(rows).toEqual([]);
  });

  test("chat create-operator creates the account and prints a working link", async () => {
    const { code, out } = await chat(
      "create-operator",
      email("owner"),
      "Owner",
      "--workspace",
      "Acme",
      "--origin",
      "https://acme.example.com",
    );
    expect(code).toBe(0);
    const cookie = await openSignInLink(app, linkIn(out));
    const body = (await (await me(cookie)).json()) as { workspaces: { role: string }[] };
    expect(body.workspaces.map((w) => w.role)).toEqual(["owner"]);
  });

  test("chat with no command, or the old reset-password, prints usage", async () => {
    const none = await chat();
    expect(none.code).toBe(2);
    expect(none.err).toContain("chat sign-in-link <email>");
    const old = await chat("reset-password", email("cli"));
    expect(old.code).toBe(2);
    expect(old.err).not.toContain("reset-password");
  });
});

describe("password routes", () => {
  const post = (path: string, body: Record<string, unknown>) =>
    app.request(path, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("none of them answers any more", async () => {
    await newOperator(email("routes"));
    const cookie = await signIn(app, auth, email("routes"));
    for (const path of [
      "/v1/auth/sign-in/email",
      "/v1/auth/sign-up/email",
      "/v1/auth/request-password-reset",
      "/v1/auth/reset-password",
      "/v1/auth/change-password",
      "/v1/auth/set-password",
      "/v1/auth/send-verification-email",
      "/v1/auth/forget-password",
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: email("routes"), password: "a-long-password-value" }),
      });
      expect(response.status, path).toBe(404);
    }
    for (const path of ["/v1/auth/verify-email?token=x", "/v1/auth/reset-password/x"]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
    expect((await app.request("/reset-password")).status).toBe(404);
  });

  test("nobody signs themselves up through BetterAuth", async () => {
    await post("/v1/auth/sign-up/email", { email: email("self"), password: "x".repeat(12) });
    const { rows } = await owner.execute(
      sql`select 1 from operator where email = ${email("self")}`,
    );
    expect(rows).toEqual([]);
  });
});

describe("the link limit", () => {
  test("stops one address after 5 requests for one account, and counts before the lookup", async () => {
    for (const target of [email("limit"), email("limit-unknown")]) {
      if (target === email("limit")) await newOperator(target);
      for (let i = 0; i < 5; i++)
        expect((await askLink(target, { ip: address(1) })).status).toBe(200);
      const limited = await askLink(target, { ip: address(1) });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("3600");
    }
    // Another address still gets its own link.
    expect((await askLink(email("limit"), { ip: address(2) })).status).toBe(200);
  });

  test("letter case does not reset the count", async () => {
    for (let i = 0; i < 5; i++) await askLink(email("case-limit"), { ip: address(3) });
    expect((await askLink(email("CASE-limit"), { ip: address(3) })).status).toBe(429);
  });

  test("one address cannot ask for many accounts", async () => {
    for (let i = 0; i < 30; i++) await askLink(email(`many-${i}`), { ip: address(4) });
    expect((await askLink(email("many-next"), { ip: address(4) })).status).toBe(429);
  });

  test("an account gets at most 20 links an hour, from any number of addresses", async () => {
    const target = email("total");
    for (let i = 0; i < 20; i++) {
      expect((await askLink(target, { ip: address(100 + i) })).status).toBe(200);
    }
    expect((await askLink(target, { ip: address(200) })).status).toBe(429);
  });

  test("a counter always has an expiry", async () => {
    const limit = createLinkLimit(valkey, logger);
    await limit.attempt(email("ttl"), address(5));
    const key = `dinghy:sign-in-link:${sha256Hex(email("ttl"))}`;
    expect(await valkey.ttl(key)).toBeGreaterThan(0);
    expect(await valkey.ttl(`${key}:total`)).toBeGreaterThan(0);
  });

  test("links still work with Valkey down", async () => {
    await newOperator(email("down"));
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
      mailer: mail,
      checks: { postgres: ok, valkey: ok },
      auth,
    });
    expect((await askLink(email("down"), { target: offline })).status).toBe(200);
    expect(await openSignInLink(offline, await mail.linkTo(email("down")))).not.toBe("");
    down.disconnect();
  });
});

describe("the logs", () => {
  test("a limited request and a used or refused link each write an audit line, with no email", async () => {
    const lines: Record<string, unknown>[] = [];
    const capture = pino(
      { level: "info" },
      { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const logged = createApp({
      db,
      logger: capture,
      valkey,
      mailer: mail,
      trustedProxyHops: 1,
      checks: { postgres: ok, valkey: ok },
      auth,
    });
    const { id } = await newOperator(email("audited"));
    for (let i = 0; i < 6; i++) await askLink(email("audited"), { target: logged, ip: address(6) });
    const link = await mail.linkTo(email("audited"));
    await pressLinkButton(logged, link);
    await pressLinkButton(logged, link);
    const audits = lines.filter((line) => line.msg === "audit");
    const of = (event: string) => audits.filter((line) => line.event === event);
    expect(of("sign_in.limited")).toEqual([
      expect.objectContaining({ account: sha256Hex(email("audited")).slice(0, 16) }),
    ]);
    expect(of("sign_in.link_sent")).toHaveLength(5);
    expect(of("sign_in.link_used")).toEqual([expect.objectContaining({ operatorId: id })]);
    expect(of("sign_in.link_refused")).toHaveLength(1);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(email("audited"));
    expect(text).not.toContain(new URL(link).searchParams.get("token"));
  });

  test("a mail server failure answers normally and logs the failure", async () => {
    const lines: string[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
    await newOperator(email("no-mail"));
    const failing = createApp({
      db,
      logger: capture,
      mailer: {
        send: async () => {
          throw new Error("The mail server refused the message");
        },
      },
      checks: { postgres: ok, valkey: ok },
      auth,
    });
    expect((await askLink(email("no-mail"), { target: failing })).status).toBe(200);
    await expect.poll(() => lines.join("")).toContain("could not send a sign-in link");
  });

  test("a database failure during a session check keeps the session token out of the logs", async () => {
    await newOperator(email("token-log"));
    const cookie = await signIn(app, auth, email("token-log"));
    const token = decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";
    expect(token.length).toBeGreaterThan(10);
    const lines: string[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
    const failing = createApp({ db, logger: capture, checks: { postgres: ok, valkey: ok }, auth });
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
});

describe("sessions", () => {
  test("an active operator's session renews and sends a new cookie", async () => {
    await newOperator(email("renew"));
    const cookie = await signIn(app, auth, email("renew"));
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
    await newOperator(email("out"));
    const cookie = await signIn(app, auth, email("out"));
    await app.request("/v1/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect((await me(cookie)).status).toBe(401);
  });

  test("a revoked session stops at the next request", async () => {
    await newOperator(email("revoked"));
    const cookie = await signIn(app, auth, email("revoked"));
    expect((await me(cookie)).status).toBe(200);
    await db.delete(session);
    expect((await me(cookie)).status).toBe(401);
  });
});
