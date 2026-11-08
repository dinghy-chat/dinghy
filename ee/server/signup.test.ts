// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import pg from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type App, createApp } from "../../apps/server/src/app.ts";
import { createAuth } from "../../apps/server/src/auth.ts";
import { loadConfig } from "../../apps/server/src/config.ts";
import {
  account,
  event,
  message,
  operator,
  subscription,
  workspace,
} from "../../apps/server/src/db/schema.ts";
import type { Database } from "../../apps/server/src/db/tenant.ts";
import { createImages } from "../../apps/server/src/images.ts";
import type { Mailer } from "../../apps/server/src/mailer.ts";
import { localStore } from "../../apps/server/src/storage.ts";
import { widgetWorkspace } from "../../apps/server/src/workspaces.ts";
import { createTestDatabase, type TestDatabase } from "../../apps/server/test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../../apps/server/test/env.ts";
import { createBilling } from "./billing.ts";
import { runLifecycle } from "./lifecycle.ts";
import { signupsCsv } from "./signup.ts";
import {
  type FakeStripe,
  STRIPE_PRICE_ID,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  startFakeStripe,
} from "./test/fake-stripe.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const PASSWORD = "a-long-test-password";
const SITE = "https://site.example";
const CLI = fileURLToPath(new URL("../../apps/server/src/cli.ts", import.meta.url));
const DAY_MS = 86_400_000;
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let workerDb: Database;
let valkey: Redis;
let stripe: FakeStripe;
let directory: string;
let auth: ReturnType<typeof createAuth>;
/** Early signup on, billing off: the cloud before it takes payments. */
let early: App;
/** The same server once Stripe keys are set. */
let paying: App;
/** A self-hosted install: neither setting. */
let selfHosted: App;
/** Early signup on a server with a mail server, which verifies every new account's email. */
let verifying: App;

const mails: { to: string; subject: string; text: string }[] = [];
const mailer: Mailer = {
  async send(to, subject, text) {
    mails.push({ to, subject, text });
  },
};

const IP = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

