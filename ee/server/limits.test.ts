// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { createHash, randomUUID } from "node:crypto";
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
  invite as inviteTable,
  message,
  operator,
  storageDeletion,
  visitor,
  workspaceMember,
} from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { StorageFullError } from "../../apps/server/src/limits.ts";
import { appendMessage, listConversations } from "../../apps/server/src/messages.ts";
import { localStore } from "../../apps/server/src/storage.ts";
import { createUploads, processImage } from "../../apps/server/src/uploads.ts";
import { startWorker } from "../../apps/server/src/worker.ts";
import { createWorkspace, type NewWorkspace } from "../../apps/server/src/workspaces.ts";
import { createTestDatabase, type TestDatabase } from "../../apps/server/test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../../apps/server/test/env.ts";
import { signedInOperator } from "../../apps/server/test/operators.ts";
import { type CloudSettings, cloudWorkerStep } from "./index.ts";
import { createLimits, MAX_OPERATORS } from "./limits.ts";
import { removeOldUploads, uploadCutoff } from "./retention.ts";

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
/** The cloud, with room for two of the test's uploads and one operator stream. */
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
    uploads: createUploads({
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
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const processed = await processImage(await testImage());
  if (typeof processed === "string") throw new Error(processed);
  imageSize = processed.data.byteLength;
  cloud = app({
    signup: "early",
    limits: {
      maxStoredBytes: Math.floor(imageSize * 2.5),
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
  role: "owner" | "admin" | "member" = "owner",
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

const newEmail = () => `invitee-${randomUUID()}@example.com`;

async function invite(server: App, space: NewWorkspace, by: Person, email = newEmail()) {
  return call(server, "POST", inSpace(space, "/invites"), by, { email, role: "member" });
}

async function token(
  server: App,
  space: NewWorkspace,
  by: Person,
  email = newEmail(),
): Promise<string> {
  const response = await invite(server, space, by, email);
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
  return server.request(`/v1/widget/${space.publicKey}/uploads?clientId=${randomUUID()}`, {
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

/** A visitor's PDF of `size` bytes, which is stored as it came. */
function uploadPdf(server: App, space: NewWorkspace, visitorBearer: string, size: number) {
  const bytes = Buffer.alloc(size, " ");
  bytes.write("%PDF-1.7\n");
  return server.request(
    `/v1/widget/${space.publicKey}/uploads?clientId=${randomUUID()}&filename=notes.pdf`,
    {
      method: "POST",
      headers: { origin: SITE, authorization: `Bearer ${visitorBearer}` },
      body: bytes,
    },
  );
}

describe("operators: 5 per workspace on the cloud", () => {
  test("two simultaneous acceptances at the limit admit one", async () => {
    const space = await createWorkspace(db, "Full", [SITE]);
    const boss = await person(cloud, space);
    await person(cloud, space, "member");
    await person(cloud, space, "member");
    const [ann, bob] = await Promise.all([person(cloud, null), person(cloud, null)]);
    // Three members and two open invites fill the five places, so both links were handed out.
    const first = await token(cloud, space, boss, ann.email);
    const second = await token(cloud, space, boss, bob.email);
    const refused = await invite(cloud, space, boss);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "operator_limit",
        message: "This workspace has as many operators as its plan allows.",
      },
    });
    // A fourth member joins another way, so only one place is left for the two links.
    await person(cloud, space, "member");
    const answers = await Promise.all([
      call(cloud, "POST", "/v1/operator/invites/accept", ann, { token: first }),
      call(cloud, "POST", "/v1/operator/invites/accept", bob, { token: second }),
    ]);
    expect(answers.map((one) => one.status).sort()).toEqual([200, 409]);
    const loser = answers.find((one) => one.status === 409);
    expect(await loser?.json()).toMatchObject({ error: { code: "operator_limit" } });
    expect(await members(space)).toBe(MAX_OPERATORS);

    // A new account through an invite made before the plan filled is refused too, and its
    // rollback leaves no account.
    const email = newEmail();
    const unused = `${space.id}.${randomUUID()}`;
    await owner.insert(inviteTable).values({
      workspaceId: space.id,
      tokenHash: createHash("sha256").update(unused).digest("hex"),
      role: "member",
      email,
      mailed: false,
      createdBy: boss.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const joined = await call(cloud, "POST", "/v1/invites/join", null, {
      token: unused,
      name: "New",
    });
    expect(joined.status).toBe(409);
    expect(await joined.json()).toMatchObject({ error: { code: "operator_limit" } });
    expect(joined.headers.getSetCookie()).toEqual([]);
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
      storageBytes: { used: 0, limit: Math.floor(imageSize * 2.5) },
    });
  });
});

describe("uploads: a byte limit per workspace on the cloud", () => {
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

  test("concurrent uploads near the limit cannot pass it", async () => {
    const space = await createWorkspace(db, "Race", [SITE]);
    const [row] = await withWorkspace(db, space.id, (tx) =>
      tx.insert(visitor).values({ workspaceId: space.id, externalId: "v" }).returning(),
    );
    const visitorId = row?.id ?? "";
    const limits = createLimits(valkey, logger, { maxStoredBytes: 350 });
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
              attachment: {
                kind: "image",
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
      usage: { storageBytes: { used: number } };
    };
    expect(usage.usage.storageBytes.used).toBe(0);
    // With room again, an upload works.
    expect((await upload(cloud, space, bearer, "192.0.2.4")).status).toBe(201);
    expect(await storedBytes(space)).toBe(imageSize);
  });

  test("files count toward the same limit, and a full workspace still takes text", async () => {
    const space = await createWorkspace(db, "Files", [SITE]);
    const bearer = await visitorToken(cloud, space);
    expect((await uploadPdf(cloud, space, bearer, imageSize * 2)).status).toBe(201);
    expect(await storedBytes(space)).toBe(imageSize * 2);
    const full = await uploadPdf(cloud, space, bearer, imageSize);
    expect(full.status).toBe(507);
    expect(await full.json()).toMatchObject({ error: { code: "storage_full" } });
    expect((await upload(cloud, space, bearer, "192.0.2.30")).status).toBe(507);
    expect(await files(space)).toHaveLength(1);
    const text = await cloud.request(`/v1/widget/${space.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: randomUUID(), body: "Did my file arrive?" }),
    });
    expect(text.status).toBe(201);
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
      inSpace(space, `/conversations/${conversation?.id}/uploads?clientId=${randomUUID()}`),
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

describe("uploads older than 12 months", () => {
  test("the cloud's worker removes them, and the message says so", async () => {
    const space = await createWorkspace(db, "Old", [SITE]);
    const bearer = await visitorToken(cloud, space);
    const before = await upload(cloud, space, bearer, "192.0.2.20");
    expect(before.status).toBe(201);
    const old = (await before.json()) as { id: string };
    expect((await upload(cloud, space, bearer, "192.0.2.21")).status).toBe(201);
    expect(await files(space)).toHaveLength(2);
    // One image is a day past the cutoff.
    const past = new Date(uploadCutoff(new Date()).getTime() - 86_400_000);
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
    ).json()) as { messages: { id: string; attachment: { removed?: true } | null }[] };
    const removed = page.messages.find((one) => one.id === old.id);
    expect(removed).toMatchObject({ attachment: { type: "image", removed: true } });
    expect(page.messages.filter((one) => one.attachment?.removed)).toHaveLength(1);
    const [row] = await owner.select().from(message).where(eq(message.id, old.id));
    expect(row?.metadata).toEqual({ imageRemoved: true });
    // A second pass finds nothing more to do.
    expect(await removeOldUploads(workerDb)).toBe(0);
  });

  test("a file goes after 12 months too, and its message says so", async () => {
    const space = await createWorkspace(db, "Old file", [SITE]);
    const bearer = await visitorToken(cloud, space);
    const sent = (await (await uploadPdf(cloud, space, bearer, 100)).json()) as { id: string };
    const past = new Date(uploadCutoff(new Date()).getTime() - 86_400_000);
    await owner
      .update(attachment)
      .set({ createdAt: past })
      .where(and(eq(attachment.workspaceId, space.id), eq(attachment.messageId, sent.id)));
    expect(await removeOldUploads(workerDb)).toBe(1);
    const page = (await (
      await cloud.request(`/v1/widget/${space.publicKey}/messages`, {
        headers: { origin: SITE, authorization: `Bearer ${bearer}` },
      })
    ).json()) as { messages: { id: string; kind: string; attachment: unknown }[] };
    expect(page.messages.find((one) => one.id === sent.id)).toEqual(
      expect.objectContaining({ kind: "file", attachment: { type: "file", removed: true } }),
    );
    const [row] = await owner.select().from(message).where(eq(message.id, sent.id));
    expect(row?.metadata).toEqual({ fileRemoved: true });
    // With its name gone, the inbox tells it from an image by its kind.
    const listed = await withWorkspace(db, space.id, (tx) =>
      listConversations(tx, space.id, null, "open", { assignee: { kind: "all" } }, undefined, 10),
    );
    expect(listed.conversations[0]?.lastMessage).toMatchObject({ body: null, kind: "file" });
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
    const past = new Date(uploadCutoff(new Date()).getTime() - 86_400_000);
    await owner
      .update(attachment)
      .set({ createdAt: past })
      .where(inArray(attachment.workspaceId, ids));

    const second = database.connect("worker").db;
    const removed = await Promise.all([removeOldUploads(workerDb), removeOldUploads(second)]);
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
    for (let i = 0; i < 5; i++) await person(selfHosted, space, "member");
    expect(await members(space)).toBe(6);
    const joiner = await person(selfHosted, null);
    const link = await token(selfHosted, space, boss, joiner.email);
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

    // The worker keeps uploads for good, because the cloud's step does not exist here.
    expect(
      cloudWorkerStep(undefined, {
        db: workerDb,
        logger,
        publicUrl: PUBLIC_URL,
        secret: AUTH_SECRET,
        signals: { wake() {}, revoke() {}, tell() {}, tellVisitor() {} },
      }),
    ).toBeUndefined();
  });
});
