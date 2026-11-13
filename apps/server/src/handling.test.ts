import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { and, desc, eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { setReplyMode } from "../test/keys.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, withKey } from "../test/requests.ts";
import { SITE, visitorSays, visitorStarts } from "../test/visitors.ts";
import { fanOutOne } from "./alerts.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import {
  alertDelivery,
  apiKey,
  conversation,
  draftReply,
  event,
  message,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createLive } from "./live.ts";
import { localStore } from "./storage.ts";
import { createUploads } from "./uploads.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let workerDb: Database;
let app: App;
let space: NewWorkspace;
let boss: { id: string; cookie: string };
let agent: { id: string; cookie: string };
let key: { id: string; token: string };
const cleanups: (() => void)[] = [];

const inSpace = (path = "") => `/v1/operator/workspaces/${space.id}${path}`;
const inChat = (conversationId: string, path: string) =>
  inSpace(`/conversations/${conversationId}${path}`);

const keyReply = (conversationId: string, body: string, clientId: string = randomUUID()) =>
  withKey(app, key.token, "POST", inChat(conversationId, "/messages"), { clientId, body });

async function errorCode(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function conversationRow(conversationId: string) {
  const [row] = await owner.select().from(conversation).where(eq(conversation.id, conversationId));
  return row;
}

/** What the visitor's chat lists. */
async function widgetText(token: string) {
  const response = await app.request(`/v1/widget/${space.publicKey}/messages`, {
    headers: { origin: SITE, authorization: `Bearer ${token}` },
  });
  return response.text();
}

interface StreamEvent {
  event: string;
  id: string | undefined;
  data: Record<string, unknown>;
}

/** Reads a server-sent event stream in the background, as a client would. */
function listen(response: Response) {
  const reader = response.body?.getReader();
  const events: StreamEvent[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const read = await reader?.read().catch(() => undefined);
      if (read === undefined || read.done) return;
      buffer += decoder.decode(read.value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          block
            .split("\n")
            .find((line) => line.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        const name = field("event");
        if (name !== undefined) {
          events.push({ event: name, id: field("id"), data: JSON.parse(field("data") ?? "{}") });
        }
      }
    }
  })();
  const waitFor = async (match: (one: StreamEvent) => boolean) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = events.find(match);
      if (found !== undefined) return found;
      await delay(20);
    }
    throw new Error(`No such event in ${JSON.stringify(events)}`);
  };
  cleanups.push(() => void reader?.cancel().catch(() => {}));
  return { events, waitFor, stop: () => reader?.cancel().catch(() => {}) };
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  workerDb = database.connect("worker", 2).db;
  owner = database.connect("migrator").db;
  const publisher = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  publisher.on("error", () => {});
  const live = createLive(publisher, VALKEY_URL, logger);
  cleanups.push(() => {
    live.stop();
    publisher.disconnect();
  });
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({
    db,
    logger,
    auth,
    live,
    uploads: createUploads({
      store: localStore(tmpdir()),
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    }),
    checks: { postgres: ok, valkey: ok },
    stream: { heartbeatMs: 200, lifetimeMs: 60_000 },
  });
  space = await createWorkspace(db, "Acme", [SITE]);
  boss = await signedInOperator({ app, auth, owner, name: "Mona", workspaceId: space.id });
  agent = await signedInOperator({
    app,
    auth,
    owner,
    name: "Ana",
    workspaceId: space.id,
    role: "member",
  });
  await owner
    .update(workspaceMember)
    .set({ alertEmail: true })
    .where(eq(workspaceMember.workspaceId, space.id));
  const made = await asOperator(app, boss.cookie, "POST", inSpace("/api-keys"), {
    name: "Support bot",
  });
  key = (await made.json()) as { id: string; token: string };
}, 30_000);

beforeEach(async () => {
  await setReplyMode(owner, key.id, "send");
  await owner.update(workspace).set({ botsPausedAt: null }).where(eq(workspace.id, space.id));
});

afterAll(async () => {
  for (const cleanup of cleanups) cleanup();
  await database.drop();
});

describe("reply modes", () => {
  test("a new key drafts, as the migration left only the old keys sending", async () => {
    const made = await asOperator(app, boss.cookie, "POST", inSpace("/api-keys"), {
      name: "New bot",
    });
    const { id } = (await made.json()) as { id: string };
    const [row] = await owner.select().from(apiKey).where(eq(apiKey.id, id));
    expect(row?.replyMode).toBe("draft");
  });

  test("a send-mode key's reply reaches the visitor", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    const sent = await keyReply(chat.conversationId, "It ships today.");
    expect(sent.status).toBe(201);
    expect(await widgetText(chat.token)).toContain("It ships today.");
  });

  test("a draft-mode key's reply waits as a draft, and a retry returns the same one", async () => {
    await setReplyMode(owner, key.id, "draft");
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    const first = await keyReply(chat.conversationId, "Maybe tomorrow.", "d1");
    expect(first.status).toBe(202);
    const { draft } = (await first.json()) as { draft: { id: string; status: string } };
    expect(draft).toMatchObject({
      status: "open",
      authorName: "Support bot",
      body: "Maybe tomorrow.",
    });
    const again = await keyReply(chat.conversationId, "Maybe tomorrow.", "d1");
    expect(((await again.json()) as { draft: { id: string } }).draft.id).toBe(draft.id);
    expect(await widgetText(chat.token)).not.toContain("Maybe tomorrow.");
    expect(await owner.select().from(message).where(eq(message.body, "Maybe tomorrow."))).toEqual(
      [],
    );
    const drafts = await owner.select().from(draftReply).where(eq(draftReply.clientId, "d1"));
    expect(drafts).toHaveLength(1);
  });

  test("a draft-mode key's image answers drafts_text_only, and nothing is stored", async () => {
    await setReplyMode(owner, key.id, "draft");
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const response = await app.request(inChat(chat.conversationId, "/uploads?clientId=img1"), {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "image/png" },
      body: png,
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("drafts_text_only");
  });
});

