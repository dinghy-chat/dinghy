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
import { signedInOperator } from "../test/operators.ts";
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
  note,
  type ReplyMode,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createImages } from "./images.ts";
import { createLive } from "./live.ts";
import { localStore } from "./storage.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const ORIGIN = new URL(PUBLIC_URL).origin;
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

function call(headers: Record<string, string>, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const asOperator = (who: { cookie: string }, method: string, path: string, body?: unknown) =>
  call({ cookie: who.cookie, origin: ORIGIN }, method, path, body);
const asKey = (method: string, path: string, body?: unknown, token = key.token) =>
  call({ authorization: `Bearer ${token}` }, method, path, body);

const setMode = (replyMode: ReplyMode) =>
  owner.update(apiKey).set({ replyMode }).where(eq(apiKey.id, key.id));

/** A new visitor's first message, which opens a conversation. */
async function newChat(body = "Where is my order?") {
  const made = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  const visitor = (await made.json()) as { visitorId: string; token: string };
  const conversationId = await visitorSays(visitor.token, body);
  return { ...visitor, conversationId };
}

async function visitorSays(token: string, body: string) {
  const sent = await call(
    { origin: SITE, authorization: `Bearer ${token}` },
    "POST",
    `/v1/widget/${space.publicKey}/messages`,
    { clientId: randomUUID(), body },
  );
  expect(sent.status).toBe(201);
  return ((await sent.json()) as { conversationId: string }).conversationId;
}

const keyReply = (conversationId: string, body: string, clientId: string = randomUUID()) =>
  asKey("POST", inChat(conversationId, "/messages"), { clientId, body });

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
    images: createImages({
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
  const made = await asOperator(boss, "POST", inSpace("/api-keys"), { name: "Support bot" });
  key = (await made.json()) as { id: string; token: string };
}, 30_000);

beforeEach(async () => {
  await setMode("send");
  await owner.update(workspace).set({ botsPausedAt: null }).where(eq(workspace.id, space.id));
});

afterAll(async () => {
  for (const cleanup of cleanups) cleanup();
  await database.drop();
});

describe("reply modes", () => {
  test("a new key drafts, as the migration left only the old keys sending", async () => {
    const made = await asOperator(boss, "POST", inSpace("/api-keys"), { name: "New bot" });
    const { id } = (await made.json()) as { id: string };
    const [row] = await owner.select().from(apiKey).where(eq(apiKey.id, id));
    expect(row?.replyMode).toBe("draft");
  });

  test("a send-mode key's reply reaches the visitor", async () => {
    const chat = await newChat();
    const sent = await keyReply(chat.conversationId, "It ships today.");
    expect(sent.status).toBe(201);
    expect(await widgetText(chat.token)).toContain("It ships today.");
  });

  test("a draft-mode key's reply waits as a draft, and a retry returns the same one", async () => {
    await setMode("draft");
    const chat = await newChat();
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
    await setMode("draft");
    const chat = await newChat();
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const response = await app.request(inChat(chat.conversationId, "/images?clientId=img1"), {
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
    const chat = await newChat();
    await asOperator(boss, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "I have it.",
    });
    expect((await conversationRow(chat.conversationId))?.humanSince).not.toBeNull();
    const refused = await keyReply(chat.conversationId, "Me too!");
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("human_handling");
    await setMode("draft");
    expect((await keyReply(chat.conversationId, "A suggestion")).status).toBe(202);
    const read = await asOperator(boss, "GET", inChat(chat.conversationId, "/messages"));
    const { conversation: shown } = (await read.json()) as {
      conversation: { handler: { kind: string }; humanSince: string };
    };
    expect(shown.handler.kind).toBe("human");
    expect(shown.humanSince).toEqual(expect.any(String));
    const handled = await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.kind, "conversation.handled")))
      .orderBy(desc(event.seq))
      .limit(1);
    expect(handled[0]?.payload).toEqual({ conversationId: chat.conversationId, change: "human" });
  });

  test("give back lets the key send again, and only people can do it", async () => {
    const chat = await newChat();
    await asOperator(agent, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Let me look.",
    });
    expect((await asKey("POST", inChat(chat.conversationId, "/give-back"))).status).toBe(403);
    expect(
      (await asOperator(agent, "POST", inChat(chat.conversationId, "/give-back"))).status,
    ).toBe(200);
    expect((await conversationRow(chat.conversationId))?.humanSince).toBeNull();
    expect((await keyReply(chat.conversationId, "Back to me.")).status).toBe(201);
  });
});

