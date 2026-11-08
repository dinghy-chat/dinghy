import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { Redis } from "iovalkey";
import { SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, fromSocket, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { sendOperatorMessage } from "../test/messages.ts";
import { type App, createApp } from "./app.ts";
import { operator, visitor, workspace, workspaceMember } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { createLive, type Live, noLive } from "./live.ts";
import { appendMessage } from "./messages.ts";
import { openLiveStream, type StreamOptions } from "./stream.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = "https://app.example.com";
const OPERATOR = "00000000-0000-4000-8000-0000000000f2";
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let a: NewWorkspace;
const cleanups: (() => void)[] = [];

function instance(stream?: Partial<StreamOptions>, url = VALKEY_URL): { app: App; live: Live } {
  const publisher = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  publisher.on("error", () => {});
  const live = createLive(publisher, url, logger);
  cleanups.push(() => {
    live.stop();
    publisher.disconnect();
  });
  const app = createApp({
    db,
    logger,
    live,
    checks: { postgres: ok, valkey: ok },
    stream: { heartbeatMs: 25_000, lifetimeMs: 60_000, ...stream },
  });
  return { app, live };
}

async function newVisitor(app: App, key = a.publicKey) {
  const response = await app.request(`/v1/widget/${key}/visitors`, {
    method: "POST",
    headers: { origin: ORIGIN },
  });
  return (await response.json()) as { visitorId: string; token: string };
}

async function send(app: App, token: string, clientId: string, body: string) {
  const response = await app.request(`/v1/widget/${a.publicKey}/messages`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ clientId, body }),
  });
  return { status: response.status, json: (await response.json()) as { conversationId: string } };
}

interface StreamEvent {
  event: string;
  id: string | undefined;
  data: Record<string, unknown>;
}

/** A small client that reads the stream the way the widget will: with fetch and a bearer token. */
async function connect(
  app: App,
  token: string,
  after?: string,
  origin = ORIGIN,
  key = a.publicKey,
  address?: string,
) {
  const query = after === undefined ? "" : `?after=${after}`;
  const response = await app.request(
    `/v1/widget/${key}/stream${query}`,
    { headers: { origin, authorization: `Bearer ${token}` } },
    address === undefined ? undefined : fromSocket(address),
  );
  // Cancelling the body is what a real disconnect does to the server's stream.
  const reader = response.status === 200 ? response.body?.getReader() : undefined;
  const events: StreamEvent[] = [];
  let rawText = "";
  let ended = false;
  const reading = (async () => {
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        rawText += text;
        buffer += text;
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end === -1) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const field = (name: string) =>
            block
              .split("\n")
              .find((line) => line.startsWith(`${name}: `))
              ?.slice(name.length + 2);
          const event = field("event");
          if (event !== undefined) {
            events.push({ event, id: field("id"), data: JSON.parse(field("data") ?? "{}") });
          }
        }
      }
    } catch {
      // An abort ends the read.
    }
    ended = true;
  })();
  const close = () => {
    reader?.cancel().catch(() => {});
  };
  cleanups.push(close);
  const messages = () => events.filter((e) => e.event === "message").map((e) => e.data.body);
  return {
    response,
    events,
    messages,
    raw: () => rawText,
    ended: () => ended,
    reading,
    close,
    async until(predicate: () => boolean, what: string, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${what}. Saw ${JSON.stringify(events)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    lastCursor: () => events.filter((e) => e.id !== undefined).at(-1)?.id,
    async ready() {
      await this.until(() => events.some((e) => e.event === "ready"), "ready");
    },
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 20).db;
  owner = database.connect("migrator").db;
  a = await createWorkspace(db, "A", [ORIGIN]);
  await owner.insert(operator).values({ id: OPERATOR, name: "Anna", email: "anna@example.com" });
  await owner
    .insert(workspaceMember)
    .values({ workspaceId: a.id, operatorId: OPERATOR, role: "owner" });
});

afterAll(async () => {
  for (const cleanup of cleanups) cleanup();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await database.drop();
});

