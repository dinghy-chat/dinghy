import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { asc, eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, DATABASE_URL, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { type App, createApp } from "./app.ts";
import { inboundEmailFromConfig, loadConfig } from "./config.ts";
import { conversation, message, visitor } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { createReplyAddress } from "./inbound-email.ts";
import type { ShipmailInbound } from "./shipmail-inbound.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const DOMAIN = "reply.example.com";
const MAILBOX = "mbx_replies";
const API_KEY = "sm_live_test";
const WEBHOOK_SECRET = "a-shipmail-webhook-secret";
const PATH = "/v1/inbound-email/shipmail";
const logger = pino({ level: "silent" });
const ok = async () => {};

/**
 * Shipmail's inbox API for one mailbox, as the receiver uses it: a download, a move to Trash and a
 * delete that works only in Trash. `failing` makes every call with that method answer 500.
 */
async function fakeShipmail() {
  const messages = new Map<string, string>();
  const trashed = new Set<string>();
  const calls: string[] = [];
  const failing = new Set<string>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { method = "", url = "" } = request;
    calls.push(`${method} ${url}`);
    const match = /^\/api\/v1\/mailboxes\/([^/]+)\/inbox\/messages\/([^/]+)(\/raw|\/move)?$/.exec(
      url,
    );
    const [, mailbox, id = "", action] = match ?? [];
    if (request.headers.authorization !== `Bearer ${API_KEY}` || mailbox !== MAILBOX) {
      response.writeHead(401).end();
    } else if (failing.has(method)) {
      response.writeHead(500).end();
    } else if (!messages.has(id)) {
      response.writeHead(404).end();
    } else if (method === "GET" && action === "/raw") {
      response.writeHead(200, { "content-type": "message/rfc822" }).end(messages.get(id));
    } else if (
      method === "POST" &&
      action === "/move" &&
      JSON.parse(body).target_role === "trash"
    ) {
      trashed.add(id);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    } else if (method === "DELETE" && action === undefined && trashed.has(id)) {
      messages.delete(id);
      response.writeHead(204).end();
    } else {
      response.writeHead(422).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    apiBase: `http://127.0.0.1:${port}/api/v1`,
    messages,
    calls,
    failing,
    close: () => server.close(),
  };
}

let database: TestDatabase;
let db: Database;
let workerDb: Database;
let owner: Database;
let valkey: Redis;
let shipmail: Awaited<ReturnType<typeof fakeShipmail>>;
let app: App;
let space: NewWorkspace;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app").db;
  workerDb = database.connect("worker").db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
  shipmail = await fakeShipmail();
  const settings: ShipmailInbound = {
    apiBase: shipmail.apiBase,
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    mailboxId: MAILBOX,
  };
  app = createApp({
    db,
    inboundEmail: { domain: DOMAIN, shipmail: settings },
    logger,
    valkey,
    checks: { postgres: ok, valkey: ok },
  });
  space = await createWorkspace(db, "Acme", ["https://a.example.com"]);
});

beforeEach(() => {
  shipmail.calls.length = 0;
  shipmail.failing.clear();
});

afterAll(async () => {
  shipmail.close();
  valkey.disconnect();
  await database.drop();
});

/** A visitor's conversation and the reply address of an email about it. */
async function newChat() {
  const [row] = await owner
    .insert(visitor)
    .values({ workspaceId: space.id, tokenHash: randomUUID(), email: "ada@example.com" })
    .returning({ id: visitor.id });
  const visitorId = row?.id ?? "";
  const [started] = await owner
    .insert(conversation)
    .values({ workspaceId: space.id, visitorId })
    .returning({ id: conversation.id });
  const conversationId = started?.id ?? "";
  // The worker makes reply addresses, as it sends the emails that carry them.
  const address = await withWorkspace(workerDb, space.id, (tx) =>
    createReplyAddress(tx, space.id, visitorId, conversationId, DOMAIN),
  );
  return { conversationId, address };
}

/** An email in the Shipmail mailbox, as it arrived. Returns its ID there. */
function arrives(to: string, text: string, headers: string[] = []): string {
  const emailId = `eml_${randomUUID().replaceAll("-", "")}`;
  const raw = [
    "From: Ada <ada@example.com>",
    `To: ${to}`,
    "Subject: Re: Acme replied to your message",
    `Message-ID: <${randomUUID()}@mail.example.com>`,
    ...headers,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");
  shipmail.messages.set(emailId, raw);
  return emailId;
}

/** Shipmail's event for a message received in a mailbox, with the fields it sends. */
const receivedEvent = (emailId: string, mailboxId = MAILBOX, eventType = "message.received") => ({
  version: "2026-09-10",
  event_id: `evt_${emailId}`,
  event_type: eventType,
  created_at: new Date().toISOString(),
  test: false,
  data: {
    tracked_message_id: "msg_1",
    mailbox_id: mailboxId,
    email_id: emailId,
    rfc_message_id: "<x@mail.example.com>",
    from: { address: "ada@example.com", name: "Ada" },
    to: [{ address: "reply+x@reply.example.com", name: null }],
    cc: [],
    subject: "Re: Acme replied to your message",
    category: "human",
  },
});

const now = () => Math.floor(Date.now() / 1000);

/** Posts the event as Shipmail delivers it, signed with the webhook's secret. */
function deliver(event: object, { time = now(), secret = WEBHOOK_SECRET } = {}) {
  const body = JSON.stringify(event);
  const signature = createHmac("sha256", secret).update(`v1=${time}\n${body}`).digest("hex");
  return app.request(PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shipmail-timestamp": String(time),
      "x-shipmail-signature": signature,
    },
    body,
  });
}

