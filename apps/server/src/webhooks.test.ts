import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
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
  signature,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookPolicy,
} from "./webhooks.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const ORIGIN = new URL(PUBLIC_URL).origin;
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

const inSpace = (path = "") => `/v1/operator/workspaces/${space.id}${path}`;
const asBoss = (method: string, path: string, body?: unknown, server = app) =>
  server.request(path, {
    method,
    headers: {
      cookie: boss.cookie,
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function addWebhook(events: string[], url = receiverUrl) {
  const response = await asBoss("POST", inSpace("/webhooks"), { url, events });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; secret: string; url: string };
}

async function visitorSends(body: string) {
  const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  const { token } = (await created.json()) as { token: string };
  const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
    method: "POST",
    headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ clientId: crypto.randomUUID(), body }),
  });
  return ((await sent.json()) as { conversationId: string }).conversationId;
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
      response.writeHead(answers.shift() ?? 200).end("thanks");
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
    const listed = await (await asBoss("GET", inSpace("/webhooks"))).text();
    expect(listed).toContain(made.id);
    expect(listed).not.toContain(made.secret);

    const changed = await asBoss("PATCH", inSpace(`/webhooks/${made.id}`), {
      events: ["conversation.closed", "conversation.closed"],
      enabled: false,
    });
    expect(await changed.json()).toMatchObject({ events: ["conversation.closed"], enabled: false });

    const tested = await asBoss("POST", inSpace(`/webhooks/${made.id}/test`), {});
    expect(await tested.json()).toEqual({ delivered: true, status: 200, error: null });
    const ping = verified(received[0] as Received, made.secret);
    expect(ping).toMatchObject({ type: "webhook.test", workspaceId: space.id, data: {} });

    const rotated = (await (
      await asBoss("POST", inSpace(`/webhooks/${made.id}/rotate-secret`), {})
    ).json()) as { secret: string };
    expect(rotated.secret).not.toBe(made.secret);
    await asBoss("POST", inSpace(`/webhooks/${made.id}/test`), {});
    verified(received[1] as Received, rotated.secret);

    expect((await asBoss("DELETE", inSpace(`/webhooks/${made.id}`))).status).toBe(200);
    expect(await (await asBoss("GET", inSpace("/webhooks"))).json()).toEqual({ webhooks: [] });
  });

  test("a failed test says why", async () => {
    const made = await addWebhook(["message.created"]);
    answers.push(500);
    const tested = await asBoss("POST", inSpace(`/webhooks/${made.id}/test`), {});
    expect(await tested.json()).toEqual({
      delivered: false,
      status: 500,
      error: "The receiving server refused the event. Check its logs and webhook settings.",
    });
  });

  test("a workspace has at most 5", async () => {
    for (let index = 0; index < 5; index++) await addWebhook(["message.created"]);
    const sixth = await asBoss("POST", inSpace("/webhooks"), {
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
    const as = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { cookie: agent.cookie, origin: ORIGIN, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect((await as("GET", inSpace("/webhooks"))).status).toBe(403);
    expect((await as("POST", inSpace(`/webhooks/${made.id}/test`), {})).status).toBe(403);
    expect((await as("GET", inSpace(`/webhooks/${made.id}/deliveries`))).status).toBe(403);
    expect((await as("DELETE", inSpace(`/webhooks/${made.id}`))).status).toBe(403);
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
      const response = await asBoss(
        "POST",
        inSpace("/webhooks"),
        { url, events: ["message.created"] },
        strict,
      );
      expect([url, response.status]).toEqual([url, 400]);
      expect(await response.json()).toMatchObject({ error: { code: "bad_endpoint" } });
    }
    const fine = await asBoss(
      "POST",
      inSpace("/webhooks"),
      { url: "https://93.184.215.14/hook", events: ["message.created"] },
      strict,
    );
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
  test("each change reaches the webhook once, signed, in the operator API's shapes", async () => {
    const hook = await addWebhook([
      "conversation.created",
      "message.created",
      "conversation.closed",
      "conversation.reopened",
      "conversation.assigned",
    ]);
    const conversationId = await visitorSends("Is it in stock?");
    const path = inSpace(`/conversations/${conversationId}`);
    await asBoss("POST", `${path}/messages`, { clientId: "r1", body: "Yes, three left." });
    await asBoss("PATCH", path, { status: "closed" });
    await asBoss("PATCH", path, { status: "open" });
    await asBoss("PUT", `${path}/assignee`, { operatorId: null });
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
    await asBoss("PATCH", inSpace(`/webhooks/${off.id}`), { enabled: false });
    const conversationId = await visitorSends("Bye");
    await asBoss("PATCH", inSpace(`/conversations/${conversationId}`), { status: "closed" });
    await runWorker();
    expect(received.map((request) => verified(request, closes.secret).type)).toEqual([
      "conversation.closed",
    ]);
    expect(await deliveriesOf(off.id)).toEqual([]);
  });

  test("a workspace with no webhook gives the worker nothing to do", async () => {
    await visitorSends("Nobody listens");
    const flagged = await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.needsWebhook, true)));
    expect(flagged).toEqual([]);
  });

  test("a failed send waits and tries again with the same event ID", async () => {
    const hook = await addWebhook(["message.created"]);
    await visitorSends("Try again");
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
      await asBoss("GET", inSpace(`/webhooks/${hook.id}/deliveries`))
    ).json()) as {
      deliveries: unknown[];
    };
    expect(listed.deliveries).toEqual([
      expect.objectContaining({ type: "message.created", status: "sent", attempts: 2 }),
    ]);
  });

  test("it gives up after its last attempt, or after a day", async () => {
    const hook = await addWebhook(["message.created"]);
    await visitorSends("First");
    await visitorSends("Second");
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
    await visitorSends("Reach inside?");
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
    const conversationId = await visitorSends("Delete me");
    await runWorker();
    expect(await deliveriesOf(hook.id)).toHaveLength(1);
    await owner
      .update(webhookDelivery)
      .set({ finishedAt: new Date(Date.now() - 40 * 24 * 3_600_000) })
      .where(eq(webhookDelivery.webhookId, hook.id));
    await pruneOnce(workerDb, new Date(Date.now() - 30 * 24 * 3_600_000));
    expect(await deliveriesOf(hook.id)).toEqual([]);

    // A delivery that waits goes when its conversation is deleted.
    await visitorSends("Another");
    await fanOutWebhooksOne(workerDb);
    const deleted = await asBoss("DELETE", inSpace(`/conversations/${conversationId}`));
    expect(deleted.status).toBe(200);
    const left = await deliveriesOf(hook.id);
    expect(left.every((row) => row.conversationId !== conversationId)).toBe(true);
  });
});

test("the signature is the HMAC-SHA256 of the time and the body", () => {
  expect(signature("whsec_x", 1700000000, '{"a":1}')).toBe(
    `t=1700000000,v1=${createHmac("sha256", "whsec_x").update('1700000000.{"a":1}').digest("hex")}`,
  );
});