describe("delivery", () => {
  test("a stream tells a proxy such as nginx not to buffer it", async () => {
    const { app } = instance();
    const { token } = await newVisitor(app);
    const client = await connect(app, token);
    expect(client.response.headers.get("x-accel-buffering")).toBe("no");
    await client.ready();
    client.close();
  });

  test("a stream replays history, then reports ready", async () => {
    const { app } = instance();
    const { token } = await newVisitor(app);
    await send(app, token, "m1", "first");
    await send(app, token, "m2", "second");
    const client = await connect(app, token);
    expect(client.response.headers.get("content-type")).toContain("text/event-stream");
    expect(client.response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    await client.ready();
    expect(client.messages()).toEqual(["first", "second"]);
  });

  test("a message sent to one instance reaches a client on another", async () => {
    const one = instance();
    const two = instance();
    const { token } = await newVisitor(one.app);
    const client = await connect(two.app, token);
    await client.ready();
    await send(one.app, token, "across", "hello from one");
    await client.until(() => client.messages().length === 1, "the message");
    expect(client.messages()).toEqual(["hello from one"]);
  });

  test("a reply from an operator reaches the visitor", async () => {
    const { app, live } = instance();
    const { token, visitorId } = await newVisitor(app);
    const { json } = await send(app, token, "q", "question");
    const client = await connect(app, token);
    await client.ready();
    await sendOperatorMessage(db, a.id, OPERATOR, json.conversationId, "answer");
    live.wake(a.id, visitorId);
    await client.until(() => client.messages().length === 2, "the reply");
    expect(client.events.filter((e) => e.event === "message").at(-1)?.data.fromVisitor).toBe(false);
  });

  test("a signal for one visitor delivers nothing to another", async () => {
    const { app } = instance();
    const first = await newVisitor(app);
    const second = await newVisitor(app);
    const client = await connect(app, second.token);
    await client.ready();
    await send(app, first.token, "private", "private text");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.messages()).toEqual([]);
    expect(client.raw()).not.toContain("private text");
  });

  test("a stream connects from a cursor and skips what it has", async () => {
    const { app } = instance();
    const { token } = await newVisitor(app);
    await send(app, token, "c1", "seen");
    const first = await connect(app, token);
    await first.ready();
    const cursor = first.lastCursor();
    first.close();
    await send(app, token, "c2", "new");
    const second = await connect(app, token, cursor);
    await second.ready();
    expect(second.messages()).toEqual(["new"]);
  });

  test("a stale generation gets a resync, then the full history", async () => {
    const { app } = instance();
    const { token } = await newVisitor(app);
    await send(app, token, "r1", "one");
    const client = await connect(app, token, "999.5");
    await client.ready();
    expect(client.events.map((e) => e.event)).toEqual(["resync", "message", "ready"]);
  });
});

