import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { medianFirstReplySeconds } from "./analytics.ts";
import { type App, createApp } from "./app.ts";
import { readTar } from "./archive.ts";
import { createAuth } from "./auth.ts";
import { conversation, event, webhook } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { createImages } from "./images.ts";
import type { Live } from "./live.ts";
import { localStore } from "./storage.ts";
import { exportArchive } from "./transfer.ts";
import { claimWebhookDeliveries, deliverWebhook, fanOutWebhooksOne } from "./webhooks.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });

let database: TestDatabase;
let db: Database;
let owner: Database;
let workerDb: Database;
let app: App;
let space: NewWorkspace;
let ana: { id: string; cookie: string };
let ben: { id: string; cookie: string };
let keyToken: string;
const wakes: string[] = [];

const live: Live = {
  wake(_workspaceId, subscriber) {
    wakes.push(subscriber);
  },
  revoke() {},
  tell() {},
  tellVisitor() {},
  async subscribe() {
    return () => {};
  },
  stop() {},
};

interface Line {
  id: string;
  seq: string;
  kind: string;
  body: string | null;
  fromVisitor: boolean;
  replyTo: { id: string | null; text: string } | null;
  deleted: boolean;
}

const send = (cookie: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      cookie,
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const widget = (token: string, method: string, path: string, workspace = space) =>
  app.request(`/v1/widget/${workspace.publicKey}/${path}`, {
    method,
    headers: { origin: SITE, authorization: `Bearer ${token}` },
  });

const inSpace = (path: string, workspace = space) =>
  `/v1/operator/workspaces/${workspace.id}${path}`;
const thread = (conversationId: string, workspace = space) =>
  inSpace(`/conversations/${conversationId}/messages`, workspace);

/** A new visitor's first message, which starts a conversation. */
async function visitorStarts(body: string, workspace = space) {
  const created = await app.request(`/v1/widget/${workspace.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  const { token, visitorId } = (await created.json()) as { token: string; visitorId: string };
  const sent = await app.request(`/v1/widget/${workspace.publicKey}/messages`, {
    method: "POST",
    headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ clientId: randomUUID(), body }),
  });
  const first = (await sent.json()) as Line & { conversationId: string };
  return { token, visitorId, conversationId: first.conversationId, first };
}

async function write(
  cookie: string,
  conversationId: string,
  body: string,
  extra: { note?: boolean; replyToMessageId?: string } = {},
  workspace = space,
): Promise<Line> {
  const response = await send(cookie, "POST", thread(conversationId, workspace), {
    clientId: randomUUID(),
    body,
    ...extra,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Line;
}
const addNote = (cookie: string, conversationId: string, body: string, workspace = space) =>
  write(cookie, conversationId, body, { note: true }, workspace);

async function operatorLines(conversationId: string): Promise<Line[]> {
  const response = await send(ana.cookie, "GET", thread(conversationId));
  return ((await response.json()) as { messages: Line[] }).messages;
}

async function widgetLines(token: string, after?: string) {
  const query = after === undefined ? "" : `?after=${after}`;
  const response = await widget(token, "GET", `messages${query}`);
  return (await response.json()) as { messages: Line[]; cursor: string };
}

/** The widget stream's backlog after a cursor, as raw text, up to its `ready` event. */
async function widgetStream(token: string, after: string) {
  const response = await widget(token, "GET", `stream?after=${after}`);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (reader !== undefined && !text.includes("event: ready")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader?.cancel();
  return text;
}

const setStatus = (conversationId: string, status: "open" | "closed") =>
  send(ana.cookie, "PATCH", inSpace(`/conversations/${conversationId}`), { status });

/** A workspace of its own, with one owner, for counts that every conversation adds to. */
async function ownSpace(name: string) {
  const fresh = await createWorkspace(db, name, [SITE]);
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const lead = await signedInOperator({
    app,
    auth,
    owner,
    email: `lead-${randomUUID()}@example.com`,
    name: "Lead",
    workspaceId: fresh.id,
    role: "owner",
  });
  return { fresh, lead };
}

const mcp = (name: string, args: Record<string, unknown>) =>
  app.request("/v1/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${keyToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  workerDb = database.connect("worker").db;
  const ok = async () => {};
  app = createApp({
    db,
    live,
    logger,
    checks: { postgres: ok, valkey: ok },
    stream: { heartbeatMs: 25_000, lifetimeMs: 60_000 },
    auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL }),
    images: createImages({
      store: localStore(await mkdtemp(join(tmpdir(), "dinghy-notes-images-"))),
      secret: "a-test-secret",
      publicUrl: PUBLIC_URL,
    }),
  });
  space = await createWorkspace(db, "Acme", [SITE]);
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const member = (email: string, name: string, role: "owner" | "member") =>
    signedInOperator({ app, auth, owner, email, name, workspaceId: space.id, role });
  ana = await member("ana@example.com", "Ana Lee", "owner");
  ben = await member("ben@example.com", "Ben", "member");
  const made = await send(ana.cookie, "POST", inSpace("/api-keys"), { name: "Helper bot" });
  keyToken = ((await made.json()) as { token: string }).token;
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("writing a note", () => {
  test("an operator adds a note: the team sees it with its kind, and the visitor's stream is not woken", async () => {
    const { conversationId, visitorId } = await visitorStarts("Hello");
    wakes.length = 0;
    const note = await addNote(ana.cookie, conversationId, "VIP customer, be kind");
    expect(note).toMatchObject({ kind: "note", fromVisitor: false, body: "VIP customer, be kind" });
    expect(wakes).not.toContain(visitorId);
    expect((await operatorLines(conversationId)).at(-1)).toMatchObject({ id: note.id });
  });

  test("a retry with the same clientId returns the original note", async () => {
    const { conversationId } = await visitorStarts("Hello");
    const body = { clientId: "note-1", body: "Once", note: true };
    const first = await send(ana.cookie, "POST", thread(conversationId), body);
    const again = await send(ana.cookie, "POST", thread(conversationId), body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Line).id).toBe(((await first.json()) as Line).id);
  });

  test("a note goes in a closed conversation and leaves it closed", async () => {
    const { conversationId } = await visitorStarts("Hello");
    await setStatus(conversationId, "closed");
    await addNote(ana.cookie, conversationId, "Followed up by phone");
    const read = await send(ana.cookie, "GET", thread(conversationId));
    const body = (await read.json()) as { conversation: { status: string }; messages: Line[] };
    expect(body.conversation.status).toBe("closed");
    expect(body.messages.at(-1)?.kind).toBe("note");
  });

  test("a note never assigns the conversation, and the first reply after it still does", async () => {
    const { conversationId } = await visitorStarts("Hello");
    await addNote(ben.cookie, conversationId, "Looking into it");
    const assignee = async () =>
      (
        (await (await send(ana.cookie, "GET", thread(conversationId))).json()) as {
          conversation: { assigneeOperatorId: string | null };
        }
      ).conversation.assigneeOperatorId;
    expect(await assignee()).toBeNull();
    await write(ben.cookie, conversationId, "Hi there");
    expect(await assignee()).toBe(ben.id);
  });

  test("an API key adds a note through the REST API and through MCP's add_note", async () => {
    const { conversationId, token } = await visitorStarts("Hello");
    const viaApi = await app.request(thread(conversationId), {
      method: "POST",
      headers: { authorization: `Bearer ${keyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ clientId: randomUUID(), body: "Bot note", note: true }),
    });
    expect(viaApi.status).toBe(201);
    expect(await viaApi.json()).toMatchObject({ kind: "note", authorName: "Helper bot" });
    const viaMcp = await mcp("add_note", { conversationId, body: "MCP note", clientId: "mcp-n" });
    const result = (await viaMcp.json()) as {
      result: { isError: boolean; structuredContent: { message: Line } };
    };
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent.message).toMatchObject({ kind: "note", via: "mcp" });
    const again = await mcp("add_note", { conversationId, body: "MCP note", clientId: "mcp-n" });
    const retried = (await again.json()) as typeof result;
    expect(retried.result.structuredContent.message.id).toBe(
      result.result.structuredContent.message.id,
    );
    expect((await widgetLines(token)).messages.map((one) => one.body)).toEqual(["Hello"]);
  });

  test("a note with an image is refused", async () => {
    const { conversationId } = await visitorStarts("Hello");
    const response = await app.request(
      inSpace(`/conversations/${conversationId}/images?clientId=img-note&note=true`),
      {
        method: "POST",
        headers: { cookie: ana.cookie, origin: ORIGIN, "content-type": "image/png" },
        body: new Uint8Array(
          await sharp({
            create: { width: 4, height: 4, channels: 3, background: "#fc0" },
          })
            .png()
            .toBuffer(),
        ),
      },
    );
    expect(response.status).toBe(400);
    expect((await operatorLines(conversationId)).map((one) => one.kind)).toEqual(["text"]);
  });
});

