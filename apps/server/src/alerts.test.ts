import { type ChildProcess, spawn } from "node:child_process";
import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import webPush from "web-push";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, DATABASE_URL, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import {
  claimDeliveries,
  emailStopUrl,
  fanOutOne,
  finishDelivery,
  MAX_ATTEMPTS,
  pruneOnce,
  REPLY_EMAIL_DELAY_MS,
  REPLY_EMAILS_PER_DAY,
} from "./alerts.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import {
  alertDelivery,
  emailStop,
  event,
  ipBlock,
  operator,
  pushSubscription,
  visitor,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { emailAddressHash } from "./identity.ts";
import type { Mailer } from "./mailer.ts";
import { appendMessage, listWorkspaceEvents, setConversationStatus } from "./messages.ts";
import { createPush, isPushEndpoint } from "./push.ts";
import { retryDelayMs } from "./retry.ts";
import { startWorker, type Worker } from "./worker.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });
const keys = { ...webPush.generateVAPIDKeys(), subject: "mailto:hello@dinghy.chat" };
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

let database: TestDatabase;
let owner: Database;
let app: Database;
let workerDb: Database;
let space: NewWorkspace;

// A real HTTP server in the place of a push service. `answer` decides each response.
interface Received {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
let received: Received[] = [];
let answer: (url: string) => number | "hold" = () => 201;
let held: http.ServerResponse[] = [];
const service = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const url = req.url ?? "";
    received.push({ url, headers: req.headers, body: Buffer.concat(chunks) });
    const result = answer(url);
    if (result === "hold") held.push(res);
    else res.writeHead(result).end();
  });
});
const serviceUrl = (path: string) =>
  `http://127.0.0.1:${(service.address() as AddressInfo).port}/${path}`;

const mails: { to: string; subject: string; text: string; headers?: Record<string, string> }[] = [];
const mailer: Mailer = {
  async send(to, subject, text, headers) {
    mails.push({ to, subject, text, ...(headers && { headers }) });
  },
};

const workers: Worker[] = [];
/** A worker with push on, and with the test mailer when `mail` is set. Options override both. */
function runWorker({
  mail,
  ...options
}: { mail?: boolean } & Partial<Parameters<typeof startWorker>[0]> = {}) {
  const worker = startWorker({
    db: workerDb,
    logger,
    push: createPush(keys),
    mailer: mail ? mailer : undefined,
    publicUrl: PUBLIC_URL,
    secret: AUTH_SECRET,
    pollMs: 20,
    retryMs: 1,
    ...options,
  });
  workers.push(worker);
  return worker;
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function addOperator(email: string, options: { alertEmail?: boolean } = {}) {
  const [row] = await owner
    .insert(operator)
    .values({ name: email, email, emailVerified: true })
    .returning({ id: operator.id });
  const id = row?.id ?? "";
  await owner.insert(workspaceMember).values({
    workspaceId: space.id,
    operatorId: id,
    role: "agent",
    alertEmail: options.alertEmail ?? false,
  });
  return id;
}

function browserKeys() {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, publicKey, auth };
}

async function addDevice(operatorId: string, path: string) {
  const browser = browserKeys();
  await owner.insert(pushSubscription).values({
    operatorId,
    endpoint: serviceUrl(path),
    p256dh: browser.publicKey.toString("base64url"),
    auth: browser.auth.toString("base64url"),
  });
  return browser;
}

/** Reads a push body as the browser does (RFC 8291), so the test proves the encryption works. */
function decrypt(body: Buffer, browser: ReturnType<typeof browserKeys>): unknown {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const serverKey = body.subarray(21, 21 + idLength);
  const content = body.subarray(21 + idLength);
  const shared = browser.ecdh.computeSecret(serverKey);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), browser.publicKey, serverKey]);
  const secret = Buffer.from(hkdfSync("sha256", shared, browser.auth, info, 32));
  const derive = (label: string, length: number) =>
    Buffer.from(
      hkdfSync("sha256", secret, salt, Buffer.from(`Content-Encoding: ${label}\0`), length),
    );
  const decipher = createDecipheriv("aes-128-gcm", derive("aes128gcm", 16), derive("nonce", 12));
  decipher.setAuthTag(content.subarray(-16));
  const plain = Buffer.concat([decipher.update(content.subarray(0, -16)), decipher.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}

async function addVisitor(email: string | null = null) {
  const id = randomUUID();
  await owner.insert(visitor).values({ workspaceId: space.id, id, tokenHash: randomUUID(), email });
  return id;
}

const visitorWrites = (visitorId: string, body: string) =>
  withWorkspace(app, space.id, (tx) =>
    appendMessage(tx, space.id, { kind: "visitor", visitorId }, { clientId: randomUUID(), body }),
  );

const operatorWrites = (operatorId: string, conversationId: string, body: string) =>
  withWorkspace(app, space.id, (tx) =>
    appendMessage(
      tx,
      space.id,
      { kind: "operator", operatorId, conversationId },
      { clientId: randomUUID(), body },
    ),
  );

const deliveries = () => owner.select().from(alertDelivery);
const fanOutAll = async (channels = { push: true, email: true }) => {
  while (await fanOutOne(workerDb, channels));
};

/** The state a dead worker leaves behind, once its claim has run out. */
const expireClaims = () =>
  owner.execute(sql`update alert_delivery set claimed_until = now() - interval '1 second'
                    where finished_at is null and claimed_until is not null`);
const makeDue = () =>
  owner.execute(sql`update alert_delivery set next_attempt_at = now() where finished_at is null`);

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  owner = database.connect("migrator").db;
  app = database.connect("app").db;
  workerDb = database.connect("worker").db;
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
  await database.drop();
});

beforeEach(async () => {
  received = [];
  held = [];
  mails.length = 0;
  answer = () => 201;
  space = await createWorkspace(app, "Acme", ["https://app.example.com"]);
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  for (const response of held) response.destroy();
  await owner.delete(alertDelivery);
  await owner.update(event).set({ needsAlert: false });
  await owner.delete(pushSubscription);
});