describe("a person handling a conversation", () => {
  test("an operator's reply silences a send-mode key, which may still draft", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    await asOperator(app, boss.cookie, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "I have it.",
    });
    expect((await conversationRow(chat.conversationId))?.humanSince).not.toBeNull();
    const refused = await keyReply(chat.conversationId, "Me too!");
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("human_handling");
    await setReplyMode(owner, key.id, "draft");
    expect((await keyReply(chat.conversationId, "A suggestion")).status).toBe(202);
    const read = await asOperator(
      app,
      boss.cookie,
      "GET",
      inChat(chat.conversationId, "/messages"),
    );
    const { conversation: shown } = (await read.json()) as {
      conversation: Record<string, unknown>;
    };
    expect(shown.handler).toEqual({
      kind: "person",
      operatorId: boss.id,
      name: "Mona",
      since: expect.any(String),
    });
    expect(shown).not.toHaveProperty("humanSince");
    const handled = await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.kind, "conversation.handled")))
      .orderBy(desc(event.seq))
      .limit(1);
    expect(handled[0]?.payload).toEqual({ conversationId: chat.conversationId, change: "human" });
  });

  test("give back lets the key send again, and only people can do it", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    await asOperator(app, agent.cookie, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Let me look.",
    });
    expect(
      (await withKey(app, key.token, "POST", inChat(chat.conversationId, "/give-back"))).status,
    ).toBe(403);
    expect(
      (await asOperator(app, agent.cookie, "POST", inChat(chat.conversationId, "/give-back")))
        .status,
    ).toBe(200);
    expect((await conversationRow(chat.conversationId))?.humanSince).toBeNull();
    expect((await keyReply(chat.conversationId, "Back to me.")).status).toBe(201);
  });
});

describe("who handles a conversation", () => {
  /** The handler as the list and the read show it, which must agree. */
  async function handlerOf(conversationId: string) {
    const list = await asOperator(app, boss.cookie, "GET", inSpace("/conversations?limit=100"));
    const { conversations } = (await list.json()) as {
      conversations: { id: string; handler: unknown }[];
    };
    const read = await asOperator(app, boss.cookie, "GET", inChat(conversationId, "/messages"));
    const { conversation: shown } = (await read.json()) as { conversation: { handler: unknown } };
    expect(conversations.find((one) => one.id === conversationId)?.handler).toEqual(shown.handler);
    return shown.handler;
  }

  test("no one, then the bot that took part, the team after a handoff, the bot again", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    expect(await handlerOf(chat.conversationId)).toBeNull();
    await setReplyMode(owner, key.id, "draft");
    await keyReply(chat.conversationId, "A suggestion");
    const bot = { kind: "bot", apiKeyId: key.id, name: "Support bot" };
    expect(await handlerOf(chat.conversationId)).toEqual(bot);
    await withKey(app, key.token, "POST", inChat(chat.conversationId, "/handoff"), {
      clientId: randomUUID(),
      reason: "A person should answer",
    });
    expect(await handlerOf(chat.conversationId)).toEqual({
      kind: "team",
      since: expect.any(String),
    });
    await asOperator(app, agent.cookie, "PUT", inChat(chat.conversationId, "/assignee"), {
      operatorId: agent.id,
    });
    expect(await handlerOf(chat.conversationId)).toMatchObject({
      kind: "person",
      operatorId: agent.id,
      name: "Ana",
    });
    await asOperator(app, agent.cookie, "POST", inChat(chat.conversationId, "/give-back"));
    expect(await handlerOf(chat.conversationId)).toEqual(bot);
  });

  test("a key's note makes it the bot that took part, and an operator's note does not", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    await asOperator(app, boss.cookie, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Watch this one.",
      note: true,
    });
    expect(await handlerOf(chat.conversationId)).toBeNull();
    await withKey(app, key.token, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Looked up the order.",
      note: true,
    });
    expect(await handlerOf(chat.conversationId)).toEqual({
      kind: "bot",
      apiKeyId: key.id,
      name: "Support bot",
    });
  });
});

describe("picking who handles a conversation", () => {
  /** A conversation that the key answered last, so the bot handles it. */
  async function botChat() {
    await setReplyMode(owner, key.id, "send");
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    await keyReply(chat.conversationId, "Let me check.");
    return chat;
  }
  const read = async (conversationId: string) =>
    (
      (await (
        await asOperator(app, boss.cookie, "GET", inChat(conversationId, "/messages"))
      ).json()) as {
        conversation: {
          assigneeOperatorId: string | null;
          handler: { kind: string } | null;
          bot: { apiKeyId: string; name: string } | null;
        };
      }
    ).conversation;
  /** The kinds of the events written for this conversation after `seq`, in order. */
  async function eventsSince(conversationId: string, seq: bigint) {
    const rows = await owner
      .select({ kind: event.kind, payload: event.payload, seq: event.seq })
      .from(event)
      .where(eq(event.workspaceId, space.id))
      .orderBy(event.seq);
    return rows
      .filter(
        (row) =>
          row.seq > seq &&
          (row.payload as { conversationId?: string }).conversationId === conversationId,
      )
      .map(
        (row) =>
          `${row.kind}${"change" in (row.payload as object) ? `:${(row.payload as { change: string }).change}` : ""}`,
      );
  }
  async function lastSeq() {
    const [row] = await owner
      .select({ seq: event.seq })
      .from(event)
      .where(eq(event.workspaceId, space.id))
      .orderBy(desc(event.seq))
      .limit(1);
    return row?.seq ?? 0n;
  }
  const assign = (conversationId: string, operatorId: string | null) =>
    asOperator(app, boss.cookie, "PUT", inChat(conversationId, "/assignee"), { operatorId });

  test("picking a person takes over from the bot: assigned, a person handles it, one transaction", async () => {
    const chat = await botChat();
    const before = await lastSeq();
    expect((await assign(chat.conversationId, agent.id)).status).toBe(200);
    expect(await read(chat.conversationId)).toMatchObject({
      assigneeOperatorId: agent.id,
      handler: { kind: "person", operatorId: agent.id },
      bot: { apiKeyId: key.id, name: "Support bot" },
    });
    expect(await eventsSince(chat.conversationId, before)).toEqual([
      "conversation.assigned",
      "conversation.handled:human",
    ]);
    expect(await errorCode(await keyReply(chat.conversationId, "Still me."))).toBe(
      "human_handling",
    );
  });

  test("picking Team takes over with nobody assigned", async () => {
    const chat = await botChat();
    await assign(chat.conversationId, agent.id);
    expect((await assign(chat.conversationId, null)).status).toBe(200);
    expect(await read(chat.conversationId)).toMatchObject({
      assigneeOperatorId: null,
      handler: { kind: "team" },
    });
    const fresh = await botChat();
    expect((await assign(fresh.conversationId, null)).status).toBe(200);
    expect((await read(fresh.conversationId)).handler).toMatchObject({ kind: "team" });
  });

  test("picking the bot gives it back: no person handles it and nobody is assigned", async () => {
    const chat = await botChat();
    await assign(chat.conversationId, agent.id);
    const before = await lastSeq();
    const back = await asOperator(
      app,
      boss.cookie,
      "POST",
      inChat(chat.conversationId, "/give-back"),
    );
    expect(back.status).toBe(200);
    const shown = await read(chat.conversationId);
    expect(shown).toMatchObject({
      assigneeOperatorId: null,
      handler: { kind: "bot", apiKeyId: key.id },
      bot: { apiKeyId: key.id },
    });
    expect(await eventsSince(chat.conversationId, before)).toEqual([
      "conversation.assigned",
      "conversation.handled:given_back",
    ]);
    expect((await conversationRow(chat.conversationId))?.humanSince).toBeNull();
    expect((await keyReply(chat.conversationId, "Back to me.")).status).toBe(201);
  });

  test("a key's assign changes only the assignee, and the bot keeps answering", async () => {
    const chat = await botChat();
    const assigned = await withKey(
      app,
      key.token,
      "PUT",
      inChat(chat.conversationId, "/assignee"),
      {
        operatorId: agent.id,
      },
    );
    expect(assigned.status).toBe(200);
    expect((await conversationRow(chat.conversationId))?.humanSince).toBeNull();
    expect(await read(chat.conversationId)).toMatchObject({
      assigneeOperatorId: agent.id,
      handler: { kind: "bot" },
    });
    expect((await keyReply(chat.conversationId, "Still me.")).status).toBe(201);
  });
});