const bodiesOf = async (conversationId: string) =>
  (
    await owner
      .select({ body: message.body })
      .from(message)
      .where(eq(message.conversationId, conversationId))
      .orderBy(asc(message.seq))
  ).map((row) => row.body);

describe("Shipmail's webhook", () => {
  test("stores the reply in its conversation, then deletes the message", async () => {
    const chat = await newChat();
    const emailId = arrives(chat.address, "Thanks, that fixed it.");
    const answer = await deliver(receivedEvent(emailId));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true });
    expect(await bodiesOf(chat.conversationId)).toEqual(["Thanks, that fixed it."]);
    const path = `/api/v1/mailboxes/${MAILBOX}/inbox/messages/${emailId}`;
    expect(shipmail.calls).toEqual([`GET ${path}/raw`, `POST ${path}/move`, `DELETE ${path}`]);
    expect(shipmail.messages.has(emailId)).toBe(false);
  });

  test("a bad signature or an old time is refused before anything is fetched", async () => {
    const chat = await newChat();
    const emailId = arrives(chat.address, "Signed?");
    const event = receivedEvent(emailId);
    expect((await deliver(event, { secret: "another-secret" })).status).toBe(401);
    expect((await deliver(event, { time: now() - 301 })).status).toBe(401);
    const unsigned = await app.request(PATH, { method: "POST", body: JSON.stringify(event) });
    expect(unsigned.status).toBe(401);
    expect(shipmail.calls).toEqual([]);
    expect(await bodiesOf(chat.conversationId)).toEqual([]);
  });

  test("another mailbox, another event and an unreadable body are ignored", async () => {
    const chat = await newChat();
    const emailId = arrives(chat.address, "Elsewhere");
    for (const event of [
      receivedEvent(emailId, "mbx_other"),
      receivedEvent(emailId, MAILBOX, "message.sent"),
      { event_type: "message.received", data: { mailbox_id: MAILBOX } },
    ]) {
      expect((await deliver(event)).status).toBe(200);
    }
    expect(shipmail.calls).toEqual([]);
    expect(shipmail.messages.has(emailId)).toBe(true);
  });

  test("a failed download answers 5xx and deletes nothing", async () => {
    const chat = await newChat();
    const emailId = arrives(chat.address, "Still there?");
    shipmail.failing.add("GET");
    expect((await deliver(receivedEvent(emailId))).status).toBe(500);
    expect(shipmail.calls.some((call) => !call.startsWith("GET"))).toBe(false);
    expect(shipmail.messages.has(emailId)).toBe(true);
    expect(await bodiesOf(chat.conversationId)).toEqual([]);
  });

  test("a retry after a failed delete adds nothing, and one after the delete does nothing", async () => {
    const chat = await newChat();
    const emailId = arrives(chat.address, "Once only");
    shipmail.failing.add("DELETE");
    expect((await deliver(receivedEvent(emailId))).status).toBe(500);
    shipmail.failing.clear();
    expect((await deliver(receivedEvent(emailId))).status).toBe(200);
    expect(shipmail.messages.has(emailId)).toBe(false);
    shipmail.calls.length = 0;
    expect((await deliver(receivedEvent(emailId))).status).toBe(200);
    expect(shipmail.calls).toEqual([
      `GET /api/v1/mailboxes/${MAILBOX}/inbox/messages/${emailId}/raw`,
    ]);
    expect(await bodiesOf(chat.conversationId)).toEqual(["Once only"]);
  });

  test("an automatic answer and an unknown address are dropped and deleted", async () => {
    const chat = await newChat();
    const autoReply = arrives(chat.address, "I am away.", ["Auto-Submitted: auto-replied"]);
    const unknown = arrives(`reply+${"0".repeat(32)}.${"a".repeat(25)}@${DOMAIN}`, "Hello?");
    for (const emailId of [autoReply, unknown]) {
      expect((await deliver(receivedEvent(emailId))).status).toBe(200);
      expect(shipmail.messages.has(emailId)).toBe(false);
    }
    expect(await bodiesOf(chat.conversationId)).toEqual([]);
  });
});

describe("the settings", () => {
  const base = { DATABASE_URL, VALKEY_URL, AUTH_SECRET, PUBLIC_URL };
  const trio = {
    SHIPMAIL_API_KEY: API_KEY,
    SHIPMAIL_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SHIPMAIL_MAILBOX_ID: MAILBOX,
  };

  test("Shipmail needs all three settings, and the domain needs a receiver", () => {
    const inbound = (env: Record<string, string>) =>
      inboundEmailFromConfig(loadConfig({ ...base, ...env }));
    expect(inbound({ INBOUND_EMAIL_DOMAIN: DOMAIN, ...trio })).toEqual({
      domain: DOMAIN,
      secret: undefined,
      shipmail: {
        apiBase: "https://shipmail.to/api/v1",
        apiKey: API_KEY,
        webhookSecret: WEBHOOK_SECRET,
        mailboxId: MAILBOX,
      },
    });
    const { SHIPMAIL_MAILBOX_ID: _left, ...two } = trio;
    expect(() => inbound({ INBOUND_EMAIL_DOMAIN: DOMAIN, ...two })).toThrow(
      /SHIPMAIL_MAILBOX_ID together/,
    );
    expect(() => inbound(trio)).toThrow(/INBOUND_EMAIL_DOMAIN/);
    expect(() => inbound({ INBOUND_EMAIL_DOMAIN: DOMAIN })).toThrow(/SHIPMAIL_API_KEY/);
  });

  test("with Shipmail alone, the raw route is off", async () => {
    const answer = await app.request("/v1/inbound-email", {
      method: "POST",
      headers: { "content-length": "2" },
      body: "hi",
    });
    expect(answer.status).toBe(404);
  });
});