test("a failed alert or file delete waits twice as long each time, up to an hour", () => {
  expect([1, 2, 3, 4].map((attempts) => retryDelayMs(30_000, attempts))).toEqual([
    30_000, 60_000, 120_000, 240_000,
  ]);
  expect(retryDelayMs(30_000, 8)).toBe(3_600_000);
  // A row that failed for days must not overflow to Infinity or NaN.
  expect(retryDelayMs(30_000, 5000)).toBe(3_600_000);
});

describe("web push", () => {
  test("a visitor message reaches each device, encrypted, tagged with its event", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const ben = await addOperator(`ben-${randomUUID()}@example.com`);
    const annaPhone = await addDevice(anna, "anna-phone");
    const annaLaptop = await addDevice(anna, "anna-laptop");
    const benPhone = await addDevice(ben, "ben-phone");
    const written = await visitorWrites(await addVisitor(), "The import stops at 40%.");

    runWorker();
    await until(() => received.length === 3, "three pushes");
    await until(
      async () => (await deliveries()).every((row) => row.outcome === "sent"),
      "the rows to finish",
    );

    const seq = written.message.seq.toString();
    for (const [path, browser] of [
      ["anna-phone", annaPhone],
      ["anna-laptop", annaLaptop],
      ["ben-phone", benPhone],
    ] as const) {
      const push = received.find((one) => one.url === `/${path}`);
      expect(push?.headers["content-encoding"]).toBe("aes128gcm");
      expect(push?.headers.authorization).toMatch(/^vapid t=.+, k=.+/);
      expect(decrypt(push?.body ?? Buffer.alloc(0), browser)).toEqual({
        title: "Acme",
        body: "The import stops at 40%.",
        tag: `${space.id}:${seq}`,
        url: `/?workspace=${space.id}&conversation=${written.message.conversationId}`,
      });
    }
    // One row for each recipient and channel, however many devices the recipient has.
    expect(await deliveries()).toHaveLength(2);
  });

  test("an operator reply and an operator with no device send no push", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const written = await visitorWrites(await addVisitor(), "Hello");
    await operatorWrites(anna, written.message.conversationId, "Hi");
    runWorker();
    await until(
      async () => (await owner.select().from(event).where(eq(event.needsAlert, true))).length === 0,
      "fan-out",
    );
    expect(received).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });

  test("a 404 or 410 deletes the subscription and ends the delivery", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "gone-404");
    await addDevice(anna, "gone-410");
    answer = (url) => (url.endsWith("404") ? 404 : 410);
    await visitorWrites(await addVisitor(), "Hello");
    runWorker();
    await until(
      async () => (await owner.select().from(pushSubscription)).length === 0,
      "the subscriptions to go",
    );
    await until(
      async () => (await deliveries())[0]?.outcome === "skipped",
      "the delivery to finish",
    );
    expect(received).toHaveLength(2);
  });

  test("a failed send retries, then stops at its limit", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "broken");
    answer = () => 500;
    await visitorWrites(await addVisitor(), "Hello");
    runWorker();
    await until(async () => (await deliveries())[0]?.outcome === "failed", "the limit");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(MAX_ATTEMPTS);
    expect((await deliveries())[0]?.attempts).toBe(MAX_ATTEMPTS);
  });

  test("a failure that clears delivers on the retry", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "flaky");
    let calls = 0;
    answer = () => (++calls === 1 ? 503 : 201);
    await visitorWrites(await addVisitor(), "Hello");
    runWorker();
    await until(async () => (await deliveries())[0]?.outcome === "sent", "the retry");
    expect(received).toHaveLength(2);
  });

  test("a failed alert to one operator does not alert the other four again", async () => {
    const paths = ["one", "two", "three", "four", "five"];
    for (const path of paths) {
      await addDevice(await addOperator(`${path}-${randomUUID()}@example.com`), path);
    }
    let failures = 0;
    answer = (url) => (url === "/three" && ++failures === 1 ? 500 : 201);
    await visitorWrites(await addVisitor(), "Hello");
    runWorker();
    await until(async () => {
      const rows = await deliveries();
      return rows.length === 5 && rows.every((row) => row.outcome === "sent");
    }, "all five");
    const count = (path: string) => received.filter((one) => one.url === `/${path}`).length;
    expect(paths.map(count)).toEqual([1, 1, 2, 1, 1]);
  });

  test("a removed operator gets no row from a later message", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`, { alertEmail: true });
    await addDevice(anna, "removed-later");
    await owner
      .update(workspaceMember)
      .set({ removedAt: new Date() })
      .where(eq(workspaceMember.operatorId, anna));
    await visitorWrites(await addVisitor(), "Hello");
    await fanOutAll();
    expect(await deliveries()).toEqual([]);
  });

  test("a removed operator receives nothing, even from a row made before the removal", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "removed");
    await visitorWrites(await addVisitor(), "Hello");
    await fanOutAll();
    await owner
      .update(workspaceMember)
      .set({ removedAt: new Date() })
      .where(eq(workspaceMember.operatorId, anna));
    runWorker();
    await until(async () => (await deliveries())[0]?.outcome === "skipped", "the skip");
    expect(received).toEqual([]);
  });

  test("a device with a key it cannot use fails alone, and the others still get the alert", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "working");
    await owner.insert(pushSubscription).values({
      operatorId: anna,
      endpoint: serviceUrl("bad-key"),
      p256dh: "not-a-key",
      auth: "not-a-secret",
    });
    await visitorWrites(await addVisitor(), "Hello");
    runWorker();
    await until(async () => (await deliveries())[0]?.outcome === "sent", "the delivery");
    expect(received.filter((one) => one.url === "/bad-key")).toEqual([]);
    // Once, because a retry for the other device would alert this one again.
    expect(received.filter((one) => one.url === "/working")).toHaveLength(1);
  });

  test("a delivery retries when no device accepted it", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await owner.insert(pushSubscription).values({
      operatorId: anna,
      endpoint: serviceUrl("only-bad-key"),
      p256dh: "not-a-key",
      auth: "not-a-secret",
    });
    await visitorWrites(await addVisitor(), "Hello");
    runWorker();
    await until(async () => (await deliveries())[0]?.outcome === "failed", "the limit");
    expect((await deliveries())[0]?.attempts).toBe(MAX_ATTEMPTS);
  });

  test("a device that never answers does not hold up the other operators' alerts", async () => {
    await addDevice(await addOperator(`slow-${randomUUID()}@example.com`), "slow");
    for (let index = 0; index < 4; index++) {
      await addDevice(
        await addOperator(`fast-${index}-${randomUUID()}@example.com`),
        `fast-${index}`,
      );
    }
    answer = (url) => (url.includes("slow") ? "hold" : 201);
    runWorker();
    await visitorWrites(await addVisitor(), "First");
    await until(() => received.some((one) => one.url === "/slow"), "the slow send to start");
    // The slow send still holds, and a second message reaches the four others meanwhile.
    await visitorWrites(await addVisitor(), "Second");
    await until(
      () => received.filter((one) => one.url.startsWith("/fast")).length === 8,
      "both messages at the fast devices",
    );
  });

  test("a fan-out that fails every pass does not stop the deliveries behind it", async () => {
    await addDevice(await addOperator(`on-${randomUUID()}@example.com`), "after");
    await visitorWrites(await addVisitor(), "Delivered anyway");
    await fanOutAll();
    // The oldest event the fan-out takes, and one it fails on every time.
    await owner.insert(event).values({
      workspaceId: space.id,
      seq: 1_000_000n,
      kind: "message.created",
      payload: { messageId: "not-a-uuid", conversationId: "not-a-uuid" },
      needsAlert: true,
      createdAt: new Date(Date.now() - 60_000),
    });
    runWorker();
    await until(() => received.some((one) => one.url === "/after"), "the delivery");
  });

  test("the list of push services refuses a private or plain address", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/x")).toBe(true);
    expect(isPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/x",
      "https://169.254.169.254/latest",
      "https://localhost/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evil.example/fcm.googleapis.com",
      "not a url",
    ]) {
      expect(isPushEndpoint(bad)).toBe(false);
    }
  });
});

describe("claims", () => {
  test("two workers never hold the same claim", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "claims");
    const from = await addVisitor();
    for (let index = 0; index < 40; index++) await visitorWrites(from, `Message ${index}`);
    await fanOutAll();
    const second = database.connect("worker").db;
    const claims = await Promise.all([
      claimDeliveries(workerDb, 15, 60_000),
      claimDeliveries(second, 15, 60_000),
      claimDeliveries(workerDb, 15, 60_000),
      claimDeliveries(second, 15, 60_000),
    ]);
    const ids = claims.flat().map((row) => row.id);
    expect(ids.length).toBe(40);
    expect(new Set(ids).size).toBe(40);
  });

  test("two workers fanning out make one set of rows", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "fan");
    const from = await addVisitor();
    for (let index = 0; index < 20; index++) await visitorWrites(from, `Message ${index}`);
    const second = database.connect("worker").db;
    const run = async (db: Database) => {
      while (await fanOutOne(db, { push: true, email: true }));
    };
    await Promise.all([run(workerDb), run(second)]);
    expect(await deliveries()).toHaveLength(20);
  });

  test("a live claim stays out of reach, and an expired claim returns", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "expiry");
    await visitorWrites(await addVisitor(), "Hello");
    await fanOutAll();
    expect(await claimDeliveries(workerDb, 10, 60_000)).toHaveLength(1);
    expect(await claimDeliveries(workerDb, 10, 60_000)).toHaveLength(0);
    await expireClaims();
    const [again] = await claimDeliveries(workerDb, 10, 60_000);
    expect(again?.attempts).toBe(2);
  });

  test("a worker that outlived its claim cannot finish the next worker's row", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "stale");
    await visitorWrites(await addVisitor(), "Hello");
    await fanOutAll();
    const [stale] = await claimDeliveries(workerDb, 10, 60_000);
    await expireClaims();
    await claimDeliveries(workerDb, 10, 60_000);
    if (stale === undefined) throw new Error("No claim");
    await finishDelivery(workerDb, stale, "failed");
    expect((await deliveries())[0]?.outcome).toBeNull();
  });

  test("a row that crashes every worker stops at the limit", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "crashes");
    await visitorWrites(await addVisitor(), "Hello");
    await fanOutAll();
    await owner.update(alertDelivery).set({ attempts: MAX_ATTEMPTS });
    runWorker();
    await until(async () => (await deliveries())[0]?.outcome === "failed", "the limit");
    expect(received).toEqual([]);
  });

  test("stopping a worker with a claimed job releases it", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "stop");
    answer = () => "hold";
    await visitorWrites(await addVisitor(), "Hello");
    const worker = runWorker();
    await until(() => received.length === 1, "the send to start");
    await worker.stop();
    const [row] = await deliveries();
    expect(row?.claimedUntil).toBeNull();
    expect(row?.attempts).toBe(0);
    expect(row?.finishedAt).toBeNull();

    answer = () => 201;
    runWorker();
    await until(async () => (await deliveries())[0]?.outcome === "sent", "the next worker");
  });
});

describe("crashes of the real worker process", () => {
  function startProcess() {
    const child = spawn(process.execPath, [MAIN, "worker"], {
      env: {
        ...process.env,
        DATABASE_URL,
        WORKER_DATABASE_URL: database.url("worker"),
        VALKEY_URL,
        AUTH_SECRET,
        PUBLIC_URL,
        VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_SUBJECT: keys.subject,
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });
    return child;
  }
  const kill = (child: ChildProcess) =>
    new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGKILL");
    });

  test("a crash before the send: the next worker sends it once", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "before");
    await visitorWrites(await addVisitor(), "Hello");
    await fanOutAll();
    // The claim committed, and then the worker died before it called the push service.
    await claimDeliveries(workerDb, 10, 60_000);
    const child = startProcess();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(received).toEqual([]);
      await expireClaims();
      await until(async () => (await deliveries())[0]?.outcome === "sent", "the resend");
      expect(received).toHaveLength(1);
    } finally {
      await kill(child);
    }
  }, 20_000);

  test("a crash after the send: the alert repeats, with the same tag", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const phone = await addDevice(anna, "after");
    answer = () => "hold";
    await visitorWrites(await addVisitor(), "Hello");
    const first = startProcess();
    await until(() => received.length === 1, "the first send");
    // The push service has the message, and the worker dies before it records that.
    await kill(first);
    const [row] = await deliveries();
    expect(row?.outcome).toBeNull();

    answer = () => 201;
    await expireClaims();
    const second = startProcess();
    try {
      await until(async () => (await deliveries())[0]?.outcome === "sent", "the repeat");
      expect(received).toHaveLength(2);
      const tags = received.map((one) => (decrypt(one.body, phone) as { tag: string }).tag);
      expect(tags[0]).toBe(tags[1]);
    } finally {
      await kill(second);
    }
  }, 20_000);

  test("a crash during a fan-out: finished recipients do not get it again", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const ben = await addOperator(`ben-${randomUUID()}@example.com`);
    await addDevice(anna, "partial-anna");
    await addDevice(ben, "partial-ben");
    answer = (url) => (url.includes("ben") ? "hold" : 201);
    await visitorWrites(await addVisitor(), "Hello");
    const first = startProcess();
    await until(async () => {
      const rows = await deliveries();
      return (
        rows.some((row) => row.outcome === "sent") &&
        received.some((one) => one.url.includes("ben"))
      );
    }, "Anna's alert to finish and Ben's to start");
    await kill(first);

    answer = () => 201;
    await expireClaims();
    const second = startProcess();
    try {
      await until(
        async () => (await deliveries()).every((row) => row.outcome === "sent"),
        "Ben's repeat",
      );
      expect(received.filter((one) => one.url.includes("anna"))).toHaveLength(1);
      expect(received.filter((one) => one.url.includes("ben"))).toHaveLength(2);
    } finally {
      await kill(second);
    }
  }, 20_000);
});

describe("email", () => {
  const replyRows = async () => (await deliveries()).filter((row) => row.visitorId !== null);

  test("an operator who chose email gets one per conversation in a burst", async () => {
    const email = `anna-${randomUUID()}@example.com`;
    await addOperator(email, { alertEmail: true });
    await addOperator(`quiet-${randomUUID()}@example.com`);
    const from = await addVisitor("visitor@example.com");
    const written = await visitorWrites(from, "First");
    await visitorWrites(from, "Second");
    runWorker({ mail: true });
    await until(() => mails.length === 1, "the email");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe(email);
    // The operator's own name, which this test sets to their email.
    expect(mails[0]?.text.startsWith(`Hi ${email},\n\n`)).toBe(true);
    expect(mails[0]?.text).toContain("visitor@example.com wrote in Acme:");
    expect(mails[0]?.text).toContain("First");
    expect(mails[0]?.text).toContain("turn them off in Settings, under Alerts");
    expect(mails[0]?.text.endsWith("\n\nCheers,\nThe Dinghy team")).toBe(true);
    expect(mails[0]?.text).toContain(
      `${PUBLIC_URL}/?workspace=${space.id}&conversation=${written.message.conversationId}`,
    );
  });

  test("a mail server that never answers becomes a retry, and push alerts still go out", async () => {
    const stalled: Mailer = { send: () => new Promise(() => {}) };
    const emailer = await addOperator(`mail-${randomUUID()}@example.com`, { alertEmail: true });
    await addDevice(await addOperator(`push-${randomUUID()}@example.com`), "pushed");
    runWorker({ mailer: stalled, retryMs: 60_000, mailTimeoutMs: 200 });
    await visitorWrites(await addVisitor("v@example.com"), "Hello");
    await until(() => received.some((one) => one.url === "/pushed"), "the push");
    await until(
      async () =>
        (await deliveries()).some(
          (row) =>
            row.operatorId === emailer &&
            row.attempts === 1 &&
            row.finishedAt === null &&
            row.claimedUntil === null,
        ),
      "the email's retry",
    );
  });

  test("emails waiting for an SMTP connection do not time out there and go out twice", async () => {
    // Like nodemailer's pool: three connections, and the rest of the emails wait in a queue.
    const delivered: string[] = [];
    let busy = 0;
    const queue: (() => void)[] = [];
    const pooled: Mailer = {
      async send(to) {
        if (busy >= 3) await new Promise<void>((resolve) => queue.push(resolve));
        busy += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        delivered.push(to);
        busy -= 1;
        queue.shift()?.();
      },
    };
    const emailers: string[] = [];
    for (let n = 0; n < 9; n++) {
      emailers.push(
        await addOperator(`pool-${n}-${randomUUID()}@example.com`, { alertEmail: true }),
      );
    }
    runWorker({ push: undefined, mailer: pooled, retryMs: 60_000, mailTimeoutMs: 250 });
    await visitorWrites(await addVisitor("v@example.com"), "Hello");
    await until(async () => {
      const rows = (await deliveries()).filter(
        (row) => row.operatorId !== null && emailers.includes(row.operatorId),
      );
      return rows.length === 9 && rows.every((row) => row.finishedAt !== null);
    }, "every email finished");
    expect(delivered).toHaveLength(9);
  });

  test("an email that gave up waiting does not take a free connection from the next one", async () => {
    let delivered = 0;
    const slow: Mailer = {
      async send() {
        await new Promise((resolve) => setTimeout(resolve, 400));
        delivered += 1;
      },
    };
    const emailers: string[] = [];
    for (let n = 0; n < 25; n++) {
      emailers.push(
        await addOperator(`wait-${n}-${randomUUID()}@example.com`, { alertEmail: true }),
      );
    }
    runWorker({ push: undefined, mailer: slow, retryMs: 60_000, mailTimeoutMs: 500 });
    await visitorWrites(await addVisitor("v@example.com"), "Hello");
    // 20 in flight: 3 send, 3 more at 400 ms, and the other 14 give up at 500 ms. The last 5 are
    // claimed then, and 3 of them must get the connections that free up at 800 ms.
    await until(async () => {
      const rows = (await deliveries()).filter(
        (row) => row.operatorId !== null && emailers.includes(row.operatorId),
      );
      return (
        rows.length === 25 &&
        rows.every(
          (row) => row.finishedAt !== null || (row.attempts > 0 && row.claimedUntil === null),
        )
      );
    }, "every email sent or waiting for its retry");
    await expect.poll(() => delivered, { timeout: 500 }).toBeGreaterThanOrEqual(9);
  });

  test("with no mail server, email creates no rows", async () => {
    await addOperator(`anna-${randomUUID()}@example.com`, { alertEmail: true });
    await visitorWrites(await addVisitor("v@example.com"), "Hello");
    await fanOutAll({ push: true, email: false });
    expect(await deliveries()).toEqual([]);
  });

  test("a reply email waits, then carries every unread reply and a stop link", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    const conversationId = written.message.conversationId;
    await operatorWrites(anna, conversationId, "First answer");
    await operatorWrites(anna, conversationId, "Second answer");
    await fanOutAll();
    const rows = await replyRows();
    // The second reply joins the pending email.
    expect(rows).toHaveLength(1);
    const wait = (rows[0]?.nextAttemptAt.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(REPLY_EMAIL_DELAY_MS - 5000);

    runWorker({ mail: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mails).toEqual([]);

    await makeDue();
    await until(() => mails.length === 1, "the email");
    const mail = mails[0];
    expect(mail?.to).toBe("v@example.com");
    expect(mail?.subject).toBe("Acme replied to your message");
    expect(mail?.text).toContain("First answer\n\nSecond answer");
    // Nobody proved the visitor's address, so it greets no name.
    expect(mail?.text.startsWith("Hi,\n\nAcme replied to your message:")).toBe(true);
    expect(mail?.text.endsWith("\n\nCheers,\nThe Dinghy team")).toBe(true);
    const stop = emailStopUrl(PUBLIC_URL, AUTH_SECRET, space.id, "v@example.com");
    expect(mail?.text).toContain(stop);
    expect(mail?.text).toContain(
      "You got this because this address was entered in a chat with Acme.",
    );
    expect(mail?.headers?.["list-unsubscribe"]).toBe(`<${stop}>`);
    expect(mail?.headers?.["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
  });

  test("a visitor who read the reply gets no email", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    const reply = await operatorWrites(anna, written.message.conversationId, "Answer");
    await fanOutAll();
    await owner
      .update(visitor)
      .set({ lastReadSeq: BigInt(reply.message.seq) })
      .where(and(eq(visitor.workspaceId, space.id), eq(visitor.id, from)));
    await makeDue();
    runWorker({ mail: true });
    await until(async () => (await replyRows())[0]?.outcome === "skipped", "the skip");
    expect(mails).toEqual([]);
  });

  test("a stopped address gets no email, including one already waiting", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    await operatorWrites(anna, written.message.conversationId, "Answer");
    await fanOutAll();
    await owner
      .insert(emailStop)
      .values({ workspaceId: space.id, addressHash: emailAddressHash(" V@example.com") });
    await makeDue();
    runWorker({ mail: true });
    await until(async () => (await replyRows())[0]?.outcome === "skipped", "the skip");
    // With nothing pending, a new reply reaches the stop check and creates no row.
    await operatorWrites(anna, written.message.conversationId, "Another");
    await until(
      async () => (await owner.select().from(event).where(eq(event.needsAlert, true))).length === 0,
      "fan-out",
    );
    expect(await replyRows()).toHaveLength(1);
    expect(mails).toEqual([]);
  });

  test("a stop follows the address: a new visitor is stopped, a corrected address is not", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await owner
      .insert(emailStop)
      .values({ workspaceId: space.id, addressHash: emailAddressHash("stranger@example.com") });
    const repeat = await addVisitor("Stranger@example.com");
    const first = await visitorWrites(repeat, "Help");
    await operatorWrites(anna, first.message.conversationId, "Answer");
    await fanOutAll();
    expect(await replyRows()).toEqual([]);

    await owner.update(visitor).set({ email: "me@example.com" }).where(eq(visitor.id, repeat));
    await operatorWrites(anna, first.message.conversationId, "Answer again");
    await fanOutAll();
    await makeDue();
    runWorker({ mail: true });
    await until(() => mails.length === 1, "the email");
    expect(mails[0]?.to).toBe("me@example.com");
  });

  test("a new reply after the first was read still gets its email", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    const conversationId = written.message.conversationId;
    const first = await operatorWrites(anna, conversationId, "First answer");
    await fanOutAll();
    await owner
      .update(visitor)
      .set({ lastReadSeq: BigInt(first.message.seq) })
      .where(eq(visitor.id, from));
    await operatorWrites(anna, conversationId, "Second answer");
    await fanOutAll();
    await makeDue();
    runWorker({ mail: true });
    await until(() => mails.length === 1, "the email");
    expect(mails[0]?.text).toContain("Second answer");
    expect(mails[0]?.text).not.toContain("First answer");
  });

  test("a waiting email carries a reply from the visitor's other conversation", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    const conversationId = written.message.conversationId;
    await operatorWrites(anna, conversationId, "Answer in the first");
    await fanOutAll();
    await withWorkspace(app, space.id, (tx) =>
      setConversationStatus(tx, space.id, conversationId, "closed"),
    );
    const next = await visitorWrites(from, "One more thing");
    expect(next.message.conversationId).not.toBe(conversationId);
    await operatorWrites(anna, next.message.conversationId, "Answer in the second");
    await fanOutAll();
    expect(await replyRows()).toHaveLength(1);
    await makeDue();
    runWorker({ mail: true });
    await until(() => mails.length === 1, "the email");
    expect(mails[0]?.text).toContain("Answer in the first");
    expect(mails[0]?.text).toContain("Answer in the second");
  });

  test("a reply during a send gets its own later email", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    const conversationId = written.message.conversationId;
    await operatorWrites(anna, conversationId, "First");
    await fanOutAll();
    await makeDue();
    await claimDeliveries(workerDb, 1, 60_000);
    await operatorWrites(anna, conversationId, "Second");
    await fanOutAll();
    const rows = await replyRows();
    expect(rows).toHaveLength(2);
    const later = rows.find((row) => row.attempts === 0);
    expect((later?.nextAttemptAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      REPLY_EMAIL_DELAY_MS + 60_000,
    );
  });

  test("a due email waits for the gap after a send it did not know about", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    const conversationId = written.message.conversationId;
    await operatorWrites(anna, conversationId, "First");
    await fanOutAll();
    await makeDue();
    const [slow] = await claimDeliveries(workerDb, 1, 60_000);
    await operatorWrites(anna, conversationId, "Second");
    await fanOutAll();
    // The first row's slow retry succeeds just before the second row comes due.
    if (slow === undefined) throw new Error("No claim");
    await finishDelivery(workerDb, slow, "sent");
    await makeDue();
    runWorker({ mail: true });
    await until(async () => {
      const waiting = (await replyRows()).find((row) => row.finishedAt === null);
      return (
        (waiting?.nextAttemptAt.getTime() ?? 0) > Date.now() + REPLY_EMAIL_DELAY_MS &&
        waiting?.claimedUntil === null
      );
    }, "the row to move later");
    expect(mails).toEqual([]);
    expect((await replyRows()).find((row) => row.finishedAt === null)?.attempts).toBe(0);
  });

  test("a due email stops if the daily limit was reached while it waited", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    const conversationId = written.message.conversationId;
    await operatorWrites(anna, conversationId, "Answer");
    await fanOutAll();
    const old = new Date(Date.now() - 3_600_000);
    await owner.insert(alertDelivery).values(
      Array.from({ length: REPLY_EMAILS_PER_DAY }, (_, index) => ({
        workspaceId: space.id,
        eventSeq: BigInt(1000 + index),
        conversationId,
        messageId: written.message.id,
        visitorId: from,
        channel: "email" as const,
        finishedAt: old,
        outcome: "sent" as const,
      })),
    );
    await makeDue();
    runWorker({ mail: true });
    await until(
      async () => (await replyRows()).some((row) => row.outcome === "skipped"),
      "the skip",
    );
    expect(mails).toEqual([]);
  });

  test("a reply that joins a waiting email gets its full wait", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    const conversationId = written.message.conversationId;
    await operatorWrites(anna, conversationId, "First");
    await fanOutAll();
    await owner.update(alertDelivery).set({ nextAttemptAt: new Date(Date.now() + 10_000) });
    await operatorWrites(anna, conversationId, "Second");
    await fanOutAll();
    const [row] = await replyRows();
    expect((row?.nextAttemptAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      REPLY_EMAIL_DELAY_MS - 5000,
    );
  });

  test("an email waiting for a retry stops when the operator turns email off", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`, { alertEmail: true });
    await visitorWrites(await addVisitor(), "Hello");
    await fanOutAll();
    await owner
      .update(workspaceMember)
      .set({ alertEmail: false })
      .where(eq(workspaceMember.operatorId, anna));
    runWorker({ mail: true });
    await until(async () => (await deliveries())[0]?.outcome === "skipped", "the skip");
    expect(mails).toEqual([]);
  });

  test("workers fanning out at once still send one email for a burst", async () => {
    await addOperator(`anna-${randomUUID()}@example.com`, { alertEmail: true });
    const from = await addVisitor();
    for (let index = 0; index < 30; index++) await visitorWrites(from, `Message ${index}`);
    const others = [database.connect("worker").db, database.connect("worker").db];
    const run = async (db: Database) => {
      while (await fanOutOne(db, { push: true, email: true }));
    };
    await Promise.all([run(workerDb), ...others.map(run)]);
    expect(await deliveries()).toHaveLength(1);
  });

  test("reply emails keep a gap and stop at the daily limit", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    const from = await addVisitor("v@example.com");
    const written = await visitorWrites(from, "Help");
    const conversationId = written.message.conversationId;
    const sendOne = async () => {
      await operatorWrites(anna, conversationId, "Answer");
      await fanOutAll();
      await makeDue();
      const [row] = await claimDeliveries(workerDb, 1, 60_000);
      if (row !== undefined) await finishDelivery(workerDb, row, "sent");
    };
    await sendOne();
    // The next one waits for the gap after the last one sent, which is longer than the delay.
    await operatorWrites(anna, conversationId, "Answer");
    await fanOutAll();
    const pending = (await replyRows()).find((row) => row.finishedAt === null);
    expect((pending?.nextAttemptAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      REPLY_EMAIL_DELAY_MS + 60_000,
    );
    await makeDue();
    const [row] = await claimDeliveries(workerDb, 1, 60_000);
    if (row !== undefined) await finishDelivery(workerDb, row, "sent");
    for (let index = 2; index < REPLY_EMAILS_PER_DAY; index++) await sendOne();
    expect(await replyRows()).toHaveLength(REPLY_EMAILS_PER_DAY);
    await operatorWrites(anna, conversationId, "Over the limit");
    await fanOutAll();
    expect(await replyRows()).toHaveLength(REPLY_EMAILS_PER_DAY);
  });
});