describe("drafts", () => {
  async function drafted(body: string) {
    await setMode("draft");
    const chat = await newChat();
    const made = await keyReply(chat.conversationId, body);
    const { draft } = (await made.json()) as { draft: { id: string } };
    return { ...chat, draftId: draft.id };
  }
  const listed = async (conversationId: string) =>
    (
      (await (await asOperator(boss, "GET", inChat(conversationId, "/drafts"))).json()) as {
        drafts: { id: string; status: string }[];
      }
    ).drafts;

  test("a new visitor message marks the waiting drafts stale", async () => {
    const chat = await drafted("Try restarting it.");
    expect((await listed(chat.conversationId)).map((one) => one.status)).toEqual(["open"]);
    await visitorSays(chat.token, "Actually, it works now.");
    expect((await listed(chat.conversationId)).map((one) => one.status)).toEqual(["stale"]);
  });

  test("sending a draft writes the operator's message, and keeps the bot on the conversation", async () => {
    const chat = await drafted("Your order left today.");
    const path = inChat(chat.conversationId, `/drafts/${chat.draftId}/send`);
    const sent = await asOperator(boss, "POST", path, { body: "Your order left this morning." });
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
    const again = await asOperator(boss, "POST", path, {});
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(shown.id);
    expect(await listed(chat.conversationId)).toEqual([]);
  });

  test("a discarded draft never reaches the visitor and cannot be sent", async () => {
    const chat = await drafted("Wrong answer.");
    const base = inChat(chat.conversationId, `/drafts/${chat.draftId}`);
    expect((await asOperator(agent, "POST", `${base}/discard`)).status).toBe(200);
    expect((await asOperator(boss, "POST", `${base}/send`, {})).status).toBe(404);
    expect(await listed(chat.conversationId)).toEqual([]);
    expect(await widgetText(chat.token)).not.toContain("Wrong answer.");
  });

  test("keys cannot list, send or discard drafts", async () => {
    const chat = await drafted("Not for keys.");
    expect((await asKey("GET", inChat(chat.conversationId, "/drafts"))).status).toBe(403);
    const base = inChat(chat.conversationId, `/drafts/${chat.draftId}`);
    expect((await asKey("POST", `${base}/send`, {})).status).toBe(403);
    expect((await asKey("POST", `${base}/discard`)).status).toBe(403);
  });
});

describe("notes", () => {
  test("operators and keys add notes, which the thread shows and the visitor never sees", async () => {
    const chat = await newChat();
    const path = inChat(chat.conversationId, "/notes");
    const first = await asOperator(boss, "POST", path, { clientId: "n1", body: "VIP customer" });
    expect(first.status).toBe(201);
    expect(
      (await asOperator(boss, "POST", path, { clientId: "n1", body: "VIP customer" })).status,
    ).toBe(200);
    const byKey = await asKey("POST", path, { clientId: "n1", body: "Order #1234 is late" });
    expect(byKey.status).toBe(201);
    expect(await byKey.json()).toMatchObject({ authorKind: "key", authorName: "Support bot" });
    const read = await asOperator(boss, "GET", inChat(chat.conversationId, "/messages"));
    const { notes, messages } = (await read.json()) as {
      notes: { body: string; authorName: string; seq: string }[];
      messages: { seq: string }[];
    };
    expect(notes.map((one) => [one.body, one.authorName])).toEqual([
      ["VIP customer", "Mona"],
      ["Order #1234 is late", "Support bot"],
    ]);
    expect(BigInt(notes[0]?.seq ?? "0")).toBeGreaterThan(BigInt(messages[0]?.seq ?? "0"));
    const visitorSide = await widgetText(chat.token);
    expect(visitorSide).not.toContain("VIP customer");
    expect(visitorSide).not.toContain("Order #1234");
    const stream = listen(
      await app.request(`/v1/widget/${space.publicKey}/stream?after=0.0`, {
        headers: { origin: SITE, authorization: `Bearer ${chat.token}` },
      }),
    );
    await stream.waitFor((one) => one.event === "ready");
    expect(JSON.stringify(stream.events)).not.toContain("VIP customer");
    await stream.stop();
  });
});

