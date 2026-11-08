import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import pg from "pg";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { untilWaiting } from "../test/locks.ts";
import { addOperator, signedInOperator } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { event, invite, message, subscription, workspace, workspaceMember } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createImages } from "./images.ts";
import { createLive, type Live } from "./live.ts";
import { localStore } from "./storage.ts";
import { setSuspended } from "./suspension.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const SITE = "https://site.example";
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let publisher: Redis;
let live: Live;
let app: App;
let space: NewWorkspace;
let cookie: string;
let operatorId: string;
let auth: ReturnType<typeof createAuth>;

/**
 * `chat suspend` or `chat unsuspend`, as the server's admin runs it on the migrate service, which
 * reads the Valkey login from the app's secrets.
 */
async function chat(...args: string[]): Promise<{ code: number | null; stdout: string }> {
  const appSecrets = await mkdtemp(join(tmpdir(), "dinghy-app-secrets-"));
  await writeFile(join(appSecrets, "valkey_url"), `${VALKEY_URL}\n`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env.PATH,
        ADMIN_DATABASE_URL: database.adminUrl(),
        APP_SECRETS_DIR: appSecrets,
      },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

/** Reads a stream, each call until `wanted` appears in what it has read so far. */
function streamReader(response: Response) {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  return async (wanted: string): Promise<string> => {
    while (reader !== undefined && !text.includes(wanted)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
    }
    return text;
  };
}

const widget = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
  app.request(`/v1/widget/${space.publicKey}${path}`, {
    method: init.method ?? "GET",
    headers: {
      origin: SITE,
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const operatorCall = (method: string, path: string, body?: unknown) =>
  app.request(path, {
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
  owner = database.connect("migrator", 1).db;
  publisher = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  live = createLive(publisher, VALKEY_URL, logger);
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger });
  app = createApp({
    auth,
    db,
    live,
    logger,
    valkey: publisher,
    checks: { postgres: ok, valkey: ok },
  });
  space = await createWorkspace(db, "Shop", [SITE]);
  ({ id: operatorId, cookie } = await signedInOperator({
    app,
    auth,
    owner,
    email: `boss-${randomUUID()}@example.com`,
    name: "Boss",
    workspaceId: space.id,
  }));
}, 30_000);

afterAll(async () => {
  live.stop();
  publisher.disconnect();
  await database.drop();
});

describe("suspending a workspace", () => {
  test("it cannot send, its widget stream closes, and its operators see why", async () => {
    const created = await widget("/visitors", { method: "POST" });
    const { token } = (await created.json()) as { token: string };
    const first = await widget("/messages", {
      method: "POST",
      token,
      body: { clientId: "one", body: "Hello" },
    });
    expect(first.status).toBe(201);
    const { conversationId } = (await first.json()) as { conversationId: string };
    const stream = await widget("/stream", { token });
    expect(stream.status).toBe(200);
    const readUntil = streamReader(stream);
    expect(await readUntil("event: ready")).toContain("event: ready");

    const suspended = await chat("suspend", space.id, "Spam", "reports");
    expect(suspended.code).toBe(0);
    expect(suspended.stdout).toContain("Suspended");
    // The open stream closes at once, through Valkey.
    expect(await readUntil("event: close")).toContain('"reason":"revoked"');

    const [row] = await owner
      .select({ at: workspace.suspendedAt, reason: workspace.suspendedReason })
      .from(workspace)
      .where(eq(workspace.id, space.id));
    expect(row?.at).toBeInstanceOf(Date);
    expect(row?.reason).toBe("Spam reports");
    // Open inboxes learn of it from the feed, even if the signal is lost.
    const changes = await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.kind, "workspace.changed")));
    expect(changes).toHaveLength(1);

    // The widget gets the answer for an unknown key, so it serves nothing.
    expect(
      (await widget("/messages", { method: "POST", token, body: { clientId: "two", body: "Hi" } }))
        .status,
    ).toBe(403);
    expect((await widget("/stream", { token })).status).toBe(403);
    expect((await widget("/visitors", { method: "POST" })).status).toBe(403);

    // Operators can read and cannot write.
    const inSpace = `/v1/operator/workspaces/${space.id}`;
    const reply = await operatorCall(
      "POST",
      `${inSpace}/conversations/${conversationId}/messages`,
      {
        clientId: "r1",
        body: "Reply",
      },
    );
    expect(reply.status).toBe(403);
    expect(await reply.json()).toMatchObject({ error: { code: "suspended" } });
    const image = await app.request(
      `${inSpace}/conversations/${conversationId}/images?clientId=r2`,
      { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "image/png" } },
    );
    expect(image.status).toBe(403);
    expect((await operatorCall("GET", `${inSpace}/conversations`)).status).toBe(200);
    const me = (await (await operatorCall("GET", "/v1/operator/me")).json()) as {
      workspaces: { suspended: boolean }[];
      contact: string | null;
    };
    expect(me.workspaces[0]?.suspended).toBe(true);
    // A self-hosted server has no cloud contact. Its operators ask the server's admin.
    expect(me.contact).toBeNull();

    const lifted = await chat("unsuspend", space.id);
    expect(lifted.code).toBe(0);
    expect(
      (
        await widget("/messages", {
          method: "POST",
          token,
          body: { clientId: "three", body: "Back" },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await operatorCall("POST", `${inSpace}/conversations/${conversationId}/messages`, {
          clientId: "r3",
          body: "Reply",
        })
      ).status,
    ).toBe(201);
    const [after] = await owner
      .select({ at: workspace.suspendedAt, reason: workspace.suspendedReason })
      .from(workspace)
      .where(eq(workspace.id, space.id));
    expect(after).toEqual({ at: null, reason: null });
  });

  test("a stream whose signal was lost ends on its next read", async () => {
    const other = await createWorkspace(db, "Quiet", [SITE]);
    const created = await app.request(`/v1/widget/${other.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: SITE },
    });
    const { token } = (await created.json()) as { token: string };
    const stream = await app.request(`/v1/widget/${other.publicKey}/stream`, {
      headers: { origin: SITE, authorization: `Bearer ${token}` },
    });
    const readUntil = streamReader(stream);
    expect(await readUntil("event: ready")).toContain("event: ready");
    // Straight in the database, with no signal at all.
    await owner
      .update(workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(workspace.id, other.id));
    const [{ id: visitorId } = { id: "" }] = (
      await owner.execute<{ id: string }>(
        `select id from visitor where workspace_id = '${other.id}'`,
      )
    ).rows;
    live.wake(other.id, visitorId);
    expect(await readUntil("event: close")).toContain('"reason":"unauthorized"');
  });

  test("an unknown workspace is an error", async () => {
    expect((await chat("suspend", randomUUID())).code).toBe(1);
    expect((await chat("suspend", "not-an-id")).code).toBe(2);
  });
});

test("chat workspaces lists the ID that the suspend and export commands take", async () => {
  const unpaid = await createWorkspace(db, "Unpaid", [SITE], { active: false });
  const listed = await chat("workspaces");
  expect(listed.code).toBe(0);
  const [header, ...rows] = listed.stdout.trimEnd().split("\n");
  expect(header).toBe("id\tpublic key\tstate\tname");
  const row = rows.find((line) => line.startsWith(`${space.id}\t`));
  expect(row?.split("\t").slice(1, 2)).toEqual([space.publicKey]);
  expect(row?.endsWith("\tShop")).toBe(true);
  // The same state the API and the widget act on, not only whether it is suspended.
  const waiting = rows.find((line) => line.startsWith(`${unpaid.id}\t`));
  expect(waiting?.split("\t")[2]).toBe("waiting_payment");
});

describe("a suspension that lands while a message is on its way", () => {
  let directory: string;
  let withImages: App;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "dinghy-suspension-"));
    withImages = createApp({
      auth,
      db,
      logger,
      checks: { postgres: ok, valkey: ok },
      images: createImages({
        store: localStore(directory),
        secret: "a-test-secret",
        publicUrl: PUBLIC_URL,
      }),
    });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** A workspace of the signed-in operator, with a visitor and an open conversation. */
  async function setUp() {
    const created = await createWorkspace(db, "Racing", [SITE]);
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: created.id, operatorId, role: "owner" });
    const visitor = await withImages.request(`/v1/widget/${created.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: SITE },
    });
    const { token } = (await visitor.json()) as { token: string };
    const first = await withImages.request(`/v1/widget/${created.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "first", body: "Hello" }),
    });
    const { conversationId } = (await first.json()) as { conversationId: string };
    return { created, token, conversationId };
  }

  async function admin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: database.adminUrl() });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  const messageCount = async (workspaceId: string) =>
    (await owner.select().from(message).where(eq(message.workspaceId, workspaceId))).length;

  async function storedFiles(): Promise<string[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  }

  /** An image body that sends its first half, then waits for `finish` before the rest. */
  async function gatedImage() {
    const bytes = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const half = Math.floor(bytes.length / 2);
    let finish = () => {};
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reading = () => {};
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (sent === 0) {
            sent = 1;
            reading();
            controller.enqueue(new Uint8Array(bytes.subarray(0, half)));
          } else if (sent === 1) {
            sent = 2;
            await released;
            controller.enqueue(new Uint8Array(bytes.subarray(half)));
          } else {
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    );
    return { body, started, finish };
  }

  test.each(["visitor", "operator"] as const)(
    "an upload from the %s that finishes after `chat suspend` stores no message and no file",
    async (sender) => {
      const { created, token, conversationId } = await setUp();
      const before = await messageCount(created.id);
      const image = await gatedImage();
      const url =
        sender === "visitor"
          ? `/v1/widget/${created.publicKey}/images?clientId=slow`
          : `/v1/operator/workspaces/${created.id}/conversations/${conversationId}/images?clientId=slow`;
      const headers =
        sender === "visitor"
          ? { origin: SITE, authorization: `Bearer ${token}` }
          : { origin: ORIGIN, cookie };
      const response = withImages.request(url, {
        method: "POST",
        headers,
        body: image.body,
        duplex: "half",
      } as RequestInit);
      // The route has let it in and is reading the body.
      await image.started;
      expect(await admin((client) => setSuspended(client, created.id, true, "Spam"))).toBe(true);
      image.finish();

      const answer = await response;
      expect(answer.status).toBe(403);
      expect(await answer.json()).toMatchObject({
        error: { code: sender === "visitor" ? "origin_not_allowed" : "suspended" },
      });
      expect(await messageCount(created.id)).toBe(before);
      expect(await storedFiles()).toEqual([]);
    },
  );

  test.each(["visitor", "operator"] as const)(
    "a text message from the %s that waits on the lock of `chat suspend` is refused",
    async (sender) => {
      const { created, token, conversationId } = await setUp();
      const before = await messageCount(created.id);
      await admin(async (client) => {
        await client.query("BEGIN");
        await client.query("UPDATE workspace SET suspended_at = now() WHERE id = $1", [created.id]);
        const response =
          sender === "visitor"
            ? withImages.request(`/v1/widget/${created.publicKey}/messages`, {
                method: "POST",
                headers: {
                  origin: SITE,
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ clientId: "racing", body: "Hi" }),
              })
            : withImages.request(
                `/v1/operator/workspaces/${created.id}/conversations/${conversationId}/messages`,
                {
                  method: "POST",
                  headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
                  body: JSON.stringify({ clientId: "racing", body: "Reply" }),
                },
              );
        // Past the check at the door, the send waits for the suspension's row lock.
        await untilWaiting(owner);
        await client.query("COMMIT");
        const answer = await response;
        expect(answer.status).toBe(403);
      });
      expect(await messageCount(created.id)).toBe(before);
    },
  );

  test("a reply that waits on the lock of the change to read-only is refused", async () => {
    const { created, conversationId } = await setUp();
    const before = await messageCount(created.id);
    await admin(async (client) => {
      await client.query("BEGIN");
      // As the billing lifecycle does: the subscription and the billing event, under the row lock.
      await client.query("UPDATE workspace SET event_seq = event_seq + 1 WHERE id = $1", [
        created.id,
      ]);
      await client.query(
        "INSERT INTO subscription (workspace_id, stripe_customer_id, read_only_at) VALUES ($1, 'cus_test', now())",
        [created.id],
      );
      const response = withImages.request(
        `/v1/operator/workspaces/${created.id}/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
          body: JSON.stringify({ clientId: "racing", body: "Reply" }),
        },
      );
      await untilWaiting(owner);
      await client.query("COMMIT");
      const answer = await response;
      expect(answer.status).toBe(402);
      expect(await answer.json()).toMatchObject({ error: { code: "read_only" } });
    });
    expect(await messageCount(created.id)).toBe(before);
  });

  test.each(["suspended", "read-only"] as const)(
    "an owner of a %s workspace can still remove a member and revoke an invite, and nothing else",
    async (state) => {
      const { created } = await setUp();
      const { id: agentId } = await addOperator({
        auth,
        owner,
        name: "Gone",
        workspaceId: created.id,
        role: "agent",
      });
      const [pending] = await owner
        .insert(invite)
        .values({
          workspaceId: created.id,
          role: "agent",
          tokenHash: randomUUID(),
          createdBy: operatorId,
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning({ id: invite.id });
      if (state === "suspended") {
        await admin((client) => setSuspended(client, created.id, true, "Spam"));
      } else {
        await owner.insert(subscription).values({
          workspaceId: created.id,
          stripeCustomerId: "cus_test",
          readOnlyAt: new Date(),
        });
      }
      const inSpace = `/v1/operator/workspaces/${created.id}`;
      const call = (method: string, path: string, body?: unknown) =>
        app.request(`${inSpace}${path}`, {
          method,
          headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      const refused = state === "suspended" ? 403 : 402;
      expect((await call("PATCH", `/members/${agentId}`, { role: "admin" })).status).toBe(refused);
      expect((await call("POST", "/invites", { role: "agent" })).status).toBe(refused);
      expect((await call("DELETE", `/invites/${pending?.id}`)).status).toBe(200);
      expect((await call("DELETE", `/members/${agentId}`)).status).toBe(200);
      const [left] = await owner
        .select({ removedAt: workspaceMember.removedAt })
        .from(workspaceMember)
        .where(
          and(eq(workspaceMember.workspaceId, created.id), eq(workspaceMember.operatorId, agentId)),
        );
      expect(left?.removedAt).toBeInstanceOf(Date);
    },
  );
});