describe("retention", () => {
  const feed = (cursor: Awaited<ReturnType<typeof listWorkspaceEvents>>["cursor"] | undefined) =>
    withWorkspace(app, space.id, (tx) => listWorkspaceEvents(tx, space.id, cursor, 10));

  test("pruning removes old events, and a cursor older than them gets resync", async () => {
    const start = (await feed(undefined)).cursor;
    const from = await addVisitor();
    await visitorWrites(from, "Old");
    await visitorWrites(from, "Also old");
    await owner.update(event).set({ needsAlert: false }).where(eq(event.workspaceId, space.id));
    const middle = (await feed(start)).cursor;
    expect((await feed(start)).events).toHaveLength(2);

    await owner
      .update(event)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(event.workspaceId, space.id));
    expect(await pruneOnce(workerDb, new Date())).toBeGreaterThanOrEqual(2);
    expect((await feed(start)).resync).toBe(true);
    // A client that has everything is still current, with nothing left in the table.
    expect((await feed(middle)).resync).toBe(false);

    await visitorWrites(from, "New");
    expect((await feed(start)).resync).toBe(true);
    const next = await feed(middle);
    expect(next.resync).toBe(false);
    expect(next.events).toHaveLength(1);
  });

  test("pruning keeps an event that still waits for fan-out, and recent events", async () => {
    await visitorWrites(await addVisitor(), "Waiting");
    await owner
      .update(event)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(event.workspaceId, space.id));
    await pruneOnce(workerDb, new Date());
    expect(await owner.select().from(event).where(eq(event.workspaceId, space.id))).toHaveLength(1);
    await owner.update(event).set({ needsAlert: false });
    await pruneOnce(workerDb, new Date(Date.now() - 7_200_000));
    expect(await owner.select().from(event).where(eq(event.workspaceId, space.id))).toHaveLength(1);
  });

  test("pruning never leaves a gap after an event it had to keep", async () => {
    const start = (await feed(undefined)).cursor;
    const from = await addVisitor();
    const written = await visitorWrites(from, "Waiting");
    const kept = (await feed(start)).cursor;
    await withWorkspace(app, space.id, (tx) =>
      setConversationStatus(tx, space.id, written.message.conversationId, "closed"),
    );
    await owner
      .update(event)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(event.workspaceId, space.id));
    await pruneOnce(workerDb, new Date());
    // The close comes after an event still waiting for fan-out, so it stays.
    const after = await feed(kept);
    expect(after.resync).toBe(false);
    expect(after.events.map((one) => one.kind)).toEqual(["conversation.closed"]);
    await owner.update(event).set({ needsAlert: false }).where(eq(event.workspaceId, space.id));
    await pruneOnce(workerDb, new Date());
    expect((await feed(kept)).resync).toBe(true);
  });

  test("pruning works out where to stop in each workspace on its own", async () => {
    const waiting = await createWorkspace(app, "Waiting", ["https://waiting.example.com"]);
    const idle = await createWorkspace(app, "Idle", ["https://idle.example.com"]);
    const old = new Date(Date.now() - 3_600_000);
    const rows = (workspaceId: string, needsAlert: (seq: number) => boolean) =>
      [1, 2, 3, 4, 5].map((seq) => ({
        workspaceId,
        seq: BigInt(seq),
        kind: "conversation.closed" as const,
        needsAlert: needsAlert(seq),
        createdAt: old,
      }));
    await owner
      .insert(event)
      .values([...rows(waiting.id, (seq) => seq === 3), ...rows(idle.id, () => false)]);
    await pruneOnce(workerDb, new Date());
    const left = async (workspaceId: string) =>
      (await owner.select({ seq: event.seq }).from(event).where(eq(event.workspaceId, workspaceId)))
        .map((row) => Number(row.seq))
        .sort();
    // The event that waits for fan-out stops the prune in its own workspace only.
    expect(await left(waiting.id)).toEqual([3, 4, 5]);
    expect(await left(idle.id)).toEqual([]);
  });

  test("pruning removes every expired address block, past one batch", async () => {
    const blocked = await addVisitor();
    const expiresAt = new Date(Date.now() - 1000);
    await owner.insert(ipBlock).values(
      Array.from({ length: 1001 }, (_, index) => ({
        workspaceId: space.id,
        ipHash: `hash-${index}`,
        visitorId: blocked,
        expiresAt,
      })),
    );
    expect(await pruneOnce(workerDb, new Date(0))).toBeGreaterThanOrEqual(1001);
    expect(await owner.select().from(ipBlock).where(eq(ipBlock.workspaceId, space.id))).toEqual([]);
  });

  test("pruning removes finished deliveries and keeps pending ones", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "prune");
    const from = await addVisitor();
    await visitorWrites(from, "One");
    await visitorWrites(from, "Two");
    await fanOutAll();
    const [row] = await claimDeliveries(workerDb, 1, 60_000);
    if (row === undefined) throw new Error("No claim");
    await finishDelivery(workerDb, row, "sent");
    await pruneOnce(workerDb, new Date(Date.now() + 1000));
    const left = await deliveries();
    expect(left).toHaveLength(1);
    expect(left[0]?.finishedAt).toBeNull();
  });
});