const request = (
  server: App,
  method: string,
  path: string,
  { cookie, body }: { cookie?: string; body?: unknown } = {},
) =>
  server.request(path, {
    method,
    headers: {
      origin: ORIGIN,
      "x-forwarded-for": IP,
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Cloud signup's two steps: the account, then the onboarding's name and workspace. */
async function signup(
  server: App,
  workspaceName = "Acme",
  email = `early-${randomUUID()}@example.com`,
) {
  const account = await request(server, "POST", "/v1/signup", {
    body: { email, password: PASSWORD },
  });
  const cookie = cookieOf(account);
  const response = await request(server, "POST", "/v1/operator/workspaces", {
    cookie,
    body: { name: "Nora", workspaceName },
  });
  const body = (await response.json()) as { workspaceId: string };
  return { account, response, email, workspaceId: body.workspaceId, cookie };
}

async function workspaceRow(id: string) {
  const [row] = await owner.select().from(workspace).where(eq(workspace.id, id));
  if (row === undefined) throw new Error("The workspace is missing");
  return row;
}

const visitorsFrom = (server: App, publicKey: string) =>
  server.request(`/v1/widget/${publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE, "x-forwarded-for": IP },
  });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 20).db;
  owner = database.connect("migrator").db;
  workerDb = database.connect("worker", 2).db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  stripe = await startFakeStripe();
  directory = await mkdtemp(join(tmpdir(), "dinghy-signup-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Dinghy</title>");
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger });
  const shared = {
    auth,
    db,
    logger,
    valkey,
    trustedProxyHops: 1,
    limitScale: 100,
    operatorDirectory: directory,
    alerts: { emailAvailable: true, secret: AUTH_SECRET },
    images: createImages({
      store: localStore(join(directory, "images")),
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    }),
    checks: { postgres: ok, valkey: ok },
  };
  early = createApp({ ...shared, cloud: { signup: "early" }, mailer });
  paying = createApp({
    ...shared,
    mailer,
    cloud: {
      signup: "early",
      billing: {
        secretKey: STRIPE_SECRET_KEY,
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        priceId: STRIPE_PRICE_ID,
        apiBase: stripe.apiBase,
      },
    },
  });
  selfHosted = createApp(shared);
  verifying = createApp({
    ...shared,
    cloud: { signup: "early" },
    mailer,
    auth: createAuth({
      db,
      secret: AUTH_SECRET,
      baseURL: PUBLIC_URL,
      logger,
      sendVerificationEmail: async (to, url) => {
        mails.push({ to, subject: "verify", text: url });
      },
    }),
  });
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await stripe.stop();
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

beforeEach(() => {
  mails.length = 0;
});

describe("early signup", () => {
  test("the setting is cloud only, and anything but early is refused", () => {
    const base = { DATABASE_URL: "postgres://x/y", VALKEY_URL: "redis://x", AUTH_SECRET };
    expect(loadConfig(base).CLOUD_SIGNUP).toBeUndefined();
    expect(loadConfig({ ...base, CLOUD_SIGNUP: "early" }).CLOUD_SIGNUP).toBe("early");
    expect(() => loadConfig({ ...base, CLOUD_SIGNUP: "open" })).toThrow();
  });

  test("creates the account, a workspace that waits for the cloud, a sample conversation and a welcome email", async () => {
    const created = await signup(early, "Harbor");
    expect(created.account.status).toBe(200);
    expect(created.response.status).toBe(200);
    expect(created.cookie).toContain("better-auth.session_token=");

    const meta = await (await early.request("/v1/meta")).json();
    expect(meta).toMatchObject({ billing: false, signup: "early" });
    expect((await early.request("/signup")).status).toBe(200);
    const me = await request(early, "GET", "/v1/operator/me", { cookie: created.cookie });
    expect(await me.json()).toMatchObject({
      email: created.email,
      name: "Nora",
      billing: false,
      workspaces: [
        {
          workspaceId: created.workspaceId,
          role: "owner",
          name: "Harbor",
          active: false,
          readOnly: false,
          waiting: true,
        },
      ],
    });
    const row = await workspaceRow(created.workspaceId);
    expect(row.active).toBe(false);
    expect(row.waitingSince).toBeInstanceOf(Date);

    // One conversation from the sample visitor, with its message's event row.
    const list = await request(
      early,
      "GET",
      `/v1/operator/workspaces/${created.workspaceId}/conversations?status=open`,
      { cookie: created.cookie },
    );
    expect(list.status).toBe(200);
    const { conversations } = (await list.json()) as {
      conversations: {
        id: string;
        visitor: { externalId: string };
        lastMessage: { body: string; fromVisitor: boolean };
      }[];
    };
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.visitor.externalId).toBe("Sample visitor");
    expect(conversations[0]?.lastMessage).toMatchObject({
      fromVisitor: true,
      body: "Hi! This is a sample conversation. When the cloud opens, your visitors' messages will appear here, and you answer them from this inbox.",
    });
    const events = await owner
      .select()
      .from(event)
      .where(eq(event.workspaceId, created.workspaceId));
    expect(events.map((one) => one.kind)).toEqual(["message.created"]);

    expect(mails).toEqual([
      { to: created.email, subject: "Welcome to Dinghy", text: expect.any(String) },
    ]);
    expect(mails[0]?.text).toContain("Your Dinghy workspace is ready");
    // Text typed at signup never reaches the inbox of an address nobody checked.
    expect(mails[0]?.text).not.toContain("Harbor");
    expect(mails[0]?.text).toContain("We will email you when you can turn it on.");
  });

  test("signup alone makes a signed-in account with no name and no workspace, and sends no email", async () => {
    const email = `early-${randomUUID()}@example.com`;
    const response = await request(early, "POST", "/v1/signup", {
      body: { email, password: PASSWORD },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, verify: false });
    const cookie = cookieOf(response);
    const me = await request(early, "GET", "/v1/operator/me", { cookie });
    expect(await me.json()).toMatchObject({ email, name: "", workspaces: [] });
    expect(mails).toEqual([]);

    // Signing in later finds the same account, which can still finish its onboarding.
    const signIn = await request(early, "POST", "/v1/auth/sign-in/email", {
      body: { email, password: PASSWORD },
    });
    expect(signIn.status).toBe(200);
    const later = await request(early, "POST", "/v1/operator/workspaces", {
      cookie: cookieOf(signIn),
      body: { name: "Nora", workspaceName: "Later" },
    });
    expect(later.status).toBe(200);
    expect(mails.map((mail) => mail.to)).toEqual([email]);
  });

  test("the onboarding needs a session, a name and a workspace name", async () => {
    const noSession = await request(early, "POST", "/v1/operator/workspaces", {
      body: { name: "Nora", workspaceName: "X" },
    });
    expect(noSession.status).toBe(401);
    const { cookie } = await signup(early);
    const blank = await request(early, "POST", "/v1/operator/workspaces", {
      cookie,
      body: { name: " ", workspaceName: "X" },
    });
    expect(blank.status).toBe(400);
    const otherSite = await early.request("/v1/operator/workspaces", {
      method: "POST",
      headers: { origin: "https://evil.example", cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Nora", workspaceName: "X" }),
    });
    expect(otherSite.status).toBe(403);
  });

  test("a known email with its own password signs in and adds a waiting workspace, with no second welcome", async () => {
    const first = await signup(early, "First");
    mails.length = 0;
    const again = await signup(early, "Second", first.email);
    expect(again.account.status).toBe(200);
    expect(again.response.status).toBe(200);
    expect((await workspaceRow(again.workspaceId)).waitingSince).toBeInstanceOf(Date);
    const me = await request(early, "GET", "/v1/operator/me", { cookie: again.cookie });
    const body = (await me.json()) as { workspaces: { workspaceId: string }[] };
    expect(body.workspaces.map((one) => one.workspaceId).sort()).toEqual(
      [first.workspaceId, again.workspaceId].sort(),
    );
    expect(mails).toEqual([]);
  });

  test("deleting the only workspace and making another sends no second welcome", async () => {
    const first = await signup(early, "Gone Soon");
    expect(mails).toHaveLength(1);
    const deleted = await request(early, "DELETE", `/v1/operator/workspaces/${first.workspaceId}`, {
      cookie: first.cookie,
      body: { name: "Gone Soon" },
    });
    expect(deleted.status).toBe(200);
    const again = await request(early, "POST", "/v1/operator/workspaces", {
      cookie: first.cookie,
      body: { name: "Nora", workspaceName: "Back Again" },
    });
    expect(again.status).toBe(200);
    expect(mails).toHaveLength(1);
  });

  test("two onboardings at once send one welcome", async () => {
    const email = `twice-${randomUUID()}@example.com`;
    const account = await request(early, "POST", "/v1/signup", {
      body: { email, password: PASSWORD },
    });
    const cookie = cookieOf(account);
    const both = await Promise.all(
      ["One", "Two"].map((workspaceName) =>
        request(early, "POST", "/v1/operator/workspaces", {
          cookie,
          body: { name: "Nora", workspaceName },
        }),
      ),
    );
    expect(both.map((one) => one.status)).toEqual([200, 200]);
    expect(mails.map((mail) => mail.to)).toEqual([email]);
  });

  test("a known email with another password gets no session", async () => {
    const first = await signup(early);
    const again = await request(early, "POST", "/v1/signup", {
      body: { email: first.email, password: "another-long-password" },
    });
    expect(again.status).toBe(409);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  test("a sign-in that fails for another reason is a logged 500, not email_taken", async () => {
    const email = `broken-${randomUUID()}@example.com`;
    const [row] = await owner
      .insert(operator)
      .values({ name: "Broken", email, emailVerified: true })
      .returning({ id: operator.id });
    const id = row?.id ?? "";
    // A stored hash that the password check cannot read makes BetterAuth fail, not refuse.
    await owner
      .insert(account)
      .values({ userId: id, accountId: id, providerId: "credential", password: "not-a-hash" });
    const again = await request(early, "POST", "/v1/signup", {
      body: { email, password: PASSWORD },
    });
    expect(again.status).toBe(500);
  });

  test("one account creates at most 5 workspaces a day", async () => {
    const strict = createApp({
      auth,
      db,
      logger,
      valkey,
      trustedProxyHops: 1,
      cloud: { signup: "early" },
      checks: { postgres: ok, valkey: ok },
    });
    const from = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
    const send = (path: string, body: unknown, cookie?: string) =>
      strict.request(path, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "x-forwarded-for": from,
          "content-type": "application/json",
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      });
    const email = `early-${randomUUID()}@example.com`;
    const cookie = cookieOf(await send("/v1/signup", { email, password: PASSWORD }));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await send(
        "/v1/operator/workspaces",
        { name: "Nora", workspaceName: `Shop ${i}` },
        cookie,
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const me = await request(strict, "GET", "/v1/operator/me", { cookie });
    expect(((await me.json()) as { workspaces: unknown[] }).workspaces).toHaveLength(5);
  });

  test("works with no SMTP, and only logs the unsent email", async () => {
    const noMail = createApp({
      auth,
      db,
      logger,
      valkey,
      trustedProxyHops: 1,
      limitScale: 100,
      cloud: { signup: "early" },
      checks: { postgres: ok, valkey: ok },
    });
    const created = await signup(noMail);
    expect(created.response.status).toBe(200);
    expect((await workspaceRow(created.workspaceId)).waitingSince).toBeInstanceOf(Date);
  });

  test("a failing mail server does not fail the signup", async () => {
    const broken = createApp({
      auth,
      db,
      logger,
      valkey,
      trustedProxyHops: 1,
      limitScale: 100,
      cloud: { signup: "early" },
      mailer: { send: () => Promise.reject(new Error("SMTP is down")) },
      checks: { postgres: ok, valkey: ok },
    });
    expect((await signup(broken)).response.status).toBe(200);
  });

  test("keeps the signup limit per address", async () => {
    const strict = createApp({
      auth,
      db,
      logger,
      valkey,
      trustedProxyHops: 1,
      cloud: { signup: "early" },
      checks: { postgres: ok, valkey: ok },
    });
    const from = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await strict.request("/v1/signup", {
        method: "POST",
        headers: { origin: ORIGIN, "x-forwarded-for": from, "content-type": "application/json" },
        body: JSON.stringify({ email: "bad", password: PASSWORD }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("with a mail server, signup verifies the email", () => {
  const linkFor = async (to: string) => {
    await expect
      .poll(() => mails.some((mail) => mail.to === to && mail.subject === "verify"))
      .toBe(true);
    const sent = mails.filter((mail) => mail.to === to && mail.subject === "verify").at(-1);
    return new URL(sent?.text ?? "");
  };
  const signupAs = (email: string, password = PASSWORD) =>
    request(verifying, "POST", "/v1/signup", { body: { email, password } });
  const signInAs = (email: string, password = PASSWORD) =>
    request(verifying, "POST", "/v1/auth/sign-in/email", { body: { email, password } });

  test("a new account gets a link, and signs in and adds a workspace only after opening it", async () => {
    const email = `verify-${randomUUID()}@example.com`;
    const answer = await signupAs(email);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true, verify: true });
    expect(answer.headers.getSetCookie()).toEqual([]);
    const link = await linkFor(email);

    // No session yet, and signing in sends a new link instead.
    const refused = await signInAs(email);
    expect(refused.status).toBe(403);
    expect(refused.headers.getSetCookie()).toEqual([]);

    const opened = await verifying.request(`${link.pathname}${link.search}`);
    expect(opened.status).toBe(302);
    const cookie = cookieOf(opened);
    const created = await request(verifying, "POST", "/v1/operator/workspaces", {
      cookie,
      body: { name: "Nora", workspaceName: "Verified" },
    });
    expect(created.status).toBe(200);
    expect((await signInAs(email)).status).toBe(200);
  });

  test("a known email with another password gets the same answer, and its owner a note", async () => {
    const email = `taken-${randomUUID()}@example.com`;
    await signupAs(email);
    const link = await linkFor(email);
    await verifying.request(`${link.pathname}${link.search}`);
    mails.length = 0;

    const fresh = await signupAs(`fresh-${randomUUID()}@example.com`);
    const known = await signupAs(email, "another-long-password");
    expect(known.status).toBe(fresh.status);
    expect(await known.json()).toEqual(await fresh.json());
    expect(known.headers.getSetCookie()).toEqual([]);
    await expect
      .poll(() => mails.filter((mail) => mail.to === email).map((mail) => mail.subject))
      .toEqual(["Your Dinghy account"]);
  });

  test("a known, verified email with its own password signs in", async () => {
    const email = `back-${randomUUID()}@example.com`;
    await signupAs(email);
    const link = await linkFor(email);
    await verifying.request(`${link.pathname}${link.search}`);
    const again = await signupAs(email);
    expect(await again.json()).toEqual({ ok: true, verify: false });
    expect(cookieOf(again)).not.toBe("");
  });
});

describe("a workspace that waits for the cloud", () => {
  test("every operator route works, with no 402", async () => {
    const created = await signup(early);
    const base = `/v1/operator/workspaces/${created.workspaceId}`;
    const as = (method: string, path: string, body?: unknown) =>
      request(early, method, `${base}${path}`, {
        cookie: created.cookie,
        ...(body === undefined ? {} : { body }),
      });
    const list = (await (await as("GET", "/conversations?status=open")).json()) as {
      conversations: { id: string }[];
    };
    const sampleId = list.conversations[0]?.id ?? "";

    expect((await as("GET", "")).status).toBe(200);
    expect((await as("GET", `/conversations/${sampleId}/messages`)).status).toBe(200);
    const reply = await as("POST", `/conversations/${sampleId}/messages`, {
      clientId: "reply-1",
      body: "Thanks!",
    });
    expect(reply.status).toBe(201);
    expect((await as("PATCH", `/conversations/${sampleId}`, { status: "closed" })).status).toBe(
      200,
    );
    expect((await as("GET", "/settings")).status).toBe(200);
    expect((await as("PATCH", "/settings", { allowedOrigins: [SITE] })).status).toBe(200);
    expect((await as("GET", "/members")).status).toBe(200);
    expect((await as("POST", "/invites", { role: "agent" })).status).toBe(201);
    expect((await as("GET", "/alerts")).status).toBe(200);
    expect((await as("PATCH", "/alerts", { email: true })).status).toBe(200);
    expect((await as("GET", "/export")).status).toBe(200);
    expect((await as("DELETE", `/conversations/${sampleId}`)).status).toBe(200);
    expect(
      await owner.select().from(message).where(eq(message.workspaceId, created.workspaceId)),
    ).toEqual([]);
    const account = await request(early, "POST", "/v1/auth/update-user", {
      cookie: created.cookie,
      body: { name: "Nora B" },
    });
    expect(account.status).toBe(200);

    expect((await as("DELETE", "", { name: "Acme" })).status).toBe(200);
    expect((await workspaceRow(created.workspaceId)).deletedAt).toBeInstanceOf(Date);
  });

  test("serves no widget, as for an unknown key", async () => {
    const created = await signup(early);
    const { publicKey } = await workspaceRow(created.workspaceId);
    await owner
      .update(workspace)
      .set({ allowedOrigins: [SITE] })
      .where(eq(workspace.id, created.workspaceId));
    expect(await widgetWorkspace(db, publicKey)).toBeNull();
    const unknown = await visitorsFrom(early, "wk_00000000000000000000000000000000");
    const waiting = await visitorsFrom(early, publicKey);
    expect(waiting.status).toBe(unknown.status);
    expect(await waiting.json()).toEqual(await unknown.json());
  });

  test("the lifecycle worker never touches it", async () => {
    const created = await signup(early);
    const before = await workspaceRow(created.workspaceId);
    mails.length = 0;
    // Far past every grace, read-only and deletion time.
    const far = new Date(Date.now() + 400 * DAY_MS);
    const billing = createBilling(
      {
        secretKey: STRIPE_SECRET_KEY,
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        priceId: STRIPE_PRICE_ID,
        apiBase: stripe.apiBase,
        now: () => far,
      },
      workerDb,
      logger,
    );
    await runLifecycle({ db: workerDb, billing, logger, mailer, publicUrl: PUBLIC_URL });
    expect(await workspaceRow(created.workspaceId)).toEqual(before);
    expect(mails).toEqual([]);
  });

  test("chat signups lists its owner as CSV", async () => {
    const created = await signup(early, '=Danger, "Quoted"');
    // An account that has not created its workspace yet is not listed.
    const unfinished = `early-${randomUUID()}@example.com`;
    await request(early, "POST", "/v1/signup", { body: { email: unfinished, password: PASSWORD } });
    const admin = new pg.Client({ connectionString: database.adminUrl() });
    await admin.connect();
    let csv: string;
    try {
      csv = await signupsCsv(admin);
    } finally {
      await admin.end();
    }
    expect(csv).not.toContain(unfinished);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("email,name,workspace,signed_up_at");
    const line = lines.find((one) => one.startsWith(created.email));
    // A cell that a spreadsheet would run as a formula gets a quote in front.
    expect(line).toMatch(
      new RegExp(`^${created.email},Nora,"'=Danger, ""Quoted""",\\d{4}-\\d\\d-\\d\\dT`),
    );

    // The command itself, as an operator runs it.
    const output = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, "signups"], {
        env: { PATH: process.env.PATH, ADMIN_DATABASE_URL: database.adminUrl() },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("close", (code) => resolve({ code, stdout }));
    });
    expect(output.code).toBe(0);
    expect(output.stdout).toBe(csv);
  });
});

describe("a self-hosted install with neither setting", () => {
  test("has no signup and no onboarding", async () => {
    const meta = await (await selfHosted.request("/v1/meta")).json();
    expect(meta).toMatchObject({ billing: false, signup: null });
    const response = await request(selfHosted, "POST", "/v1/signup", {
      body: { email: `x-${randomUUID()}@example.com`, password: PASSWORD },
    });
    expect(response.status).toBe(404);
    // A signed-in operator cannot create a workspace there either.
    const { cookie } = await signup(early);
    const created = await request(selfHosted, "POST", "/v1/operator/workspaces", {
      cookie,
      body: { name: "Nora", workspaceName: "X" },
    });
    expect(created.status).toBe(404);
    expect((await selfHosted.request("/signup")).status).toBe(404);
  });
});

describe("once Stripe keys are set", () => {
  test("signup asks for payment first, whatever CLOUD_SIGNUP says", async () => {
    const meta = await (await paying.request("/v1/meta")).json();
    expect(meta).toMatchObject({ billing: true, signup: "payment" });
    mails.length = 0;
    const created = await signup(paying);
    const row = await workspaceRow(created.workspaceId);
    expect(row).toMatchObject({ active: false, waitingSince: null });
    expect(mails).toEqual([]);
    const inbox = await request(
      paying,
      "GET",
      `/v1/operator/workspaces/${created.workspaceId}/conversations?status=open`,
      { cookie: created.cookie },
    );
    expect(inbox.status).toBe(402);
  });

  test("a waiting workspace keeps its dashboard, pays through Checkout, and its widget goes live", async () => {
    const created = await signup(early);
    const base = `/v1/operator/workspaces/${created.workspaceId}`;
    const as = (method: string, path: string) =>
      request(paying, method, `${base}${path}`, { cookie: created.cookie });
    await owner
      .update(workspace)
      .set({ allowedOrigins: [SITE] })
      .where(eq(workspace.id, created.workspaceId));
    const { publicKey } = await workspaceRow(created.workspaceId);

    // The dashboard, not the payment wall, and the owner pays from the banner.
    const me = await request(paying, "GET", "/v1/operator/me", { cookie: created.cookie });
    expect(await me.json()).toMatchObject({
      billing: true,
      workspaces: [{ workspaceId: created.workspaceId, active: false, waiting: true }],
    });
    expect((await as("GET", "/conversations?status=open")).status).toBe(200);
    expect(await (await as("GET", "/billing")).json()).toEqual({
      state: "pending",
      date: null,
      payWith: "checkout",
    });
    const checkout = await as("POST", "/checkout");
    expect(checkout.status).toBe(200);
    const { url } = (await checkout.json()) as { url: string };
    const sessionId = url.split("/").at(-1) ?? "";
    expect(stripe.sessions.get(sessionId)?.params.get("client_reference_id")).toBe(
      created.workspaceId,
    );
    expect((await visitorsFrom(paying, publicKey)).status).not.toBe(201);

    const paid = stripe.pay(sessionId);
    const event = stripe.event("checkout.session.completed", {
      object: "checkout.session",
      client_reference_id: created.workspaceId,
      subscription: paid.id,
    });
    const delivered = await paying.request("/v1/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": event.signature },
      body: event.payload,
    });
    expect(delivered.status).toBe(200);

    // A normal paid workspace now.
    expect(await workspaceRow(created.workspaceId)).toMatchObject({
      active: true,
      waitingSince: null,
    });
    const after = await request(paying, "GET", "/v1/operator/me", { cookie: created.cookie });
    expect(await after.json()).toMatchObject({
      workspaces: [{ workspaceId: created.workspaceId, active: true, waiting: false }],
    });
    expect((await as("GET", "/billing")).status).toBe(200);
    expect(await widgetWorkspace(db, publicKey)).not.toBeNull();
    expect((await visitorsFrom(paying, publicKey)).status).toBe(201);
    const [billingRow] = await owner
      .select({ paidAt: subscription.paidAt })
      .from(subscription)
      .where(and(eq(subscription.workspaceId, created.workspaceId)));
    expect(billingRow?.paidAt).toBeInstanceOf(Date);

    // It no longer counts as waiting.
    const admin = new pg.Client({ connectionString: database.adminUrl() });
    await admin.connect();
    try {
      expect(await signupsCsv(admin)).not.toContain(created.email);
    } finally {
      await admin.end();
    }
  });
});
