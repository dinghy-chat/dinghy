import { randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { SignJWT } from "jose";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, fromSocket, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { addOperator, cookieOf, TEST_PASSWORD } from "../test/operators.ts";
import { pruneOnce } from "./alerts.ts";
import { type AppOptions, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import {
  attachment,
  conversation,
  event,
  ipBlock,
  message,
  storageDeletion,
  visitor,
} from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createImages } from "./images.ts";
import { claimDeletions, localStore, type ObjectStore } from "./storage.ts";
import { startWorker } from "./worker.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const SITE = "https://app.example.com";
const logger = pino({ level: "silent" });
const ok = async () => {};
const connections: Redis[] = [];

let database: TestDatabase;
let db: Database;
let owner: Database;
let workerDb: Database;
let space: NewWorkspace;

function valkey(): Redis {
  const client = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
  connections.push(client);
  return client;
}

const auth = () => createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger });

function makeApp(options: Partial<AppOptions> = {}) {
  return createApp({
    auth: auth(),
    checks: { postgres: ok, valkey: ok },
    db,
    ipSecret: AUTH_SECRET,
    logger,
    ...options,
  });
}

/** A new address, because these counts live in Valkey and outlast the test database. */
const randomAddress = () =>
  `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;

type Server = ReturnType<typeof makeApp>;

const newVisitor = (server: Server, socket: string, headers: Record<string, string> = {}) =>
  server.request(
    `/v1/widget/${space.publicKey}/visitors`,
    { method: "POST", headers: { origin: SITE, ...headers } },
    fromSocket(socket),
  );

async function visitorToken(server: Server, socket: string) {
  const response = await newVisitor(server, socket);
  expect(response.status).toBe(201);
  return (await response.json()) as { visitorId: string; token: string };
}

const send = (server: Server, token: string, socket: string, body = "Hello") =>
  server.request(
    `/v1/widget/${space.publicKey}/messages`,
    {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: randomUUID(), body }),
    },
    fromSocket(socket),
  );

const makeOperator = (role: "owner" | "admin" | "agent") =>
  addOperator({
    auth: auth(),
    owner,
    email: `${role}-${randomUUID()}@example.com`,
    workspaceId: space.id,
    role,
  });

const signIn = (server: Server, email: string, socket: string, password = TEST_PASSWORD) =>
  server.request(
    "/v1/auth/sign-in/email",
    {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    fromSocket(socket),
  );

const asOperator = (server: Server, cookie: string, method: string, path: string, body?: unknown) =>
  server.request(`/v1/operator/workspaces/${space.id}${path}`, {
    method,
    headers: {
      cookie,
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  workerDb = database.connect("worker").db;
}, 30_000);

afterAll(async () => {
  for (const client of connections) client.disconnect();
  await database.drop();
});

beforeEach(async () => {
  space = await createWorkspace(db, "Acme", [SITE]);
});

describe("rate limits", () => {
  // A small scale, so these tests reach a limit in a few requests. 20 visitors an hour becomes 2.
  const small = { limitScale: 0.1 };

  test("a limit applies across two instances, and says when to return", async () => {
    const shared = { ...small };
    const first = makeApp({ ...shared, valkey: valkey() });
    const second = makeApp({ ...shared, valkey: valkey() });
    const address = `198.51.100.${Math.floor(Math.random() * 200)}`;
    expect((await newVisitor(first, address)).status).toBe(201);
    expect((await newVisitor(second, address)).status).toBe(201);
    const refused = await newVisitor(first, address);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // A browser must be able to read this answer.
    expect(refused.headers.get("access-control-allow-origin")).toBe(SITE);
    expect((await newVisitor(second, address)).status).toBe(429);
  });

  test("one abuser does not limit anyone else, or any other workspace", async () => {
    const server = makeApp({ ...small, valkey: valkey() });
    const abuser = "198.51.100.20";
    for (let index = 0; index < 3; index++) await newVisitor(server, abuser);
    expect((await newVisitor(server, abuser)).status).toBe(429);
    expect((await newVisitor(server, "198.51.100.21")).status).toBe(201);
    const other = await createWorkspace(db, "Other", [SITE]);
    const elsewhere = await server.request(
      `/v1/widget/${other.publicKey}/visitors`,
      { method: "POST", headers: { origin: SITE } },
      fromSocket(abuser),
    );
    expect(elsewhere.status).toBe(201);
  });

  test("with Valkey down, everything is allowed", async () => {
    const broken = new Redis("redis://127.0.0.1:1", {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    broken.on("error", () => {});
    connections.push(broken);
    const server = makeApp({ ...small, valkey: broken });
    for (let index = 0; index < 5; index++) {
      expect((await newVisitor(server, "198.51.100.30")).status).toBe(201);
    }
  });
});

describe("the client address behind a proxy", () => {
  const small = { limitScale: 0.1 };
  const proxy = "10.0.0.1";

  test("visitors behind one proxy each have their own limit", async () => {
    const server = makeApp({ ...small, valkey: valkey(), trustedProxyHops: 1 });
    const from = (client: string) => newVisitor(server, proxy, { "x-forwarded-for": client });
    for (let index = 0; index < 3; index++) await from("203.0.113.1");
    expect((await from("203.0.113.1")).status).toBe(429);
    expect((await from("203.0.113.2")).status).toBe(201);
  });

  test("a client cannot escape a limit by adding to X-Forwarded-For", async () => {
    const server = makeApp({ ...small, valkey: valkey(), trustedProxyHops: 1 });
    // The proxy appends the real address, so a forged value is always to its left.
    const forged = (fake: string) =>
      newVisitor(server, proxy, { "x-forwarded-for": `${fake}, 203.0.113.9` });
    for (let index = 0; index < 3; index++) await forged(`192.0.2.${index}`);
    expect((await forged("192.0.2.99")).status).toBe(429);
  });

  test("with no proxy set, the header means nothing", async () => {
    const server = makeApp({ ...small, valkey: valkey() });
    const socket = "198.51.100.40";
    const forged = (fake: string) => newVisitor(server, socket, { "x-forwarded-for": fake });
    for (let index = 0; index < 3; index++) await forged(`192.0.2.${index}`);
    expect((await forged("192.0.2.99")).status).toBe(429);
  });

  test("two proxies read the entry the first one wrote", async () => {
    const server = makeApp({ ...small, valkey: valkey(), trustedProxyHops: 2 });
    const from = (client: string) =>
      newVisitor(server, proxy, { "x-forwarded-for": `forged, ${client}, 172.16.0.1` });
    for (let index = 0; index < 3; index++) await from("203.0.113.20");
    expect((await from("203.0.113.20")).status).toBe(429);
    expect((await from("203.0.113.21")).status).toBe(201);
  });

  test("an address in one IPv6 network shares one limit", async () => {
    const server = makeApp({ ...small, valkey: valkey() });
    for (let index = 1; index <= 3; index++) {
      await newVisitor(server, `2001:db8:1234:5678::${index}`);
    }
    expect((await newVisitor(server, "2001:db8:1234:5678::99")).status).toBe(429);
    expect((await newVisitor(server, "2001:db8:1234:9999::1")).status).toBe(201);
  });
});

describe("login and reset limits", () => {
  test("an attacker's wrong passwords do not lock the operator out from elsewhere", async () => {
    const server = makeApp({ valkey: valkey() });
    const { email } = await makeOperator("agent");
    const attacker = randomAddress();
    for (let index = 0; index < 5; index++) {
      expect((await signIn(server, email, attacker, "wrong-password")).status).toBe(401);
    }
    expect((await signIn(server, email, attacker, "wrong-password")).status).toBe(429);
    expect((await signIn(server, email, attacker)).status).toBe(429);
    expect((await signIn(server, email, randomAddress())).status).toBe(200);
  });

  test("a forged X-Forwarded-For gives an attacker no new attempts", async () => {
    const server = makeApp({ valkey: valkey(), trustedProxyHops: 1 });
    const { email } = await makeOperator("agent");
    const client = randomAddress();
    const attempt = (fake: string) =>
      server.request(
        "/v1/auth/sign-in/email",
        {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            "x-forwarded-for": `${fake}, ${client}`,
          },
          body: JSON.stringify({ email, password: "wrong-password" }),
        },
        fromSocket("10.0.0.1"),
      );
    for (let index = 0; index < 5; index++) await attempt(`192.0.2.${index}`);
    expect((await attempt("192.0.2.77")).status).toBe(429);
  });

  test("one address cannot try many accounts", async () => {
    const server = makeApp({ valkey: valkey() });
    const address = randomAddress();
    let last = 0;
    for (let index = 0; index < 31; index++) {
      const response = await signIn(server, `nobody-${randomUUID()}@example.com`, address);
      last = response.status;
    }
    expect(last).toBe(429);
  });

  test("an attacker's reset requests do not block the owner's", async () => {
    const server = makeApp({ valkey: valkey() });
    const { email } = await makeOperator("agent");
    const reset = (socket: string) =>
      server.request(
        "/v1/auth/request-password-reset",
        {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email, redirectTo: "/reset-password" }),
        },
        fromSocket(socket),
      );
    const attacker = randomAddress();
    for (let index = 0; index < 3; index++) await reset(attacker);
    expect((await reset(attacker)).status).toBe(429);
    expect((await reset(randomAddress())).status).not.toBe(429);
  });

  test("many addresses still cannot flood one mailbox", async () => {
    const server = makeApp({ valkey: valkey() });
    const { email } = await makeOperator("agent");
    let last = 0;
    for (let index = 0; index < 11; index++) {
      const response = await server.request(
        "/v1/auth/request-password-reset",
        {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email, redirectTo: "/reset-password" }),
        },
        fromSocket(randomAddress()),
      );
      last = response.status;
    }
    expect(last).toBe(429);
  });
});

describe("blocking a visitor", () => {
  async function blockedWorld() {
    const server = makeApp();
    const { email } = await makeOperator("agent");
    const cookie = cookieOf(await signIn(server, email, "198.51.100.1"));
    const address = "198.51.100.80";
    const { visitorId, token } = await visitorToken(server, address);
    const sent = await send(server, token, address);
    const { conversationId } = (await sent.json()) as { conversationId: string };
    const path = `/conversations/${conversationId}/block`;
    expect((await asOperator(server, cookie, "POST", path, {})).status).toBe(200);
    return { server, cookie, address, visitorId, token, path, conversationId };
  }

  test("a blocked visitor cannot send, or start again after clearing their browser", async () => {
    const { server, address, token } = await blockedWorld();
    const refused = await send(server, token, address);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("blocked");
    // Cleared storage means no token, and so a new visitor, from the same address.
    expect((await newVisitor(server, address)).status).toBe(403);
    // A new address with the old token is still the same person.
    expect((await send(server, token, "198.51.100.81")).status).toBe(403);
  });

  test("the block stores no address in readable form", async () => {
    const { address } = await blockedWorld();
    const rows = await owner.select().from(ipBlock).where(eq(ipBlock.workspaceId, space.id));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(address);
  });

  test("the address block stays in its workspace and ends by itself", async () => {
    const { server, address } = await blockedWorld();
    const other = await createWorkspace(db, "Other", [SITE]);
    const elsewhere = await server.request(
      `/v1/widget/${other.publicKey}/visitors`,
      { method: "POST", headers: { origin: SITE } },
      fromSocket(address),
    );
    expect(elsewhere.status).toBe(201);

    await owner
      .update(ipBlock)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(ipBlock.workspaceId, space.id));
    expect((await newVisitor(server, address)).status).toBe(201);
    await pruneOnce(workerDb, new Date(0));
    expect(await owner.select().from(ipBlock).where(eq(ipBlock.workspaceId, space.id))).toEqual([]);
  });

  test("a signed-in visitor at a blocked address is not affected", async () => {
    const { server, address } = await blockedWorld();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(space.publicKey)
      .setSubject("office-colleague")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode(space.signingSecret));
    expect((await send(server, token, address)).status).toBe(201);
  });

  test("a signed-in visitor can be blocked, by identity and with no address block", async () => {
    const server = makeApp();
    const { email } = await makeOperator("agent");
    const cookie = cookieOf(await signIn(server, email, "198.51.100.1"));
    const now = Math.floor(Date.now() / 1000);
    const tokenFor = () =>
      new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setAudience(space.publicKey)
        .setSubject("abusive-user")
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(new TextEncoder().encode(space.signingSecret));
    const sent = await send(server, await tokenFor(), "198.51.100.90");
    const { conversationId } = (await sent.json()) as { conversationId: string };
    await asOperator(server, cookie, "POST", `/conversations/${conversationId}/block`, {});
    // A new token and a new address are the same identity.
    expect((await send(server, await tokenFor(), "198.51.100.91")).status).toBe(403);
    expect((await newVisitor(server, "198.51.100.90")).status).toBe(201);
    expect(await owner.select().from(ipBlock).where(eq(ipBlock.workspaceId, space.id))).toEqual([]);
  });

  test("another visitor is not affected, and unblock restores both paths", async () => {
    const { server, cookie, address, token, path } = await blockedWorld();
    const other = await visitorToken(server, "198.51.100.82");
    expect((await send(server, other.token, "198.51.100.82")).status).toBe(201);

    expect((await asOperator(server, cookie, "DELETE", path)).status).toBe(200);
    expect((await send(server, token, address)).status).toBe(201);
    expect((await newVisitor(server, address)).status).toBe(201);
  });

  test("two visitors at one address: unblocking one leaves the other's block", async () => {
    const { server, cookie, address, path } = await blockedWorld();
    // A second visitor at the same address, from before the block.
    const second = await (async () => {
      await owner.execute(
        sql`update ip_block set expires_at = now() - interval '1 second' where workspace_id = ${space.id}`,
      );
      const made = await visitorToken(server, address);
      const sent = await send(server, made.token, address);
      const { conversationId } = (await sent.json()) as { conversationId: string };
      await owner.execute(
        sql`update ip_block set expires_at = now() + interval '1 hour' where workspace_id = ${space.id}`,
      );
      await asOperator(server, cookie, "POST", `/conversations/${conversationId}/block`, {});
      return `/conversations/${conversationId}/block`;
    })();
    await asOperator(server, cookie, "DELETE", second);
    // The first is still blocked, so clearing a browser at this address still does not help.
    expect((await newVisitor(server, address)).status).toBe(403);
    await asOperator(server, cookie, "DELETE", path);
    expect((await newVisitor(server, address)).status).toBe(201);
  });

  test("a visitor with no conversation left is listed, and can be unblocked", async () => {
    const { server, cookie, address, token, visitorId, conversationId } = await blockedWorld();
    const admin = await makeOperator("admin");
    const adminCookie = cookieOf(await signIn(server, admin.email, "198.51.100.2"));
    await asOperator(server, adminCookie, "DELETE", `/conversations/${conversationId}`);
    const listed = await asOperator(server, cookie, "GET", "/blocked-visitors");
    const { visitors } = (await listed.json()) as { visitors: { id: string }[] };
    expect(visitors.map((one) => one.id)).toEqual([visitorId]);
    expect(
      (await asOperator(server, cookie, "DELETE", `/blocked-visitors/${visitorId}`)).status,
    ).toBe(200);
    expect((await send(server, token, address)).status).toBe(201);
    expect((await newVisitor(server, address)).status).toBe(201);
    const after = await asOperator(server, cookie, "GET", "/blocked-visitors");
    expect(((await after.json()) as { visitors: unknown[] }).visitors).toEqual([]);
  });

  test("pruning one expired block leaves another visitor's live block at that address", async () => {
    const { server, cookie, address, visitorId } = await blockedWorld();
    // The second block came later, so the first runs out first.
    await owner.execute(
      sql`update ip_block set expires_at = now() - interval '1 second' where workspace_id = ${space.id}`,
    );
    const made = await visitorToken(server, address);
    const sent = await send(server, made.token, address);
    const { conversationId } = (await sent.json()) as { conversationId: string };
    await asOperator(server, cookie, "POST", `/conversations/${conversationId}/block`, {});
    await owner.execute(
      sql`update ip_block set expires_at = now() - interval '1 second'
          where workspace_id = ${space.id} and visitor_id = ${visitorId}`,
    );
    await pruneOnce(workerDb, new Date(0));
    const left = await owner.select().from(ipBlock).where(eq(ipBlock.workspaceId, space.id));
    expect(left.map((row) => row.visitorId)).toEqual([made.visitorId]);
    expect((await newVisitor(server, address)).status).toBe(403);
  });

  test("every blocked visitor can be reached, past the first page", async () => {
    const server = makeApp();
    const { email } = await makeOperator("agent");
    const cookie = cookieOf(await signIn(server, email, "198.51.100.1"));
    const ids = Array.from({ length: 55 }, () => randomUUID());
    await owner.insert(visitor).values(
      ids.map((id, index) => ({
        workspaceId: space.id,
        id,
        tokenHash: randomUUID(),
        blockedAt: new Date(Date.now() - index * 1000),
      })),
    );
    const page = async (offset: number) =>
      (await (
        await asOperator(server, cookie, "GET", `/blocked-visitors?offset=${offset}`)
      ).json()) as { hasMore: boolean; visitors: { id: string }[] };
    const first = await page(0);
    expect(first.visitors).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const second = await page(50);
    expect(second.visitors).toHaveLength(5);
    expect(second.hasMore).toBe(false);
    // The oldest is on the last page.
    expect(second.visitors.at(-1)?.id).toBe(ids.at(-1));
    expect(new Set([...first.visitors, ...second.visitors].map((one) => one.id)).size).toBe(55);
  });

  test("the operator's view says the visitor is blocked", async () => {
    const { server, cookie, conversationId } = await blockedWorld();
    const page = await asOperator(
      server,
      cookie,
      "GET",
      `/conversations/${conversationId}/messages?after=0`,
    );
    const { conversation: seen } = (await page.json()) as {
      conversation: { visitor: { blocked: boolean } };
    };
    expect(seen.visitor.blocked).toBe(true);
  });

  test("a blocked visitor cannot upload an image, and nothing is stored", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dinghy-safety-"));
    const images = createImages({
      store: localStore(directory),
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    });
    const server = makeApp({ images });
    const { email } = await makeOperator("agent");
    const cookie = cookieOf(await signIn(server, email, "198.51.100.1"));
    const address = "198.51.100.83";
    const { token } = await visitorToken(server, address);
    const sent = await send(server, token, address);
    const { conversationId } = (await sent.json()) as { conversationId: string };
    await asOperator(server, cookie, "POST", `/conversations/${conversationId}/block`, {});
    const body = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const refused = await server.request(
      `/v1/widget/${space.publicKey}/images?clientId=${randomUUID()}`,
      {
        method: "POST",
        headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "image/png" },
        body,
      },
      fromSocket(address),
    );
    expect(refused.status).toBe(403);
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("deleting a conversation", () => {
  /** A store whose deletes can fail, as when the object store is down. */
  function flakyStore(inner: ObjectStore) {
    const state = { down: false, deletes: 0 };
    const store: ObjectStore = {
      put: (key, bytes, type) => inner.put(key, bytes, type),
      get: (key) => inner.get(key),
      async delete(key) {
        state.deletes += 1;
        if (state.down) throw new Error("The object store is down");
        await inner.delete(key);
      },
    };
    return { store, state };
  }

  async function world() {
    const directory = await mkdtemp(join(tmpdir(), "dinghy-delete-"));
    const flaky = flakyStore(localStore(directory));
    const images = createImages({
      store: flaky.store,
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    });
    const server = makeApp({ images });
    const admin = await makeOperator("admin");
    const cookie = cookieOf(await signIn(server, admin.email, "198.51.100.1"));
    const address = "198.51.100.84";
    const { token } = await visitorToken(server, address);
    const sent = await send(server, token, address, "Private text");
    const { conversationId } = (await sent.json()) as { conversationId: string };
    const body = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const uploaded = await server.request(
      `/v1/widget/${space.publicKey}/images?clientId=${randomUUID()}`,
      {
        method: "POST",
        headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "image/png" },
        body,
      },
      fromSocket(address),
    );
    const { image } = (await uploaded.json()) as { image: { url: string } };
    const path = `/conversations/${conversationId}`;
    return { server, cookie, conversationId, path, directory, image, ...flaky, token, address };
  }

  const files = async (directory: string) =>
    (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) =>
      entry.isFile(),
    );
  const worker = (store: ObjectStore) =>
    startWorker({
      db: workerDb,
      logger,
      store,
      publicUrl: PUBLIC_URL,
      secret: AUTH_SECRET,
      pollMs: 20,
      retryMs: 5,
    });
  async function until(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  const queued = () =>
    owner.select().from(storageDeletion).where(eq(storageDeletion.workspaceId, space.id));

  test("the rows go at once, and the file goes through the worker", async () => {
    const { server, cookie, path, conversationId, directory, store } = await world();
    expect(await files(directory)).toHaveLength(1);
    expect((await asOperator(server, cookie, "DELETE", path)).status).toBe(200);

    expect(
      await owner.select().from(conversation).where(eq(conversation.id, conversationId)),
    ).toEqual([]);
    expect(
      await owner.select().from(message).where(eq(message.conversationId, conversationId)),
    ).toEqual([]);
    expect(
      await owner.select().from(attachment).where(eq(attachment.workspaceId, space.id)),
    ).toEqual([]);
    // No event keeps the text, so the delete removes it.
    const events = await owner.select().from(event).where(eq(event.workspaceId, space.id));
    expect(JSON.stringify(events.map((row) => row.payload))).not.toContain("Private text");
    expect(events.map((row) => row.kind)).toContain("conversation.deleted");

    // The file stays until the worker runs.
    expect(await files(directory)).toHaveLength(1);
    expect(await queued()).toHaveLength(1);
    const running = worker(store);
    await until(async () => (await queued()).length === 0, "the delete");
    await running.stop();
    expect(await files(directory)).toEqual([]);
  });

  test("with the object store down, the delete finishes when the store returns", async () => {
    const { server, cookie, path, directory, store, state } = await world();
    state.down = true;
    expect((await asOperator(server, cookie, "DELETE", path)).status).toBe(200);
    const running = worker(store);
    await until(async () => state.deletes >= 4, "several failed attempts");
    expect(await queued()).toHaveLength(1);
    expect(await files(directory)).toHaveLength(1);

    state.down = false;
    await until(async () => (await queued()).length === 0, "the delete");
    await running.stop();
    expect(await files(directory)).toEqual([]);
  });

  test("a stopped worker leaves the delete for the next one", async () => {
    const { server, cookie, path, directory, store, state } = await world();
    state.down = true;
    await asOperator(server, cookie, "DELETE", path);
    const first = worker(store);
    await until(async () => state.deletes >= 1, "a failed attempt");
    await first.stop();
    state.down = false;
    await owner.execute(
      sql`update storage_deletion set claimed_until = null, next_attempt_at = now()`,
    );
    const second = worker(store);
    await until(async () => (await queued()).length === 0, "the delete");
    await second.stop();
    expect(await files(directory)).toEqual([]);
  });

  test("a store that stalls becomes a retry, and does not hold the worker", async () => {
    const { server, cookie, path, store } = await world();
    let calls = 0;
    const stalled: ObjectStore = {
      ...store,
      delete: () => {
        calls += 1;
        return new Promise<void>(() => {});
      },
    };
    await asOperator(server, cookie, "DELETE", path);
    const running = startWorker({
      db: workerDb,
      logger,
      store: stalled,
      publicUrl: PUBLIC_URL,
      secret: AUTH_SECRET,
      pollMs: 20,
      retryMs: 1,
      deleteTimeoutMs: 30,
    });
    await until(async () => calls >= 3, "several attempts");
    await running.stop();
    expect(await queued()).toHaveLength(1);
  });

  test("two workers never hold the same file delete", async () => {
    // Its own workspace, so the other tests' queues stay as they expect.
    const other = await createWorkspace(db, "Claims", []);
    const run = randomUUID();
    await owner.insert(storageDeletion).values(
      Array.from({ length: 40 }, (_, index) => ({
        workspaceId: other.id,
        storageKey: `claims-${run}/${index}`,
      })),
    );
    const second = database.connect("worker").db;
    const claims = await Promise.all([
      claimDeletions(workerDb, 15, 60_000),
      claimDeletions(second, 15, 60_000),
      claimDeletions(workerDb, 15, 60_000),
      claimDeletions(second, 15, 60_000),
    ]);
    // Earlier tests can leave due rows, so only this test's rows are counted.
    const ids = claims
      .flat()
      .filter((row) => row.storageKey.startsWith(`claims-${run}/`))
      .map((row) => row.id);
    expect(ids.length).toBe(40);
    expect(new Set(ids).size).toBe(40);
  });

  test("a delete and a send at once both finish, with no deadlock", async () => {
    const { server, cookie, path, conversationId } = await world();
    let deleting: Promise<Response> | undefined;
    // This holds the workspace row while the delete starts, and then needs the conversation row
    // for a foreign key, as a send does. Taking that row first, the delete would deadlock with it.
    await owner.transaction(async (tx) => {
      // The lock a send's sequence update takes, which still lets a foreign key check through.
      await tx.execute(
        sql`select event_seq from workspace where id = ${space.id} for no key update`,
      );
      deleting = Promise.resolve(asOperator(server, cookie, "DELETE", path));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx.execute(sql`select 1 from conversation where id = ${conversationId} for key share`);
    });
    expect((await deleting)?.status).toBe(200);
  });

  test("the old image URL stops at once", async () => {
    const { server, cookie, path, image } = await world();
    const url = new URL(image.url);
    const local = `${url.pathname}${url.search}`;
    expect((await server.request(local)).status).toBe(200);
    await asOperator(server, cookie, "DELETE", path);
    expect((await server.request(local)).status).toBe(404);
  });

  test("an agent cannot delete, and a second delete finds nothing", async () => {
    const { server, cookie, path } = await world();
    const agent = await makeOperator("agent");
    const agentCookie = cookieOf(await signIn(server, agent.email, "198.51.100.2"));
    expect((await asOperator(server, agentCookie, "DELETE", path)).status).toBe(403);
    expect((await asOperator(server, cookie, "DELETE", path)).status).toBe(200);
    expect((await asOperator(server, cookie, "DELETE", path)).status).toBe(404);
  });

  test("the visitor's next message starts a new conversation", async () => {
    const { server, cookie, path, conversationId, token, address } = await world();
    await asOperator(server, cookie, "DELETE", path);
    const next = await send(server, token, address, "Are you there?");
    expect(next.status).toBe(201);
    const body = (await next.json()) as { conversationId: string };
    expect(body.conversationId).not.toBe(conversationId);
    const read = await server.request(`/v1/widget/${space.publicKey}/messages`, {
      headers: { origin: SITE, authorization: `Bearer ${token}` },
    });
    expect(await read.text()).not.toContain("Private text");
  });

  test("the app role can queue a deletion and cannot read the queue", async () => {
    await expect(db.select().from(storageDeletion)).rejects.toThrow();
  });
});