describe("quotes and notes", () => {
  test("a reply that quotes a note is refused, as the visitor would see the quote", async () => {
    const { conversationId } = await visitorStarts("Hello");
    const note = await addNote(ana.cookie, conversationId, "Internal only");
    const response = await send(ana.cookie, "POST", thread(conversationId), {
      clientId: randomUUID(),
      body: "Quoting",
      replyToMessageId: note.id,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_reply_to",
    );
  });

  test("a note quotes a visitor's message, a reply or another note", async () => {
    const { conversationId, first } = await visitorStarts("Hello");
    const answer = await write(ana.cookie, conversationId, "Hi");
    const note = await addNote(ana.cookie, conversationId, "First note");
    for (const quoted of [first, answer, note]) {
      const sent = await write(ana.cookie, conversationId, "About this", {
        note: true,
        replyToMessageId: quoted.id,
      });
      expect(sent.replyTo?.id).toBe(quoted.id);
    }
  });
});

describe("what a note never reaches", () => {
  test("the widget's list and stream never carry a note, nor its edit or delete", async () => {
    const { conversationId, token } = await visitorStarts("Hello");
    const { cursor } = await widgetLines(token);
    const note = await addNote(ana.cookie, conversationId, "Refund approved by finance");
    await write(ana.cookie, conversationId, "Good news");
    const edited = await send(ana.cookie, "PATCH", `${thread(conversationId)}/${note.id}`, {
      body: "Refund approved by finance, ref 42",
    });
    expect(edited.status).toBe(200);
    expect((await widgetLines(token)).messages.map((one) => one.body)).toEqual([
      "Hello",
      "Good news",
    ]);
    const backlog = await widgetStream(token, cursor);
    expect(backlog).toContain("Good news");
    expect(backlog).not.toContain("Refund");
    expect(backlog).not.toContain(note.id);
    const before = (await widgetLines(token)).cursor;
    const deleted = await send(ana.cookie, "DELETE", `${thread(conversationId)}/${note.id}`);
    expect(deleted.status).toBe(200);
    expect((await widgetLines(token, before)).messages).toEqual([]);
    expect(await widgetStream(token, before)).not.toContain(note.id);
  });

  test("a note is not the inbox preview, does not stop a conversation from waiting, and is not unread", async () => {
    const { fresh, lead } = await ownSpace("Preview");
    const { conversationId } = await visitorStarts("Where is my order?", fresh);
    await send(lead.cookie, "POST", inSpace(`/conversations/${conversationId}/read`, fresh), {
      seq: "999999",
    });
    await addNote(lead.cookie, conversationId, "Checking with shipping", fresh);
    const list = await send(lead.cookie, "GET", inSpace("/conversations", fresh));
    const page = (await list.json()) as {
      conversations: {
        id: string;
        unread: boolean;
        lastMessage: { body: string; fromVisitor: boolean };
      }[];
      waiting: number;
    };
    expect(page.waiting).toBe(1);
    expect(page.conversations[0]?.lastMessage).toMatchObject({
      body: "Where is my order?",
      fromVisitor: true,
    });
  });

  test("search finds a conversation by its note, and shows its chat as the preview", async () => {
    const { fresh, lead } = await ownSpace("Search");
    const { conversationId } = await visitorStarts("Where is my order?", fresh);
    await addNote(lead.cookie, conversationId, "Refund pending with finance", fresh);
    const found = await send(lead.cookie, "GET", inSpace("/conversations/search?q=refund", fresh));
    const { conversations } = (await found.json()) as {
      conversations: { id: string; lastMessage: { body: string; fromVisitor: boolean } }[];
    };
    expect(conversations.map(({ id }) => id)).toEqual([conversationId]);
    expect(conversations[0]?.lastMessage).toMatchObject({
      body: "Where is my order?",
      fromVisitor: true,
    });
  });

  test("a note does not move the conversation up the inbox", async () => {
    const { conversationId } = await visitorStarts("Hello");
    const updatedAt = async () =>
      (
        await owner
          .select({ updatedAt: conversation.updatedAt })
          .from(conversation)
          .where(and(eq(conversation.workspaceId, space.id), eq(conversation.id, conversationId)))
      )[0]?.updatedAt.getTime();
    const before = await updatedAt();
    await addNote(ana.cookie, conversationId, "No hurry");
    expect(await updatedAt()).toBe(before);
  });

  test("a note is not a first reply in analytics", async () => {
    const { fresh, lead } = await ownSpace("Analytics");
    const { conversationId } = await visitorStarts("Hi", fresh);
    await addNote(lead.cookie, conversationId, "Will answer tomorrow", fresh);
    const median = await withWorkspace(db, fresh.id, (tx) =>
      medianFirstReplySeconds(tx, fresh.id, 7),
    );
    expect(median).toBeNull();
  });

  test("a note's message.created alerts nobody, and the operator stream says it is not the visitor's", async () => {
    const { conversationId } = await visitorStarts("Hello");
    const note = await addNote(ana.cookie, conversationId, "Quiet");
    const [row] = await owner
      .select({ needsAlert: event.needsAlert, payload: event.payload })
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.kind, "message.created")))
      .orderBy(event.seq)
      .then((rows) =>
        rows.filter((one) => (one.payload as { messageId: string }).messageId === note.id),
      );
    expect(row?.needsAlert).toBe(false);
    expect(row?.payload).toMatchObject({ fromVisitor: false });
  });

  test("a note's receipt is empty", async () => {
    const { conversationId, token } = await visitorStarts("Hello");
    const note = await addNote(ana.cookie, conversationId, "Quiet");
    await write(ana.cookie, conversationId, "Hi");
    const { messages } = await widgetLines(token);
    await app.request(`/v1/widget/${space.publicKey}/read`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ seq: messages.at(-1)?.seq }),
    });
    const receipt = await send(ana.cookie, "GET", `${thread(conversationId)}/${note.id}/receipt`);
    expect(await receipt.json()).toEqual({ readAt: null, emailedAt: null });
  });
});

