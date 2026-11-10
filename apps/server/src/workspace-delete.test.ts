import { randomInt } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { addOperator, signIn } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import {
  apiKey,
  conversation,
  message,
  pageView,
  subscription,
  visitor,
  webhook,
  webhookDelivery,
  workspace,
  workspaceLogo,
} from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createImages } from "./images.ts";
import { localStore, type ObjectStore } from "./storage.ts";
import { startWorker } from "./worker.ts";
import { createWorkspace, widgetWorkspace } from "./workspaces.ts";

// The owner's delete and the worker's purge on a self-hosted install, with no cloud settings.
// The cloud's cases, with Stripe, are in ee/server/lifecycle.test.ts.

const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let workerDb: Database;
let owner: Database;
let valkey: Redis;
let auth: Auth;
let app: App;
let store: ObjectStore;
let directory: string;

const IP = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;

const request = (
  method: string,
  path: string,
  { cookie, body }: { cookie?: string; body?: unknown } = {},
) =>
  app.request(path, {
    method,
    headers: {
      origin: ORIGIN,
      "x-forwarded-for": IP,
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const workspaceRow = async (workspaceId: string) =>
  (await owner.select().from(workspace).where(eq(workspace.id, workspaceId)))[0];

const subscriptionRow = async (workspaceId: string) =>
  (await owner.select().from(subscription).where(eq(subscription.workspaceId, workspaceId)))[0];

/** Tenant tables that still hold a row of this workspace. */
async function leftovers(workspaceId: string): Promise<string[]> {
  const tables = await owner.execute<{ table_name: string }>(
    sql`select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'workspace_id'`,
  );
  const left: string[] = [];
  for (const { table_name } of tables.rows) {
    const found = await owner.execute<{ count: string }>(
      sql`select count(*) as count from ${sql.identifier(table_name)} where workspace_id = ${workspaceId}`,
    );
    if (Number(found.rows[0]?.count) > 0) left.push(table_name);
  }
  return left;
}

/** Runs the real worker, with no cloud settings, until the workspace row is gone. */
async function purgeUntilGone(workspaceId: string) {
  const worker = startWorker({
    db: workerDb,
    logger,
    publicUrl: PUBLIC_URL,
    secret: AUTH_SECRET,
    store,
    pollMs: 20,
    lifecycleMs: 20,
  });
  try {
    const deadline = Date.now() + 10_000;
    while ((await workspaceRow(workspaceId)) !== undefined) {
      if (Date.now() > deadline) throw new Error("The workspace was not purged");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await worker.stop();
  }
  expect(await readdir(join(directory, "images", workspaceId)).catch(() => [])).toEqual([]);
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 20).db;
  workerDb = database.connect("worker", 10).db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  directory = await mkdtemp(join(tmpdir(), "dinghy-workspace-delete-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Dinghy</title>");
  store = localStore(join(directory, "images"));
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({
    auth,
    db,
    logger,
    valkey,
    images: createImages({ store, secret: AUTH_SECRET, publicUrl: PUBLIC_URL }),
    trustedProxyHops: 1,
    limitScale: 100,
    operatorDirectory: directory,
    checks: { postgres: ok, valkey: ok },
  });
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

describe("the owner's delete", () => {
  test("works on a self-hosted install, with no Stripe", async () => {
    const created = await createWorkspace(db, "Home", []);
    const { id: selfId, email } = await addOperator({
      auth,
      owner,
      name: "Self",
      workspaceId: created.id,
    });
    const cookie = await signIn(app, auth, email);
    // A visitor's page journey, so the check below covers it.
    const [seen] = await owner
      .insert(visitor)
      .values({ workspaceId: created.id, tokenHash: "home-visitor" })
      .returning({ id: visitor.id });
    await owner.insert(pageView).values({
      workspaceId: created.id,
      visitorId: seen?.id ?? "",
      path: "https://home.example/pricing",
    });
    // A key's reply and a webhook's delivery, whose foreign keys the purge must delete in order.
    const [key] = await owner
      .insert(apiKey)
      .values({ workspaceId: created.id, name: "Bot", tokenHash: "home-key", createdBy: selfId })
      .returning({ id: apiKey.id });
    const [talk] = await owner
      .insert(conversation)
      .values({ workspaceId: created.id, visitorId: seen?.id ?? "" })
      .returning({ id: conversation.id });
    const [said] = await owner
      .insert(message)
      .values({
        workspaceId: created.id,
        conversationId: talk?.id ?? "",
        seq: 1n,
        kind: "text",
        clientId: "bot-1",
        body: "Hello",
        authorApiKeyId: key?.id ?? "",
      })
      .returning({ id: message.id });
    const [hook] = await owner
      .insert(webhook)
      .values({
        workspaceId: created.id,
        url: "https://hooks.example.com",
        secret: "whsec_home",
        events: ["message.created"],
      })
      .returning({ id: webhook.id });
    await owner.insert(webhookDelivery).values({
      workspaceId: created.id,
      webhookId: hook?.id ?? "",
      eventId: crypto.randomUUID(),
      type: "message.created",
      conversationId: talk?.id ?? "",
      messageId: said?.id ?? "",
    });
    // A logo, which goes with the workspace row by its foreign key.
    await owner
      .insert(workspaceLogo)
      .values({ workspaceId: created.id, data: Buffer.from("logo"), contentType: "image/webp" });
    const response = await request("DELETE", `/v1/operator/workspaces/${created.id}`, {
      cookie,
      body: { name: "Home" },
    });
    expect(response.status).toBe(200);
    // No billing to clear, so the real worker's next pass purges it at once.
    await purgeUntilGone(created.id);
    expect(await workspaceRow(created.id)).toBeUndefined();
    expect(await leftovers(created.id)).toEqual([]);
  });
});

describe("a self-hosted install", () => {
  // With no cloud settings, the worker runs no subscription lifecycle at all, so no clock matters.
  test("never goes read-only, however long it runs", async () => {
    const created = await createWorkspace(db, "Forever", []);
    const worker = startWorker({
      db: workerDb,
      logger,
      publicUrl: PUBLIC_URL,
      secret: AUTH_SECRET,
      store,
      pollMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await worker.stop();
    expect(await widgetWorkspace(db, created.publicKey)).not.toBeNull();
    expect(await workspaceRow(created.id)).toMatchObject({ active: true, deletedAt: null });
    expect(await subscriptionRow(created.id)).toBeUndefined();
  });
});
