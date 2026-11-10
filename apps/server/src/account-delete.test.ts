import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { addOperator, captureMail, openLink, pressLinkButton, signIn } from "../test/operators.ts";
import { FORMER_MEMBER_NAME } from "./account-delete.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth, signInLink } from "./auth.ts";
import {
  account,
  event,
  operator,
  pushSubscription,
  session,
  verification,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import type { Live } from "./live.ts";
import { appendMessage } from "./messages.ts";
import { createWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const lines: Record<string, unknown>[] = [];
const logger = pino(
  { level: "info" },
  {
    write: (line: string) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.msg === "audit") lines.push(parsed);
    },
  },
);
const audits = (event: string, operatorId: string) =>
  lines.filter((line) => line.event === event && line.operatorId === operatorId);
const ok = async () => {};
const wakes: string[] = [];
const live: Live = {
  wake(workspaceId) {
    wakes.push(workspaceId);
  },
  revoke() {},
  async subscribe() {
    return () => {};
  },
  stop() {},
};

let database: TestDatabase;
let db: Database;
let owner: Database;
let valkey: Redis;
let auth: Auth;
/** The server with a mail server, which confirms by email. */
let app: App;
/** The same server with no mail server, which confirms with the typed email. */
let noMailApp: App;
const mail = captureMail();

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await new Promise((resolve) => valkey.once("ready", resolve));
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const options = { auth, db, logger, live, valkey, checks: { postgres: ok, valkey: ok } };
  app = createApp({ ...options, mailer: mail });
  noMailApp = createApp(options);
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await database.drop();
});

interface Person {
  id: string;
  email: string;
  cookie: string;
}

async function person(workspaceId: string, role: "owner" | "admin" | "member"): Promise<Person> {
  const email = `op-${randomUUID()}@example.com`;
  const { id } = await addOperator({ auth, owner, email, name: "Robin", workspaceId, role });
  return { id, email, cookie: await signIn(app, auth, email) };
}

const askDelete = (as: Person, body: unknown = {}, server = app) =>
  server.request("/v1/operator/account/delete", {
    method: "POST",
    headers: { cookie: as.cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const me = (as: Person) => app.request("/v1/operator/me", { headers: { cookie: as.cookie } });

/** Asks for a delete link and returns it, from the email. */
async function deleteLink(as: Person): Promise<string> {
  const before = mail.countTo(as.email);
  const response = await askDelete(as);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deleted: false });
  return mail.linkTo(as.email, before);
}

const operatorRow = async (id: string) =>
  (await owner.select().from(operator).where(eq(operator.id, id)))[0];

/** A team with two owners, so either one may delete their account. */
async function team() {
  const space = await createWorkspace(db, "Harbor", []);
  return { space, first: await person(space.id, "owner"), second: await person(space.id, "owner") };
}

describe("a sole owner", () => {
  test("cannot delete their account until someone else is an owner", async () => {
    const space = await createWorkspace(db, "Solo", []);
    const solo = await person(space.id, "owner");
    const mine = (await (await me(solo)).json()) as { workspaces: { soleOwner: boolean }[] };
    expect(mine.workspaces).toMatchObject([{ soleOwner: true }]);
    const refused = await askDelete(solo);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: "sole_owner", workspaceIds: [space.id] },
    });
    expect(mail.countTo(solo.email)).toBe(0);

    const helper = await person(space.id, "member");
    await owner
      .update(workspaceMember)
      .set({ role: "owner" })
      .where(eq(workspaceMember.operatorId, helper.id));
    const after = (await (await me(solo)).json()) as { workspaces: { soleOwner: boolean }[] };
    expect(after.workspaces).toMatchObject([{ soleOwner: false }]);
    expect((await askDelete(solo)).status).toBe(200);
  });

  test("whose co-owner left after the email cannot use the link until they hand over", async () => {
    const { space, first, second } = await team();
    const link = await deleteLink(first);
    await owner
      .update(workspaceMember)
      .set({ removedAt: new Date() })
      .where(eq(workspaceMember.operatorId, second.id));
    const refused = await pressLinkButton(app, link);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { workspaceIds: [space.id] } });
    expect(await operatorRow(first.id)).toMatchObject({ deletedAt: null, email: first.email });
    // Nothing changed, so the workspace still has its owner.
    expect((await me(first)).status).toBe(200);
  });
});

