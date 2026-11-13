import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { setReplyMode } from "../test/keys.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, withKey } from "../test/requests.ts";
import { SITE, visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { apiKey, message, workspace } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { localStore } from "./storage.ts";
import { createUploads } from "./uploads.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
let valkey: Redis;
let a: NewWorkspace;
let b: NewWorkspace;
let ownerA: { id: string; cookie: string };
let agentA: { id: string; cookie: string };
let ownerB: { id: string; cookie: string };

const inA = (path = "") => `/v1/operator/workspaces/${a.id}${path}`;
const inB = (path = "") => `/v1/operator/workspaces/${b.id}${path}`;

async function makeKey(name: string, space = a, as = ownerA.cookie) {
  const response = await asOperator(
    app,
    as,
    "POST",
    `/v1/operator/workspaces/${space.id}/api-keys`,
    {
      name,
    },
  );
  expect(response.status).toBe(201);
  const made = (await response.json()) as { id: string; name: string; token: string };
  // A new key drafts. These tests are about what a key that sends can reach.
  await setReplyMode(owner, made.id, "send");
  return made;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  valkey = new Redis(VALKEY_URL, { lazyConnect: true });
  app = createApp({
    db,
    logger,
    auth,
    checks: { postgres: ok, valkey: ok },
    uploads: createUploads({
      store: localStore(await mkdtemp(join(tmpdir(), "dinghy-keys-"))),
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    }),
  });
  a = await createWorkspace(db, "Acme", [SITE]);
  b = await createWorkspace(db, "Beta", [SITE]);
  const person = async (workspaceId: string, name: string, role: "owner" | "member") => {
    const made = await signedInOperator({ app, auth, owner, name, workspaceId, role });
    return { id: made.id, cookie: made.cookie };
  };
  ownerA = await person(a.id, "Olivia", "owner");
  agentA = await person(a.id, "Abel", "member");
  ownerB = await person(b.id, "Bruno", "owner");
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await database.drop();
});

describe("managing keys", () => {
  test("an owner creates a key, sees its token once, lists and revokes it", async () => {
    const made = await makeKey("Support bot");
    expect(made.token).toMatch(new RegExp(`^dk_${a.id}\\.[A-Za-z0-9_-]{43}$`));
    const listed = await (await asOperator(app, ownerA.cookie, "GET", inA("/api-keys"))).json();
    const text = JSON.stringify(listed);
    expect(text).toContain("Support bot");
    expect(text).toContain("Olivia");
    expect(text).not.toContain(made.token);
    // Only the hash is stored.
    const [row] = await owner.select().from(apiKey).where(eq(apiKey.id, made.id));
    expect(row?.tokenHash).not.toContain(made.token);
    expect(
      (await asOperator(app, ownerA.cookie, "DELETE", inA(`/api-keys/${made.id}`))).status,
    ).toBe(200);
    const after = await (await asOperator(app, ownerA.cookie, "GET", inA("/api-keys"))).text();
    expect(after).not.toContain(made.id);
  });

  test("a member can neither see nor make keys", async () => {
    expect((await asOperator(app, agentA.cookie, "GET", inA("/api-keys"))).status).toBe(403);
    expect(
      (await asOperator(app, agentA.cookie, "POST", inA("/api-keys"), { name: "Mine" })).status,
    ).toBe(403);
    const made = await makeKey("Owned");
    expect(
      (await asOperator(app, agentA.cookie, "DELETE", inA(`/api-keys/${made.id}`))).status,
    ).toBe(403);
  });

  test("a key's name is one line of 1 to 60 characters", async () => {
    for (const name of ["", " ", "x".repeat(61), "two\nlines"]) {
      expect(
        (await asOperator(app, ownerA.cookie, "POST", inA("/api-keys"), { name })).status,
      ).toBe(400);
    }
    expect((await makeKey("x".repeat(60))).name).toHaveLength(60);
  });
});