describe("drafts", () => {
  async function drafted(body: string) {
    await setReplyMode(owner, key.id, "draft");
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    const made = await keyReply(chat.conversationId, body);
    const { draft } = (await made.json()) as { draft: { id: string } };
    return { ...chat, draftId: draft.id };
  }
  const listed = async (conversationId: string) =>
    (
      (await (
        await asOperator(app, boss.cookie, "GET", inChat(conversationId, "/drafts"))
      ).json()) as {
        drafts: { id: string; status: string }[];
      }
    ).drafts;

  test("a new visitor message marks the waiting drafts stale", async () => {
    const chat = await drafted("Try restarting it.");
    expect((await listed(chat.conversationId)).map((one) => one.status)).toEqual(["open"]);
    await visitorSays(app, space.publicKey, chat.token, "Actually, it works now.");
    expect((await listed(chat.conversationId)).map((one) => one.status)).toEqual(["stale"]);
  });

  test("a visitor's message that reopens a closed conversation marks its drafts stale", async () => {
    const chat = await drafted("Try restarting it.");
    await asOperator(app, boss.cookie, "PATCH", inChat(chat.conversationId, ""), {
      status: "closed",
    });
    const again = await visitorSays(app, space.publicKey, chat.token, "It broke again.");
    expect(again.conversationId).toBe(chat.conversationId);
    expect((await listed(chat.conversationId)).map((one) => one.status)).toEqual(["stale"]);
  });

  test("a person's reply marks the waiting drafts stale", async () => {
    const chat = await drafted("Try restarting it.");
    await asOperator(app, boss.cookie, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "I'll take this one.",
    });
    expect((await listed(chat.conversationId)).map((one) => one.status)).toEqual(["stale"]);
  });

  test("an operator's note leaves the drafts waiting and the bots answering", async () => {
    const chat = await drafted("Try restarting it.");
    const noted = await asOperator(
      app,
      boss.cookie,
      "POST",
      inChat(chat.conversationId, "/messages"),
      {
        clientId: randomUUID(),
        body: "Check their plan first.",
        note: true,
      },
    );
    expect(noted.status).toBe(201);
    expect((await listed(chat.conversationId)).map((one) => one.status)).toEqual(["open"]);
    // A note is no answer to the visitor, so no person handles the conversation yet.
    expect((await conversationRow(chat.conversationId))?.humanSince).toBeNull();
    await setReplyMode(owner, key.id, "send");
    expect((await keyReply(chat.conversationId, "Restart it, please.")).status).toBe(201);
  });

  test("sending a draft marks the other waiting drafts stale, not itself", async () => {
    const chat = await drafted("First idea.");
    const second = await keyReply(chat.conversationId, "Second idea.");
    const { draft } = (await second.json()) as { draft: { id: string } };
    const path = inChat(chat.conversationId, `/drafts/${draft.id}/send`);
    expect((await asOperator(app, boss.cookie, "POST", path, {})).status).toBe(201);
    const [sent] = await owner.select().from(draftReply).where(eq(draftReply.id, draft.id));
    expect(sent).toMatchObject({ resolved: "sent", staleAt: null });
    expect(await listed(chat.conversationId)).toEqual([
      expect.objectContaining({ id: chat.draftId, status: "stale" }),
    ]);
  });

  test("a draft that one operator sent, another sends again: the visitor gets it once", async () => {
    const chat = await drafted("Your parcel is on its way.");
    const path = inChat(chat.conversationId, `/drafts/${chat.draftId}/send`);
    const first = await asOperator(app, boss.cookie, "POST", path, {});
    expect(first.status).toBe(201);
    const second = await asOperator(app, agent.cookie, "POST", path, { body: "Something else" });
    expect(second.status).toBe(200);
    const shown = (await second.json()) as { id: string; authorOperatorId: string; body: string };
    expect(shown).toMatchObject({
      id: ((await first.json()) as { id: string }).id,
      authorOperatorId: boss.id,
      body: "Your parcel is on its way.",
    });
    const sent = await owner
      .select()
      .from(message)
      .where(
        and(
          eq(message.conversationId, chat.conversationId),
          eq(message.clientId, `draft-${chat.draftId}`),
        ),
      );
    expect(sent).toHaveLength(1);
    expect(await widgetText(chat.token)).not.toContain("Something else");
  });

  test("sending a draft writes the operator's message, and keeps the bot on the conversation", async () => {
    const chat = await drafted("Your order left today.");
    const path = inChat(chat.conversationId, `/drafts/${chat.draftId}/send`);
    const sent = await asOperator(app, boss.cookie, "POST", path, {
      body: "Your order left this morning.",
    });
    expect(sent.status).toBe(201);
    const shown = (await sent.json()) as { id: string };
    expect(shown).toMatchObject({
      authorOperatorId: boss.id,
      authorApiKeyId: null,
      via: "draft",
      body: "Your order left this morning.",
    });
    expect(await widgetText(chat.token)).toContain("Your order left this morning.");
    expect((await conversationRow(chat.conversationId))?.humanSince).toBeNull();
    const [row] = await owner.select().from(draftReply).where(eq(draftReply.id, chat.draftId));
    expect(row).toMatchObject({ resolved: "sent", sentMessageId: shown.id, apiKeyId: key.id });
    const again = await asOperator(app, boss.cookie, "POST", path, {});
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(shown.id);
    expect(await listed(chat.conversationId)).toEqual([]);
  });

  test("a discarded draft never reaches the visitor and cannot be sent", async () => {
    const chat = await drafted("Wrong answer.");
    const base = inChat(chat.conversationId, `/drafts/${chat.draftId}`);
    expect((await asOperator(app, agent.cookie, "POST", `${base}/discard`)).status).toBe(200);
    expect((await asOperator(app, boss.cookie, "POST", `${base}/send`, {})).status).toBe(404);
    expect(await listed(chat.conversationId)).toEqual([]);
    expect(await widgetText(chat.token)).not.toContain("Wrong answer.");
  });

  test("keys cannot list, send or discard drafts", async () => {
    const chat = await drafted("Not for keys.");
    expect(
      (await withKey(app, key.token, "GET", inChat(chat.conversationId, "/drafts"))).status,
    ).toBe(403);
    const base = inChat(chat.conversationId, `/drafts/${chat.draftId}`);
    expect((await withKey(app, key.token, "POST", `${base}/send`, {})).status).toBe(403);
    expect((await withKey(app, key.token, "POST", `${base}/discard`)).status).toBe(403);
  });
});