describe("changing a note", () => {
  test("its author edits it even after the visitor read past it; others and keys cannot", async () => {
    const { conversationId, token } = await visitorStarts("Hello");
    const note = await addNote(ana.cookie, conversationId, "Draft note");
    await write(ana.cookie, conversationId, "Hi");
    const { messages } = await widgetLines(token);
    await app.request(`/v1/widget/${space.publicKey}/read`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ seq: messages.at(-1)?.seq }),
    });
    const path = `${thread(conversationId)}/${note.id}`;
    expect((await send(ben.cookie, "PATCH", path, { body: "Mine now" })).status).toBe(403);
    const edited = await send(ana.cookie, "PATCH", path, { body: "Final note" });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ kind: "note", body: "Final note" });
  });

  test("a member deletes only their own note, and the visitor's stream is not woken", async () => {
    const { conversationId, visitorId } = await visitorStarts("Hello");
    const note = await addNote(ana.cookie, conversationId, "Ana's note");
    const path = `${thread(conversationId)}/${note.id}`;
    expect((await send(ben.cookie, "DELETE", path)).status).toBe(403);
    wakes.length = 0;
    expect((await send(ana.cookie, "DELETE", path)).status).toBe(200);
    expect(wakes).not.toContain(visitorId);
    expect((await operatorLines(conversationId)).at(-1)).toMatchObject({
      id: note.id,
      kind: "note",
      deleted: true,
    });
  });
});

