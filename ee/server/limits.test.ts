// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type App, createApp } from "../../apps/server/src/app.ts";
import { createAuth } from "../../apps/server/src/auth.ts";
import {
  attachment,
  message,
  operator,
  storageDeletion,
  visitor,
  workspaceMember,
} from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { createImages, processImage } from "../../apps/server/src/images.ts";
import { StorageFullError } from "../../apps/server/src/limits.ts";
import { appendMessage } from "../../apps/server/src/messages.ts";
import { localStore } from "../../apps/server/src/storage.ts";
import { startWorker } from "../../apps/server/src/worker.ts";
import { createWorkspace, type NewWorkspace } from "../../apps/server/src/workspaces.ts";
import { createTestDatabase, type TestDatabase } from "../../apps/server/test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../../apps/server/test/env.ts";
import { signedInOperator, TEST_PASSWORD } from "../../apps/server/test/operators.ts";
import { type CloudSettings, cloudWorkerStep } from "./index.ts";
import { createLimits, MAX_OPERATORS } from "./limits.ts";
import { imageCutoff, removeOldImages } from "./retention.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const SITE = "https://site.example";
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let workerDb: Database;
let valkey: Redis;
let directory: string;
let auth: ReturnType<typeof createAuth>;
/** The cloud, with room for two of the test's images and one operator stream. */
let cloud: App;
let selfHosted: App;
let imageSize: number;

// A 1x1 PNG. The server re-encodes it, and the test reads the stored size from the same code.
const testImage = async () =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

const app = (settings: CloudSettings | undefined) =>
  createApp({
    auth,
    cloud: settings,
    db,
    images: createImages({
      store: localStore(directory),
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    }),
    logger,
    valkey,
    // Each upload comes from its own address, so the per-address cap does not get in the way.
    trustedProxyHops: 1,
    limitScale: 1000,
    checks: { postgres: ok, valkey: ok },
  });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 20).db;
  owner = database.connect("migrator", 2).db;
  workerDb = database.connect("worker", 2).db;
  valkey = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
  directory = await mkdtemp(join(tmpdir(), "dinghy-limits-"));
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger });
  const processed = await processImage(await testImage());
  if (typeof processed === "string") throw new Error(processed);
  imageSize = processed.data.byteLength;
  cloud = app({
    signup: "early",
    limits: {
      maxImageBytes: Math.floor(imageSize * 2.5),
      maxStreams: { widget: 2, operator: 1 },
    },
  });
  selfHosted = app(undefined);
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

interface Person {
  id: string;
  email: string;
  cookie: string;
}

const person = (
  server: App,
  space: NewWorkspace | null,
  role: "owner" | "admin" | "agent" = "owner",
): Promise<Person> =>
  signedInOperator({
    app: server,
    auth,
    owner,
    ...(space === null ? {} : { workspaceId: space.id, role }),
  });