describe("notes", () => {
  test("a key writes a note while a person handles the conversation", async () => {
    await setReplyMode(owner, key.id, "send");
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    await asOperator(app, boss.cookie, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "I'm on it.",
    });
    expect(await errorCode(await keyReply(chat.conversationId, "Me too"))).toBe("human_handling");
    const noted = await withKey(app, key.token, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Order #1234 is late",
      note: true,
    });
    expect(noted.status).toBe(201);
    expect(await noted.json()).toMatchObject({ kind: "note", authorName: "Support bot" });
    expect(await widgetText(chat.token)).not.toContain("Order #1234");
  });
});

describe("handoff", () => {
  const handoffPath = (conversationId: string) => inChat(conversationId, "/handoff");

  test("the handoff note names whom it went to: the member, or null for the team", async () => {
    const handoffOf = async (conversationId: string) => {
      const read = await asOperator(app, boss.cookie, "GET", inChat(conversationId, "/messages"));
      const { messages } = (await read.json()) as {
        messages: { kind: string; handoff: { operatorId: string | null } | null }[];
      };
      return messages.map((one) => one.handoff);
    };
    const toAgent = await visitorStarts(app, space.publicKey, "I want a refund");
    await withKey(app, key.token, "POST", handoffPath(toAgent.conversationId), {
      clientId: randomUUID(),
      reason: "Refund",
      operatorId: agent.id,
    });
    expect(await handoffOf(toAgent.conversationId)).toEqual([null, { operatorId: agent.id }]);
    const toTeam = await visitorStarts(app, space.publicKey, "I want a refund");
    await withKey(app, key.token, "POST", handoffPath(toTeam.conversationId), {
      clientId: randomUUID(),
      reason: "Refund",
    });
    expect(await handoffOf(toTeam.conversationId)).toEqual([null, { operatorId: null }]);
  });

  test("only a key hands off", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    const body = { clientId: randomUUID(), reason: "Refund" };
    expect(
      (await asOperator(app, boss.cookie, "POST", handoffPath(chat.conversationId), body)).status,
    ).toBe(403);
  });

  test("a handoff tells the visitor, assigns, silences the bot and alerts the assignee", async () => {
    const chat = await visitorStarts(app, space.publicKey, "I want a refund");
    // Earlier events alert on their own, and an email to the same person within minutes is skipped.
    await owner.update(event).set({ needsAlert: false }).where(eq(event.workspaceId, space.id));
    const body = {
      clientId: "h1",
      reason: "Refund over the limit",
      summary: "Order #1234, 120 EUR",
      operatorId: agent.id,
      visitorMessage: "I've passed this to the team.",
    };
    const done = await withKey(app, key.token, "POST", handoffPath(chat.conversationId), body);
    expect(done.status).toBe(201);
    expect(await done.json()).toMatchObject({
      visitorMessage: { status: "sent", message: { body: "I've passed this to the team." } },
    });
    expect(await widgetText(chat.token)).toContain("I've passed this to the team.");
    const row = await conversationRow(chat.conversationId);
    expect(row).toMatchObject({ assigneeOperatorId: agent.id, handoffByApiKeyId: key.id });
    expect(row?.humanSince).not.toBeNull();
    const notesOf = (conversationId: string) =>
      owner
        .select()
        .from(message)
        .where(and(eq(message.conversationId, conversationId), eq(message.kind, "note")));
    const [written] = await notesOf(chat.conversationId);
    expect(written).toMatchObject({
      body: "Handed off: Refund over the limit\n\nOrder #1234, 120 EUR",
      authorApiKeyId: key.id,
    });
    expect(await widgetText(chat.token)).not.toContain("Refund over the limit");
    expect(await errorCode(await keyReply(chat.conversationId, "One more thing"))).toBe(
      "human_handling",
    );
    const retry = await withKey(app, key.token, "POST", handoffPath(chat.conversationId), body);
    expect(retry.status).toBe(200);
    expect(await notesOf(chat.conversationId)).toHaveLength(1);

    while (await fanOutOne(workerDb, { push: true, email: true }));
    const alerts = await owner
      .select()
      .from(alertDelivery)
      .where(eq(alertDelivery.conversationId, chat.conversationId));
    expect(alerts.map((one) => [one.operatorId, one.channel])).toEqual([[agent.id, "email"]]);
  });

  test("a retry answers the first result and sends nothing, even after bots resume", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    const paused = inSpace("/bots-paused");
    await asOperator(app, boss.cookie, "PUT", paused, { paused: true });
    const body = {
      clientId: randomUUID(),
      reason: "Needs a person",
      visitorMessage: "A person will take over.",
    };
    const first = await withKey(app, key.token, "POST", handoffPath(chat.conversationId), body);
    expect(first.status).toBe(201);
    const notSent = { visitorMessage: { status: "not_sent", reason: "bots_paused" } };
    expect(await first.json()).toEqual(notSent);
    await asOperator(app, boss.cookie, "PUT", paused, { paused: false });
    const retry = await withKey(app, key.token, "POST", handoffPath(chat.conversationId), body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(notSent);
    expect(await widgetText(chat.token)).not.toContain("A person will take over.");
    const notes = await owner
      .select()
      .from(message)
      .where(and(eq(message.conversationId, chat.conversationId), eq(message.kind, "note")));
    expect(notes).toHaveLength(1);
  });

  test("an unassigned handoff alerts every member with alerts on", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    await owner.update(event).set({ needsAlert: false }).where(eq(event.workspaceId, space.id));
    const done = await withKey(app, key.token, "POST", handoffPath(chat.conversationId), {
      clientId: randomUUID(),
      reason: "Angry customer",
    });
    expect(await done.json()).toEqual({ visitorMessage: null });
    while (await fanOutOne(workerDb, { push: true, email: true }));
    const alerts = await owner
      .select()
      .from(alertDelivery)
      .where(eq(alertDelivery.conversationId, chat.conversationId));
    expect(alerts.map((one) => one.operatorId).sort()).toEqual([boss.id, agent.id].sort());
  });

  test("a draft-mode key's message becomes a draft, and a stranger cannot be assigned", async () => {
    await setReplyMode(owner, key.id, "draft");
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    const stranger = await withKey(app, key.token, "POST", handoffPath(chat.conversationId), {
      clientId: randomUUID(),
      reason: "x",
      operatorId: randomUUID(),
    });
    expect(stranger.status).toBe(400);
    expect(await errorCode(stranger)).toBe("not_a_member");
    const done = await withKey(app, key.token, "POST", handoffPath(chat.conversationId), {
      clientId: randomUUID(),
      reason: "Billing",
      visitorMessage: "A person will reply soon.",
    });
    expect(await done.json()).toMatchObject({ visitorMessage: { status: "drafted" } });
    expect(await widgetText(chat.token)).not.toContain("A person will reply soon.");
  });
});

