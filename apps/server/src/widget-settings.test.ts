import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WIDGET_DEFAULTS } from "../../../packages/widget/src/shared.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { keySends } from "../test/keys.ts";
import { sendOperatorMessage } from "../test/messages.ts";
import { addOperator, signedInOperator } from "../test/operators.ts";
import { FORMER_MEMBER_NAME } from "./account-delete.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import {
  operator,
  operatorPicture,
  widgetSettings,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { visitorAuthorId } from "./identity.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });

// What the form saves: the widget's defaults without the logo and the faces, with no chosen member.
const { logoUrl: _logo, team: _team, faces: _faces, ...WIDGET_SETTINGS } = WIDGET_DEFAULTS;
const DEFAULTS = { ...WIDGET_SETTINGS, headerMembers: [] };

const CHANGED = {
  title: "Ask Acme",
  greeting: "Ask us anything.",
  away: "We are asleep.",
  primary: "#112233",
  accent: "#1F6BFF",
  position: "left",
  theme: "dark",
  launcher: "bubble",
  mascot: false,
  radius: 4,
  emailAsk: "before_first",
  branding: false,
  sound: false,
  transcript: false,
  headerFaces: "repliers",
  headerFaceCount: 5,
  headerDot: false,
  headerStatus: "reply_time",
  headerMembers: [],
};

const SOME_ID = randomUUID();

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
const ok = async () => {};

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({
    db,
    logger,
    auth,
    publicUrl: PUBLIC_URL,
    checks: { postgres: ok, valkey: ok },
  });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

/** A new workspace and its signed-in owner. */
async function workspaceWithOwner(name = "Acme") {
  const space = await createWorkspace(db, name, [SITE]);
  const boss = await signedInOperator({ app, auth, owner, workspaceId: space.id });
  return { space, boss };
}

const settingsPath = (space: NewWorkspace) => `/v1/operator/workspaces/${space.id}/widget`;

