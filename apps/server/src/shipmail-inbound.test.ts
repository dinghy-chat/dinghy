import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { asc, eq, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, DATABASE_URL, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { type App, createApp } from "./app.ts";
import { inboundEmailFromConfig, loadConfig } from "./config.ts";
import {
  conversation,
  message,
  shipmailHeldEmail,
  subscription,
  visitor,
  workspace,
} from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import {
  createEmailIntake,
  createReplyAddress,
  EMAIL_MAX_BYTES,
  MESSAGES_PER_ADDRESS_PER_HOUR,
} from "./inbound-email.ts";
import { NO_LIMITS } from "./limits.ts";
import { noLive } from "./live.ts";
import { createRateLimit } from "./rate-limit.ts";
import { heldEmailStep, type ShipmailInbound } from "./shipmail-inbound.ts";
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
 * delete that works only in Trash. `failing` makes every call with that method answer 500,
 * `rawStatus` makes a message's download answer that status, and `downloads` holds every download
 * until it resolves.
 */
async function fakeShipmail() {
  const messages = new Map<string, string>();
  const trashed = new Set<string>();
  const calls: string[] = [];
  const failing = new Set<string>();
  const rawStatus = new Map<string, number>();
  const fake = { downloads: Promise.resolve() };
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
      await fake.downloads;
      const status = rawStatus.get(id) ?? 200;
      response.writeHead(status, { "content-type": "message/rfc822" }).end(messages.get(id));
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
  return Object.assign(fake, {
    apiBase: `http://127.0.0.1:${port}/api/v1`,
    messages,
    calls,
    failing,
    rawStatus,
    close: () => server.close(),
  });
}

let database: TestDatabase;
let db: Database;
let workerDb: Database;
let owner: Database;
let valkey: Redis;
let shipmail: Awaited<ReturnType<typeof fakeShipmail>>;
let app: App;
let space: NewWorkspace;
let takeHeldEmails: () => Promise<boolean>;

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
  // As the worker process builds it: the intake writes with the app's role.
  const intake = createEmailIntake({
    db,
    domain: DOMAIN,
    uploads: undefined,
    limits: NO_LIMITS,
    live: noLive,
    rateLimit: createRateLimit(valkey, logger),
  });
  takeHeldEmails = heldEmailStep({ db, workerDb, intake, settings, logger });
});

beforeEach(() => {
  shipmail.calls.length = 0;
  shipmail.failing.clear();
  shipmail.rawStatus.clear();
  shipmail.downloads = Promise.resolve();
});

afterAll(async () => {
  shipmail.close();
  valkey.disconnect();
  await database.drop();
});

/** A visitor's conversation and the reply address of an email about it. */
async function newChat(inSpace = space) {
  const [row] = await owner
    .insert(visitor)
    .values({ workspaceId: inSpace.id, tokenHash: randomUUID(), email: "ada@example.com" })
    .returning({ id: visitor.id });
  const visitorId = row?.id ?? "";
  const [started] = await owner
    .insert(conversation)
    .values({ workspaceId: inSpace.id, visitorId })
    .returning({ id: conversation.id });
  const conversationId = started?.id ?? "";
  // The worker makes reply addresses, as it sends the emails that carry them.
  const address = await withWorkspace(workerDb, inSpace.id, (tx) =>
    createReplyAddress(tx, inSpace.id, visitorId, conversationId, DOMAIN),
  );
  return { visitorId, conversationId, address };
}