describe("pausing every bot", () => {
  test("only owners and admins pause, and the apps can read it", async () => {
    const path = inSpace("/bots-paused");
    expect((await asOperator(app, agent.cookie, "PUT", path, { paused: true })).status).toBe(403);
    expect((await withKey(app, key.token, "PUT", path, { paused: true })).status).toBe(403);
    expect((await asOperator(app, boss.cookie, "PUT", path, { paused: true })).status).toBe(200);
    const me = (await (await asOperator(app, agent.cookie, "GET", "/v1/operator/me")).json()) as {
      workspaces: { botsPaused: boolean; botsPausedBy: string | null }[];
    };
    expect(me.workspaces[0]).toMatchObject({ botsPaused: true, botsPausedBy: "Mona" });
    const face = (await (await withKey(app, key.token, "GET", inSpace())).json()) as {
      botsPaused: boolean;
    };
    expect(face).toMatchObject({ botsPaused: true, botsPausedBy: "Mona" });
    const resumed = await asOperator(app, boss.cookie, "PUT", path, { paused: false });
    expect(await resumed.json()).toEqual({ paused: false, pausedBy: null });
    const again = await asOperator(app, boss.cookie, "PUT", path, { paused: true });
    expect(await again.json()).toEqual({ paused: true, pausedBy: "Mona" });
    await asOperator(app, boss.cookie, "PUT", path, { paused: false });
  });

  test("a pause refuses replies, drafts and typing, and leaves notes and handoffs", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    await asOperator(app, boss.cookie, "PUT", inSpace("/bots-paused"), { paused: true });
    expect(await errorCode(await keyReply(chat.conversationId, "Hi"))).toBe("bots_paused");
    await setReplyMode(owner, key.id, "draft");
    expect(await errorCode(await keyReply(chat.conversationId, "Hi"))).toBe("bots_paused");
    const typing = await withKey(app, key.token, "POST", inChat(chat.conversationId, "/typing"), {
      typing: true,
    });
    expect(await errorCode(typing)).toBe("bots_paused");
    const noted = await withKey(app, key.token, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Paused, noted",
      note: true,
    });
    expect(noted.status).toBe(201);
    const handedOff = await withKey(
      app,
      key.token,
      "POST",
      inChat(chat.conversationId, "/handoff"),
      {
        clientId: randomUUID(),
        reason: "Paused",
        visitorMessage: "Someone will reply.",
      },
    );
    expect(await handedOff.json()).toEqual({
      visitorMessage: { status: "not_sent", reason: "bots_paused" },
    });
  });
});

describe("typing", () => {
  test("a key's typing reaches the visitor's chat, and a person's handling refuses it", async () => {
    const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
    const stream = listen(
      await app.request(`/v1/widget/${space.publicKey}/stream`, {
        headers: { origin: SITE, authorization: `Bearer ${chat.token}` },
      }),
    );
    await stream.waitFor((one) => one.event === "ready");
    const typing = await withKey(app, key.token, "POST", inChat(chat.conversationId, "/typing"), {
      typing: true,
    });
    expect(typing.status).toBe(200);
    const notice = await stream.waitFor((one) => one.event === "notice");
    expect(notice.data).toEqual({ kind: "typing", name: "Support bot", typing: true });
    await stream.stop();
    expect(
      (await asOperator(app, boss.cookie, "POST", inChat(chat.conversationId, "/typing"), {}))
        .status,
    ).toBe(403);
    await asOperator(app, boss.cookie, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Mine.",
    });
    const refused = await withKey(
      app,
      key.token,
      "POST",
      inChat(chat.conversationId, "/typing"),
      {},
    );
    expect(await errorCode(refused)).toBe("human_handling");
  });
});