describe("lost signals", () => {
  test("publication in the reverse of commit order loses nothing", async () => {
    const { app, live } = instance();
    const { token, visitorId } = await newVisitor(app);
    const client = await connect(app, token);
    await client.ready();
    const write = (clientId: string, body: string) =>
      withWorkspace(db, a.id, (tx) =>
        appendMessage(tx, a.id, { kind: "visitor", visitorId }, { clientId, body }),
      );
    // Both commit, but only the later one publishes, and it publishes first.
    await write("older", "older");
    await write("newer", "newer");
    live.wake(a.id, visitorId);
    await client.until(() => client.messages().length === 2, "both messages");
    expect(client.messages()).toEqual(["older", "newer"]);
    const cursor = client.lastCursor();
    client.close();
    const after = await connect(app, token, cursor);
    await after.ready();
    expect(after.messages()).toEqual([]);
  });

  test("a connected client recovers when the subscriber loses its connection", async () => {
    const { app } = instance();
    const { token } = await newVisitor(app);
    const client = await connect(app, token);
    await client.ready();
    const admin = new Redis(VALKEY_URL);
    // The signal for this send goes nowhere, and the stream itself stays connected.
    await admin.call("CLIENT", "KILL", "TYPE", "pubsub");
    await send(app, token, "killed", "sent while away");
    admin.disconnect();
    await client.until(() => client.messages().length === 1, "the message after a reconnect");
    expect(client.ended()).toBe(false);
  });

  test("after a reconnect, the streams wake a few at a time, not all at once", async () => {
    const publisher = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    publisher.on("error", () => {});
    const live = createLive(publisher, VALKEY_URL, logger);
    cleanups.push(() => {
      live.stop();
      publisher.disconnect();
    });
    const woken: number[] = [];
    const session = { wake: () => void woken.push(Date.now()), close() {} };
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) => live.subscribe(a.id, `v${index}`, session)),
    );
    // The first connection wakes them too, so wait for that round to end.
    await expect.poll(() => woken.length, { timeout: 5000 }).toBe(1000);
    woken.length = 0;
    const admin = new Redis(VALKEY_URL);
    await admin.call("CLIENT", "KILL", "TYPE", "pubsub");
    admin.disconnect();
    await expect.poll(() => woken.length, { timeout: 5000 }).toBeGreaterThan(0);
    const first = woken[0] ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(woken.filter((at) => at - first < 150).length).toBeLessThan(500);
    await expect.poll(() => woken.length, { timeout: 5000 }).toBe(1000);
  });

  test("when a sender dies before publishing, the lifetime cap delivers the message", async () => {
    const { app } = instance({ lifetimeMs: 300 });
    const { token, visitorId } = await newVisitor(app);
    const client = await connect(app, token);
    await client.ready();
    // It commits and never publishes.
    await withWorkspace(db, a.id, (tx) =>
      appendMessage(tx, a.id, { kind: "visitor", visitorId }, { clientId: "dead", body: "kept" }),
    );
    await client.until(() => client.events.some((e) => e.event === "close"), "the lifetime cap");
    expect(client.events.at(-1)?.data.reason).toBe("lifetime");
    const reconnected = await connect(app, token);
    await reconnected.ready();
    expect(reconnected.messages()).toEqual(["kept"]);
  });

  test("a send succeeds with Valkey down, and a stream still catches up", async () => {
    const { app } = instance({}, "redis://127.0.0.1:1");
    const { token } = await newVisitor(app);
    const started = Date.now();
    const { status } = await send(app, token, "down", "still stored");
    expect(status).toBe(201);
    expect(Date.now() - started).toBeLessThan(1000);
    const client = await connect(app, token);
    await client.ready();
    expect(client.messages()).toEqual(["still stored"]);
  });
});

/** Forwards to Valkey only once started, so a test can boot an instance with Valkey down. */
async function valkeyProxy() {
  const free = net.createServer();
  await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
  const { port } = free.address() as net.AddressInfo;
  await new Promise((resolve) => free.close(resolve));
  const target = new URL(VALKEY_URL);
  const sockets = new Set<net.Socket>();
  let broken = false;
  const proxy = net.createServer((client) => {
    client.on("error", () => {});
    if (broken) {
      sockets.add(client);
      client.on("data", () => client.write("!! not the protocol\r\n"));
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname);
    sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
  });
  return {
    url: `redis://127.0.0.1:${port}`,
    start: () => new Promise<void>((resolve) => proxy.listen(port, "127.0.0.1", resolve)),
    /** Answers every connection with bytes that are not Valkey's protocol, a fatal error. */
    breakProtocol() {
      broken = true;
    },
    heal() {
      broken = false;
      for (const socket of sockets) socket.destroy();
    },
  };
}

