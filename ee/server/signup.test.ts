// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import pg from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type App, createApp } from "../../apps/server/src/app.ts";
import { createAuth } from "../../apps/server/src/auth.ts";
import { loadConfig } from "../../apps/server/src/config.ts";
import {
  event,
  message,
  operator,
  subscription,
  visitor,
  workspace,
  workspaceMember,
} from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { createImages } from "../../apps/server/src/images.ts";
import type { Mailer } from "../../apps/server/src/mailer.ts";
import { appendMessage } from "../../apps/server/src/messages.ts";
import { localStore } from "../../apps/server/src/storage.ts";
import { widgetWorkspace } from "../../apps/server/src/workspaces.ts";
import { createTestDatabase, type TestDatabase } from "../../apps/server/test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../../apps/server/test/env.ts";
import {
  deletedDuring,
  openSignInLink,
  pressLinkButton,
  signIn,
} from "../../apps/server/test/operators.ts";
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

const mails: { to: string; subject: string; text: string }[] = [];
const mailer: Mailer = {
  async send(to, subject, text) {
    mails.push({ to, subject, text });
  },
};

const newIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const IP = newIp();
const welcomes = () => mails.filter((mail) => mail.subject.endsWith(" is ready"));

/** The link in the latest email to `to`, once it arrives: links go out after the answer. */
async function linkFor(to: string, subject: string): Promise<string> {
  await expect
    .poll(() => mails.some((mail) => mail.to === to && mail.subject === subject))
    .toBe(true);
  const sent = mails.filter((mail) => mail.to === to && mail.subject === subject).at(-1);
  return /https?:\/\/\S+/.exec(sent?.text ?? "")?.[0] ?? "";
}

/** Asks for a signup link, from an address of its own, since link counts outlast a run. */
const askSignup = (server: App, email: string, from = newIp()) =>
  server.request("/v1/signup", {
    method: "POST",
    headers: { origin: ORIGIN, "x-forwarded-for": from, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });

/** Signs up by link and returns the session: a new email gets one email, a known one another. */
async function linkSignup(server: App, email: string, known = false) {
  const before = mails.length;
  const answer = await askSignup(server, email);
  expect(answer.status).toBe(200);
  const subject = known ? "Your Dinghy sign-in link" : "Finish signing up for Dinghy";
  await expect.poll(() => mails.slice(before).some((mail) => mail.to === email)).toBe(true);
  return openSignInLink(server, await linkFor(email, subject));
}

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

/** Cloud signup's two steps: the account by link, then the onboarding's name and workspace. */
async function signup(
  server: App,
  workspaceName = "Acme",
  email = `early-${randomUUID()}@example.com`,
  known = false,
) {
  const cookie = await linkSignup(server, email, known);
  const response = await request(server, "POST", "/v1/operator/workspaces", {
    cookie,
    body: { name: "Nora", workspaceName },
  });
  const body = (await response.json()) as { workspaceId: string };
  return { response, email, workspaceId: body.workspaceId, cookie };
}

/** Each run starts a Node process, which takes over a second on a CI runner. */
const CLI_TEST_MS = 20_000;

/** The chat command, as an operator runs it on the server. */
const runCli = (args: string[]) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, ADMIN_DATABASE_URL: database.adminUrl() },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout }));
  });

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

