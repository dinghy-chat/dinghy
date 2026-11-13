import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { setReplyMode } from "../test/keys.ts";
import { untilWaiting } from "../test/locks.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, withKey } from "../test/requests.ts";
import { SITE, visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { readTar } from "./archive.ts";
import { createAuth } from "./auth.ts";
import {
  alertDelivery,
  attachment,
  event,
  message,
  storageDeletion,
  webhook,
  webhookDelivery,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import type { Live } from "./live.ts";
import { appendMessage, listConversationMessages } from "./messages.ts";
import { localStore } from "./storage.ts";
import type { Role } from "./team.ts";
import { DAY_MS, RETENTION_MS } from "./time.ts";
import { exportArchive } from "./transfer.ts";
import { fanOutWebhooksOne } from "./webhooks.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });

let database: TestDatabase;
let db: Database;
let owner: Database;
let workerDb: Database;
let app: App;
let space: NewWorkspace;
let other: NewWorkspace;
let ana: { id: string; cookie: string };
let ben: { id: string; cookie: string };
let cleo: { id: string; cookie: string };
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

interface Quote {
  id: string | null;
  authorName: string | null;
  fromVisitor: boolean;
  text: string;
  hasImage: boolean;
}
interface Line {
  id: string;
  seq: string;
  body: string | null;
  fromVisitor: boolean;
  replyTo: Quote | null;
  editedAt?: string | null;
  deleted: boolean;
  readAt?: string | null;
  via?: string | null;
  image: unknown;
}

const widget = (token: string, method: string, path: string, body?: unknown) =>
  app.request(`/v1/widget/${space.publicKey}/${path}`, {
    method,
    headers: {
      origin: SITE,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const thread = (conversationId: string) =>
  `/v1/operator/workspaces/${space.id}/conversations/${conversationId}/messages`;

async function reply(
  cookie: string,
  conversationId: string,
  body: string,
  replyToMessageId?: string,
): Promise<Line> {
  const response = await asOperator(app, cookie, "POST", thread(conversationId), {
    clientId: randomUUID(),
    body,
    replyToMessageId,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Line;
}

async function operatorLines(conversationId: string): Promise<Line[]> {
  const response = await asOperator(app, ana.cookie, "GET", thread(conversationId));
  return ((await response.json()) as { messages: Line[] }).messages;
}

async function widgetLines(token: string, after?: string) {
  const query = after === undefined ? "" : `?after=${after}`;
  const response = await widget(token, "GET", `messages${query}`);
  return (await response.json()) as { messages: Line[]; cursor: string };
}

async function member(email: string, name: string, role: Role) {
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  return signedInOperator({ app, auth, owner, email, name, workspaceId: space.id, role });
}

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
  });
  space = await createWorkspace(db, "Acme", [SITE]);
  other = await createWorkspace(db, "Beta", [SITE]);
  ana = await member("ana@example.com", "Ana Lee", "owner");
  ben = await member("ben@example.com", "Ben", "member");
  cleo = await member("cleo@example.com", "Cleo", "admin");
  const made = await asOperator(
    app,
    ana.cookie,
    "POST",
    `/v1/operator/workspaces/${space.id}/api-keys`,
    {
      name: "Helper bot",
    },
  );
  const key = (await made.json()) as { id: string; token: string };
  await setReplyMode(owner, key.id, "send");
  keyToken = key.token;
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("a reply with a quote", () => {
  test("an operator quotes a visitor's message, and both sides show the quote", async () => {
    const { token, conversationId, first } = await visitorStarts(
      app,
      space.publicKey,
      "Do you have a **yearly** plan? See [pricing](https://example.com/p)",
    );
    const sent = await reply(ana.cookie, conversationId, "Yes.", first.id);
    const quote = {
      id: first.id,
      authorName: null,
      fromVisitor: true,
      text: "Do you have a yearly plan? See pricing",
      hasImage: false,
    };
    expect(sent.replyTo).toEqual(quote);
    expect((await operatorLines(conversationId)).at(-1)?.replyTo).toEqual(quote);
    expect((await widgetLines(token)).messages.at(-1)?.replyTo).toEqual(quote);
  });

  test("a visitor quotes a reply: the operator sees the full name, the visitor the first name", async () => {
    const { token, conversationId } = await visitorStarts(app, space.publicKey, "Hello");
    const answer = await reply(ana.cookie, conversationId, "x".repeat(300));
    const response = await widget(token, "POST", "messages", {
      clientId: randomUUID(),
      body: "Thanks",
      replyToMessageId: answer.id,
    });
    expect(response.status).toBe(201);
    // The whole message, however long.
    const text = "x".repeat(300);
    expect((await operatorLines(conversationId)).at(-1)?.replyTo).toMatchObject({
      id: answer.id,
      authorName: "Ana Lee",
      text,
    });
    expect((await widgetLines(token)).messages.at(-1)?.replyTo).toMatchObject({
      authorName: "Ana",
      text,
    });
  });

  test("a quote from another conversation, another workspace or a status line is refused", async () => {
    const mine = await visitorStarts(app, space.publicKey, "Mine");
    const elsewhere = await visitorStarts(app, space.publicKey, "Elsewhere");
    const theirs = await visitorStarts(app, other.publicKey, "Theirs");
    await asOperator(
      app,
      ana.cookie,
      "PATCH",
      `/v1/operator/workspaces/${space.id}/conversations/${mine.conversationId}`,
      {
        status: "closed",
      },
    );
    await asOperator(
      app,
      ana.cookie,
      "PATCH",
      `/v1/operator/workspaces/${space.id}/conversations/${mine.conversationId}`,
      {
        status: "open",
      },
    );
    const status = (await operatorLines(mine.conversationId)).at(-1);
    for (const quoted of [elsewhere.first.id, theirs.first.id, status?.id ?? "", randomUUID()]) {
      const response = await asOperator(app, ana.cookie, "POST", thread(mine.conversationId), {
        clientId: randomUUID(),
        body: "No",
        replyToMessageId: quoted,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_reply_to" } });
    }
    const fromWidget = await widget(mine.token, "POST", "messages", {
      clientId: randomUUID(),
      body: "No",
      replyToMessageId: elsewhere.first.id,
    });
    expect(fromWidget.status).toBe(400);
    expect(await fromWidget.json()).toMatchObject({ error: { code: "invalid_reply_to" } });
  });

  test("a deleted quoted message leaves the quote with no ID", async () => {
    const { token, conversationId, first } = await visitorStarts(
      app,
      space.publicKey,
      "My card is 4242 4242 4242 4242",
    );
    const quoting = await reply(ana.cookie, conversationId, "Please never send that.", first.id);
    const { cursor } = await widgetLines(token);
    const removed = await asOperator(
      app,
      ana.cookie,
      "DELETE",
      `${thread(conversationId)}/${first.id}`,
    );
    expect(removed.status).toBe(200);
    const deleted = { id: null, fromVisitor: true, text: "", hasImage: false };
    expect((await operatorLines(conversationId)).at(-1)?.replyTo).toMatchObject(deleted);
    // An open chat gets the reply that quotes it again, with its new quote, after the delete.
    const live = await widgetLines(token, cursor);
    expect(live.messages.map((line) => [line.id, line.replyTo?.id ?? null])).toEqual([
      [first.id, null],
      [quoting.id, null],
    ]);
    expect(live.messages[1]?.replyTo).toMatchObject(deleted);
    // The widget's history comes in change order, so the delete sends the quoted row last.
    const widgetReply = (await widgetLines(token)).messages.find((line) => line.replyTo !== null);
    expect(widgetReply?.replyTo).toMatchObject(deleted);
    expect(JSON.stringify(await operatorLines(conversationId))).not.toContain("4242");
  });

  test("a list reads every quote in its one statement", async () => {
    const { conversationId, first } = await visitorStarts(app, space.publicKey, "One");
    for (let n = 0; n < 3; n += 1) await reply(ana.cookie, conversationId, `Answer ${n}`, first.id);
    let statements = 0;
    const page = await withWorkspace(db, space.id, (tx) => {
      const counted = new Proxy(tx, {
        get(target, name, receiver) {
          if (name === "select" || name === "execute") statements += 1;
          const value = Reflect.get(target, name, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Transaction;
      return listConversationMessages(counted, space.id, conversationId, 0n, 100);
    });
    expect(statements).toBe(1);
    expect(page.messages.filter((line) => line.replyTo?.id === first.id)).toHaveLength(3);
  });
});

describe("editing a reply", () => {
  test("the author edits it, and the widget and the other operators get it again", async () => {
    const { token, visitorId, conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const sent = await reply(ana.cookie, conversationId, "Teh answer");
    const before = await widgetLines(token);
    wakes.length = 0;
    const response = await asOperator(
      app,
      ana.cookie,
      "PATCH",
      `${thread(conversationId)}/${sent.id}`,
      {
        body: "The answer",
      },
    );
    expect(response.status).toBe(200);
    const edited = (await response.json()) as Line;
    expect(edited).toMatchObject({ body: "The answer", seq: sent.seq });
    expect(edited.editedAt).not.toBeNull();
    expect(wakes).toContain(visitorId);
    // A stream from the old cursor sends the message again, with its new text.
    const after = await widgetLines(token, before.cursor);
    expect(after.messages.map((line) => [line.id, line.body])).toEqual([[sent.id, "The answer"]]);
    const events = await withWorkspace(db, space.id, (tx) =>
      tx
        .select({ kind: event.kind, payload: event.payload })
        .from(event)
        .where(eq(event.workspaceId, space.id)),
    );
    expect(events.at(-1)).toEqual({
      kind: "message.updated",
      payload: { messageId: sent.id, conversationId, fromVisitor: false },
    });
  });

  test("an edit sends again the replies that quote it, with the new words", async () => {
    const { token, conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const sent = await reply(ana.cookie, conversationId, "Teh **answer**");
    const quoting = await reply(ana.cookie, conversationId, "And more", sent.id);
    const { cursor } = await widgetLines(token);
    await asOperator(app, ana.cookie, "PATCH", `${thread(conversationId)}/${sent.id}`, {
      body: "The **answer**",
    });
    const live = await widgetLines(token, cursor);
    expect(live.messages.map((line) => [line.id, line.replyTo?.text ?? null])).toEqual([
      [sent.id, null],
      [quoting.id, "The answer"],
    ]);
  });

  test("only the operator who wrote a text reply may edit it, and never a key", async () => {
    const { conversationId, first } = await visitorStarts(app, space.publicKey, "Hi");
    const sent = await reply(ana.cookie, conversationId, "Mine");
    const path = `${thread(conversationId)}/${sent.id}`;
    expect((await asOperator(app, ben.cookie, "PATCH", path, { body: "Ben's" })).status).toBe(403);
    expect((await asOperator(app, cleo.cookie, "PATCH", path, { body: "Cleo's" })).status).toBe(
      403,
    );
    expect((await withKey(app, keyToken, "PATCH", path, { body: "Bot's" })).status).toBe(403);
    const visitorsOwn = `${thread(conversationId)}/${first.id}`;
    expect(
      (await asOperator(app, ana.cookie, "PATCH", visitorsOwn, { body: "Changed" })).status,
    ).toBe(403);
    expect((await operatorLines(conversationId)).at(-1)?.body).toBe("Mine");
  });

  test("a reply the visitor read can no longer change", async () => {
    const { token, conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const sent = await reply(ana.cookie, conversationId, "Read me");
    expect((await widget(token, "POST", "read", { seq: sent.seq })).status).toBe(200);
    const response = await asOperator(
      app,
      ana.cookie,
      "PATCH",
      `${thread(conversationId)}/${sent.id}`,
      {
        body: "Too late",
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "message_seen" } });
  });

  test("a reply older than the record of its emails can no longer change", async () => {
    const { conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const sent = await reply(ana.cookie, conversationId, "Long ago");
    // The record of what an email carried is pruned after RETENTION_MS, so an older reply may
    // have reached the visitor's inbox with no trace left.
    await withWorkspace(db, space.id, (tx) =>
      tx
        .update(message)
        .set({ createdAt: new Date(Date.now() - RETENTION_MS - DAY_MS) })
        .where(and(eq(message.workspaceId, space.id), eq(message.id, sent.id))),
    );
    const response = await asOperator(
      app,
      ana.cookie,
      "PATCH",
      `${thread(conversationId)}/${sent.id}`,
      {
        body: "Rewritten",
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "message_seen" } });
  });

  test("a reply an email carried, or one an email is sending now, can no longer change", async () => {
    for (const state of ["sent", "sending"] as const) {
      const { visitorId, conversationId } = await visitorStarts(app, space.publicKey, "Hi");
      const sent = await reply(ana.cookie, conversationId, "Emailed");
      await owner.insert(alertDelivery).values({
        workspaceId: space.id,
        eventSeq: BigInt(sent.seq),
        conversationId,
        messageId: sent.id,
        visitorId,
        channel: "email",
        coveredFromSeq: BigInt(sent.seq),
        coveredToSeq: BigInt(sent.seq),
        ...(state === "sent"
          ? { outcome: "sent", finishedAt: new Date(Date.now() + 1000) }
          : { claimedUntil: new Date(Date.now() + 60_000) }),
      });
      const response = await asOperator(
        app,
        ana.cookie,
        "PATCH",
        `${thread(conversationId)}/${sent.id}`,
        {
          body: "Changed",
        },
      );
      expect(response.status).toBe(409);
    }
  });
});

describe("edits and reads at once", () => {
  test("a visitor's read and an edit that wait for the same visitor both finish", async () => {
    const { token, visitorId, conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const sent = await reply(ana.cookie, conversationId, "Teh answer");
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Another read holds the visitor's row, so the read and the edit below line up behind it.
    const holder = owner.transaction(async (tx) => {
      await tx.execute(sql`select 1 from visitor where id = ${visitorId} for update`);
      held.resolve();
      await release.promise;
    });
    try {
      await held.promise;
      const read = widget(token, "POST", "read", { seq: sent.seq });
      await untilWaiting(owner, 1);
      const edit = asOperator(app, ana.cookie, "PATCH", `${thread(conversationId)}/${sent.id}`, {
        body: "The answer",
      });
      await untilWaiting(owner, 2);
      release.resolve();
      await holder;
      // The read goes first, so the visitor saw the old text and the edit is refused, not stuck.
      expect((await read).status).toBe(200);
      expect((await edit).status).toBe(409);
    } finally {
      release.resolve();
    }
  });
});

describe("deleting a message", () => {
  test("the author deletes their own; a member may not delete someone else's", async () => {
    const { conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const anas = await reply(ana.cookie, conversationId, "Ana's");
    const bens = await reply(ben.cookie, conversationId, "Ben's");
    expect(
      (await asOperator(app, ben.cookie, "DELETE", `${thread(conversationId)}/${anas.id}`)).status,
    ).toBe(403);
    expect(
      (await asOperator(app, ben.cookie, "DELETE", `${thread(conversationId)}/${bens.id}`)).status,
    ).toBe(200);
    expect(
      (await withKey(app, keyToken, "DELETE", `${thread(conversationId)}/${anas.id}`)).status,
    ).toBe(403);
    const lines = await operatorLines(conversationId);
    expect(lines.find((line) => line.id === anas.id)).toMatchObject({ deleted: false });
    expect(lines.find((line) => line.id === bens.id)).toMatchObject({ deleted: true, body: null });
  });

  test("an admin deletes a visitor's message, and its image goes to the worker to delete", async () => {
    const { token, conversationId, visitorId } = await visitorStarts(app, space.publicKey, "Look");
    const shot = await withWorkspace(db, space.id, (tx) =>
      appendMessage(
        tx,
        space.id,
        { kind: "visitor", visitorId },
        {
          clientId: randomUUID(),
          attachment: {
            kind: "image",
            attachmentId: randomUUID(),
            storageKey: `${space.id}/shot-${randomUUID()}`,
            byteSize: 10,
            contentType: "image/png",
            width: 4,
            height: 3,
          },
        },
      ),
    );
    const before = await widgetLines(token);
    const response = await asOperator(
      app,
      cleo.cookie,
      "DELETE",
      `${thread(conversationId)}/${shot.message.id}`,
    );
    expect(response.status).toBe(200);
    const files = await owner
      .select({ messageId: attachment.messageId })
      .from(attachment)
      .where(eq(attachment.messageId, shot.message.id));
    expect(files).toEqual([]);
    const queued = await owner
      .select({ storageKey: storageDeletion.storageKey })
      .from(storageDeletion)
      .where(eq(storageDeletion.workspaceId, space.id));
    expect(queued.map((row) => row.storageKey)).toContainEqual(
      expect.stringContaining(`${space.id}/shot-`),
    );
    const again = await widgetLines(token, before.cursor);
    expect(again.messages).toEqual([
      expect.objectContaining({ id: shot.message.id, deleted: true, body: null, image: null }),
    ]);
  });

  test("an export shows a deleted message with no body", async () => {
    const { conversationId, first } = await visitorStarts(app, space.publicKey, "Secret 123");
    await asOperator(app, ana.cookie, "DELETE", `${thread(conversationId)}/${first.id}`);
    const store = localStore(await mkdtemp(join(tmpdir(), "dinghy-actions-")));
    let data: { messages: { id: string; body: string | null; deletedAt: string | null }[] } = {
      messages: [],
    };
    for await (const entry of readTar(exportArchive(db, store, space.id))) {
      if (entry.name === "export.json") data = JSON.parse(Buffer.from(entry.bytes).toString());
    }
    const exported = data.messages.find((row) => row.id === first.id);
    expect(exported?.body).toBeNull();
    expect(exported?.deletedAt).not.toBeNull();
  });
});

describe("webhooks and info", () => {
  test("an edit and a delete each reach a webhook, with the message", async () => {
    const hooked = await createWorkspace(db, "Hooked", [SITE]);
    await owner.insert(webhook).values({
      workspaceId: hooked.id,
      url: "https://hooks.example.com/in",
      secret: "whsec_test",
      events: ["message.updated", "message.deleted"],
    });
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const dana = await signedInOperator({
      app,
      auth,
      owner,
      email: "dana@example.com",
      name: "Dana",
      workspaceId: hooked.id,
    });
    const { conversationId } = await visitorStarts(app, hooked.publicKey, "Hi");
    const path = `/v1/operator/workspaces/${hooked.id}/conversations/${conversationId}/messages`;
    const sent = await asOperator(app, dana.cookie, "POST", path, {
      clientId: randomUUID(),
      body: "Draft",
    });
    const { id } = (await sent.json()) as { id: string };
    await asOperator(app, dana.cookie, "PATCH", `${path}/${id}`, { body: "Final" });
    await asOperator(app, dana.cookie, "DELETE", `${path}/${id}`);
    while (await fanOutWebhooksOne(workerDb)) {}
    const rows = await owner
      .select({ type: webhookDelivery.type, messageId: webhookDelivery.messageId })
      .from(webhookDelivery)
      .where(eq(webhookDelivery.workspaceId, hooked.id));
    expect(rows).toEqual([
      { type: "message.updated", messageId: id },
      { type: "message.deleted", messageId: id },
    ]);
  });

  test("a key's reply says whether it came through the API or MCP, and a read sets its time", async () => {
    const { token, conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const viaApi = await withKey(app, keyToken, "POST", thread(conversationId), {
      clientId: randomUUID(),
      body: "From the API",
    });
    expect(await viaApi.json()).toMatchObject({ authorName: "Helper bot", via: "api" });
    const viaMcp = await app.request("/v1/mcp", {
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
        params: {
          name: "reply",
          arguments: { conversationId, body: "From MCP", clientId: "mcp-1" },
        },
      }),
    });
    expect(viaMcp.status).toBe(200);
    const lines = await operatorLines(conversationId);
    const last = lines.at(-1);
    expect(last).toMatchObject({ body: "From MCP", via: "mcp", readAt: null });
    await widget(token, "POST", "read", { seq: last?.seq });
    const receipt = await asOperator(
      app,
      ana.cookie,
      "GET",
      `${thread(conversationId)}/${last?.id}/receipt`,
    );
    expect(await receipt.json()).toMatchObject({ emailedAt: null, readAt: expect.any(String) });
    const read = await owner
      .select({ readAt: message.readAt })
      .from(message)
      .where(and(eq(message.workspaceId, space.id), eq(message.conversationId, conversationId)));
    // The visitor's own message is never "read" by them.
    expect(read.filter((row) => row.readAt !== null)).toHaveLength(2);
  });
});