describe("Valkey down at boot", () => {
  test("a stream opened during the outage gets the message when Valkey comes up", async () => {
    const proxy = await valkeyProxy();
    const { app } = instance({}, proxy.url);
    const { token, visitorId } = await newVisitor(app);
    const client = await connect(app, token);
    await client.ready();
    await withWorkspace(db, a.id, (tx) =>
      appendMessage(tx, a.id, { kind: "visitor", visitorId }, { clientId: "boot", body: "kept" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.messages()).toEqual([]);
    await proxy.start();
    await client.until(() => client.messages().length === 1, "the message");
  }, 20_000);

  test("another stream's cleanup cannot orphan a stream that is still subscribing", async () => {
    const proxy = await valkeyProxy();
    const { app } = instance({}, proxy.url);
    const first = await newVisitor(app);
    const second = await newVisitor(app);
    // The first stream waits for its subscription while the second opens and closes.
    const firstClient = connect(app, first.token);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondClient = await connect(app, second.token);
    await secondClient.ready();
    secondClient.close();
    await secondClient.reading;
    const client = await firstClient;
    await client.ready();
    await proxy.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The stream still receives signals, so a revoke reaches it.
    const other = instance();
    // Repeated, because a new instance drops a signal until its publisher has connected.
    const revoking = setInterval(() => other.live.revoke(a.id, first.visitorId), 100);
    await client
      .until(() => client.events.some((e) => e.event === "close"), "the revoke")
      .finally(() => clearInterval(revoking));
    expect(client.events.at(-1)?.data.reason).toBe("revoked");
  }, 20_000);
});

describe("a failed subscribe", () => {
  test("it does not block later streams in the workspace", async () => {
    const proxy = await valkeyProxy();
    proxy.breakProtocol();
    await proxy.start();
    const { app } = instance({}, proxy.url);
    const first = await newVisitor(app);
    const firstClient = await connect(app, first.token);
    await firstClient.ready();
    const second = await newVisitor(app);
    const secondClient = await connect(app, second.token);
    await secondClient.ready();
    proxy.heal();

    // Once Valkey answers again, a stream that subscribed during the failure gets signals.
    const other = instance();
    const revoking = setInterval(() => other.live.revoke(a.id, first.visitorId), 100);
    await firstClient
      .until(() => firstClient.events.some((e) => e.event === "close"), "the revoke")
      .finally(() => clearInterval(revoking));
    expect(firstClient.events.at(-1)?.data.reason).toBe("revoked");
    expect(secondClient.ended()).toBe(false);
  }, 20_000);
});

describe("a client that stops reading", () => {
  async function subscribers(workspaceId: string) {
    const admin = new Redis(VALKEY_URL);
    const reply = (await admin.call("PUBSUB", "NUMSUB", `dinghy:signals:${workspaceId}`)) as [
      string,
      number,
    ];
    admin.disconnect();
    return Number(reply[1]);
  }

  test("the lifetime cap still releases its resources", async () => {
    const own = await createWorkspace(db, "Stalled", [ORIGIN]);
    const { app } = instance({ lifetimeMs: 200 });
    const { token } = await newVisitor(app, own.publicKey);
    await app.request(`/v1/widget/${own.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "s", body: "never read" }),
    });
    // This client never reads the body, so the first write blocks.
    await app.request(`/v1/widget/${own.publicKey}/stream`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    });
    await expect.poll(() => subscribers(own.id), { timeout: 5000 }).toBe(0);
  }, 10_000);
});

describe("access", () => {
  /** An instance that counts open streams in Valkey, as every real install does. */
  function counted() {
    const valkey = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
    cleanups.push(() => valkey.disconnect());
    const { live } = instance();
    return createApp({
      db,
      logger,
      live,
      valkey,
      ipSecret: AUTH_SECRET,
      checks: { postgres: ok, valkey: ok },
      stream: { heartbeatMs: 25_000, lifetimeMs: 60_000 },
    });
  }
  // A new address each run, because these counts live in Valkey and outlast the test database.
  const randomAddress = () =>
    `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
  const open = (app: App, token: string, address: string) =>
    connect(app, token, undefined, ORIGIN, a.publicKey, address);

  test("one visitor cannot hold more than 10 streams, and another visitor still connects", async () => {
    const app = counted();
    const address = randomAddress();
    const { token } = await newVisitor(app);
    const streams = [];
    for (let index = 0; index < 10; index++) {
      const stream = await open(app, token, address);
      expect(stream.response.status).toBe(200);
      streams.push(stream);
    }
    const refused = await open(app, token, address);
    expect(refused.response.status).toBe(429);
    expect(refused.response.headers.get("retry-after")).not.toBeNull();
    expect((await open(app, (await newVisitor(app)).token, address)).response.status).toBe(200);
    streams[0]?.close();
    await expect
      .poll(async () => {
        const again = await open(app, token, address);
        again.close();
        return again.response.status;
      })
      .toBe(200);
  });

  test("one address cannot hold more than 50 streams, and another address still connects", async () => {
    const app = counted();
    const address = randomAddress();
    for (let person = 0; person < 5; person++) {
      const { token } = await newVisitor(app);
      for (let index = 0; index < 10; index++) {
        expect((await open(app, token, address)).response.status).toBe(200);
      }
    }
    const { token } = await newVisitor(app);
    const refused = await open(app, token, address);
    expect(refused.response.status).toBe(429);
    // The cap is per address, so the same visitor still opens from another one.
    expect((await open(app, token, randomAddress())).response.status).toBe(200);
  });

  async function hostToken(subject: string, secondsLeft: number): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(a.publicKey)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + secondsLeft)
      .sign(new TextEncoder().encode(a.signingSecret));
  }

  test("a stream with no valid token is refused", async () => {
    const { app } = instance();
    const client = await connect(app, "dbt_wrong");
    expect(client.response.status).toBe(401);
  });

  test("a stream from another site is refused", async () => {
    const { app } = instance();
    const { token } = await newVisitor(app);
    const client = await connect(app, token, undefined, "https://evil.example.com");
    expect(client.response.status).toBe(403);
  });

  test("a long replay checks access before each page", async () => {
    const reads: number[] = [];
    let allowed = true;
    const route = new Hono();
    route.get("/", (c) =>
      openLiveStream(c, {
        live: noLive,
        logger,
        options: { heartbeatMs: 25_000, lifetimeMs: 60_000 },
        workspaceId: a.id,
        subscriber: "anyone",
        expiresAt: undefined,
        after: undefined,
        authorized: async () => allowed,
        read: async () => {
          reads.push(reads.length);
          allowed = false;
          return {
            items: [{ event: "change", seq: 1n, data: {} }],
            cursor: { generation: 1, seq: 1n },
            hasMore: true,
            resync: false,
          };
        },
      }),
    );
    const response = await route.request("/");
    const text = await response.text();
    expect(reads).toHaveLength(1);
    expect(text).toContain('"reason":"unauthorized"');
  });

  test("an older tab's token does not overwrite newer user data", async () => {
    const { app } = instance();
    const now = Math.floor(Date.now() / 1000);
    const token = (plan: string, issuedAt: number) =>
      new SignJWT({ claims: { plan } })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience(a.publicKey)
        .setSubject("two-tabs")
        .setIssuedAt(issuedAt)
        .setExpirationTime(now + 3600)
        .sign(new TextEncoder().encode(a.signingSecret));
    const older = await token("free", now - 60);
    const newer = await token("pro", now);
    const client = await connect(app, older);
    await client.ready();
    await send(app, newer, "upgrade", "hello");
    await client.until(() => client.messages().length === 1, "the wake");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [row] = await withWorkspace(db, a.id, (tx) =>
      tx.select().from(visitor).where(eq(visitor.externalId, "two-tabs")),
    );
    expect(row?.claims).toEqual({ plan: "pro" });
  });

  test("a stream closes when its token expires", async () => {
    const { app } = instance();
    const client = await connect(app, await hostToken("expiring", 2));
    await client.ready();
    await client.until(() => client.events.some((e) => e.event === "close"), "the expiry");
    expect(client.events.at(-1)?.data.reason).toBe("expired");
  }, 10_000);

  test("a revoke signal closes the stream at once, on another instance too", async () => {
    const one = instance();
    const two = instance();
    const { token, visitorId } = await newVisitor(one.app);
    const client = await connect(two.app, token);
    await client.ready();
    one.live.revoke(a.id, visitorId);
    await client.until(() => client.events.some((e) => e.event === "close"), "the revoke");
    expect(client.events.at(-1)?.data.reason).toBe("revoked");
  });

  test("when a revoke signal is lost, the next read closes the stream before it sends data", async () => {
    const { app, live } = instance();
    const { token, visitorId } = await newVisitor(app);
    const client = await connect(app, token);
    await client.ready();
    // The site loses access, and no revoke signal goes out.
    await withWorkspace(db, a.id, (tx) =>
      tx.update(workspace).set({ allowedOrigins: [] }).where(eq(workspace.id, a.id)),
    );
    try {
      await withWorkspace(db, a.id, (tx) =>
        appendMessage(tx, a.id, { kind: "visitor", visitorId }, { clientId: "late", body: "late" }),
      );
      live.wake(a.id, visitorId);
      await client.until(() => client.events.some((e) => e.event === "close"), "the refusal");
      expect(client.events.at(-1)?.data.reason).toBe("unauthorized");
      expect(client.messages()).toEqual([]);
    } finally {
      await withWorkspace(db, a.id, (tx) =>
        tx
          .update(workspace)
          .set({ allowedOrigins: [ORIGIN] })
          .where(eq(workspace.id, a.id)),
      );
    }
  });
});

describe("the connection", () => {
  test("a stream sends a heartbeat", async () => {
    const { app } = instance({ heartbeatMs: 50 });
    const { token } = await newVisitor(app);
    const client = await connect(app, token);
    await client.ready();
    await client.until(() => client.raw().includes(": ping"), "a heartbeat");
  });

  test("an open stream holds no database connection", async () => {
    const { app } = instance();
    const { token } = await newVisitor(app);
    const client = await connect(app, token);
    await client.ready();
    const { rows } = await owner.execute<{ state: string }>(
      sql`select state from pg_stat_activity
          where datname = current_database() and usename = 'dinghy_app' and state <> 'idle'`,
    );
    expect(rows).toEqual([]);
    client.close();
  });

  test("a client that disconnects releases its subscription", async () => {
    const own = await createWorkspace(db, "Own channel", [ORIGIN]);
    const { app } = instance();
    const { token } = await newVisitor(app, own.publicKey);
    const client = await connect(app, token, undefined, ORIGIN, own.publicKey);
    await client.ready();
    const admin = new Redis(VALKEY_URL);
    const subscribers = async () => {
      const reply = (await admin.call("PUBSUB", "NUMSUB", `dinghy:signals:${own.id}`)) as [
        string,
        number,
      ];
      return Number(reply[1]);
    };
    expect(await subscribers()).toBe(1);
    client.close();
    await client.reading;
    await expect.poll(subscribers, { timeout: 2000 }).toBe(0);
    admin.disconnect();
  });

  test("stopping an instance with a stalled client finishes before Docker's kill timeout", async () => {
    const own = await createWorkspace(db, "Stalled stop", [ORIGIN]);
    const { app } = instance();
    const { token, visitorId } = await newVisitor(app, own.publicKey);
    const conversationRow = await withWorkspace(db, own.id, (tx) =>
      appendMessage(tx, own.id, { kind: "visitor", visitorId }, { clientId: "c", body: "first" }),
    );
    // Far more history than the socket buffers hold, so the server's writes block.
    await owner.execute(sql`
      insert into message (workspace_id, conversation_id, seq, kind, author_visitor_id, client_id, body)
      select ${own.id}::uuid, ${conversationRow.message.conversationId}::uuid, 1000 + n, 'text',
             ${visitorId}::uuid, 'bulk-' || n, repeat('x', 10000)
      from generate_series(1, 3000) as n
    `);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./main.ts", import.meta.url)), "web"],
      {
        env: {
          ...process.env,
          AUTH_SECRET,
          PUBLIC_URL,
          DATABASE_URL: database.url("app"),
          VALKEY_URL,
          PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    await expect.poll(() => output.includes("listening"), { timeout: 10_000 }).toBe(true);
    const port = JSON.parse(output.split("\n").find((l) => l.includes("listening")) ?? "{}").port;
    // A raw socket that sends the request and then never reads.
    const socket = net.connect(port, "127.0.0.1");
    socket.pause();
    socket.on("error", () => {});
    socket.write(
      `GET /v1/widget/${own.publicKey}/stream HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const started = Date.now();
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
    socket.destroy();
  }, 30_000);

  test("stopping an instance with a live stream finishes before Docker's kill timeout", async () => {
    const { app } = instance();
    const { token } = await newVisitor(app);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./main.ts", import.meta.url)), "web"],
      {
        env: {
          ...process.env,
          AUTH_SECRET,
          PUBLIC_URL,
          DATABASE_URL: database.url("app"),
          VALKEY_URL,
          PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    await expect.poll(() => output.includes("listening"), { timeout: 10_000 }).toBe(true);
    const port = JSON.parse(output.split("\n").find((l) => l.includes("listening")) ?? "{}").port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/widget/${a.publicKey}/stream`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readAll = (async () => {
      while (reader !== undefined) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value);
      }
    })();
    await expect.poll(() => text.includes("event: ready"), { timeout: 5000 }).toBe(true);

    const started = Date.now();
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
    await readAll;
    expect(text).toContain('"reason":"stopping"');
  }, 25_000);
});