describe("reply mode and changes", () => {
  test("a new key drafts unless told to send, and Settings shows it as a static key", async () => {
    const drafting = await makeKey("Drafter");
    expect(drafting).toMatchObject({ replyMode: "draft", source: "static", client: null });
    const made = await asOperator(app, ownerA.cookie, "POST", inA("/api-keys"), {
      name: "Sender",
      replyMode: "send",
    });
    expect(await made.json()).toMatchObject({ replyMode: "send" });
    const listed = (await (
      await asOperator(app, ownerA.cookie, "GET", inA("/api-keys"))
    ).json()) as {
      apiKeys: { name: string; replyMode: string; source: string }[];
    };
    expect(listed.apiKeys.find((key) => key.name === "Sender")).toMatchObject({
      replyMode: "send",
      source: "static",
    });
  });

  test("an owner changes a key's name, reply mode and level, and the key acts by them", async () => {
    const made = await makeKey("Changing");
    const path = inA(`/api-keys/${made.id}`);
    const changed = await asOperator(app, ownerA.cookie, "PATCH", path, {
      name: "Changed",
      replyMode: "send",
      level: "setup",
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      id: made.id,
      name: "Changed",
      replyMode: "send",
      level: "setup",
      createdByName: "Olivia",
    });
    expect((await withKey(app, made.token, "GET", inA("/webhooks"))).status).toBe(200);
    const [row] = await owner.select().from(apiKey).where(eq(apiKey.id, made.id));
    expect(row).toMatchObject({ name: "Changed", replyMode: "send", level: "setup" });
  });

  test("a change needs a field, an owner or admin, and a key that is not revoked", async () => {
    const made = await makeKey("Fixed");
    const path = inA(`/api-keys/${made.id}`);
    expect((await asOperator(app, ownerA.cookie, "PATCH", path, {})).status).toBe(400);
    expect(
      (await asOperator(app, ownerA.cookie, "PATCH", path, { replyMode: "shout" })).status,
    ).toBe(400);
    expect((await asOperator(app, agentA.cookie, "PATCH", path, { name: "Mine" })).status).toBe(
      403,
    );
    expect((await withKey(app, made.token, "PATCH", path, { name: "Mine" })).status).toBe(403);
    await asOperator(app, ownerA.cookie, "DELETE", path);
    expect((await asOperator(app, ownerA.cookie, "PATCH", path, { name: "Back" })).status).toBe(
      404,
    );
  });
});