const saveSettings = (space: NewWorkspace, cookie: string, body: unknown) =>
  app.request(settingsPath(space), {
    method: "PUT",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const appearance = (space: NewWorkspace, headers: Record<string, string> = {}) =>
  app.request(`/v1/widget/${space.publicKey}/appearance`, {
    headers: { origin: "https://another.example", ...headers },
  });

describe("the widget's settings", () => {
  test("a new workspace starts with the defaults, and a member reads them", async () => {
    const { space } = await workspaceWithOwner();
    const member = await signedInOperator({
      app,
      auth,
      owner,
      workspaceId: space.id,
      role: "member",
    });
    const response = await app.request(settingsPath(space), { headers: { cookie: member.cookie } });
    expect(response.status).toBe(200);
    // The database's defaults are the ones the widget falls back to with no answer. Online now
    // lists every member as a face it may show.
    expect(await response.json()).toEqual({
      ...WIDGET_DEFAULTS,
      headerMembers: [],
      faces: expect.arrayContaining([expect.objectContaining({ id: visitorAuthorId(member.id) })]),
    });
  });

  test("an owner saves every value, and a color is kept in lower case", async () => {
    const { space, boss } = await workspaceWithOwner();
    const response = await saveSettings(space, boss.cookie, CHANGED);
    expect(response.status).toBe(200);
    const expected = {
      ...CHANGED,
      accent: "#1f6bff",
      typingPreview: true,
      logoUrl: null,
      team: [],
      faces: [],
    };
    expect(await response.json()).toEqual(expected);
    const read = await app.request(settingsPath(space), { headers: { cookie: boss.cookie } });
    expect(await read.json()).toEqual(expected);
  });

  test.each([
    ["a radius over 24", { radius: 25 }],
    ["a negative radius", { radius: -1 }],
    ["a radius that is not whole", { radius: 1.5 }],
    ["a color name", { primary: "red" }],
    ["a short hex color", { accent: "#123" }],
    ["an unknown side", { position: "top" }],
    ["an unknown theme", { theme: "sepia" }],
    ["an unknown launcher", { launcher: "none" }],
    ["an unknown email ask", { emailAsk: "always" }],
    ["a title over 40 characters", { title: "x".repeat(41) }],
    ["a greeting over 200 characters", { greeting: "x".repeat(201) }],
    ["a blank text", { away: "   " }],
    ["a control character", { title: "a\u0000b" }],
    ["a missing value", { branding: undefined }],
    ["no faces", { headerFaceCount: 0 }],
    ["over 5 faces", { headerFaceCount: 6 }],
    ["an unknown faces mode", { headerFaces: "everyone" }],
    ["an unknown status line", { headerStatus: "busy" }],
    ["a member chosen twice", { headerMembers: [SOME_ID, SOME_ID] }],
    ["a chosen member that is not an ID", { headerMembers: ["maya"] }],
  ])("%s is refused, and nothing changes", async (_name, change) => {
    const { space, boss } = await workspaceWithOwner();
    const response = await saveSettings(space, boss.cookie, { ...DEFAULTS, ...change });
    expect(response.status).toBe(400);
    const [row] = await owner
      .select({ radius: widgetSettings.radius })
      .from(widgetSettings)
      .where(eq(widgetSettings.workspaceId, space.id));
    expect(row?.radius).toBe(16);
  });

  test("a member cannot change them, nor the logo", async () => {
    const { space } = await workspaceWithOwner();
    const member = await signedInOperator({
      app,
      auth,
      owner,
      workspaceId: space.id,
      role: "member",
    });
    expect((await saveSettings(space, member.cookie, CHANGED)).status).toBe(403);
    for (const method of ["PUT", "DELETE"]) {
      const logo = await app.request(`${settingsPath(space)}/logo`, {
        method,
        headers: { cookie: member.cookie, origin: ORIGIN },
        body: method === "PUT" ? new Uint8Array([1, 2, 3]) : null,
      });
      expect(logo.status).toBe(403);
    }
    const read = await app.request(settingsPath(space), { headers: { cookie: member.cookie } });
    expect(await read.json()).toMatchObject(DEFAULTS);
  });

  test("an API key can neither read nor change them", async () => {
    const { space, boss } = await workspaceWithOwner();
    const made = await app.request(`/v1/operator/workspaces/${space.id}/api-keys`, {
      method: "POST",
      headers: { cookie: boss.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bot" }),
    });
    const { token } = (await made.json()) as { token: string };
    const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await app.request(settingsPath(space), { headers: bearer })).status).toBe(403);
    const put = await app.request(settingsPath(space), {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify(CHANGED),
    });
    expect(put.status).toBe(403);
  });

  test("row-level security shows and changes only the workspace's own row", async () => {
    const { space: mine } = await workspaceWithOwner("Mine");
    const { space: theirs } = await workspaceWithOwner("Theirs");
    const rows = await withWorkspace(db, mine.id, async (tx) => {
      // No filter on purpose: the policy alone decides what this sees and changes.
      await tx.update(widgetSettings).set({ title: "Changed in mine" });
      return tx.select({ workspaceId: widgetSettings.workspaceId }).from(widgetSettings);
    });
    expect(rows).toEqual([{ workspaceId: mine.id }]);
    const [other] = await owner
      .select({ title: widgetSettings.title })
      .from(widgetSettings)
      .where(eq(widgetSettings.workspaceId, theirs.id));
    expect(other?.title).toBeNull();
  });
});

describe("the widget's appearance", () => {
  test("any site reads it, cached for 5 minutes, and a matching ETag answers 304", async () => {
    const { space, boss } = await workspaceWithOwner();
    const first = await appearance(space);
    expect(first.status).toBe(200);
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    expect(first.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await first.json()).toEqual({ ...WIDGET_DEFAULTS, faces: expect.any(Array) });
    const tag = first.headers.get("etag") ?? "";
    expect(tag).not.toBe("");

    const same = await appearance(space, { "if-none-match": tag });
    expect(same.status).toBe(304);
    expect(same.headers.get("access-control-allow-origin")).toBe("*");

    await saveSettings(space, boss.cookie, CHANGED);
    const changed = await appearance(space, { "if-none-match": tag });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ launcher: "bubble", accent: "#1f6bff" });
  });

  test.each([
    ["waits for its first payment", { active: false }],
    ["waits for the cloud to open", { active: false, waitingSince: new Date() }],
    ["is suspended", { suspendedAt: new Date() }],
    ["was deleted", { deletedAt: new Date() }],
  ])("a workspace that %s answers 404", async (_state, change) => {
    const { space } = await workspaceWithOwner();
    await owner.update(workspace).set(change).where(eq(workspace.id, space.id));
    const response = await appearance(space);
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("a read-only workspace, and an unknown or malformed key, answer 404", async () => {
    const { space } = await workspaceWithOwner();
    await owner.execute(
      sql`insert into subscription (workspace_id, stripe_customer_id, read_only_at) values (${space.id}, 'cus_test', now())`,
    );
    expect((await appearance(space)).status).toBe(404);
    const unknown = { ...space, publicKey: `wk_${"0".repeat(32)}` };
    expect((await appearance(unknown)).status).toBe(404);
    expect((await appearance({ ...space, publicKey: "not-a-key" })).status).toBe(404);
  });

  test("the team is the members who replied last, by first name, never an email", async () => {
    const { space } = await workspaceWithOwner();
    const names = ["Maya Chen", "Sam Diaz", "Ana Ruiz", "Lee Park"];
    const team = await Promise.all(
      names.map((name) =>
        addOperator({ auth, owner, name, workspaceId: space.id, role: "member" }),
      ),
    );
    const [maya, sam, ana, lee] = team;
    if (maya === undefined || sam === undefined || ana === undefined || lee === undefined) {
      throw new Error("The team is missing");
    }
    await owner
      .update(operator)
      .set({ pictureUpdatedAt: new Date(1_800_000_000_000) })
      .where(eq(operator.id, ana.id));
    const { conversationId } = await visitorWrites(space);
    for (const one of [maya, sam, ana, lee, maya]) await reply(space, one.id, conversationId);
    // A member who left is not on the team any more.
    await owner
      .update(workspaceMember)
      .set({ removedAt: new Date() })
      .where(eq(workspaceMember.operatorId, lee.id));
    const response = await appearance(space);
    const text = await response.text();
    expect(JSON.parse(text).team).toEqual([
      { id: visitorAuthorId(maya.id), name: "Maya", pictureUrl: null },
      {
        id: visitorAuthorId(ana.id),
        name: "Ana",
        pictureUrl: `${PUBLIC_URL}/v1/pictures/${ana.id}?v=1800000000000`,
      },
      { id: visitorAuthorId(sam.id), name: "Sam", pictureUrl: null },
    ]);
    expect(text).not.toContain("@");
  });
});

describe("the header's faces", () => {
  /** Maya and Sam replied, Sam last. Ana never did. */
  async function teamOfThree() {
    const { space, boss } = await workspaceWithOwner();
    const [maya, sam, ana] = await Promise.all(
      ["Maya Chen", "Sam Diaz", "Ana Ruiz"].map((name) =>
        addOperator({ auth, owner, name, workspaceId: space.id, role: "member" }),
      ),
    );
    if (maya === undefined || sam === undefined || ana === undefined) {
      throw new Error("The team is missing");
    }
    const { conversationId } = await visitorWrites(space);
    for (const one of [maya, sam]) await reply(space, one.id, conversationId);
    return { space, boss, maya, sam, ana };
  }
  const ids = (faces: { id: string }[]) => faces.map((face) => face.id);

  test("Online now offers every member, the latest repliers first", async () => {
    const { space, boss, maya, sam, ana } = await teamOfThree();
    const body = await (await appearance(space)).json();
    expect(ids(body.faces).slice(0, 2)).toEqual([sam, maya].map((one) => visitorAuthorId(one.id)));
    expect(ids(body.faces).sort()).toEqual(
      [boss, maya, sam, ana].map((one) => visitorAuthorId(one.id)).sort(),
    );
    // The fallback when nobody is online.
    expect(ids(body.team)).toEqual([sam, maya].map((one) => visitorAuthorId(one.id)));
  });

  test("chosen members keep their order, a removed one is skipped, and no site sees an ID", async () => {
    const { space, boss, maya, sam, ana } = await teamOfThree();
    const chosen = { ...DEFAULTS, headerFaces: "chosen", headerMembers: [ana.id, maya.id, sam.id] };
    expect((await saveSettings(space, boss.cookie, chosen)).status).toBe(200);
    await owner
      .update(workspaceMember)
      .set({ removedAt: new Date() })
      .where(eq(workspaceMember.operatorId, maya.id));
    const read = await app.request(settingsPath(space), { headers: { cookie: boss.cookie } });
    expect((await read.json()).headerMembers).toEqual([ana.id, sam.id]);
    const text = await (await appearance(space)).text();
    expect(ids(JSON.parse(text).faces)).toEqual([ana, sam].map((one) => visitorAuthorId(one.id)));
    expect(text).not.toContain("headerMembers");
    expect(text).not.toContain(ana.id);
  });

  test("Online now offers a member who never replied, past the first five", async () => {
    const { space } = await teamOfThree();
    const added = await Promise.all(
      ["Kim", "Lou", "Max"].map((name) =>
        addOperator({ auth, owner, name, workspaceId: space.id, role: "member" }),
      ),
    );
    const faces = ids((await (await appearance(space)).json()).faces);
    expect(faces).toHaveLength(7);
    for (const one of added) expect(faces).toContain(visitorAuthorId(one.id));
  });

  test("Latest repliers offers the team's latest repliers, and None nobody", async () => {
    const { space, boss, maya, sam } = await teamOfThree();
    await saveSettings(space, boss.cookie, { ...DEFAULTS, headerFaces: "repliers" });
    expect(ids((await (await appearance(space)).json()).faces)).toEqual(
      [sam, maya].map((one) => visitorAuthorId(one.id)),
    );
    await saveSettings(space, boss.cookie, { ...DEFAULTS, headerFaces: "none" });
    expect((await (await appearance(space)).json()).faces).toEqual([]);
  });

  test("the usual reply time comes with the presence answer, only when it shows and someone is online", async () => {
    const valkey = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
    const live = createApp({ db, logger, auth, valkey, checks: { postgres: ok, valkey: ok } });
    try {
      const { space, boss } = await workspaceWithOwner();
      const { conversationId } = await visitorWrites(space);
      await reply(space, boss.id, conversationId);
      // The visitor wrote 2 minutes before the reply.
      await owner.execute(
        sql`update conversation set created_at = created_at - interval '2 minutes' where id = ${conversationId}`,
      );
      const replySeconds = async () =>
        (
          await (
            await live.request(`/v1/widget/${space.publicKey}/presence`, {
              headers: { origin: SITE },
            })
          ).json()
        ).replySeconds;
      await saveSettings(space, boss.cookie, { ...DEFAULTS, headerStatus: "reply_time" });
      expect(await replySeconds()).toBeNull();
      await live.request(`/v1/operator/workspaces/${space.id}/presence`, {
        method: "PUT",
        headers: { cookie: boss.cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ viewing: null, left: null, hidden: false }),
      });
      const seconds = await replySeconds();
      expect(seconds).toBeGreaterThanOrEqual(120);
      expect(seconds).toBeLessThan(130);
      await saveSettings(space, boss.cookie, DEFAULTS);
      expect(await replySeconds()).toBeNull();
      expect(await (await appearance(space)).text()).not.toContain("replySeconds");
    } finally {
      valkey.disconnect();
    }
  });
});