/** A visitor's conversation in a workspace, as the widget would start one. */
async function visitorConversation(workspaceId: string): Promise<string> {
  const [guest] = await owner
    .insert(visitor)
    .values({ workspaceId, tokenHash: randomUUID() })
    .returning({ id: visitor.id });
  const sent = await withWorkspace(db, workspaceId, (tx) =>
    appendMessage(
      tx,
      workspaceId,
      { kind: "visitor", visitorId: guest?.id ?? "" },
      { clientId: randomUUID(), body: "Hello" },
    ),
  );
  return sent.message.conversationId;
}

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
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
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

  test("creates the account, a workspace that waits for the cloud, an empty inbox and a welcome email", async () => {
    const created = await signup(early, "Harbor");
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

    // No welcome chat, because this server does not name one.
    const list = await request(
      early,
      "GET",
      `/v1/operator/workspaces/${created.workspaceId}/conversations?status=open`,
      { cookie: created.cookie },
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ conversations: [] });
    expect(
      await owner.select().from(event).where(eq(event.workspaceId, created.workspaceId)),
    ).toEqual([]);

    expect(welcomes()).toEqual([
      { to: created.email, subject: "Harbor is ready", text: expect.any(String) },
    ]);
    // The link proved this address before the operator typed these names, so they are safe here.
    // Only steps that work in a workspace that waits for the cloud: the widget does not run yet.
    expect(welcomes()[0]?.text).toBe(
      [
        "Hi Nora,",
        "Welcome to Dinghy! Your workspace Harbor is set up. Here's what to do next:",
        "- Invite your team from Settings, under Team.\n" +
          "- Turn on alerts there too, so you hear about new messages.",
        `Sign in any time at ${PUBLIC_URL}`,
        "Questions? Write to us at hello@dinghy.chat.",
        "Cheers,\nThe Dinghy team",
      ].join("\n\n"),
    );
  });

  test("the link alone makes a signed-in account with no name and no workspace, and no welcome", async () => {
    const email = `early-${randomUUID()}@example.com`;
    const cookie = await linkSignup(early, email);
    const me = await request(early, "GET", "/v1/operator/me", { cookie });
    expect(await me.json()).toMatchObject({ email, name: "", workspaces: [] });
    expect(welcomes()).toEqual([]);

    // Signing in later finds the same account, which can still finish its onboarding.
    const later = await request(early, "POST", "/v1/operator/workspaces", {
      cookie: await signIn(early, auth, email),
      body: { name: "Nora", workspaceName: "Later" },
    });
    expect(later.status).toBe(200);
    expect(welcomes().map((mail) => mail.to)).toEqual([email]);
  });

  test("an account deleted while its onboarding ran gets no name and no workspace", async () => {
    const email = `early-${randomUUID()}@example.com`;
    const cookie = await linkSignup(early, email);
    const [account] = await owner
      .select({ id: operator.id })
      .from(operator)
      .where(eq(operator.email, email));
    const operatorId = account?.id ?? "";
    const answer = await deletedDuring(owner, operatorId, () =>
      request(early, "POST", "/v1/operator/workspaces", {
        cookie,
        body: { name: "Nora", workspaceName: "Ghost" },
      }),
    );
    expect(answer.status).toBe(401);
    const [row] = await owner.select().from(operator).where(eq(operator.id, operatorId));
    expect(row?.name).toBe("Former team member");
    expect(
      await owner.select().from(workspaceMember).where(eq(workspaceMember.operatorId, operatorId)),
    ).toEqual([]);
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

  test("a known email signs in by link and adds a waiting workspace, with no second welcome", async () => {
    const first = await signup(early, "First");
    mails.length = 0;
    const again = await signup(early, "Second", first.email, true);
    expect(again.response.status).toBe(200);
    expect((await workspaceRow(again.workspaceId)).waitingSince).toBeInstanceOf(Date);
    const me = await request(early, "GET", "/v1/operator/me", { cookie: again.cookie });
    const body = (await me.json()) as { workspaces: { workspaceId: string }[] };
    expect(body.workspaces.map((one) => one.workspaceId).sort()).toEqual(
      [first.workspaceId, again.workspaceId].sort(),
    );
    expect(welcomes()).toEqual([]);
  });

  test("deleting the only workspace and making another sends no second welcome", async () => {
    const first = await signup(early, "Gone Soon");
    expect(welcomes()).toHaveLength(1);
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
    expect(welcomes()).toHaveLength(1);
  });

  test("two onboardings at once send one welcome", async () => {
    const email = `twice-${randomUUID()}@example.com`;
    const cookie = await linkSignup(early, email);
    const both = await Promise.all(
      ["One", "Two"].map((workspaceName) =>
        request(early, "POST", "/v1/operator/workspaces", {
          cookie,
          body: { name: "Nora", workspaceName },
        }),
      ),
    );
    expect(both.map((one) => one.status)).toEqual([200, 200]);
    expect(welcomes().map((mail) => mail.to)).toEqual([email]);
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
    const cookie = await signIn(strict, auth, email);
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

  test("without SMTP, signup says it cannot send email, for any address", async () => {
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
    const response = await askSignup(noMail, `early-${randomUUID()}@example.com`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "email_unavailable" } });
  });

  test("a failing mail server does not fail the answer", async () => {
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
    expect((await askSignup(broken, `early-${randomUUID()}@example.com`)).status).toBe(200);
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
        body: JSON.stringify({ email: "bad" }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("signup by link", () => {
  const operatorRow = async (email: string) =>
    (await owner.select().from(operator).where(eq(operator.email, email)))[0];

  test("a new and a known email get the same answer, and no account exists before the link", async () => {
    const known = `known-${randomUUID()}@example.com`;
    await linkSignup(early, known);
    const fresh = `fresh-${randomUUID()}@example.com`;
    const answers = [await askSignup(early, fresh), await askSignup(early, known)];
    expect(answers.map((one) => one.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(answers.map((one) => one.text()));
    expect(first).toBe(JSON.stringify({ ok: true }));
    expect(second).toBe(first);
    expect(answers.flatMap((one) => one.headers.getSetCookie())).toEqual([]);
    await linkFor(fresh, "Finish signing up for Dinghy");
    expect(await operatorRow(fresh)).toBeUndefined();
  });

  test("a new email's link creates a proven account with no name, signs in, and onboarding follows", async () => {
    const email = `new-${randomUUID()}@example.com`;
    await askSignup(early, email);
    const link = await linkFor(email, "Finish signing up for Dinghy");
    const sent = mails.find((mail) => mail.to === email);
    expect(sent?.text.startsWith("Hi,\n\n")).toBe(true);
    expect(sent?.text).toContain("15 minutes");
    expect(sent?.text.endsWith("\n\nCheers,\nThe Dinghy team")).toBe(true);
    // Its page's button says "Continue setting up".
    expect(link.startsWith(`${ORIGIN}/link?for=signup&token=`)).toBe(true);
    const cookie = await openSignInLink(early, link);
    expect(await operatorRow(email)).toMatchObject({ name: "", emailVerified: true });
    const created = await request(early, "POST", "/v1/operator/workspaces", {
      cookie,
      body: { name: "Nora", workspaceName: "Proven" },
    });
    expect(created.status).toBe(200);
  });

  test("an unknown email on the sign-in page gets a note with the signup page, and no link", async () => {
    const email = `lost-${randomUUID()}@example.com`;
    const asked = await request(early, "POST", "/v1/auth/sign-in/magic-link", { body: { email } });
    expect(asked.status).toBe(200);
    expect(await linkFor(email, "You don't have a Dinghy account yet")).toBe(`${ORIGIN}/signup`);
    expect(await operatorRow(email)).toBeUndefined();
  });

  test("a known email gets a sign-in link to the same account, with a note about the attempt", async () => {
    const email = `taken-${randomUUID()}@example.com`;
    await linkSignup(early, email);
    const { id } = (await operatorRow(email)) ?? { id: "" };
    mails.length = 0;
    await askSignup(early, email);
    const link = await linkFor(email, "Your Dinghy sign-in link");
    const sent = mails.find((mail) => mail.to === email);
    expect(sent?.text).toContain("tried to sign up for Dinghy with this email");
    expect(sent?.text).toContain("15 minutes");
    expect(sent?.text.startsWith("Hi,\n\n")).toBe(true);
    // It signs in, then lands on the workspace setup.
    expect(link.startsWith(`${ORIGIN}/link?for=add-workspace&token=`)).toBe(true);
    const cookie = await openSignInLink(early, link);
    const me = await request(early, "GET", "/v1/operator/me", { cookie });
    expect(await me.json()).toMatchObject({ id, email });
  });

  test("an account gets at most 5 links an hour from one address", async () => {
    const email = `limited-${randomUUID()}@example.com`;
    const from = newIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await askSignup(early, email, from)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
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
    const conversationId = await visitorConversation(created.workspaceId);

    expect((await as("GET", "")).status).toBe(200);
    expect((await as("GET", `/conversations/${conversationId}/messages`)).status).toBe(200);
    const reply = await as("POST", `/conversations/${conversationId}/messages`, {
      clientId: "reply-1",
      body: "Thanks!",
    });
    expect(reply.status).toBe(201);
    expect(
      (await as("PATCH", `/conversations/${conversationId}`, { status: "closed" })).status,
    ).toBe(200);
    expect((await as("GET", "/settings")).status).toBe(200);
    expect((await as("PATCH", "/settings", { allowedOrigins: [SITE] })).status).toBe(200);
    expect((await as("GET", "/members")).status).toBe(200);
    const invited = { email: "invited@example.com", role: "member" };
    expect((await as("POST", "/invites", invited)).status).toBe(201);
    expect((await as("GET", "/alerts")).status).toBe(200);
    expect((await as("PATCH", "/alerts", { email: true })).status).toBe(200);
    expect((await as("GET", "/export")).status).toBe(200);
    expect((await as("DELETE", `/conversations/${conversationId}`)).status).toBe(200);
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
    await runLifecycle({
      db: workerDb,
      billing,
      logger,
      mailer,
      publicUrl: PUBLIC_URL,
      secret: AUTH_SECRET,
    });
    expect(await workspaceRow(created.workspaceId)).toEqual(before);
    expect(mails).toEqual([]);
  });

  test("chat signups lists its owner as CSV", async () => {
    const created = await signup(early, '=Danger, "Quoted"');
    // An account that has not created its workspace yet is not listed.
    const unfinished = `early-${randomUUID()}@example.com`;
    await linkSignup(early, unfinished);
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
    const output = await runCli(["signups"]);
    expect(output.code).toBe(0);
    expect(output.stdout).toBe(csv);
  });
});

describe("a self-hosted install with neither setting", () => {
  test("has no signup and no onboarding", async () => {
    const meta = await (await selfHosted.request("/v1/meta")).json();
    expect(meta).toMatchObject({ billing: false, signup: null });
    const response = await request(selfHosted, "POST", "/v1/signup", {
      body: { email: `x-${randomUUID()}@example.com` },
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
    expect(welcomes()).toEqual([]);
    const inbox = await request(
      paying,
      "GET",
      `/v1/operator/workspaces/${created.workspaceId}/conversations?status=open`,
      { cookie: created.cookie },
    );
    expect(inbox.status).toBe(402);
  });

  test("an owner who never paid deletes the workspace, then the account", async () => {
    const created = await signup(paying);
    const deleteAccount = () =>
      request(paying, "POST", "/v1/operator/account/delete", { cookie: created.cookie, body: {} });
    expect((await deleteAccount()).status).toBe(409);
    const deleted = await request(
      paying,
      "DELETE",
      `/v1/operator/workspaces/${created.workspaceId}`,
      {
        cookie: created.cookie,
        body: { name: "Acme" },
      },
    );
    expect(deleted.status).toBe(200);
    expect((await workspaceRow(created.workspaceId)).deletedAt).not.toBeNull();

    expect((await deleteAccount()).status).toBe(200);
    const link = await linkFor(
      created.email,
      "Confirm that you want to delete your Dinghy account",
    );
    expect((await pressLinkButton(paying, link)).status).toBe(200);
    const [row] = await owner.select().from(operator).where(eq(operator.email, created.email));
    expect(row).toBeUndefined();
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
  test(
    "chat free turns a waiting workspace on with no subscription, for good",
    async () => {
      const created = await signup(early);
      const base = `/v1/operator/workspaces/${created.workspaceId}`;
      await owner
        .update(workspace)
        .set({ allowedOrigins: [SITE] })
        .where(eq(workspace.id, created.workspaceId));
      const { publicKey } = await workspaceRow(created.workspaceId);

      const freed = await runCli(["free", created.workspaceId]);
      expect(freed.code).toBe(0);
      expect(await workspaceRow(created.workspaceId)).toMatchObject({
        active: true,
        waitingSince: null,
      });
      expect(await widgetWorkspace(db, publicKey)).not.toBeNull();
      expect((await visitorsFrom(paying, publicKey)).status).toBe(201);
      const billing = await request(paying, "GET", `${base}/billing`, { cookie: created.cookie });
      expect(await billing.json()).toMatchObject({ state: "free", date: null });
      // Open inboxes hear about it from the feed.
      const [last] = await owner
        .select({ kind: event.kind })
        .from(event)
        .where(eq(event.workspaceId, created.workspaceId))
        .orderBy(desc(event.seq))
        .limit(1);
      expect(last?.kind).toBe("billing.changed");

      // Far past every deadline, the lifecycle worker leaves it on.
      const before = await workspaceRow(created.workspaceId);
      const far = new Date(Date.now() + 400 * DAY_MS);
      await runLifecycle({
        db: workerDb,
        billing: createBilling(
          {
            secretKey: STRIPE_SECRET_KEY,
            webhookSecret: STRIPE_WEBHOOK_SECRET,
            priceId: STRIPE_PRICE_ID,
            apiBase: stripe.apiBase,
            now: () => far,
          },
          workerDb,
          logger,
        ),
        logger,
        mailer,
        publicUrl: PUBLIC_URL,
        secret: AUTH_SECRET,
      });
      expect(await workspaceRow(created.workspaceId)).toEqual(before);
    },
    CLI_TEST_MS,
  );

  test(
    "chat free refuses a workspace with a subscription, and an unknown one",
    async () => {
      const created = await signup(early);
      await owner
        .insert(subscription)
        .values({ workspaceId: created.workspaceId, stripeCustomerId: "cus_free_test" });
      const refused = await runCli(["free", created.workspaceId]);
      expect(refused.code).toBe(1);
      expect((await workspaceRow(created.workspaceId)).active).toBe(false);
      expect((await runCli(["free", randomUUID()])).code).toBe(1);
      expect((await runCli(["free", "not-an-id"])).code).toBe(2);
    },
    CLI_TEST_MS,
  );
});