describe("the email link", () => {
  test("deletes the account once, and keeps the history it wrote", async () => {
    const { space, first, second } = await team();
    const visitorId = randomUUID();
    await owner.execute(
      sql`insert into visitor (workspace_id, id, token_hash) values (${space.id}, ${visitorId}, ${randomUUID()})`,
    );
    const conversationId = await withWorkspace(db, space.id, async (tx) => {
      const asked = await appendMessage(
        tx,
        space.id,
        { kind: "visitor", visitorId },
        { clientId: randomUUID(), body: "Hello" },
      );
      const { conversationId } = asked.message;
      await appendMessage(
        tx,
        space.id,
        { kind: "operator", operatorId: first.id, conversationId },
        { clientId: randomUUID(), body: "Hi, how can I help?" },
      );
      return conversationId;
    });
    await owner.insert(pushSubscription).values({
      operatorId: first.id,
      endpoint: `https://push.example.com/${first.id}`,
      p256dh: "key",
      auth: "secret",
    });
    // A sign-in link sent before the delete, which must not make a new account after it.
    const oldSignIn = await signInLink(auth, first.email, "sign-in", "email");

    const link = await deleteLink(first);
    expect(mail.sent.at(-1)?.text).toContain("delete your Dinghy account");
    // Opening the page uses nothing, so a mail scanner cannot delete an account.
    await openLink(app, link);
    expect(await operatorRow(first.id)).toMatchObject({ deletedAt: null });
    wakes.length = 0;
    const done = await pressLinkButton(app, link);
    expect(done.status).toBe(200);

    const row = await operatorRow(first.id);
    expect(row).toMatchObject({
      name: FORMER_MEMBER_NAME,
      email: `deleted-${first.id}@invalid`,
      image: null,
    });
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await owner.select().from(session).where(eq(session.userId, first.id))).toEqual([]);
    expect(await owner.select().from(account).where(eq(account.userId, first.id))).toEqual([]);
    expect(
      await owner.select().from(pushSubscription).where(eq(pushSubscription.operatorId, first.id)),
    ).toEqual([]);
    expect((await me(first)).status).toBe(401);
    const [membership] = await owner
      .select()
      .from(workspaceMember)
      .where(eq(workspaceMember.operatorId, first.id));
    expect(membership?.removedAt).toBeInstanceOf(Date);
    expect(wakes).toContain(space.id);
    const changes = await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.kind, "team.changed")));
    expect(changes.length).toBeGreaterThan(0);
    expect(audits("account.deleted", first.id)).toHaveLength(1);
    expect(audits("member.removed", first.id)).toHaveLength(1);

    // The reply stays, from a former team member.
    const thread = await app.request(
      `/v1/operator/workspaces/${space.id}/conversations/${conversationId}/messages`,
      { headers: { cookie: second.cookie } },
    );
    const { messages } = (await thread.json()) as {
      messages: { body: string | null; authorName: string | null }[];
    };
    expect(messages.find((one) => one.body === "Hi, how can I help?")?.authorName).toBe(
      FORMER_MEMBER_NAME,
    );

    expect((await pressLinkButton(app, link)).status).toBe(400);
    expect((await pressLinkButton(app, oldSignIn)).status).toBe(400);
    const accounts = await owner.select().from(operator).where(eq(operator.email, first.email));
    expect(accounts).toEqual([]);
  });

  test("the same email can make a new account after", async () => {
    const { first } = await team();
    expect((await pressLinkButton(app, await deleteLink(first))).status).toBe(200);
    const again = await addOperator({ auth, owner, email: first.email });
    expect(again.id).not.toBe(first.id);
    expect((await me({ ...again, cookie: await signIn(app, auth, first.email) })).status).toBe(200);
  });

  test("an expired link deletes nothing", async () => {
    const { first } = await team();
    const link = await deleteLink(first);
    await owner
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(verification.identifier, "account-delete:%"));
    const refused = await pressLinkButton(app, link);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "link_invalid" } });
    expect(await operatorRow(first.id)).toMatchObject({ deletedAt: null });
  });

  test("a link from another site is refused", async () => {
    const { first } = await team();
    const token = new URL(await deleteLink(first)).searchParams.get("token");
    const response = await app.request("/v1/account/delete", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(403);
    expect(await operatorRow(first.id)).toMatchObject({ deletedAt: null });
  });

  test("asking is rate-limited", async () => {
    const { first } = await team();
    for (let sent = 0; sent < 5; sent += 1) expect((await askDelete(first)).status).toBe(200);
    expect((await askDelete(first)).status).toBe(429);
  });
});

describe("a server with no mail server", () => {
  test("deletes the account when the operator types its email", async () => {
    const { first } = await team();
    const wrong = await askDelete(first, { email: "someone@example.com" }, noMailApp);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: { code: "email_mismatch" } });
    expect(await operatorRow(first.id)).toMatchObject({ deletedAt: null });

    const done = await askDelete(first, { email: first.email.toUpperCase() }, noMailApp);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ deleted: true });
    expect(await operatorRow(first.id)).toMatchObject({ name: FORMER_MEMBER_NAME });
    expect((await me(first)).status).toBe(401);
  });
});