describe("a reply in the widget", () => {
  test("names its operator by first name and picture, and a key's reply is a bot's", async () => {
    const { space, boss } = await workspaceWithOwner();
    const maya = await addOperator({ auth, owner, name: "Maya Chen", workspaceId: space.id });
    await owner.insert(operatorPicture).values({ operatorId: maya.id, data: Buffer.from("x") });
    await owner
      .update(operator)
      .set({ pictureUpdatedAt: new Date(1_800_000_000_000) })
      .where(eq(operator.id, maya.id));
    const { token, conversationId } = await visitorWrites(space);
    await reply(space, maya.id, conversationId);
    const made = await app.request(`/v1/operator/workspaces/${space.id}/api-keys`, {
      method: "POST",
      headers: { cookie: boss.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Helper bot" }),
    });
    const key = (await made.json()) as { id: string; token: string };
    await keySends(owner, key.id);
    await app.request(
      `/v1/operator/workspaces/${space.id}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
        body: JSON.stringify({ clientId: "bot-1", body: "From the bot" }),
      },
    );

    const response = await app.request(`/v1/widget/${space.publicKey}/messages`, {
      headers: { origin: SITE, authorization: `Bearer ${token}` },
    });
    const { messages } = (await response.json()) as { messages: Record<string, unknown>[] };
    const authors = messages.map(({ fromBot, authorName, authorPictureUrl }) => ({
      fromBot,
      authorName,
      authorPictureUrl,
    }));
    expect(authors).toEqual([
      { fromBot: false, authorName: null, authorPictureUrl: null },
      {
        fromBot: false,
        authorName: "Maya",
        authorPictureUrl: `${PUBLIC_URL}/v1/pictures/${maya.id}?v=1800000000000`,
      },
      { fromBot: true, authorName: "Helper bot", authorPictureUrl: null },
    ]);
    // Each author has an ID of its own, which names neither the operator nor the key.
    const [visitorId, mayaId, botId] = messages.map((one) => one.authorId);
    expect(visitorId).toBeNull();
    expect(mayaId).toMatch(/^[0-9a-f]{16}$/);
    expect(botId).toMatch(/^[0-9a-f]{16}$/);
    expect(botId).not.toBe(mayaId);
    expect(JSON.stringify(messages)).not.toContain(key.id);
  });

  test("from a deleted account names a former team member in full, with no picture", async () => {
    const { space } = await workspaceWithOwner();
    const maya = await addOperator({ auth, owner, name: "Maya Chen", workspaceId: space.id });
    const { token, conversationId } = await visitorWrites(space);
    await reply(space, maya.id, conversationId);
    // What deleting the account leaves of the operator's row.
    await owner
      .update(operator)
      .set({ name: FORMER_MEMBER_NAME, pictureUpdatedAt: null, deletedAt: new Date() })
      .where(eq(operator.id, maya.id));

    const response = await app.request(`/v1/widget/${space.publicKey}/messages`, {
      headers: { origin: SITE, authorization: `Bearer ${token}` },
    });
    const { messages } = (await response.json()) as { messages: Record<string, unknown>[] };
    expect(messages.at(-1)).toMatchObject({
      authorName: FORMER_MEMBER_NAME,
      authorPictureUrl: null,
    });
  });
});

/** A visitor's first message, which starts a conversation. */
async function visitorWrites(space: NewWorkspace) {
  const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  const { token } = (await created.json()) as { token: string };
  const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
    method: "POST",
    headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ clientId: randomUUID(), body: "Hello?" }),
  });
  const { conversationId } = (await sent.json()) as { conversationId: string };
  return { token, conversationId };
}

/** A reply from `operatorId`, written as the inbox writes it. */
const reply = (space: NewWorkspace, operatorId: string, conversationId: string) =>
  sendOperatorMessage(db, space.id, operatorId, conversationId, `From ${operatorId}`);
