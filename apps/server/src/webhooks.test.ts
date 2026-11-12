import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { setReplyMode } from "../test/keys.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, withKey } from "../test/requests.ts";
import { SITE, visitorStarts } from "../test/visitors.ts";
import { pruneOnce } from "./alerts.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { event, webhook, webhookDelivery } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import {
  claimWebhookDeliveries,
  deliverWebhook,
  fanOutWebhooksOne,
  isPrivateAddress,
  PUBLIC_ONLY,
  responseExcerpt,
  signature,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookPolicy,
} from "./webhooks.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });
const ok = async () => {};
const LOCAL: WebhookPolicy = { allowPrivate: true };

let database: TestDatabase;
let db: Database;
let workerDb: Database;
let owner: Database;
let auth: Auth;
/** Allows private addresses, so it can send to the receiver below. */
let app: App;
/** The default: https and public addresses only. */
let strict: App;
let space: NewWorkspace;
let boss: { id: string; cookie: string };

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
let receiver: Server;
let receiverUrl: string;
const received: Received[] = [];
/** The statuses the receiver answers with, in turn. Empty means 200. */
const answers: number[] = [];
/** The bodies the receiver answers with, in turn. Empty means "thanks". */
const bodies: string[] = [];

const inSpace = (path = "") => `/v1/operator/workspaces/${space.id}${path}`;
async function addWebhook(events: string[], url = receiverUrl) {
  const response = await asOperator(app, boss.cookie, "POST", inSpace("/webhooks"), {
    url,
    events,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; secret: string; url: string };
}

/** Runs the worker's webhook steps once: fan out every event, then send what is due. */
async function runWorker(policy = LOCAL) {
  while (await fanOutWebhooksOne(workerDb)) {}
  const rows = await claimWebhookDeliveries(workerDb, 50, 60_000);
  const stopping = new AbortController().signal;
  await Promise.all(
    rows.map((row) =>
      deliverWebhook(workerDb, row, { images: undefined, policy, retryMs: 30_000, stopping }),
    ),
  );
  return rows.length;
}

const deliveriesOf = (webhookId: string) =>
  owner
    .select()
    .from(webhookDelivery)
    .where(eq(webhookDelivery.webhookId, webhookId))
    .orderBy(webhookDelivery.createdAt);

/** Checks a request's signature the way a receiver should, and returns its parsed body. */
function verified(request: Received, secret: string) {
  const header = String(request.headers["dinghy-signature"]);
  const [, timestamp, digest] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header) ?? [];
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${request.body}`)
    .digest("hex");
  expect(digest).toBe(expected);
  expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(60);
  const parsed = JSON.parse(request.body) as {
    id: string;
    type: string;
    workspaceId: string;
    createdAt: string;
    data: Record<string, Record<string, unknown>>;
  };
  expect(request.headers["dinghy-event-id"]).toBe(parsed.id);
  return parsed;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  workerDb = database.connect("worker", 5).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({ db, logger, auth, checks: { postgres: ok, valkey: ok }, webhooks: LOCAL });
  strict = createApp({ db, logger, auth, checks: { postgres: ok, valkey: ok } });
  receiver = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(parts).toString("utf8") });
      response.writeHead(answers.shift() ?? 200).end(bodies.shift() ?? "thanks");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
}, 30_000);

beforeEach(async () => {
  // Each test has a workspace of its own, so the five-webhook limit and the events stay apart.
  space = await createWorkspace(db, "Hooks", [SITE]);
  const made = await signedInOperator({ app, auth, owner, name: "Hana", workspaceId: space.id });
  boss = { id: made.id, cookie: made.cookie };
  received.length = 0;
  answers.length = 0;
  bodies.length = 0;
});

afterAll(async () => {
  receiver.closeAllConnections();
  receiver.close();
  await database.drop();
});

describe("managing webhooks", () => {
  test("an owner adds, lists, changes, tests, rotates and deletes a webhook", async () => {
    const made = await addWebhook(["message.created"]);
    expect(made.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const listed = await (await asOperator(app, boss.cookie, "GET", inSpace("/webhooks"))).text();
    expect(listed).toContain(made.id);
    expect(listed).not.toContain(made.secret);

    const changed = await asOperator(app, boss.cookie, "PATCH", inSpace(`/webhooks/${made.id}`), {
      events: ["conversation.closed", "conversation.closed"],
      enabled: false,
    });
    expect(await changed.json()).toMatchObject({ events: ["conversation.closed"], enabled: false });

    const tested = await asOperator(
      app,
      boss.cookie,
      "POST",
      inSpace(`/webhooks/${made.id}/test`),
      {},
    );
    expect(await tested.json()).toEqual({ delivered: true, status: 200, error: null });
    const ping = verified(received[0] as Received, made.secret);
    expect(ping).toMatchObject({ type: "webhook.test", workspaceId: space.id, data: {} });

    const rotated = (await (
      await asOperator(app, boss.cookie, "POST", inSpace(`/webhooks/${made.id}/rotate-secret`), {})
    ).json()) as { secret: string };
    expect(rotated.secret).not.toBe(made.secret);
    await asOperator(app, boss.cookie, "POST", inSpace(`/webhooks/${made.id}/test`), {});
    verified(received[1] as Received, rotated.secret);

    expect(
      (await asOperator(app, boss.cookie, "DELETE", inSpace(`/webhooks/${made.id}`))).status,
    ).toBe(200);
    expect(await (await asOperator(app, boss.cookie, "GET", inSpace("/webhooks"))).json()).toEqual({
      webhooks: [],
    });
  });

  test("a failed test says why", async () => {
    const made = await addWebhook(["message.created"]);
    answers.push(500);
    const tested = await asOperator(
      app,
      boss.cookie,
      "POST",
      inSpace(`/webhooks/${made.id}/test`),
      {},
    );
    expect(await tested.json()).toEqual({
      delivered: false,
      status: 500,
      error: "The receiving server refused the event. Check its logs and webhook settings.",
    });
  });

  test("a workspace has at most 5", async () => {
    for (let index = 0; index < 5; index++) await addWebhook(["message.created"]);
    const sixth = await asOperator(app, boss.cookie, "POST", inSpace("/webhooks"), {
      url: receiverUrl,
      events: ["message.created"],
    });
    expect(sixth.status).toBe(409);
    expect(await sixth.json()).toMatchObject({ error: { code: "webhook_limit" } });
  });

  test("a member cannot see or change webhooks", async () => {
    const made = await addWebhook(["message.created"]);
    const agent = await signedInOperator({
      app,
      auth,
      owner,
      name: "Ari",
      workspaceId: space.id,
      role: "member",
    });
    expect((await asOperator(app, agent.cookie, "GET", inSpace("/webhooks"))).status).toBe(403);
    expect(
      (await asOperator(app, agent.cookie, "POST", inSpace(`/webhooks/${made.id}/test`), {}))
        .status,
    ).toBe(403);
    expect(
      (await asOperator(app, agent.cookie, "GET", inSpace(`/webhooks/${made.id}/deliveries`)))
        .status,
    ).toBe(403);
    expect(
      (await asOperator(app, agent.cookie, "DELETE", inSpace(`/webhooks/${made.id}`))).status,
    ).toBe(403);
  });

  test("by default, only an https address on the public internet is taken", async () => {
    for (const url of [
      "http://93.184.215.14/hook",
      "https://127.0.0.1/hook",
      "https://localhost/hook",
      "https://[::1]/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.8/hook",
      "https://[fd00:ec2::254]/hook",
      "ftp://93.184.215.14/hook",
      "not a url",
    ]) {
      const response = await asOperator(strict, boss.cookie, "POST", inSpace("/webhooks"), {
        url,
        events: ["message.created"],
      });
      expect([url, response.status]).toEqual([url, 400]);
      expect(await response.json()).toMatchObject({ error: { code: "bad_endpoint" } });
    }
    const fine = await asOperator(strict, boss.cookie, "POST", inSpace("/webhooks"), {
      url: "https://93.184.215.14/hook",
      events: ["message.created"],
    });
    expect(fine.status).toBe(201);
  });

  test("private and special addresses are refused, public ones are not", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
    ]) {
      expect([address, isPrivateAddress(address)]).toEqual([address, true]);
    }
    for (const address of [
      "::1",
      "fe80::1",
      "fd00:ec2::254",
      "::ffff:10.0.0.1",
      "100.100.100.200",
    ]) {
      expect([address, isPrivateAddress(address)]).toEqual([address, true]);
    }
    for (const address of ["93.184.215.14", "1.1.1.1", "2606:4700::1111"]) {
      expect([address, isPrivateAddress(address)]).toEqual([address, false]);
    }
  });
});

describe("delivery", () => {
  test("notes, handoffs and a bot's return arrive with their data", async () => {
    const hook = await addWebhook([
      "message.created",
      "conversation.handoff",
      "conversation.given_back",
    ]);
    const made = await asOperator(app, boss.cookie, "POST", inSpace("/api-keys"), { name: "Bot" });
    const { id: keyId, token } = (await made.json()) as { id: string; token: string };
    await setReplyMode(owner, keyId, "send");
    const { conversationId } = await visitorStarts(app, space.publicKey, "Refund please");
    const path = inSpace(`/conversations/${conversationId}`);
    await asOperator(app, boss.cookie, "POST", `${path}/messages`, {
      clientId: "n1",
      body: "Known customer",
      note: true,
    });
    const handed = await app.request(`${path}/handoff`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "h1", reason: "Refund" }),
    });
    expect(handed.status).toBe(201);
    await asOperator(app, boss.cookie, "POST", `${path}/give-back`);
    await runWorker();

    const events = received.map((request) => verified(request, hook.secret));
    const ofType = (type: string) => events.filter((one) => one.type === type);
    expect(events.map((one) => one.type).sort()).toEqual([
      "conversation.given_back",
      "conversation.handoff",
      "message.created",
      "message.created",
      "message.created",
    ]);
    const notes = ofType("message.created")
      .map((one) => one.data.message as { kind: string; body: string; authorName: string })
      .filter((one) => one.kind === "note");
    expect(notes.map((one) => [one.body, one.authorName]).sort()).toEqual([
      ["Handed off: Refund", "Bot"],
      ["Known customer", "Hana"],
    ]);
    // A body shows the conversation as it is when the worker sends, after the give back here.
    expect(ofType("conversation.handoff")[0]?.data.conversation).toMatchObject({
      id: conversationId,
    });
    expect(ofType("conversation.given_back")[0]?.data.conversation).toMatchObject({
      handler: { kind: "bot", apiKeyId: keyId, name: "Bot" },
    });
    expect(ofType("conversation.given_back")[0]?.data.conversation).not.toHaveProperty(
      "humanSince",
    );
  });

  test("each change reaches the webhook once, signed, in the operator API's shapes", async () => {
    const hook = await addWebhook([
      "conversation.created",
      "message.created",
      "conversation.closed",
      "conversation.reopened",
      "conversation.assigned",
    ]);
    const { conversationId } = await visitorStarts(app, space.publicKey, "Is it in stock?");
    const path = inSpace(`/conversations/${conversationId}`);
    await asOperator(app, boss.cookie, "POST", `${path}/messages`, {
      clientId: "r1",
      body: "Yes, three left.",
    });
    await asOperator(app, boss.cookie, "PATCH", path, { status: "closed" });
    await asOperator(app, boss.cookie, "PATCH", path, { status: "open" });
    await asOperator(app, boss.cookie, "PUT", `${path}/assignee`, { operatorId: null });
    // The first reply assigned the conversation to its sender, and the last change unassigned it.
    expect(await runWorker()).toBe(7);

    const events = received.map((request) => verified(request, hook.secret));
    expect(events.map((one) => one.type).sort()).toEqual([
      "conversation.assigned",
      "conversation.assigned",
      "conversation.closed",
      "conversation.created",
      "conversation.reopened",
      "message.created",
      "message.created",
    ]);
    for (const one of events) {
      expect(one.workspaceId).toBe(space.id);
      expect(one.data.conversation).toMatchObject({ id: conversationId, pageContext: null });
      expect(one.data.conversation?.visitor).toMatchObject({ blocked: false });
    }
    const messages = events.filter((one) => one.type === "message.created");
    expect(messages.map((one) => one.data.message)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "Is it in stock?", fromVisitor: true, authorName: null }),
        expect.objectContaining({
          body: "Yes, three left.",
          fromVisitor: false,
          authorName: "Hana",
        }),
      ]),
    );
    const ids = new Set(events.map((one) => one.id));
    expect(ids.size).toBe(events.length);
    const rows = await deliveriesOf(hook.id);
    expect(rows.every((row) => row.outcome === "sent" && row.lastStatus === 200)).toBe(true);
    // Done: nothing is left to fan out or send.
    expect(await runWorker()).toBe(0);
  });

  test("a webhook gets only the events it asked for, and nothing while it is off", async () => {
    const closes = await addWebhook(["conversation.closed"]);
    const off = await addWebhook(["message.created"]);
    await asOperator(app, boss.cookie, "PATCH", inSpace(`/webhooks/${off.id}`), { enabled: false });
    const { conversationId } = await visitorStarts(app, space.publicKey, "Bye");
    await asOperator(app, boss.cookie, "PATCH", inSpace(`/conversations/${conversationId}`), {
      status: "closed",
    });
    await runWorker();
    expect(received.map((request) => verified(request, closes.secret).type)).toEqual([
      "conversation.closed",
    ]);
    expect(await deliveriesOf(off.id)).toEqual([]);
  });

  test("a workspace with no webhook gives the worker nothing to do", async () => {
    await visitorStarts(app, space.publicKey, "Nobody listens");
    const flagged = await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.needsWebhook, true)));
    expect(flagged).toEqual([]);
  });

  test("a failed send waits and tries again with the same event ID", async () => {
    const hook = await addWebhook(["message.created"]);
    await visitorStarts(app, space.publicKey, "Try again");
    answers.push(503);
    await runWorker();
    const [waiting] = await deliveriesOf(hook.id);
    expect(waiting).toMatchObject({ finishedAt: null, attempts: 1, lastStatus: 503 });
    expect(waiting?.lastError).toBe(
      "The receiving server refused the event. Check its logs and webhook settings.",
    );
    expect(waiting?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    // Not due yet.
    expect(await runWorker()).toBe(0);
    await owner
      .update(webhookDelivery)
      .set({ nextAttemptAt: new Date() })
      .where(eq(webhookDelivery.webhookId, hook.id));
    await runWorker();
    const [done] = await deliveriesOf(hook.id);
    expect(done).toMatchObject({ outcome: "sent", attempts: 2, lastStatus: 200, lastError: null });
    expect(received).toHaveLength(2);
    expect(received[0]?.headers["dinghy-event-id"]).toBe(received[1]?.headers["dinghy-event-id"]);
    expect(received[0]?.headers["dinghy-event-id"]).toBe(done?.eventId);

    const listed = (await (
      await asOperator(app, boss.cookie, "GET", inSpace(`/webhooks/${hook.id}/deliveries`))
    ).json()) as {
      deliveries: unknown[];
    };
    expect(listed.deliveries).toEqual([
      expect.objectContaining({ type: "message.created", status: "sent", attempts: 2 }),
    ]);
  });

  test("it gives up after its last attempt, or after a day", async () => {
    const hook = await addWebhook(["message.created"]);
    await visitorStarts(app, space.publicKey, "First");
    await visitorStarts(app, space.publicKey, "Second");
    answers.push(500, 500);
    await fanOutWebhooksOne(workerDb);
    await fanOutWebhooksOne(workerDb);
    const [first, second] = await deliveriesOf(hook.id);
    await owner
      .update(webhookDelivery)
      .set({ attempts: WEBHOOK_MAX_ATTEMPTS - 1 })
      .where(eq(webhookDelivery.id, first?.id ?? ""));
    await owner
      .update(webhookDelivery)
      .set({ createdAt: new Date(Date.now() - 24 * 3_600_000) })
      .where(eq(webhookDelivery.id, second?.id ?? ""));
    await runWorker();
    const rows = await deliveriesOf(hook.id);
    expect(rows.map((row) => [row.outcome, row.lastStatus])).toEqual([
      ["failed", 500],
      ["failed", 500],
    ]);
  });

  test("a send to a private address is refused when it is made, whatever the address was at save", async () => {
    // Saved before the rule, or a name that pointed elsewhere then.
    const [hook] = await owner
      .insert(webhook)
      .values({
        workspaceId: space.id,
        url: "https://localhost:9/hook",
        secret: "whsec_test",
        events: ["message.created"],
      })
      .returning({ id: webhook.id });
    const [plain] = await owner
      .insert(webhook)
      .values({
        workspaceId: space.id,
        url: receiverUrl,
        secret: "whsec_test",
        events: ["message.created"],
      })
      .returning({ id: webhook.id });
    await visitorStarts(app, space.publicKey, "Reach inside?");
    await runWorker(PUBLIC_ONLY);
    const [refused] = await deliveriesOf(hook?.id ?? "");
    expect(refused).toMatchObject({ finishedAt: null, lastStatus: null });
    expect(refused?.lastError).toBe(
      "Dinghy cannot send to this private address. Use a public HTTPS address for the receiving app.",
    );
    const [http] = await deliveriesOf(plain?.id ?? "");
    expect(http?.lastError).toBe("Dinghy cannot use this webhook URL. Use an HTTPS address.");
    expect(received).toEqual([]);
  });

  test("a delivery goes with its conversation, and old finished ones are pruned", async () => {
    const hook = await addWebhook(["message.created"]);
    const { conversationId } = await visitorStarts(app, space.publicKey, "Delete me");
    await runWorker();
    expect(await deliveriesOf(hook.id)).toHaveLength(1);
    await owner
      .update(webhookDelivery)
      .set({ finishedAt: new Date(Date.now() - 40 * 24 * 3_600_000) })
      .where(eq(webhookDelivery.webhookId, hook.id));
    await pruneOnce(workerDb, new Date(Date.now() - 30 * 24 * 3_600_000));
    expect(await deliveriesOf(hook.id)).toEqual([]);

    // A delivery that waits goes when its conversation is deleted.
    await visitorStarts(app, space.publicKey, "Another");
    await fanOutWebhooksOne(workerDb);
    const deleted = await asOperator(
      app,
      boss.cookie,
      "DELETE",
      inSpace(`/conversations/${conversationId}`),
    );
    expect(deleted.status).toBe(200);
    const left = await deliveriesOf(hook.id);
    expect(left.every((row) => row.conversationId !== conversationId)).toBe(true);
  });
});

describe("replays and refusals", () => {
  const deliveries = async (hookId: string) =>
    (
      (await (
        await asOperator(app, boss.cookie, "GET", inSpace(`/webhooks/${hookId}/deliveries`))
      ).json()) as {
        deliveries: {
          id: string;
          eventId: string;
          status: string;
          responseExcerpt: string | null;
          replayOf: string | null;
        }[];
      }
    ).deliveries;

  test("a refused delivery keeps the start of the answer's body, at most 2 KB", async () => {
    const hook = await addWebhook(["message.created"]);
    // Earlier tests can leave a due delivery, which would take this answer.
    await runWorker();
    answers.push(500);
    bodies.push(`\u0007Bad\u0000 signature\n${"é".repeat(100_000)}`);
    await visitorStarts(app, space.publicKey, "Hello");
    await runWorker();
    const [row] = await deliveriesOf(hook.id);
    expect(row?.lastStatus).toBe(500);
    const excerpt = row?.responseExcerpt ?? "";
    expect(excerpt.startsWith("Bad signature\né")).toBe(true);
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(2048);
    // The cut in the middle of a two-byte letter leaves no broken letter behind.
    expect(excerpt).not.toContain("\uFFFD");
    expect((await deliveries(hook.id))[0]?.responseExcerpt).toBe(excerpt);
  });

  test("the excerpt is readable text or nothing", () => {
    expect(responseExcerpt(Buffer.from("\u0000\u001b[31m  "))).toBe("[31m");
    expect(responseExcerpt(Buffer.from(" \r\n "))).toBeNull();
    expect(responseExcerpt(Buffer.alloc(5000, "a"))).toHaveLength(2048);
  });

  test("a replay sends the same event again, now, with its own delivery", async () => {
    const hook = await addWebhook(["message.created"]);
    await visitorStarts(app, space.publicKey, "Replay me");
    await runWorker();
    const [first] = await deliveries(hook.id);
    const replayed = await asOperator(
      app,
      boss.cookie,
      "POST",
      inSpace(`/webhooks/${hook.id}/deliveries/${first?.id}/replay`),
      {},
    );
    expect(replayed.status).toBe(201);
    const { delivery } = (await replayed.json()) as { delivery: Record<string, unknown> };
    expect(delivery).toMatchObject({
      eventId: first?.eventId,
      replayOf: first?.id,
      status: "pending",
      attempts: 0,
    });
    await runWorker();
    expect(received.map((one) => one.headers["dinghy-event-id"])).toEqual([
      first?.eventId,
      first?.eventId,
    ]);
    expect((await deliveries(hook.id)).map((one) => one.status)).toEqual(["sent", "sent"]);
    const unknown = await asOperator(
      app,
      boss.cookie,
      "POST",
      inSpace(`/webhooks/${hook.id}/deliveries/${crypto.randomUUID()}/replay`),
      {},
    );
    expect(unknown.status).toBe(404);
  });

  test("a Setup key lists and replays deliveries through MCP", async () => {
    const hook = await addWebhook(["message.created"]);
    await visitorStarts(app, space.publicKey, "Through MCP");
    await runWorker();
    const key = await asOperator(app, boss.cookie, "POST", inSpace("/api-keys"), {
      name: "Bot",
      level: "setup",
    });
    const { token } = (await key.json()) as { token: string };
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await app.request("/v1/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return ((await response.json()) as { result: { structuredContent: Record<string, unknown> } })
        .result.structuredContent;
    };
    const listed = (await call("list_webhook_deliveries", { webhookId: hook.id })) as {
      deliveries: { id: string; eventId: string }[];
    };
    const [first] = listed.deliveries;
    const replayed = await call("replay_webhook_delivery", {
      webhookId: hook.id,
      deliveryId: first?.id,
    });
    expect(replayed).toMatchObject({ delivery: { eventId: first?.eventId, replayOf: first?.id } });
    const missing = await call("replay_webhook_delivery", {
      webhookId: hook.id,
      deliveryId: crypto.randomUUID(),
    });
    expect(missing).toMatchObject({ error: { code: "not_found" } });
  });

  test("a payload says whether its visitor is a test visitor", async () => {
    await runWorker();
    received.length = 0;
    const hook = await addWebhook(["message.created"]);
    await visitorStarts(app, space.publicKey, "A person");
    const key = await asOperator(app, boss.cookie, "POST", inSpace("/api-keys"), {
      name: "Bot",
      level: "setup",
    });
    const { token } = (await key.json()) as { token: string };
    await app.request(inSpace("/test-visitors/messages"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "A test" }),
    });
    await runWorker();
    const isTest = Object.fromEntries(
      received
        .map((one) => verified(one, hook.secret))
        .map((body) => [
          body.data.message?.body,
          (body.data.conversation?.visitor as { isTest?: boolean } | undefined)?.isTest,
        ]),
    );
    expect(isTest).toEqual({ "A person": false, "A test": true });
  });
});

test("the signature is the HMAC-SHA256 of the time and the body", () => {
  expect(signature("whsec_x", 1700000000, '{"a":1}')).toBe(
    `t=1700000000,v1=${createHmac("sha256", "whsec_x").update('1700000000.{"a":1}').digest("hex")}`,
  );
});

describe("Setup API keys", () => {
  const makeKey = async (level?: "conversations" | "setup", name = "Agent") => {
    const response = await asOperator(app, boss.cookie, "POST", inSpace("/api-keys"), {
      name,
      ...(level === undefined ? {} : { level }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; token: string; level: string };
  };
  const mcpTools = async (token: string) => {
    const response = await withKey(app, token, "POST", "/v1/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const { result } = (await response.json()) as { result: { tools: { name: string }[] } };
    return result.tools.map((one) => one.name);
  };

  test("a key is Conversations unless made Setup, and the list says which", async () => {
    expect((await makeKey()).level).toBe("conversations");
    expect((await makeKey("setup", "Builder")).level).toBe("setup");
    const listed = (await (
      await asOperator(app, boss.cookie, "GET", inSpace("/api-keys"))
    ).json()) as {
      apiKeys: { name: string; level: string }[];
    };
    expect(Object.fromEntries(listed.apiKeys.map((one) => [one.name, one.level]))).toEqual({
      Agent: "conversations",
      Builder: "setup",
    });
  });

  test("a Conversations key gets 403 on every webhook route", async () => {
    const hook = await addWebhook(["message.created"]);
    const key = await makeKey("conversations");
    for (const [method, path, body] of [
      ["GET", inSpace("/webhooks"), undefined],
      ["POST", inSpace("/webhooks"), { url: receiverUrl, events: ["message.created"] }],
      ["PATCH", inSpace(`/webhooks/${hook.id}`), { enabled: false }],
      ["POST", inSpace(`/webhooks/${hook.id}/rotate-secret`), {}],
      ["POST", inSpace(`/webhooks/${hook.id}/test`), {}],
      ["GET", inSpace(`/webhooks/${hook.id}/deliveries`), undefined],
      ["POST", inSpace(`/webhooks/${hook.id}/deliveries/${crypto.randomUUID()}/replay`), {}],
      ["DELETE", inSpace(`/webhooks/${hook.id}`), undefined],
    ] as const) {
      const response = await withKey(app, key.token, method, path, body);
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }
    expect(await owner.select().from(webhook).where(eq(webhook.id, hook.id))).toHaveLength(1);
  });

  test("a Setup key adds, tests and deletes a webhook, which names it as its creator", async () => {
    const key = await makeKey("setup", "Coding agent");
    const added = await withKey(app, key.token, "POST", inSpace("/webhooks"), {
      url: receiverUrl,
      events: ["message.created"],
    });
    expect(added.status).toBe(201);
    const made = (await added.json()) as { id: string; secret: string; createdBy: unknown };
    expect(made.createdBy).toEqual({ kind: "key", name: "Coding agent" });
    const [row] = await owner.select().from(webhook).where(eq(webhook.id, made.id));
    expect(row).toMatchObject({ createdByApiKeyId: key.id, createdByOperatorId: null });
    // The owner's list says who added it.
    const listed = (await (
      await asOperator(app, boss.cookie, "GET", inSpace("/webhooks"))
    ).json()) as {
      webhooks: { id: string; createdBy: unknown }[];
    };
    expect(listed.webhooks.find((one) => one.id === made.id)?.createdBy).toEqual({
      kind: "key",
      name: "Coding agent",
    });
    const tested = await withKey(app, key.token, "POST", inSpace(`/webhooks/${made.id}/test`), {});
    expect(await tested.json()).toEqual({ delivered: true, status: 200, error: null });
    verified(received[0] as Received, made.secret);
    expect((await withKey(app, key.token, "DELETE", inSpace(`/webhooks/${made.id}`))).status).toBe(
      200,
    );
    expect(await owner.select().from(webhook).where(eq(webhook.id, made.id))).toEqual([]);
  });

  test("an operator's webhook names the operator", async () => {
    const made = await addWebhook(["message.created"]);
    const [row] = await owner.select().from(webhook).where(eq(webhook.id, made.id));
    expect(row).toMatchObject({ createdByOperatorId: boss.id, createdByApiKeyId: null });
    const listed = (await (
      await asOperator(app, boss.cookie, "GET", inSpace("/webhooks"))
    ).json()) as {
      webhooks: { createdBy: unknown }[];
    };
    expect(listed.webhooks[0]?.createdBy).toEqual({ kind: "operator", name: "Hana" });
  });

  test("no key reaches the keys, the members, export or the workspace's deletion", async () => {
    for (const level of ["conversations", "setup"] as const) {
      const key = await makeKey(level, `Key ${level}`);
      for (const [method, path, body] of [
        ["GET", inSpace("/api-keys"), undefined],
        ["POST", inSpace("/api-keys"), { name: "More", level: "setup" }],
        ["DELETE", inSpace(`/api-keys/${key.id}`), undefined],
        ["GET", inSpace("/members"), undefined],
        ["POST", inSpace("/invites"), { email: "x@example.com", role: "member" }],
        ["GET", inSpace("/export"), undefined],
        ["DELETE", inSpace(""), { name: "Hooks" }],
      ] as const) {
        const response = await withKey(app, key.token, method, path, body);
        expect([level, method, path, response.status]).toEqual([level, method, path, 403]);
      }
    }
  });

  test("MCP offers the webhook tools to a Setup key only", async () => {
    const conversations = await mcpTools((await makeKey("conversations")).token);
    const setup = await mcpTools((await makeKey("setup", "Builder")).token);
    const webhookTools = ["list_webhooks", "create_webhook", "delete_webhook", "test_webhook"];
    for (const name of webhookTools) {
      expect(conversations).not.toContain(name);
      expect(setup).toContain(name);
    }
    // A Setup key also has every tool a Conversations key has.
    expect(conversations.filter((name) => !setup.includes(name))).toEqual([]);
  });

  test("a Setup key's MCP tools add, test and delete a webhook; a Conversations key's cannot", async () => {
    const call = async (token: string, name: string, args: Record<string, unknown>) => {
      const response = await app.request("/v1/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return (await response.json()) as {
        result?: { isError: boolean; structuredContent: Record<string, unknown> };
        error?: { code: number };
      };
    };
    const limited = await makeKey("conversations");
    const refused = await call(limited.token, "create_webhook", {
      url: receiverUrl,
      events: ["message.created"],
    });
    expect(refused.error?.code).toBe(-32602);
    const key = await makeKey("setup", "Builder");
    const made = await call(key.token, "create_webhook", {
      url: receiverUrl,
      events: ["message.created"],
    });
    const created = made.result?.structuredContent as { webhook: { id: string }; secret: string };
    expect(created.secret).toMatch(/^whsec_/);
    const tested = await call(key.token, "test_webhook", { webhookId: created.webhook.id });
    expect(tested.result?.structuredContent).toMatchObject({ delivered: true, status: 200 });
    const listed = await call(key.token, "list_webhooks", {});
    expect(JSON.stringify(listed.result?.structuredContent)).not.toContain(created.secret);
    const gone = await call(key.token, "delete_webhook", { webhookId: created.webhook.id });
    expect(gone.result?.isError).toBe(false);
    expect(await owner.select().from(webhook).where(eq(webhook.id, created.webhook.id))).toEqual(
      [],
    );
  });

  test("a Setup key does not exist in another workspace", async () => {
    const key = await makeKey("setup");
    const other = await createWorkspace(db, "Other", [SITE]);
    const elsewhere = `/v1/operator/workspaces/${other.id}/webhooks`;
    expect((await withKey(app, key.token, "GET", elsewhere)).status).toBe(404);
    const added = await withKey(app, key.token, "POST", elsewhere, {
      url: receiverUrl,
      events: ["message.created"],
    });
    expect(added.status).toBe(404);
    expect(await owner.select().from(webhook).where(eq(webhook.workspaceId, other.id))).toEqual([]);
  });
});