const call = (server: App, method: string, path: string, as: Person | null, body?: unknown) =>
  server.request(path, {
    method,
    headers: {
      ...(as === null ? {} : { cookie: as.cookie }),
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const inSpace = (space: NewWorkspace, path: string) => `/v1/operator/workspaces/${space.id}${path}`;

async function invite(server: App, space: NewWorkspace, by: Person) {
  return call(server, "POST", inSpace(space, "/invites"), by, { role: "agent" });
}

async function token(server: App, space: NewWorkspace, by: Person): Promise<string> {
  const response = await invite(server, space, by);
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

const members = async (space: NewWorkspace) => {
  const [row] = await owner
    .select({ n: count() })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, space.id), isNull(workspaceMember.removedAt)));
  return row?.n ?? 0;
};

const storedBytes = async (space: NewWorkspace) => {
  const result = await owner.execute<{ bytes: string | null }>(
    sql`select sum(byte_size) as bytes from attachment where workspace_id = ${space.id}`,
  );
  return Number(result.rows[0]?.bytes ?? 0);
};

const files = async (space: NewWorkspace) =>
  (await readdir(join(directory, space.id)).catch(() => [] as string[])).filter(
    (name) => !name.endsWith(".tmp"),
  );

/** A signed-out visitor's token on this workspace's widget. */
async function visitorToken(server: App, space: NewWorkspace): Promise<string> {
  const response = await server.request(`/v1/widget/${space.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE, "x-forwarded-for": "198.51.100.1" },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function upload(server: App, space: NewWorkspace, visitorBearer: string, address: string) {
  return server.request(`/v1/widget/${space.publicKey}/images?clientId=${randomUUID()}`, {
    method: "POST",
    headers: {
      origin: SITE,
      authorization: `Bearer ${visitorBearer}`,
      "content-type": "image/png",
      "x-forwarded-for": address,
    },
    body: await testImage(),
  });
}

describe("operators: 5 per workspace on the cloud", () => {
  test("two simultaneous acceptances at the limit admit one", async () => {
    const space = await createWorkspace(db, "Full", [SITE]);
    const boss = await person(cloud, space);
    await person(cloud, space, "agent");
    await person(cloud, space, "agent");
    // Three members and two open invites fill the five places, so both links were handed out.
    const first = await token(cloud, space, boss);
    const second = await token(cloud, space, boss);
    const refused = await invite(cloud, space, boss);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "operator_limit",
        message: "This workspace has as many operators as its plan allows.",
      },
    });
    // A fourth member joins another way, so only one place is left for the two links.
    await person(cloud, space, "agent");
    const [ann, bob] = await Promise.all([person(cloud, null), person(cloud, null)]);
    const answers = await Promise.all([
      call(cloud, "POST", "/v1/operator/invites/accept", ann, { token: first }),
      call(cloud, "POST", "/v1/operator/invites/accept", bob, { token: second }),
    ]);
    expect(answers.map((one) => one.status).sort()).toEqual([200, 409]);
    const loser = answers.find((one) => one.status === 409);
    expect(await loser?.json()).toMatchObject({ error: { code: "operator_limit" } });
    expect(await members(space)).toBe(MAX_OPERATORS);

    // A new account through the other link is refused too, and its rollback leaves no account.
    const unused = answers[0]?.status === 409 ? first : second;
    const email = `new-${randomUUID()}@example.com`;
    const joined = await call(cloud, "POST", "/v1/invites/join", null, {
      token: unused,
      name: "New",
      email,
      password: TEST_PASSWORD,
    });
    expect(joined.status).toBe(409);
    expect(await joined.json()).toMatchObject({ error: { code: "operator_limit" } });
    expect(await owner.select().from(operator).where(eq(operator.email, email))).toEqual([]);
    expect(await members(space)).toBe(MAX_OPERATORS);
  });

  test("Settings shows the plan's use", async () => {
    const space = await createWorkspace(db, "Usage", [SITE]);
    const boss = await person(cloud, space);
    const body = (await (await call(cloud, "GET", inSpace(space, "/settings"), boss)).json()) as {
      usage: unknown;
    };
    expect(body.usage).toEqual({
      operators: { used: 1, limit: 5 },
      imageBytes: { used: 0, limit: Math.floor(imageSize * 2.5) },
    });
  });
});

describe("images: a byte limit per workspace on the cloud", () => {
  test("the sum runs under the workspace lock, so it reads only an index", async () => {
    await owner.transaction(async (tx) => {
      // The test table is tiny, so make reading the table look as costly as it would be.
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const plan = await tx.execute<{ "QUERY PLAN": string }>(
        sql`explain select sum(${attachment.byteSize}) from ${attachment}
            where ${attachment.workspaceId} = ${randomUUID()}`,
      );
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(
        /Index Only Scan using attachment_bytes_idx/,
      );
    });
  });

  test("concurrent images near the limit cannot pass it", async () => {
    const space = await createWorkspace(db, "Race", [SITE]);
    const [row] = await withWorkspace(db, space.id, (tx) =>
      tx.insert(visitor).values({ workspaceId: space.id, externalId: "v" }).returning(),
    );
    const visitorId = row?.id ?? "";
    const limits = createLimits(valkey, logger, { maxImageBytes: 350 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => {
        const attachmentId = randomUUID();
        return withWorkspace(db, space.id, (tx) =>
          appendMessage(
            tx,
            space.id,
            { kind: "visitor", visitorId },
            {
              clientId: randomUUID(),
              image: {
                attachmentId,
                storageKey: `${space.id}/${attachmentId}`,
                byteSize: 100,
                contentType: "image/png",
                width: 1,
                height: 1,
              },
            },
            limits,
          ),
        );
      }),
    );
    expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(3);
    for (const one of results) {
      if (one.status === "rejected") expect(one.reason).toBeInstanceOf(StorageFullError);
    }
    expect(await storedBytes(space)).toBe(300);
  });

  test("a full workspace refuses an upload and keeps no file, and a repeated delete counts once", async () => {
    const space = await createWorkspace(db, "Uploads", [SITE]);
    const boss = await person(cloud, space);
    const bearer = await visitorToken(cloud, space);
    // Three uploads at once, from separate addresses: two fit and the third is refused.
    const answers = await Promise.all(
      ["192.0.2.1", "192.0.2.2", "192.0.2.3"].map((address) =>
        upload(cloud, space, bearer, address),
      ),
    );
    expect(answers.map((one) => one.status).sort()).toEqual([201, 201, 507]);
    const full = answers.find((one) => one.status === 507);
    expect(await full?.json()).toMatchObject({ error: { code: "storage_full" } });
    expect(await storedBytes(space)).toBe(imageSize * 2);
    // The refused upload's file went with it.
    expect(await files(space)).toHaveLength(2);

    const [conversation] = await withWorkspace(db, space.id, (tx) =>
      tx.execute<{ id: string }>(sql`select id from conversation where workspace_id = ${space.id}`),
    ).then((result) => result.rows);
    const path = inSpace(space, `/conversations/${conversation?.id}`);
    expect((await call(cloud, "DELETE", path, boss)).status).toBe(200);
    expect((await call(cloud, "DELETE", path, boss)).status).toBe(404);
    expect(await storedBytes(space)).toBe(0);
    const usage = (await (await call(cloud, "GET", inSpace(space, "/settings"), boss)).json()) as {
      usage: { imageBytes: { used: number } };
    };
    expect(usage.usage.imageBytes.used).toBe(0);
    // With room again, an upload works.
    expect((await upload(cloud, space, bearer, "192.0.2.4")).status).toBe(201);
    expect(await storedBytes(space)).toBe(imageSize);
  });

  test("an operator's image is refused the same way", async () => {
    const space = await createWorkspace(db, "Replies", [SITE]);
    const boss = await person(cloud, space);
    const bearer = await visitorToken(cloud, space);
    expect((await upload(cloud, space, bearer, "192.0.2.10")).status).toBe(201);
    expect((await upload(cloud, space, bearer, "192.0.2.11")).status).toBe(201);
    const [conversation] = await withWorkspace(db, space.id, (tx) =>
      tx.execute<{ id: string }>(sql`select id from conversation where workspace_id = ${space.id}`),
    ).then((result) => result.rows);
    const response = await cloud.request(
      inSpace(space, `/conversations/${conversation?.id}/images?clientId=${randomUUID()}`),
      {
        method: "POST",
        headers: { cookie: boss.cookie, origin: ORIGIN, "content-type": "image/png" },
        body: await testImage(),
      },
    );
    expect(response.status).toBe(507);
    expect(await files(space)).toHaveLength(2);
  });
});

describe("open streams: counted in Valkey per workspace", () => {
  test("a workspace gets as many as its cap, and a closed or lapsed one frees its place", async () => {
    const limits = createLimits(valkey, logger, { maxStreams: { widget: 2, operator: 1 } });
    const workspaceId = randomUUID();
    const one = await limits.openStream(workspaceId, "widget", 60_000);
    const two = await limits.openStream(workspaceId, "widget", 60_000);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(await limits.openStream(workspaceId, "widget", 60_000)).toBeNull();
    // The kinds and workspaces count apart.
    expect(await limits.openStream(workspaceId, "operator", 60_000)).not.toBeNull();
    expect(await limits.openStream(randomUUID(), "widget", 60_000)).not.toBeNull();
    one?.release();
    await expect.poll(() => limits.openStream(workspaceId, "widget", 50)).not.toBeNull();
    // That one lapses on its own, as when an instance dies with a stream open.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await limits.openStream(workspaceId, "widget", 60_000)).not.toBeNull();
  });

  test("an operator stream past the cap gets a 429 until the open one closes", async () => {
    const space = await createWorkspace(db, "Streams", [SITE]);
    const boss = await person(cloud, space);
    const open = () => call(cloud, "GET", inSpace(space, "/stream"), boss);
    const first = await open();
    expect(first.status).toBe(200);
    const second = await open();
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("30");
    expect(await second.json()).toMatchObject({ error: { code: "too_many_streams" } });
    await first.body?.cancel();
    await expect
      .poll(async () => {
        const again = await open();
        await again.body?.cancel();
        return again.status;
      })
      .toBe(200);
  });
});

describe("images older than 12 months", () => {
  test("the cloud's worker removes them, and the message says so", async () => {
    const space = await createWorkspace(db, "Old", [SITE]);
    const bearer = await visitorToken(cloud, space);
    const before = await upload(cloud, space, bearer, "192.0.2.20");
    expect(before.status).toBe(201);
    const old = (await before.json()) as { id: string };
    expect((await upload(cloud, space, bearer, "192.0.2.21")).status).toBe(201);
    expect(await files(space)).toHaveLength(2);
    // One image is a day past the cutoff.
    const past = new Date(imageCutoff(new Date()).getTime() - 86_400_000);
    await owner
      .update(attachment)
      .set({ createdAt: past })
      .where(and(eq(attachment.workspaceId, space.id), eq(attachment.messageId, old.id)));

    const worker = startWorker({
      db: workerDb,
      logger,
      cloud: { signup: "early" },
      store: localStore(directory),
      publicUrl: PUBLIC_URL,
      secret: AUTH_SECRET,
      lifecycleMs: 10,
      pollMs: 20,
    });
    try {
      await expect.poll(() => files(space), { timeout: 10_000 }).toHaveLength(1);
    } finally {
      await worker.stop();
    }
    expect(await storedBytes(space)).toBe(imageSize);
    const pending = await owner
      .select()
      .from(storageDeletion)
      .where(eq(storageDeletion.workspaceId, space.id));
    expect(pending).toEqual([]);

    const page = (await (
      await cloud.request(`/v1/widget/${space.publicKey}/messages`, {
        headers: { origin: SITE, authorization: `Bearer ${bearer}` },
      })
    ).json()) as { messages: { id: string; image: unknown; imageRemoved: boolean }[] };
    const removed = page.messages.find((one) => one.id === old.id);
    expect(removed).toMatchObject({ image: null, imageRemoved: true });
    expect(page.messages.filter((one) => one.imageRemoved)).toHaveLength(1);
    const [row] = await owner.select().from(message).where(eq(message.id, old.id));
    expect(row?.metadata).toEqual({ imageRemoved: true });
    // A second pass finds nothing more to do.
    expect(await removeOldImages(workerDb)).toBe(0);
  });

  test("two workers at once queue each old image's file once", async () => {
    const spaces = [
      await createWorkspace(db, "Old A", [SITE]),
      await createWorkspace(db, "Old B", [SITE]),
    ];
    for (const [index, space] of spaces.entries()) {
      const bearer = await visitorToken(cloud, space);
      for (const turn of [0, 1]) {
        expect(
          (await upload(cloud, space, bearer, `192.0.2.${30 + index * 2 + turn}`)).status,
        ).toBe(201);
      }
    }
    const ids = spaces.map((space) => space.id);
    const past = new Date(imageCutoff(new Date()).getTime() - 86_400_000);
    await owner
      .update(attachment)
      .set({ createdAt: past })
      .where(inArray(attachment.workspaceId, ids));

    const second = database.connect("worker").db;
    const removed = await Promise.all([removeOldImages(workerDb), removeOldImages(second)]);
    expect(removed[0] + removed[1]).toBe(4);
    const queued = await owner
      .select()
      .from(storageDeletion)
      .where(inArray(storageDeletion.workspaceId, ids));
    expect(queued).toHaveLength(4);
    expect(new Set(queued.map((row) => row.storageKey)).size).toBe(4);
  });
});

describe("a self-hosted install", () => {
  test("has no limits", async () => {
    const space = await createWorkspace(db, "Self", [SITE]);
    const boss = await person(selfHosted, space);
    for (let i = 0; i < 5; i++) await person(selfHosted, space, "agent");
    expect(await members(space)).toBe(6);
    const link = await token(selfHosted, space, boss);
    const joiner = await person(selfHosted, null);
    const accepted = await call(selfHosted, "POST", "/v1/operator/invites/accept", joiner, {
      token: link,
    });
    expect(accepted.status).toBe(200);
    expect(await members(space)).toBe(7);

    const settings = (await (
      await call(selfHosted, "GET", inSpace(space, "/settings"), boss)
    ).json()) as { usage: unknown };
    expect(settings.usage).toBeNull();

    const bearer = await visitorToken(selfHosted, space);
    for (const address of ["192.0.2.30", "192.0.2.31", "192.0.2.32"]) {
      expect((await upload(selfHosted, space, bearer, address)).status).toBe(201);
    }

    const streams = await Promise.all(
      [1, 2, 3].map(() => call(selfHosted, "GET", inSpace(space, "/stream"), boss)),
    );
    expect(streams.map((one) => one.status)).toEqual([200, 200, 200]);
    await Promise.all(streams.map((one) => one.body?.cancel()));

    // The worker keeps images for good, because the cloud's step does not exist here.
    expect(
      cloudWorkerStep(undefined, {
        db: workerDb,
        logger,
        publicUrl: PUBLIC_URL,
        signals: { wake() {}, revoke() {} },
      }),
    ).toBeUndefined();
  });
});