describe("the roles", () => {
  test("the app role cannot read deliveries or delete events", async () => {
    await expect(app.select().from(alertDelivery)).rejects.toThrow();
    await expect(
      withWorkspace(app, space.id, (tx) => tx.delete(event).where(eq(event.workspaceId, space.id))),
    ).rejects.toThrow();
  });

  test("the worker can change only the alert flag on an event", async () => {
    await visitorWrites(await addVisitor(), "Hello");
    await expect(
      withWorkspace(workerDb, space.id, (tx) => tx.update(event).set({ kind: "team.changed" })),
    ).rejects.toThrow();
  });

  test("the worker cannot read another workspace's messages while it fans out", async () => {
    const other = await createWorkspace(app, "Other", ["https://other.example.com"]);
    const [secret] = await withWorkspace(workerDb, other.id, (tx) =>
      tx.execute(sql`select current_setting('app.workspace_id', true) as id`).then((r) => r.rows),
    );
    expect(secret?.id).toBe(other.id);
    await visitorWrites(await addVisitor(), "Hello");
    const rows = await withWorkspace(workerDb, other.id, (tx) =>
      tx.execute(sql`select id from message`).then((r) => r.rows),
    );
    expect(rows).toEqual([]);
  });
});

describe("the routes", () => {
  let server: App;
  let cookie: string;
  let operatorId: string;
  const ORIGIN = new URL(PUBLIC_URL).origin;
  const sends: string[] = [];
  const push = createPush(keys, (async (url: string) => {
    sends.push(String(url));
    return new Response(null, { status: url.toString().includes("gone") ? 410 : 201 });
  }) as typeof fetch);

  const request = (method: string, path: string, body?: unknown, as = cookie) =>
    server.request(path, {
      method,
      headers: { cookie: as, origin: ORIGIN, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const device = (endpoint: string) => {
    const browser = browserKeys();
    return {
      endpoint,
      keys: {
        p256dh: browser.publicKey.toString("base64url"),
        auth: browser.auth.toString("base64url"),
      },
    };
  };

  beforeEach(async () => {
    sends.length = 0;
    const auth = createAuth({ db: app, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    server = createApp({
      alerts: { push, emailAvailable: true, secret: AUTH_SECRET },
      auth,
      checks: { postgres: async () => {}, valkey: async () => {} },
      db: app,
      logger,
      valkey: null,
    });
    ({ id: operatorId, cookie } = await signedInOperator({
      app: server,
      auth,
      owner,
      email: `route-${randomUUID()}@example.com`,
      workspaceId: space.id,
      role: "agent",
    }));
  });

  test("settings read and change for a member, and stay hidden from others", async () => {
    const path = `/v1/operator/workspaces/${space.id}/alerts`;
    expect(await (await request("GET", path)).json()).toEqual({
      email: false,
      pushKey: keys.publicKey,
      emailAvailable: true,
    });
    const changed = await request("PATCH", path, { email: true });
    expect(((await changed.json()) as { email: boolean }).email).toBe(true);
    const other = await createWorkspace(app, "Other", ["https://other.example.com"]);
    expect((await request("GET", `/v1/operator/workspaces/${other.id}/alerts`)).status).toBe(404);
    expect((await request("GET", path, undefined, "")).status).toBe(401);
  });

  test("a device saves once per browser, and a private address is refused", async () => {
    const good = device("https://fcm.googleapis.com/fcm/send/abc");
    expect((await request("PUT", "/v1/operator/push-subscription", good)).status).toBe(200);
    expect((await request("PUT", "/v1/operator/push-subscription", good)).status).toBe(200);
    const mine = () =>
      owner.select().from(pushSubscription).where(eq(pushSubscription.operatorId, operatorId));
    expect(await mine()).toHaveLength(1);
    const bad = device("https://169.254.169.254/latest/meta-data");
    expect((await request("PUT", "/v1/operator/push-subscription", bad)).status).toBe(400);
    expect(await mine()).toHaveLength(1);
  });

  test("a device with keys of the wrong size is refused", async () => {
    const bad = {
      endpoint: "https://fcm.googleapis.com/fcm/send/bad",
      keys: { p256dh: "short", auth: "short" },
    };
    expect((await request("PUT", "/v1/operator/push-subscription", bad)).status).toBe(400);
  });

  test("an operator cannot delete someone else's device", async () => {
    const anna = await addOperator(`anna-${randomUUID()}@example.com`);
    await addDevice(anna, "not-yours");
    const body = { endpoint: serviceUrl("not-yours") };
    expect((await request("DELETE", "/v1/operator/push-subscription", body)).status).toBe(200);
    expect(await owner.select().from(pushSubscription)).toHaveLength(1);
  });

  test("an operator keeps at most ten devices, the newest ones", async () => {
    for (let index = 0; index < 12; index++) {
      const saved = await request(
        "PUT",
        "/v1/operator/push-subscription",
        device(`https://fcm.googleapis.com/fcm/send/${index}`),
      );
      expect(saved.status).toBe(200);
    }
    const rows = await owner
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.operatorId, operatorId));
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.endpoint)).toContain("https://fcm.googleapis.com/fcm/send/11");
  });

  test("the test notification reaches each device and removes a dead one", async () => {
    await request(
      "PUT",
      "/v1/operator/push-subscription",
      device("https://fcm.googleapis.com/fcm/send/live"),
    );
    await request(
      "PUT",
      "/v1/operator/push-subscription",
      device("https://fcm.googleapis.com/fcm/send/gone"),
    );
    const response = await request("POST", "/v1/operator/push-test", {});
    expect(await response.json()).toEqual({ sent: 1, failed: 0 });
    expect(sends).toHaveLength(2);
    const rows = await owner
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.operatorId, operatorId));
    expect(rows.map((row) => row.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/live"]);
  });

  test("the stop link asks first, stops on POST, and needs its signature", async () => {
    const email = `stop-${randomUUID()}@example.com`;
    const url = new URL(emailStopUrl(PUBLIC_URL, AUTH_SECRET, space.id, email));
    const path = `${url.pathname}${url.search}`;
    const stops = () => owner.select().from(emailStop).where(eq(emailStop.workspaceId, space.id));
    expect(path).not.toContain(email);

    const asked = await server.request(path);
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("<form");
    // A mail scanner opens the link, and that must not stop the emails.
    expect(await stops()).toEqual([]);

    const forged = await server.request(`${url.pathname}?signature=forged`, { method: "POST" });
    expect(forged.status).toBe(404);
    expect(await stops()).toEqual([]);
    const moved = await server.request(
      `${url.pathname.replace(emailAddressHash(email), emailAddressHash("other@example.com"))}${url.search}`,
      { method: "POST" },
    );
    expect(moved.status).toBe(404);

    expect((await server.request(path, { method: "POST" })).status).toBe(200);
    expect((await server.request(path, { method: "POST" })).status).toBe(200);
    expect(await stops()).toEqual([
      expect.objectContaining({ addressHash: emailAddressHash(email) }),
    ]);
  });
});