/** A chat in a new workspace of its own, for a test that changes the workspace. */
async function chatInNewWorkspace() {
  const own = await createWorkspace(db, "Own", ["https://own.example.com"]);
  return { workspaceId: own.id, ...(await newChat(own)) };
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

  test("a suspended workspace's email stays in the mailbox, answered 200 so Shipmail stops", async () => {
    const chat = await newChat();
    const emailId = arrives(chat.address, "Anyone there?");
    const suspend = (at: Date | null) =>
      owner.update(workspace).set({ suspendedAt: at }).where(eq(workspace.id, space.id));
    await suspend(new Date());
    try {
      expect((await deliver(receivedEvent(emailId))).status).toBe(200);
    } finally {
      await suspend(null);
    }
    expect(shipmail.messages.has(emailId)).toBe(true);
    expect(await bodiesOf(chat.conversationId)).toEqual([]);
  });

  test("an unpaid or read-only workspace's email stays in the mailbox", async () => {
    const unpaid = await chatInNewWorkspace();
    await owner
      .update(workspace)
      .set({ active: false })
      .where(eq(workspace.id, unpaid.workspaceId));
    const readOnly = await chatInNewWorkspace();
    await owner.insert(subscription).values({
      workspaceId: readOnly.workspaceId,
      stripeCustomerId: "cus_test",
      readOnlyAt: new Date(),
    });
    for (const chat of [unpaid, readOnly]) {
      const emailId = arrives(chat.address, "Still open?");
      expect((await deliver(receivedEvent(emailId))).status).toBe(200);
      expect(shipmail.messages.has(emailId)).toBe(true);
      expect(await bodiesOf(chat.conversationId)).toEqual([]);
    }
  });

  test("a deleted workspace's email is refused for good and deleted", async () => {
    const chat = await chatInNewWorkspace();
    await owner
      .update(workspace)
      .set({ deletedAt: new Date() })
      .where(eq(workspace.id, chat.workspaceId));
    const emailId = arrives(chat.address, "Hello?");
    expect((await deliver(receivedEvent(emailId))).status).toBe(200);
    expect(shipmail.messages.has(emailId)).toBe(false);
    expect(await bodiesOf(chat.conversationId)).toEqual([]);
  });

  test("an automatic answer, an unknown address and a blocked visitor are dropped and deleted", async () => {
    const chat = await newChat();
    const blocked = await newChat();
    await owner
      .update(visitor)
      .set({ blockedAt: new Date() })
      .where(eq(visitor.id, blocked.visitorId));
    const autoReply = arrives(chat.address, "I am away.", ["Auto-Submitted: auto-replied"]);
    const unknown = arrives(`reply+${"0".repeat(32)}.${"a".repeat(25)}@${DOMAIN}`, "Hello?");
    const fromBlocked = arrives(blocked.address, "Let me in");
    for (const emailId of [autoReply, unknown, fromBlocked]) {
      expect((await deliver(receivedEvent(emailId))).status).toBe(200);
      expect(shipmail.messages.has(emailId)).toBe(false);
    }
    expect(await bodiesOf(chat.conversationId)).toEqual([]);
    expect(await bodiesOf(blocked.conversationId)).toEqual([]);
  });

  test("an email over the limit is deleted, whether Shipmail or the download finds it", async () => {
    const chat = await newChat();
    const refusedByShipmail = arrives(chat.address, "Huge");
    shipmail.rawStatus.set(refusedByShipmail, 413);
    const overLimit = arrives(chat.address, "x".repeat(EMAIL_MAX_BYTES));
    for (const emailId of [refusedByShipmail, overLimit]) {
      expect((await deliver(receivedEvent(emailId))).status).toBe(200);
      expect(shipmail.messages.has(emailId)).toBe(false);
    }
    expect(await bodiesOf(chat.conversationId)).toEqual([]);
  });

  test("past the hourly limit, the answer is 429 with Retry-After, and the email stays", async () => {
    const chat = await newChat();
    for (let sent = 0; sent < MESSAGES_PER_ADDRESS_PER_HOUR; sent += 1) {
      const emailId = arrives(chat.address, `Message ${sent + 1}`);
      expect((await deliver(receivedEvent(emailId))).status).toBe(200);
    }
    const emailId = arrives(chat.address, "One too many");
    const answer = await deliver(receivedEvent(emailId));
    expect(answer.status).toBe(429);
    expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await answer.json()).toMatchObject({ error: { code: "too_many_requests" } });
    expect(shipmail.messages.has(emailId)).toBe(true);
  });

  test("while 4 emails are held, the answer is 503 with Retry-After, and the email stays", async () => {
    const chat = await newChat();
    let release = () => {};
    shipmail.downloads = new Promise((resolve) => {
      release = resolve;
    });
    const held = Array.from({ length: 4 }, (_, index) =>
      deliver(receivedEvent(arrives(chat.address, `Held ${index + 1}`))),
    );
    // The held deliveries reach the download, which waits, before the fifth comes.
    await expect.poll(() => shipmail.calls.length).toBe(4);
    const emailId = arrives(chat.address, "A fifth");
    const answer = await deliver(receivedEvent(emailId));
    release();
    expect(answer.status).toBe(503);
    expect(answer.headers.get("retry-after")).toBe("1");
    expect(await answer.json()).toMatchObject({ error: { code: "busy" } });
    expect(shipmail.messages.has(emailId)).toBe(true);
    expect((await Promise.all(held)).map((one) => one.status)).toEqual([200, 200, 200, 200]);
  });

  test("an event over 256 KB is refused as too_large", async () => {
    const answer = await deliver({ ...receivedEvent("eml_x"), padding: "x".repeat(256 * 1024) });
    expect(answer.status).toBe(413);
    expect(await answer.json()).toMatchObject({ error: { code: "too_large" } });
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
    expect(() => inbound({ INBOUND_EMAIL_DOMAIN: DOMAIN })).toThrow(/three SHIPMAIL_ settings/);
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

/** The worker's passes over kept emails, until one claims nothing. */
async function workerPasses() {
  while (await takeHeldEmails()) {}
}

/** The Shipmail IDs of the emails kept for a workspace, as the worker sees them. */
const heldIn = async (workspaceId: string) =>
  (
    await owner
      .select({ emailId: shipmailHeldEmail.emailId })
      .from(shipmailHeldEmail)
      .where(eq(shipmailHeldEmail.workspaceId, workspaceId))
  ).map((row) => row.emailId);

const setSuspended = (workspaceId: string, at: Date | null) =>
  owner.update(workspace).set({ suspendedAt: at }).where(eq(workspace.id, workspaceId));

/** A reply that arrives while its workspace is suspended, and that the webhook keeps. */
async function keptEmail(text: string) {
  const chat = await chatInNewWorkspace();
  await setSuspended(chat.workspaceId, new Date());
  const emailId = arrives(chat.address, text);
  expect((await deliver(receivedEvent(emailId))).status).toBe(200);
  expect(await heldIn(chat.workspaceId)).toEqual([emailId]);
  return { ...chat, emailId };
}

/** Makes a kept email due again now, as when its claim ran out. */
const dueNow = (emailId: string) =>
  owner
    .update(shipmailHeldEmail)
    .set({ nextTryAt: sql`now()` })
    .where(eq(shipmailHeldEmail.emailId, emailId));

describe("a kept email", () => {
  test("stays while the workspace is closed, and comes in once it opens again", async () => {
    const kept = await keptEmail("Are you back?");
    await workerPasses();
    expect(shipmail.messages.has(kept.emailId)).toBe(true);
    expect(await heldIn(kept.workspaceId)).toEqual([kept.emailId]);
    await setSuspended(kept.workspaceId, null);
    await workerPasses();
    expect(await bodiesOf(kept.conversationId)).toEqual(["Are you back?"]);
    expect(shipmail.messages.has(kept.emailId)).toBe(false);
    expect(await heldIn(kept.workspaceId)).toEqual([]);
  });

  test("a second delivery of its event keeps one row and its first time", async () => {
    const kept = await keptEmail("Twice");
    const [first] = await owner
      .select({ heldAt: shipmailHeldEmail.heldAt })
      .from(shipmailHeldEmail)
      .where(eq(shipmailHeldEmail.emailId, kept.emailId));
    expect((await deliver(receivedEvent(kept.emailId))).status).toBe(200);
    expect(
      await owner
        .select({ heldAt: shipmailHeldEmail.heldAt })
        .from(shipmailHeldEmail)
        .where(eq(shipmailHeldEmail.emailId, kept.emailId)),
    ).toEqual([first]);
  });

  test("is deleted from the mailbox after 90 days if the workspace never opens", async () => {
    const kept = await keptEmail("Too late");
    await owner
      .update(shipmailHeldEmail)
      .set({ heldAt: sql`now() - interval '91 days'` })
      .where(eq(shipmailHeldEmail.emailId, kept.emailId));
    await workerPasses();
    expect(shipmail.messages.has(kept.emailId)).toBe(false);
    expect(await heldIn(kept.workspaceId)).toEqual([]);
    expect(await bodiesOf(kept.conversationId)).toEqual([]);
  });

  test("whose message is gone at Shipmail clears its row", async () => {
    const kept = await keptEmail("Gone");
    shipmail.messages.delete(kept.emailId);
    await setSuspended(kept.workspaceId, null);
    await workerPasses();
    expect(await heldIn(kept.workspaceId)).toEqual([]);
    expect(await bodiesOf(kept.conversationId)).toEqual([]);
  });

  test("whose download fails stays for a later pass, and comes in then", async () => {
    const kept = await keptEmail("Retry me");
    await setSuspended(kept.workspaceId, null);
    shipmail.failing.add("GET");
    await workerPasses();
    expect(await heldIn(kept.workspaceId)).toEqual([kept.emailId]);
    expect(shipmail.messages.has(kept.emailId)).toBe(true);
    // The claim holds it back until it runs out.
    shipmail.failing.clear();
    shipmail.calls.length = 0;
    await workerPasses();
    expect(shipmail.calls).toEqual([]);
    await dueNow(kept.emailId);
    await workerPasses();
    expect(await bodiesOf(kept.conversationId)).toEqual(["Retry me"]);
    expect(await heldIn(kept.workspaceId)).toEqual([]);
  });

  test("of a workspace deleted meanwhile is refused for good and deleted", async () => {
    const kept = await keptEmail("Still there?");
    await owner
      .update(workspace)
      .set({ deletedAt: new Date() })
      .where(eq(workspace.id, kept.workspaceId));
    await workerPasses();
    expect(shipmail.messages.has(kept.emailId)).toBe(false);
    expect(await heldIn(kept.workspaceId)).toEqual([]);
  });

  test("stays in its workspace: the app cannot note one for another workspace or read any", async () => {
    const kept = await keptEmail("Mine");
    const other = await createWorkspace(db, "Other", ["https://other.example.com"]);
    await expect(
      withWorkspace(db, other.id, (tx) =>
        tx.insert(shipmailHeldEmail).values({ workspaceId: kept.workspaceId, emailId: "eml_x" }),
      ),
    ).rejects.toThrow();
    await expect(
      withWorkspace(db, kept.workspaceId, (tx) => tx.select().from(shipmailHeldEmail)),
    ).rejects.toThrow();
    expect(await heldIn(kept.workspaceId)).toEqual([kept.emailId]);
  });
});