describe("handoff", () => {
  const handoffPath = (conversationId: string) => inChat(conversationId, "/handoff");

  test("only a key hands off", async () => {
    const chat = await newChat();
    const body = { clientId: randomUUID(), reason: "Refund" };
    expect((await asOperator(boss, "POST", handoffPath(chat.conversationId), body)).status).toBe(
      403,
    );
  });

  test("a handoff tells the visitor, assigns, silences the bot and alerts the assignee", async () => {
    const chat = await newChat("I want a refund");
    // Earlier events alert on their own, and an email to the same person within minutes is skipped.
    await owner.update(event).set({ needsAlert: false }).where(eq(event.workspaceId, space.id));
    const body = {
      clientId: "h1",
      reason: "Refund over the limit",
      summary: "Order #1234, 120 EUR",
      operatorId: agent.id,
      visitorMessage: "I've passed this to the team.",
    };
    const done = await asKey("POST", handoffPath(chat.conversationId), body);
    expect(done.status).toBe(201);
    expect(await done.json()).toMatchObject({
      visitorMessage: { status: "sent", message: { body: "I've passed this to the team." } },
    });
    expect(await widgetText(chat.token)).toContain("I've passed this to the team.");
    const row = await conversationRow(chat.conversationId);
    expect(row).toMatchObject({ assigneeOperatorId: agent.id, handoffByApiKeyId: key.id });
    expect(row?.humanSince).not.toBeNull();
    const [written] = await owner
      .select()
      .from(note)
      .where(eq(note.conversationId, chat.conversationId));
    expect(written?.body).toBe("Handed off: Refund over the limit\n\nOrder #1234, 120 EUR");
    expect(await errorCode(await keyReply(chat.conversationId, "One more thing"))).toBe(
      "human_handling",
    );
    const retry = await asKey("POST", handoffPath(chat.conversationId), body);
    expect(retry.status).toBe(200);
    expect(
      await owner.select().from(note).where(eq(note.conversationId, chat.conversationId)),
    ).toHaveLength(1);

    while (await fanOutOne(workerDb, { push: true, email: true }));
    const alerts = await owner
      .select()
      .from(alertDelivery)
      .where(eq(alertDelivery.conversationId, chat.conversationId));
    expect(alerts.map((one) => [one.operatorId, one.channel])).toEqual([[agent.id, "email"]]);
  });

  test("an unassigned handoff alerts every member with alerts on", async () => {
    const chat = await newChat();
    await owner.update(event).set({ needsAlert: false }).where(eq(event.workspaceId, space.id));
    const done = await asKey("POST", handoffPath(chat.conversationId), {
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
    await setMode("draft");
    const chat = await newChat();
    const stranger = await asKey("POST", handoffPath(chat.conversationId), {
      clientId: randomUUID(),
      reason: "x",
      operatorId: randomUUID(),
    });
    expect(stranger.status).toBe(400);
    expect(await errorCode(stranger)).toBe("not_a_member");
    const done = await asKey("POST", handoffPath(chat.conversationId), {
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
    expect((await asOperator(agent, "PUT", path, { paused: true })).status).toBe(403);
    expect((await asKey("PUT", path, { paused: true })).status).toBe(403);
    expect((await asOperator(boss, "PUT", path, { paused: true })).status).toBe(200);
    const me = (await (await asOperator(agent, "GET", "/v1/operator/me")).json()) as {
      workspaces: { botsPaused: boolean }[];
    };
    expect(me.workspaces[0]?.botsPaused).toBe(true);
    const face = (await (await asKey("GET", inSpace())).json()) as { botsPaused: boolean };
    expect(face.botsPaused).toBe(true);
    expect((await asOperator(boss, "PUT", path, { paused: false })).status).toBe(200);
  });

  test("a pause refuses replies, drafts and typing, and leaves notes and handoffs", async () => {
    const chat = await newChat();
    await asOperator(boss, "PUT", inSpace("/bots-paused"), { paused: true });
    expect(await errorCode(await keyReply(chat.conversationId, "Hi"))).toBe("bots_paused");
    await setMode("draft");
    expect(await errorCode(await keyReply(chat.conversationId, "Hi"))).toBe("bots_paused");
    const typing = await asKey("POST", inChat(chat.conversationId, "/typing"), { typing: true });
    expect(await errorCode(typing)).toBe("bots_paused");
    const noted = await asKey("POST", inChat(chat.conversationId, "/notes"), {
      clientId: randomUUID(),
      body: "Paused, noted",
    });
    expect(noted.status).toBe(201);
    const handedOff = await asKey("POST", inChat(chat.conversationId, "/handoff"), {
      clientId: randomUUID(),
      reason: "Paused",
      visitorMessage: "Someone will reply.",
    });
    expect(await handedOff.json()).toEqual({
      visitorMessage: { status: "not_sent", reason: "bots_paused" },
    });
  });
});

describe("typing", () => {
  test("a key's typing reaches the visitor's chat, and a person's handling refuses it", async () => {
    const chat = await newChat();
    const stream = listen(
      await app.request(`/v1/widget/${space.publicKey}/stream`, {
        headers: { origin: SITE, authorization: `Bearer ${chat.token}` },
      }),
    );
    await stream.waitFor((one) => one.event === "ready");
    const typing = await asKey("POST", inChat(chat.conversationId, "/typing"), { typing: true });
    expect(typing.status).toBe(200);
    const notice = await stream.waitFor((one) => one.event === "notice");
    expect(notice.data).toEqual({ kind: "typing", name: "Support bot", typing: true });
    await stream.stop();
    expect(
      (await asOperator(boss, "POST", inChat(chat.conversationId, "/typing"), {})).status,
    ).toBe(403);
    await asOperator(boss, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Mine.",
    });
    const refused = await asKey("POST", inChat(chat.conversationId, "/typing"), {});
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
    const chat = await newChat("Hello from the stream");
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
    await asOperator(boss, "POST", inChat(chat.conversationId, "/notes"), {
      clientId: randomUUID(),
      body: "Streamed note",
    });
    const noted = await live.waitFor((one) => one.event === "note.created");
    expect(noted.data.data).toMatchObject({
      note: { body: "Streamed note", authorName: "Mona", authorKind: "operator" },
    });
    await live.stop();

    // From the first message's cursor: what came after, and only the types asked for.
    const resumed = listen(
      await open("?types=note.created", { "last-event-id": created.id ?? "" }),
    );
    await resumed.waitFor((one) => one.event === "ready");
    expect(resumed.events.map((one) => one.event)).toEqual(["note.created", "ready"]);
    await resumed.stop();
    expect((await open("?types=message.created,nothing")).status).toBe(400);
  });

  test("a revoked key's stream closes at the next heartbeat", async () => {
    const made = await asOperator(boss, "POST", inSpace("/api-keys"), { name: "Short-lived" });
    const temporary = (await made.json()) as { id: string; token: string };
    const stream = listen(await open("", {}, temporary.token));
    await stream.waitFor((one) => one.event === "ready");
    await asOperator(boss, "DELETE", inSpace(`/api-keys/${temporary.id}`));
    const closed = await stream.waitFor((one) => one.event === "close");
    expect(closed.data).toEqual({ reason: "revoked" });
  });
});