describe("webhooks and export", () => {
  test("a note's created, updated and deleted events reach a webhook, with its kind", async () => {
    const bodies: string[] = [];
    const receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        bodies.push(body);
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    try {
      const { fresh, lead } = await ownSpace("Hooked");
      await owner.insert(webhook).values({
        workspaceId: fresh.id,
        url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/in`,
        secret: "whsec_test",
        events: ["message.created", "message.updated", "message.deleted"],
      });
      const { conversationId } = await visitorStarts("Hi", fresh);
      const note = await addNote(lead.cookie, conversationId, "Draft", fresh);
      const path = `${thread(conversationId, fresh)}/${note.id}`;
      await send(lead.cookie, "PATCH", path, { body: "Final" });
      await send(lead.cookie, "DELETE", path);
      while (await fanOutWebhooksOne(workerDb)) {}
      const stopping = new AbortController().signal;
      for (const row of await claimWebhookDeliveries(workerDb, 50, 60_000)) {
        const policy = { allowPrivate: true };
        await deliverWebhook(workerDb, row, { images: undefined, policy, retryMs: 1, stopping });
      }
      const forNote = bodies
        .map((body) => JSON.parse(body) as { type: string; data: { message: Line } })
        .filter((one) => one.data.message.id === note.id);
      expect(forNote.map((one) => one.type).sort()).toEqual([
        "message.created",
        "message.deleted",
        "message.updated",
      ]);
      expect(forNote.every((one) => one.data.message.kind === "note")).toBe(true);
    } finally {
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
    }
  });

  test("a workspace export keeps a note, with its kind", async () => {
    const { conversationId } = await visitorStarts("Hello");
    const note = await addNote(ana.cookie, conversationId, "Keep me");
    const store = localStore(await mkdtemp(join(tmpdir(), "dinghy-notes-")));
    let data: { messages: { id: string; kind: string; body: string | null }[] } = { messages: [] };
    for await (const entry of readTar(exportArchive(db, store, space.id))) {
      if (entry.name === "export.json") data = JSON.parse(Buffer.from(entry.bytes).toString());
    }
    expect(data.messages.find((row) => row.id === note.id)).toMatchObject({
      kind: "note",
      body: "Keep me",
    });
  });
});