describe("the event stream for keys", () => {
  const open = (query = "", headers: Record<string, string> = {}, token = key.token) =>
    app.request(`/v1/events${query}`, {
      headers: { authorization: `Bearer ${token}`, ...headers },
    });

  test("it delivers webhook bodies, resumes from a cursor and keeps to the types asked", async () => {
    const live = listen(await open());
    await live.waitFor((one) => one.event === "ready");
    const chat = await visitorStarts(app, space.publicKey, "Hello from the stream");
    const created = await live.waitFor((one) => one.event === "message.created");
    expect(created.data).toMatchObject({
      type: "message.created",
      workspaceId: space.id,
      data: {
        conversation: { id: chat.conversationId, visitor: { isTest: false } },
        message: { body: "Hello from the stream", fromVisitor: true },
      },
    });
    await live.waitFor((one) => one.event === "conversation.created");
    await asOperator(app, boss.cookie, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Streamed note",
      note: true,
    });
    const noted = await live.waitFor((one) => one.event === "message.created" && one !== created);
    expect(noted.data.data).toMatchObject({
      message: { kind: "note", body: "Streamed note", authorName: "Mona" },
    });
    await live.stop();

    // From the first message's cursor: what came after, and only the types asked for.
    const resumed = listen(
      await open("?types=message.created", { "last-event-id": created.id ?? "" }),
    );
    await resumed.waitFor((one) => one.event === "ready");
    expect(resumed.events.map((one) => one.event)).toEqual(["message.created", "ready"]);
    await resumed.stop();
    expect((await open("?types=message.created,nothing")).status).toBe(400);
  });

  test("a stream that drops between the two events of a first message resumes with the second", async () => {
    const live = listen(await open());
    await live.waitFor((one) => one.event === "ready");
    const chat = await visitorStarts(app, space.publicKey, "Two events, one change");
    const started = await live.waitFor((one) => one.event === "conversation.created");
    const created = await live.waitFor((one) => one.event === "message.created");
    await live.stop();
    expect(started.id).toBe(`${created.id}.0`);
    const resumed = listen(await open("", { "last-event-id": started.id ?? "" }));
    await resumed.waitFor((one) => one.event === "ready");
    expect(resumed.events.map((one) => [one.event, one.id])).toEqual([
      ["message.created", created.id],
      ["ready", undefined],
    ]);
    expect(resumed.events[0]?.data).toMatchObject({
      data: { conversation: { id: chat.conversationId } },
    });
    await resumed.stop();
    const after = listen(await open(`?after=${created.id}`));
    await after.waitFor((one) => one.event === "ready");
    expect(after.events.map((one) => one.event)).toEqual(["ready"]);
    await after.stop();
  });

  test("one page of several events reads as it did one event at a time", async () => {
    const send = (headers: Record<string, string>, path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const asBoss = { cookie: boss.cookie, origin: new URL(PUBLIC_URL).origin };
    const asBot = { authorization: `Bearer ${key.token}` };
    const made = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: SITE },
    });
    const visitor = (await made.json()) as { token: string };
    const asVisitor = { origin: SITE, authorization: `Bearer ${visitor.token}` };
    const says = (body: string) =>
      send(asVisitor, `/v1/widget/${space.publicKey}/messages`, { clientId: randomUUID(), body });
    // The cursor of the first message, so the rest comes as one page.
    const start = listen(await app.request("/v1/events", { headers: asBot }));
    await start.waitFor((one) => one.event === "ready");
    const first = (await (await says("Where is order #1042?")).json()) as {
      conversationId: string;
    };
    const marker = await start.waitFor((one) => one.event === "message.created");
    await start.stop();
    const chat = (path: string) => inChat(first.conversationId, path);
    await says("It was due Monday.");
    await send(asBot, chat("/messages"), { clientId: randomUUID(), body: "Let me check." });
    await send(asBoss, chat("/messages"), { clientId: randomUUID(), body: "VIP", note: true });
    await send(asBot, chat("/handoff"), {
      clientId: randomUUID(),
      reason: "Shipping question",
      operatorId: boss.id,
      visitorMessage: "A person takes over now.",
    });
    await send(asBoss, chat("/give-back"), {});
    const page = listen(
      await app.request("/v1/events", { headers: { ...asBot, "last-event-id": marker.id ?? "" } }),
    );
    await page.waitFor((one) => one.event === "ready");
    await page.stop();
    const names = new Map<string, string>();
    const [, markerSeq = "0"] = (marker.id ?? "").split(".");
    const sinceMarker = (seq: string | undefined) => BigInt(seq ?? 0) - BigInt(markerSeq);
    const normalized = JSON.stringify(page.events)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
        if (!names.has(id)) names.set(id, `<id ${names.size}>`);
        return names.get(id) ?? id;
      })
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>")
      .replace(/"seq":"(\d+)"/g, (_, seq: string) => `"seq":"+${sinceMarker(seq)}"`)
      .replace(/"\d+\.\d+(\.\d)?"/g, (cursor) => {
        const [, seq, part] = cursor.slice(1, -1).split(".");
        return `"+${sinceMarker(seq)}${part === undefined ? "" : `.${part}`}"`;
      });
    expect(JSON.parse(normalized)).toMatchInlineSnapshot(`
      [
        {
          "data": {
            "data": {
              "conversation": {
                "assigneeOperatorId": null,
                "bot": {
                  "apiKeyId": "<id 2>",
                  "name": "Support bot",
                },
                "handler": {
                  "apiKeyId": "<id 2>",
                  "kind": "bot",
                  "name": "Support bot",
                },
                "id": "<id 1>",
                "labelIds": [],
                "lastMessage": null,
                "pageContext": null,
                "snooze": null,
                "startedPage": null,
                "status": "open",
                "updatedAt": "<time>",
                "visitor": {
                  "attributes": null,
                  "blocked": false,
                  "country": null,
                  "device": "Unknown",
                  "email": null,
                  "externalId": null,
                  "id": "<id 3>",
                  "isTest": false,
                  "lastPage": null,
                  "lastSeenAt": null,
                  "locale": null,
                  "name": null,
                  "pictureUrl": null,
                  "timeZone": null,
                },
                "welcome": false,
              },
              "message": {
                "attachment": null,
                "authorApiKeyId": null,
                "authorName": null,
                "authorOperatorId": null,
                "body": "It was due Monday.",
                "clientId": "<id 5>",
                "conversationId": "<id 1>",
                "createdAt": "<time>",
                "deleted": false,
                "editedAt": null,
                "fromVisitor": true,
                "handoff": null,
                "id": "<id 4>",
                "kind": "text",
                "mentions": [],
                "readAt": null,
                "replyTo": null,
                "seq": "+1",
                "via": null,
              },
            },
            "type": "message.created",
            "workspaceId": "<id 0>",
          },
          "event": "message.created",
          "id": "+1",
        },
        {
          "data": {
            "data": {
              "conversation": {
                "assigneeOperatorId": null,
                "bot": {
                  "apiKeyId": "<id 2>",
                  "name": "Support bot",
                },
                "handler": {
                  "apiKeyId": "<id 2>",
                  "kind": "bot",
                  "name": "Support bot",
                },
                "id": "<id 1>",
                "labelIds": [],
                "lastMessage": null,
                "pageContext": null,
                "snooze": null,
                "startedPage": null,
                "status": "open",
                "updatedAt": "<time>",
                "visitor": {
                  "attributes": null,
                  "blocked": false,
                  "country": null,
                  "device": "Unknown",
                  "email": null,
                  "externalId": null,
                  "id": "<id 3>",
                  "isTest": false,
                  "lastPage": null,
                  "lastSeenAt": null,
                  "locale": null,
                  "name": null,
                  "pictureUrl": null,
                  "timeZone": null,
                },
                "welcome": false,
              },
              "message": {
                "attachment": null,
                "authorApiKeyId": "<id 2>",
                "authorName": "Support bot",
                "authorOperatorId": null,
                "body": "Let me check.",
                "clientId": "<id 7>",
                "conversationId": "<id 1>",
                "createdAt": "<time>",
                "deleted": false,
                "editedAt": null,
                "fromVisitor": false,
                "handoff": null,
                "id": "<id 6>",
                "kind": "text",
                "mentions": [],
                "readAt": null,
                "replyTo": null,
                "seq": "+2",
                "via": "api",
              },
            },
            "type": "message.created",
            "workspaceId": "<id 0>",
          },
          "event": "message.created",
          "id": "+2",
        },
        {
          "data": {
            "data": {
              "conversation": {
                "assigneeOperatorId": null,
                "bot": {
                  "apiKeyId": "<id 2>",
                  "name": "Support bot",
                },
                "handler": {
                  "apiKeyId": "<id 2>",
                  "kind": "bot",
                  "name": "Support bot",
                },
                "id": "<id 1>",
                "labelIds": [],
                "lastMessage": null,
                "pageContext": null,
                "snooze": null,
                "startedPage": null,
                "status": "open",
                "updatedAt": "<time>",
                "visitor": {
                  "attributes": null,
                  "blocked": false,
                  "country": null,
                  "device": "Unknown",
                  "email": null,
                  "externalId": null,
                  "id": "<id 3>",
                  "isTest": false,
                  "lastPage": null,
                  "lastSeenAt": null,
                  "locale": null,
                  "name": null,
                  "pictureUrl": null,
                  "timeZone": null,
                },
                "welcome": false,
              },
              "message": {
                "attachment": null,
                "authorApiKeyId": null,
                "authorName": "Mona",
                "authorOperatorId": "<id 9>",
                "body": "VIP",
                "clientId": "<id 10>",
                "conversationId": "<id 1>",
                "createdAt": "<time>",
                "deleted": false,
                "editedAt": null,
                "fromVisitor": false,
                "handoff": null,
                "id": "<id 8>",
                "kind": "note",
                "mentions": [],
                "readAt": null,
                "replyTo": null,
                "seq": "+3",
                "via": null,
              },
            },
            "type": "message.created",
            "workspaceId": "<id 0>",
          },
          "event": "message.created",
          "id": "+3",
        },
        {
          "data": {
            "data": {
              "conversation": {
                "assigneeOperatorId": null,
                "bot": {
                  "apiKeyId": "<id 2>",
                  "name": "Support bot",
                },
                "handler": {
                  "apiKeyId": "<id 2>",
                  "kind": "bot",
                  "name": "Support bot",
                },
                "id": "<id 1>",
                "labelIds": [],
                "lastMessage": null,
                "pageContext": null,
                "snooze": null,
                "startedPage": null,
                "status": "open",
                "updatedAt": "<time>",
                "visitor": {
                  "attributes": null,
                  "blocked": false,
                  "country": null,
                  "device": "Unknown",
                  "email": null,
                  "externalId": null,
                  "id": "<id 3>",
                  "isTest": false,
                  "lastPage": null,
                  "lastSeenAt": null,
                  "locale": null,
                  "name": null,
                  "pictureUrl": null,
                  "timeZone": null,
                },
                "welcome": false,
              },
              "message": {
                "attachment": null,
                "authorApiKeyId": "<id 2>",
                "authorName": "Support bot",
                "authorOperatorId": null,
                "body": "A person takes over now.",
                "clientId": "<id 12>",
                "conversationId": "<id 1>",
                "createdAt": "<time>",
                "deleted": false,
                "editedAt": null,
                "fromVisitor": false,
                "handoff": null,
                "id": "<id 11>",
                "kind": "text",
                "mentions": [],
                "readAt": null,
                "replyTo": null,
                "seq": "+4",
                "via": "api",
              },
            },
            "type": "message.created",
            "workspaceId": "<id 0>",
          },
          "event": "message.created",
          "id": "+4",
        },
        {
          "data": {
            "data": {
              "conversation": {
                "assigneeOperatorId": null,
                "bot": {
                  "apiKeyId": "<id 2>",
                  "name": "Support bot",
                },
                "handler": {
                  "apiKeyId": "<id 2>",
                  "kind": "bot",
                  "name": "Support bot",
                },
                "id": "<id 1>",
                "labelIds": [],
                "lastMessage": null,
                "pageContext": null,
                "snooze": null,
                "startedPage": null,
                "status": "open",
                "updatedAt": "<time>",
                "visitor": {
                  "attributes": null,
                  "blocked": false,
                  "country": null,
                  "device": "Unknown",
                  "email": null,
                  "externalId": null,
                  "id": "<id 3>",
                  "isTest": false,
                  "lastPage": null,
                  "lastSeenAt": null,
                  "locale": null,
                  "name": null,
                  "pictureUrl": null,
                  "timeZone": null,
                },
                "welcome": false,
              },
              "message": {
                "attachment": null,
                "authorApiKeyId": "<id 2>",
                "authorName": "Support bot",
                "authorOperatorId": null,
                "body": "Handed off: Shipping question",
                "clientId": "handoff:<id 12>",
                "conversationId": "<id 1>",
                "createdAt": "<time>",
                "deleted": false,
                "editedAt": null,
                "fromVisitor": false,
                "handoff": {
                  "operatorId": "<id 9>",
                },
                "id": "<id 13>",
                "kind": "note",
                "mentions": [],
                "readAt": null,
                "replyTo": null,
                "seq": "+5",
                "via": "api",
              },
            },
            "type": "message.created",
            "workspaceId": "<id 0>",
          },
          "event": "message.created",
          "id": "+5",
        },
        {
          "data": {
            "data": {
              "conversation": {
                "assigneeOperatorId": null,
                "bot": {
                  "apiKeyId": "<id 2>",
                  "name": "Support bot",
                },
                "handler": {
                  "apiKeyId": "<id 2>",
                  "kind": "bot",
                  "name": "Support bot",
                },
                "id": "<id 1>",
                "labelIds": [],
                "lastMessage": null,
                "pageContext": null,
                "snooze": null,
                "startedPage": null,
                "status": "open",
                "updatedAt": "<time>",
                "visitor": {
                  "attributes": null,
                  "blocked": false,
                  "country": null,
                  "device": "Unknown",
                  "email": null,
                  "externalId": null,
                  "id": "<id 3>",
                  "isTest": false,
                  "lastPage": null,
                  "lastSeenAt": null,
                  "locale": null,
                  "name": null,
                  "pictureUrl": null,
                  "timeZone": null,
                },
                "welcome": false,
              },
            },
            "type": "conversation.assigned",
            "workspaceId": "<id 0>",
          },
          "event": "conversation.assigned",
          "id": "+6",
        },
        {
          "data": {
            "data": {
              "conversation": {
                "assigneeOperatorId": null,
                "bot": {
                  "apiKeyId": "<id 2>",
                  "name": "Support bot",
                },
                "handler": {
                  "apiKeyId": "<id 2>",
                  "kind": "bot",
                  "name": "Support bot",
                },
                "id": "<id 1>",
                "labelIds": [],
                "lastMessage": null,
                "pageContext": null,
                "snooze": null,
                "startedPage": null,
                "status": "open",
                "updatedAt": "<time>",
                "visitor": {
                  "attributes": null,
                  "blocked": false,
                  "country": null,
                  "device": "Unknown",
                  "email": null,
                  "externalId": null,
                  "id": "<id 3>",
                  "isTest": false,
                  "lastPage": null,
                  "lastSeenAt": null,
                  "locale": null,
                  "name": null,
                  "pictureUrl": null,
                  "timeZone": null,
                },
                "welcome": false,
              },
            },
            "type": "conversation.handoff",
            "workspaceId": "<id 0>",
          },
          "event": "conversation.handoff",
          "id": "+7",
        },
        {
          "data": {
            "data": {
              "conversation": {
                "assigneeOperatorId": null,
                "bot": {
                  "apiKeyId": "<id 2>",
                  "name": "Support bot",
                },
                "handler": {
                  "apiKeyId": "<id 2>",
                  "kind": "bot",
                  "name": "Support bot",
                },
                "id": "<id 1>",
                "labelIds": [],
                "lastMessage": null,
                "pageContext": null,
                "snooze": null,
                "startedPage": null,
                "status": "open",
                "updatedAt": "<time>",
                "visitor": {
                  "attributes": null,
                  "blocked": false,
                  "country": null,
                  "device": "Unknown",
                  "email": null,
                  "externalId": null,
                  "id": "<id 3>",
                  "isTest": false,
                  "lastPage": null,
                  "lastSeenAt": null,
                  "locale": null,
                  "name": null,
                  "pictureUrl": null,
                  "timeZone": null,
                },
                "welcome": false,
              },
            },
            "type": "conversation.assigned",
            "workspaceId": "<id 0>",
          },
          "event": "conversation.assigned",
          "id": "+8",
        },
        {
          "data": {
            "data": {
              "conversation": {
                "assigneeOperatorId": null,
                "bot": {
                  "apiKeyId": "<id 2>",
                  "name": "Support bot",
                },
                "handler": {
                  "apiKeyId": "<id 2>",
                  "kind": "bot",
                  "name": "Support bot",
                },
                "id": "<id 1>",
                "labelIds": [],
                "lastMessage": null,
                "pageContext": null,
                "snooze": null,
                "startedPage": null,
                "status": "open",
                "updatedAt": "<time>",
                "visitor": {
                  "attributes": null,
                  "blocked": false,
                  "country": null,
                  "device": "Unknown",
                  "email": null,
                  "externalId": null,
                  "id": "<id 3>",
                  "isTest": false,
                  "lastPage": null,
                  "lastSeenAt": null,
                  "locale": null,
                  "name": null,
                  "pictureUrl": null,
                  "timeZone": null,
                },
                "welcome": false,
              },
            },
            "type": "conversation.given_back",
            "workspaceId": "<id 0>",
          },
          "event": "conversation.given_back",
          "id": "+9",
        },
        {
          "data": {
            "cursor": "+9",
          },
          "event": "ready",
        },
      ]
    `);
  });

  test("a revoked key's stream closes at the next heartbeat", async () => {
    const made = await asOperator(app, boss.cookie, "POST", inSpace("/api-keys"), {
      name: "Short-lived",
    });
    const temporary = (await made.json()) as { id: string; token: string };
    const stream = listen(await open("", {}, temporary.token));
    await stream.waitFor((one) => one.event === "ready");
    await asOperator(app, boss.cookie, "DELETE", inSpace(`/api-keys/${temporary.id}`));
    const closed = await stream.waitFor((one) => one.event === "close");
    expect(closed.data).toEqual({ reason: "revoked" });
  });
});