describe("what a key can do", () => {
  test("it reads, searches, replies, closes, reopens and assigns in its own workspace", async () => {
    const key = await makeKey("Helper bot");
    const { conversationId } = await visitorStarts(app, a.publicKey, "Where is my parcel?");
    const list = (await (await withKey(app, key.token, "GET", inA("/conversations"))).json()) as {
      conversations: { id: string }[];
    };
    expect(list.conversations.map((one) => one.id)).toContain(conversationId);
    const found = await withKey(app, key.token, "GET", inA("/conversations/search?q=parcel"));
    expect(await found.text()).toContain(conversationId);

    const reply = { clientId: "bot-1", body: "It ships today." };
    const path = inA(`/conversations/${conversationId}/messages`);
    const sent = await withKey(app, key.token, "POST", path, reply);
    expect(sent.status).toBe(201);
    const written = (await sent.json()) as Record<string, unknown>;
    expect(written).toMatchObject({
      authorName: "Helper bot",
      authorApiKeyId: key.id,
      authorOperatorId: null,
      fromVisitor: false,
    });
    // A retry with the same client ID returns the first message.
    const again = await withKey(app, key.token, "POST", path, reply);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(written.id);

    const read = (await (await withKey(app, key.token, "GET", path)).json()) as {
      conversation: { assigneeOperatorId: string | null };
      messages: { body: string; authorName: string | null }[];
    };
    // A bot's reply never takes the conversation.
    expect(read.conversation.assigneeOperatorId).toBeNull();
    expect(read.messages.map((one) => [one.body, one.authorName])).toEqual([
      ["Where is my parcel?", null],
      ["It ships today.", "Helper bot"],
    ]);

    const conversation = inA(`/conversations/${conversationId}`);
    expect(
      (await withKey(app, key.token, "PATCH", conversation, { status: "closed" })).status,
    ).toBe(200);
    expect(
      (await withKey(app, key.token, "POST", path, { clientId: "bot-2", body: "x" })).status,
    ).toBe(409);
    expect((await withKey(app, key.token, "PATCH", conversation, { status: "open" })).status).toBe(
      200,
    );
    const assignee = inA(`/conversations/${conversationId}/assignee`);
    expect((await withKey(app, key.token, "PUT", assignee, { operatorId: ownerA.id })).status).toBe(
      200,
    );
    expect((await withKey(app, key.token, "PUT", assignee, { operatorId: ownerB.id })).status).toBe(
      400,
    );
  });

  test("it lists the unassigned conversations, and has none of its own", async () => {
    const key = await makeKey("Triage bot");
    const { conversationId } = await visitorStarts(app, a.publicKey, "Nobody has this yet");
    const unassigned = await withKey(app, key.token, "GET", inA("/conversations?assignee=none"));
    expect(unassigned.status).toBe(200);
    expect(await unassigned.text()).toContain(conversationId);
    const mine = await withKey(app, key.token, "GET", inA("/conversations?assignee=me"));
    expect(mine.status).toBe(400);
    expect(await mine.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  test("it sends an image under its own name", async () => {
    const key = await makeKey("Image bot");
    const { conversationId } = await visitorStarts(app, a.publicKey, "Show me");
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const response = await app.request(
      inA(`/conversations/${conversationId}/uploads?clientId=bot-image`),
      {
        method: "POST",
        headers: { authorization: `Bearer ${key.token}`, "content-type": "image/png" },
        body: png,
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ kind: "image", authorName: "Image bot" });
  });

  test("it needs no Origin, because a browser never sends a bearer header on its own", async () => {
    const key = await makeKey("Anywhere");
    const response = await app.request(inA("/conversations"), {
      headers: { authorization: `Bearer ${key.token}`, origin: "https://elsewhere.example" },
    });
    expect(response.status).toBe(200);
  });

  test("it never reaches settings, members, keys, webhooks, export, delete or the stream", async () => {
    const key = await makeKey("Limited");
    for (const [method, path, body] of [
      ["GET", inA("/settings"), undefined],
      ["PATCH", inA("/settings"), { allowedOrigins: [] }],
      ["POST", inA("/settings/rotate-secret"), {}],
      ["GET", inA("/members"), undefined],
      ["POST", inA("/invites"), { email: "invited@example.com", role: "member" }],
      ["GET", inA("/api-keys"), undefined],
      ["POST", inA("/api-keys"), { name: "More" }],
      ["DELETE", inA(`/api-keys/${key.id}`), undefined],
      ["GET", inA("/webhooks"), undefined],
      ["POST", inA("/webhooks"), { url: "https://93.184.215.14/x", events: ["message.created"] }],
      ["GET", inA("/stream"), undefined],
      ["DELETE", inA(""), { name: "Acme" }],
    ] as const) {
      const response = await withKey(app, key.token, method, path, body);
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }
    for (const path of ["/v1/operator/me", "/v1/operator/push-test"]) {
      expect((await withKey(app, key.token, "GET", path)).status).toBe(403);
    }
    const [row] = await owner.select().from(workspace).where(eq(workspace.id, a.id));
    expect(row?.deletedAt).toBeNull();
  });

  test("it does not exist in another workspace", async () => {
    const key = await makeKey("Here only");
    const { conversationId } = await visitorStarts(app, b.publicKey, "In the other one");
    expect((await withKey(app, key.token, "GET", inB("/conversations"))).status).toBe(404);
    const crossed = inB(`/conversations/${conversationId}/messages`);
    expect(
      (await withKey(app, key.token, "POST", crossed, { clientId: "x", body: "hi" })).status,
    ).toBe(404);
    // Its own workspace's path with the other's conversation finds nothing.
    const mixed = inA(`/conversations/${conversationId}/messages`);
    expect((await withKey(app, key.token, "GET", mixed)).status).toBe(404);
  });

  test("a revoked, unknown or altered key is refused", async () => {
    const key = await makeKey("Short-lived");
    expect((await withKey(app, key.token, "GET", inA("/conversations"))).status).toBe(200);
    await asOperator(app, ownerA.cookie, "DELETE", inA(`/api-keys/${key.id}`));
    expect((await withKey(app, key.token, "GET", inA("/conversations"))).status).toBe(401);
    expect((await withKey(app, "dk_nothing", "GET", inA("/conversations"))).status).toBe(401);
    const other = await makeKey("Kept");
    const altered = other.token.replace(a.id, b.id);
    expect((await withKey(app, altered, "GET", inB("/conversations"))).status).toBe(401);
  });

  test("a revoked key's replies keep its name", async () => {
    const key = await makeKey("Retired bot");
    const { conversationId } = await visitorStarts(app, a.publicKey, "Hello?");
    const path = inA(`/conversations/${conversationId}/messages`);
    await withKey(app, key.token, "POST", path, { clientId: "r1", body: "Hi there" });
    await asOperator(app, ownerA.cookie, "DELETE", inA(`/api-keys/${key.id}`));
    const read = (await (await asOperator(app, ownerA.cookie, "GET", path)).json()) as {
      messages: { authorName: string | null }[];
    };
    expect(read.messages.at(-1)?.authorName).toBe("Retired bot");
  });

  test("the visitor gets a key's reply as a bot's, unread, with its name and without its ID", async () => {
    const key = await makeKey("Helper bot");
    const { token, conversationId } = await visitorStarts(app, a.publicKey, "Anyone?");
    await withKey(app, key.token, "POST", inA(`/conversations/${conversationId}/messages`), {
      clientId: "w1",
      body: "Yes, here.",
    });
    const headers = { origin: SITE, authorization: `Bearer ${token}` };
    const listed = await app.request(`/v1/widget/${a.publicKey}/messages`, { headers });
    const text = await listed.text();
    expect(text).toContain("Yes, here.");
    expect(text).toContain('"fromBot":true,"authorName":"Helper bot","authorPictureUrl":null');
    expect(text).not.toContain(key.id);
    const me = (await (await app.request(`/v1/widget/${a.publicKey}/me`, { headers })).json()) as {
      unread: number;
    };
    expect(me.unread).toBe(1);
  });

  test("a key in a suspended workspace can read but not write", async () => {
    const space = await createWorkspace(db, "Paused", [SITE]);
    const boss = await signedInOperator({ app, auth, owner, name: "Pat", workspaceId: space.id });
    const key = await makeKey("Paused bot", space, boss.cookie);
    const { conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    await owner
      .update(workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(workspace.id, space.id));
    const base = `/v1/operator/workspaces/${space.id}`;
    expect((await withKey(app, key.token, "GET", `${base}/conversations`)).status).toBe(200);
    const reply = await withKey(
      app,
      key.token,
      "POST",
      `${base}/conversations/${conversationId}/messages`,
      {
        clientId: "p1",
        body: "Hello",
      },
    );
    expect(reply.status).toBe(403);
    expect(await reply.json()).toMatchObject({ error: { code: "suspended" } });
    const rows = await owner.select().from(message).where(eq(message.clientId, "p1"));
    expect(rows).toEqual([]);
    // The owner can still cut the key off while the workspace is closed.
    const revoked = await asOperator(app, boss.cookie, "DELETE", `${base}/api-keys/${key.id}`);
    expect(revoked.status).toBe(200);
    expect((await withKey(app, key.token, "GET", `${base}/conversations`)).status).toBe(401);
  });

  test("its last use is noted, at most once a minute", async () => {
    const key = await makeKey("Busy bot");
    const lastUsed = async () =>
      (await owner.select().from(apiKey).where(eq(apiKey.id, key.id)))[0]?.lastUsedAt ?? null;
    expect(await lastUsed()).toBeNull();
    await withKey(app, key.token, "GET", inA("/conversations"));
    const first = await lastUsed();
    expect(first).not.toBeNull();
    await withKey(app, key.token, "GET", inA("/conversations"));
    expect(await lastUsed()).toEqual(first);
  });
});

test("each key has its own rate limit", async () => {
  await valkey.connect();
  // A scale that leaves 3 requests a minute, so the test does not send hundreds.
  const limited = createApp({
    db,
    logger,
    auth,
    valkey,
    limitScale: 0.01,
    checks: { postgres: ok, valkey: ok },
  });
  const first = await makeKey("Fast bot");
  const second = await makeKey("Other bot");
  const statuses = [];
  for (let index = 0; index < 4; index++) {
    statuses.push((await withKey(limited, first.token, "GET", inA("/conversations"))).status);
  }
  expect(statuses).toEqual([200, 200, 200, 429]);
  expect((await withKey(limited, second.token, "GET", inA("/conversations"))).status).toBe(200);
});
