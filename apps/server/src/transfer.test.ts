import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { addOperator, openSignInLink, signIn as signInTo } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { readTar, tarEnd, tarEntry } from "./archive.ts";
import { createAuth } from "./auth.ts";
import { newGeneration } from "./db/migrate.ts";
import {
  attachment,
  conversation,
  emailStop,
  event,
  message,
  operator,
  pageView,
  visitor,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createImages } from "./images.ts";
import { CURSOR_PATTERN } from "./messages.ts";
import { localStore, type ObjectStore } from "./storage.ts";
import { exportArchive, ImportError, importArchive } from "./transfer.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const ORIGIN = new URL(PUBLIC_URL).origin;
const SITE = "https://app.example.com";
const logger = pino({ level: "silent" });
const ok = async () => {};

interface Install {
  database: TestDatabase;
  db: Database;
  owner: Database;
  directory: string;
  store: ObjectStore;
  app: App;
}

const installs: Install[] = [];
/** The installs that a beforeAll made for several tests. */
let keptInstalls = 0;

/** A whole server's data: its own database and its own image directory. */
async function freshInstall(): Promise<Install> {
  const database = await createTestDatabase();
  await database.migrate();
  const db = database.connect("app", 5).db;
  const owner = database.connect("migrator").db;
  const directory = await mkdtemp(join(tmpdir(), "dinghy-transfer-"));
  const store = localStore(directory);
  const app = createApp({
    alerts: { emailAvailable: false, secret: AUTH_SECRET },
    auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL }),
    checks: { postgres: ok, valkey: ok },
    db,
    images: createImages({ store, secret: AUTH_SECRET, publicUrl: PUBLIC_URL }),
    logger,
  });
  const install = { database, db, owner, directory, store, app };
  installs.push(install);
  return install;
}

const addPerson = (
  install: Install,
  workspaceId: string,
  role: "owner" | "admin" | "agent",
  email = `${role}-${randomUUID()}@example.com`,
) =>
  addOperator({
    auth: createAuth({ db: install.db, secret: AUTH_SECRET, baseURL: PUBLIC_URL }),
    owner: install.owner,
    email,
    workspaceId,
    role,
  });

const signIn = (install: Install, email: string) =>
  signInTo(
    install.app,
    createAuth({ db: install.db, secret: AUTH_SECRET, baseURL: PUBLIC_URL }),
    email,
  );

const png = () =>
  sharp({ create: { width: 4, height: 3, channels: 3, background: "#336699" } })
    .png()
    .toBuffer();

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

const files = async (directory: string) =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

interface Source {
  install: Install;
  space: NewWorkspace;
  other: NewWorkspace;
  ownerEmail: string;
  token: string;
  visitorId: string;
  conversationId: string;
  agentId: string;
  agentEmail: string;
}

/** A workspace with text, an image from each side, an assignment and a removed operator. */
async function makeSource(): Promise<Source> {
  const install = await freshInstall();
  const { app, db, owner } = install;
  const space = await createWorkspace(db, "Acme", [SITE]);
  const other = await createWorkspace(db, "Other company", [SITE]);
  const boss = await addPerson(install, space.id, "owner");
  const agent = await addPerson(install, space.id, "agent");
  const gone = await addPerson(install, space.id, "agent");
  const cookie = await signIn(install, boss.email);
  const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  const { visitorId, token } = (await created.json()) as { visitorId: string; token: string };
  const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
    method: "POST",
    headers: {
      origin: SITE,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      clientId: "from-visitor",
      body: "Secret from the visitor",
      page: `${SITE}/pricing?ref=ad`,
    }),
  });
  const { conversationId } = (await sent.json()) as { conversationId: string };
  const inSpace = `/v1/operator/workspaces/${space.id}`;
  await app.request(`/v1/widget/${space.publicKey}/images?clientId=visitor-image`, {
    method: "POST",
    headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "image/png" },
    body: await png(),
  });
  const write = (method: string, path: string, body: unknown) =>
    app.request(`${inSpace}${path}`, {
      method,
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  await write("POST", `/conversations/${conversationId}/messages`, {
    clientId: "from-operator",
    body: "Reply from the owner",
  });
  await app.request(`${inSpace}/conversations/${conversationId}/images?clientId=operator-image`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "image/png" },
    body: await png(),
  });
  await write("PUT", `/conversations/${conversationId}/assignee`, { operatorId: agent.id });
  await owner
    .update(workspaceMember)
    .set({ removedAt: new Date() })
    .where(eq(workspaceMember.operatorId, gone.id));
  await owner.insert(emailStop).values({ workspaceId: space.id, addressHash: "a".repeat(64) });
  await owner
    .update(workspace)
    .set({ widgetTitle: "Ask Acme", widgetGreeting: "Hello there", widgetAway: "Back soon" })
    .where(eq(workspace.id, space.id));
  await app.request(`/v1/widget/${space.publicKey}/page`, {
    method: "POST",
    headers: {
      origin: SITE,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ page: `${SITE}/docs?ref=ad`, title: "Docs" }),
  });

  // Another workspace on the same install, which must stay out of the export.
  const otherVisitor = await app.request(`/v1/widget/${other.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  const otherToken = ((await otherVisitor.json()) as { token: string }).token;
  await app.request(`/v1/widget/${other.publicKey}/messages`, {
    method: "POST",
    headers: {
      origin: SITE,
      authorization: `Bearer ${otherToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ clientId: "other", body: "Belongs to the other company" }),
  });
  return {
    install,
    space,
    other,
    ownerEmail: boss.email,
    token,
    visitorId,
    conversationId,
    agentId: agent.id,
    agentEmail: agent.email,
  };
}

let source: Source;
let archive: Buffer;

beforeAll(async () => {
  source = await makeSource();
  archive = await collect(exportArchive(source.install.db, source.install.store, source.space.id));
  keptInstalls = installs.length;
}, 30_000);

afterAll(async () => {
  for (const install of installs) await install.database.drop();
});

// Each test's installs close when it ends, because Postgres allows a limited number of connections.
afterEach(async () => {
  for (const install of installs.splice(keptInstalls)) await install.database.drop();
});

describe("an export", () => {
  test("holds only the requested workspace, and no signing secret", () => {
    const text = archive.toString("latin1");
    expect(text).toContain("Secret from the visitor");
    expect(text).not.toContain("Belongs to the other company");
    expect(text).not.toContain(source.other.id);
    expect(text).not.toContain(source.other.publicKey);
    expect(text).not.toContain(source.space.signingSecret);
  });

  test("is a real tar file, with a JSON file first and each image", async () => {
    const names: string[] = [];
    for await (const entry of readTar(once(archive))) names.push(entry.name);
    expect(names[0]).toBe("export.json");
    expect(names.filter((name) => name.startsWith("images/"))).toHaveLength(2);
    const listed = spawnSync("tar", ["-tf", "-"], { input: archive });
    expect(listed.status).toBe(0);
    expect(listed.stdout.toString()).toContain("export.json");
  });

  test("through the route needs an owner", async () => {
    const { app } = source.install;
    const path = `/v1/operator/workspaces/${source.space.id}/export`;
    const agent = await signIn(source.install, source.agentEmail);
    expect((await app.request(path, { headers: { cookie: agent } })).status).toBe(403);
    expect((await app.request(path)).status).toBe(401);
    const boss = await signIn(source.install, source.ownerEmail);
    const response = await app.request(path, { headers: { cookie: boss } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const entries: string[] = [];
    for await (const entry of readTar(once(new Uint8Array(await response.arrayBuffer())))) {
      entries.push(entry.name);
    }
    expect(entries).toHaveLength(3);
  });

  test("of more messages than one read page holds each once, in order, and imports", async () => {
    const { install } = source;
    const space = await createWorkspace(install.db, "Long", [SITE]);
    await addPerson(install, space.id, "owner");
    const visitorId = randomUUID();
    const conversationId = randomUUID();
    await install.owner.execute(sql`
      insert into visitor (workspace_id, id, token_hash) values (${space.id}, ${visitorId}, ${randomUUID()})`);
    await install.owner.execute(sql`
      insert into conversation (workspace_id, id, visitor_id) values (${space.id}, ${conversationId}, ${visitorId})`);
    await install.owner.execute(sql`
      insert into message (workspace_id, conversation_id, seq, kind, author_visitor_id, client_id, body)
      select ${space.id}, ${conversationId}, n, 'text', ${visitorId}, 'c' || n, 'Message ' || n
      from generate_series(1, 10001) as n`);
    await install.owner.execute(sql`update workspace set event_seq = 10001 where id = ${space.id}`);
    const bytes = await collect(exportArchive(install.db, install.store, space.id));
    let json: { messages: { seq: string; body: string }[] } | undefined;
    for await (const entry of readTar(once(bytes))) {
      if (entry.name === "export.json") json = JSON.parse(Buffer.from(entry.bytes).toString());
    }
    expect(json?.messages.map((row) => Number(row.seq))).toEqual(
      Array.from({ length: 10001 }, (_, index) => index + 1),
    );
    expect(json?.messages.at(-1)?.body).toBe("Message 10001");
    const target = await freshInstall();
    const imported = await importArchive(target.db, target.store, once(bytes));
    expect(imported.messages).toBe(10001);
  }, 30_000);
});

describe("a round trip onto a fresh install", () => {
  let target: Install;

  beforeAll(async () => {
    target = await freshInstall();
    const result = await importArchive(target.db, target.store, once(archive));
    expect(result.conversations).toBe(1);
    expect(result.messages).toBe(4);
    expect(result.images).toBe(2);
    expect(result.newOperators).toHaveLength(3);
    keptInstalls = installs.length;
  }, 30_000);

  test("keeps the conversation, its status, its authors and its assignee", async () => {
    const [row] = await target.owner
      .select()
      .from(conversation)
      .where(eq(conversation.id, source.conversationId));
    expect(row?.status).toBe("open");
    const [assignee] = await target.owner
      .select()
      .from(operator)
      .where(eq(operator.email, source.agentEmail));
    expect(row?.assigneeOperatorId).toBe(assignee?.id);
    expect(row?.startedPage).toBe(`${SITE}/pricing`);
    const messages = await target.owner
      .select()
      .from(message)
      .where(eq(message.conversationId, source.conversationId));
    const original = await source.install.owner
      .select()
      .from(message)
      .where(eq(message.conversationId, source.conversationId));
    expect(messages.map((one) => [one.seq, one.clientId, one.body, one.kind]).sort()).toEqual(
      original.map((one) => [one.seq, one.clientId, one.body, one.kind]).sort(),
    );
    expect(messages.filter((one) => one.authorVisitorId === source.visitorId)).toHaveLength(2);
    expect(messages.filter((one) => one.authorOperatorId !== null)).toHaveLength(2);
    expect(messages[0]?.createdAt.getTime()).toBe(
      original.find((one) => one.id === messages[0]?.id)?.createdAt.getTime(),
    );
  });

  test("keeps the members, with a removed one still removed", async () => {
    const rows = await target.owner
      .select()
      .from(workspaceMember)
      .where(eq(workspaceMember.workspaceId, source.space.id));
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.removedAt !== null)).toHaveLength(1);
    expect(rows.filter((row) => row.role === "owner")).toHaveLength(1);
  });

  test("gives a new feed generation, a new secret, and sends no alert for old messages", async () => {
    const [before] = await source.install.owner
      .select()
      .from(workspace)
      .where(eq(workspace.id, source.space.id));
    const [after] = await target.owner
      .select()
      .from(workspace)
      .where(eq(workspace.id, source.space.id));
    expect(after?.feedGeneration).not.toBe(before?.feedGeneration);
    expect(after?.eventSeq).toBe(before?.eventSeq);
    expect(after?.signingSecret).not.toBe(before?.signingSecret);
    expect(after?.signingSecret.length).toBeGreaterThanOrEqual(32);
    // A value of its own, and not a fixed one that every import would share.
    const another = await freshInstall();
    await importArchive(another.db, another.store, once(archive));
    const [second] = await another.owner
      .select()
      .from(workspace)
      .where(eq(workspace.id, source.space.id));
    expect(second?.signingSecret).not.toBe(after?.signingSecret);
    // One file imported onto two servers, so an old cursor from the first resyncs on the second.
    expect(second?.feedGeneration).not.toBe(after?.feedGeneration);
    expect(after?.publicKey).toBe(before?.publicKey);
    expect(await target.owner.select().from(event)).toEqual([]);
  });

  test("a visitor's browser keeps its chat, and an old cursor gets resync", async () => {
    const headers = { origin: SITE, authorization: `Bearer ${source.token}` };
    const { publicKey } = source.space;
    const read = await target.app.request(`/v1/widget/${publicKey}/messages`, { headers });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("Reply from the owner");
    const stream = await target.app.request(`/v1/widget/${publicKey}/stream?after=1.1`, {
      headers,
    });
    const reader = stream.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (reader !== undefined && !text.includes("event: resync")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader?.cancel();
    expect(text).toContain("event: resync");
  });

  test("a cursor from the imported workspace works on a reconnect", async () => {
    const headers = { origin: SITE, authorization: `Bearer ${source.token}` };
    const stream = (query: string) =>
      target.app.request(`/v1/widget/${source.space.publicKey}/stream${query}`, { headers });
    const reader = (await stream("")).body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (reader !== undefined && !text.includes("event: ready")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader?.cancel();
    const cursor = /"cursor":"([^"]+)"/.exec(text)?.[1] ?? "";
    expect(CURSOR_PATTERN.test(cursor)).toBe(true);
    const again = await stream(`?after=${cursor}`);
    expect(again.status).toBe(200);
    await again.body?.cancel();
  });

  test("the images serve from the new install, and are its own files", async () => {
    const rows = await target.owner
      .select()
      .from(attachment)
      .where(eq(attachment.workspaceId, source.space.id));
    expect(rows).toHaveLength(2);
    expect(await files(target.directory)).toHaveLength(2);
    const read = await target.app.request(`/v1/widget/${source.space.publicKey}/messages`, {
      headers: { origin: SITE, authorization: `Bearer ${source.token}` },
    });
    const { messages } = (await read.json()) as {
      messages: { image: { url: string; width: number } | null }[];
    };
    const images = messages.flatMap((one) => one.image ?? []);
    expect(images).toHaveLength(2);
    expect(images[0]?.width).toBe(4);
    const url = new URL(images[0]?.url ?? "");
    const served = await target.app.request(`${url.pathname}${url.search}`);
    expect(served.status).toBe(200);
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect(meta.width).toBe(4);
  });

  test("the stop list comes along", async () => {
    const rows = await target.owner
      .select()
      .from(emailStop)
      .where(eq(emailStop.workspaceId, source.space.id));
    expect(rows.map((row) => row.addressHash)).toEqual(["a".repeat(64)]);
  });

  test("the widget's words and the visitor's details come along", async () => {
    const [space] = await target.owner
      .select()
      .from(workspace)
      .where(eq(workspace.id, source.space.id));
    expect([space?.widgetTitle, space?.widgetGreeting, space?.widgetAway]).toEqual([
      "Ask Acme",
      "Hello there",
      "Back soon",
    ]);
    const [before] = await source.install.owner
      .select()
      .from(visitor)
      .where(eq(visitor.id, source.visitorId));
    const [after] = await target.owner
      .select()
      .from(visitor)
      .where(eq(visitor.id, source.visitorId));
    expect(before?.lastPage).toBe(`${SITE}/docs`);
    expect([after?.device, after?.lastPage]).toEqual([before?.device, before?.lastPage]);
    // Streams in other tests move both sides' times, so the file is what this checks.
    let exported: { visitors: { id: string; lastSeenAt?: string | null }[] } | undefined;
    for await (const entry of readTar(once(archive))) {
      if (entry.name === "export.json") exported = JSON.parse(Buffer.from(entry.bytes).toString());
    }
    const row = exported?.visitors.find((one) => one.id === source.visitorId);
    expect(row?.lastSeenAt).toMatch(/^\d{4}-/);
    expect(after?.lastSeenAt).toBeInstanceOf(Date);
  });

  test("the visitor's page journey comes along", async () => {
    const rows = await target.owner
      .select()
      .from(pageView)
      .where(eq(pageView.workspaceId, source.space.id));
    expect(rows.map((row) => [row.visitorId, row.path, row.title])).toEqual([
      [source.visitorId, `${SITE}/docs`, "Docs"],
    ]);
  });

  test("a repeated import is refused and changes nothing", async () => {
    const before = await files(target.directory);
    const messages = await target.owner.select().from(message);
    await expect(importArchive(target.db, target.store, once(archive))).rejects.toThrow(
      "already on this server",
    );
    expect(await files(target.directory)).toEqual(before);
    expect(await target.owner.select().from(message)).toHaveLength(messages.length);
  });
});

describe("an operator on the new install", () => {
  test("with an account there keeps one login and joins the workspace", async () => {
    const target = await freshInstall();
    const here = await createWorkspace(target.db, "Already here", [SITE]);
    const existing = await addPerson(target, here.id, "owner", source.agentEmail);
    const result = await importArchive(target.db, target.store, once(archive));
    expect(result.newOperators).not.toContain(source.agentEmail);
    const accounts = await target.owner
      .select()
      .from(operator)
      .where(eq(operator.email, source.agentEmail));
    expect(accounts.map((row) => row.id)).toEqual([existing.id]);
    const cookie = await signIn(target, source.agentEmail);
    const me = await target.app.request("/v1/operator/me", { headers: { cookie } });
    const { workspaces } = (await me.json()) as { workspaces: { workspaceId: string }[] };
    expect(workspaces.map((one) => one.workspaceId).sort()).toEqual(
      [here.id, source.space.id].sort(),
    );
    const [row] = await target.owner
      .select()
      .from(conversation)
      .where(eq(conversation.id, source.conversationId));
    expect(row?.assigneeOperatorId).toBe(existing.id);
  });

  test("a new one signs in with a link from chat sign-in-link", async () => {
    const target = await freshInstall();
    await importArchive(target.db, target.store, once(archive));
    const made = spawnSync(process.execPath, [CLI, "sign-in-link", source.ownerEmail], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: target.database.url("app"),
        VALKEY_URL,
        AUTH_SECRET,
        PUBLIC_URL,
      },
    });
    expect(made.status).toBe(0);
    const link = /https?:\/\/\S+/.exec(made.stdout)?.[0] ?? "";
    const cookie = await openSignInLink(target.app, link);
    const me = await target.app.request("/v1/operator/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({ email: source.ownerEmail });
  }, 30_000);
});

describe("a bad file changes nothing", () => {
  /** The archive's JSON with a change, and its images. */
  async function edited(change: (data: Record<string, unknown>) => void): Promise<Buffer> {
    const parts: Uint8Array[] = [];
    for await (const entry of readTar(once(archive))) {
      if (entry.name === "export.json") {
        const data = JSON.parse(Buffer.from(entry.bytes).toString());
        change(data);
        parts.push(...tarEntry(entry.name, Buffer.from(JSON.stringify(data))));
      } else {
        parts.push(...tarEntry(entry.name, entry.bytes));
      }
    }
    parts.push(tarEnd());
    return Buffer.concat(parts);
  }

  async function refuses(bytes: Uint8Array, text?: string) {
    const target = await freshInstall();
    const before = (await target.owner.select().from(operator)).length;
    const attempt = importArchive(target.db, target.store, once(bytes));
    await expect(attempt).rejects.toThrow(text);
    expect(await target.owner.select().from(workspace)).toEqual([]);
    expect(await target.owner.select().from(message)).toEqual([]);
    expect(await target.owner.select().from(operator)).toHaveLength(before);
    expect(await files(target.directory)).toEqual([]);
  }

  test("an export from 0.5.0, with no page journey, imports", async () => {
    const old = await edited((data) => {
      delete data.pageViews;
    });
    const target = await freshInstall();
    await importArchive(target.db, target.store, once(old));
    expect(await target.owner.select().from(pageView)).toEqual([]);
    expect(await target.owner.select().from(visitor)).not.toEqual([]);
  }, 30_000);

  test("a page view of a visitor the file does not hold", async () => {
    const bad = await edited((data) => {
      (data.pageViews as Record<string, unknown>[]).push({
        visitorId: randomUUID(),
        path: `${SITE}/x`,
        title: null,
        viewedAt: new Date().toISOString(),
      });
    });
    const target = await freshInstall();
    await expect(importArchive(target.db, target.store, once(bad))).rejects.toThrow(ImportError);
    expect(await target.owner.select().from(workspace)).toEqual([]);
  }, 30_000);

  test("an export from 0.5.0, whose visitors have claims, imports them as attributes", async () => {
    const old = await edited((data) => {
      for (const row of data.visitors as Record<string, unknown>[]) {
        row.claims = { plan: "pro" };
        delete row.attributes;
        delete row.name;
      }
    });
    const target = await freshInstall();
    await importArchive(target.db, target.store, once(old));
    const rows = await target.owner.select().from(visitor);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.attributes).toEqual({ plan: "pro" });
  }, 30_000);

  test("a file cut off anywhere", async () => {
    await refuses(archive.subarray(0, archive.length - 1024), "cut off");
    await refuses(archive.subarray(0, 700), "cut off");
  });

  test("a damaged header", async () => {
    const damaged = Buffer.from(archive);
    damaged[0] = 0x58;
    await refuses(damaged, "damaged");
  });

  test("JSON of the wrong shape", async () => {
    await refuses(await edited((data) => Object.assign(data, { version: 99 })), "format");
    await refuses(await edited((data) => Object.assign(data, { extra: true })), "format");
    await refuses(
      Buffer.concat([...tarEntry("export.json", Buffer.from("{nope")), tarEnd()]),
      "valid JSON",
    );
  });

  test("a row that points at nothing fails after the images are stored, and they are cleaned up", async () => {
    await refuses(
      await edited((data) => {
        const messages = data.messages as { conversationId: string }[];
        const first = messages[0];
        if (first !== undefined) first.conversationId = randomUUID();
      }),
      "conflict",
    );
  });

  test("a row naming an unknown operator", async () => {
    await refuses(
      await edited((data) => {
        const rows = data.conversations as { assigneeOperatorId: string }[];
        const first = rows[0];
        if (first !== undefined) first.assigneeOperatorId = randomUUID();
      }),
      "unknown operator",
    );
  });

  test("an entry with a path of its own", async () => {
    const parts = [...tarEntry("export.json", Buffer.alloc(0))];
    await refuses(Buffer.concat([...parts, tarEnd()]));
    const withEscape: Uint8Array[] = [];
    for await (const entry of readTar(once(archive))) {
      withEscape.push(...tarEntry(entry.name, entry.bytes));
      if (entry.name === "export.json") {
        withEscape.push(...tarEntry("images/../../../etc/passwd", Buffer.from("x")));
      }
    }
    withEscape.push(tarEnd());
    await refuses(Buffer.concat(withEscape), "unexpected entry");
  });

  test("a counter below a message, which would block every later send", async () => {
    await refuses(
      await edited((data) => {
        (data.workspace as { eventSeq: string }).eventSeq = "0";
      }),
      "past the workspace's counter",
    );
  });

  test("an image that is not an image", async () => {
    const parts: Uint8Array[] = [];
    for await (const entry of readTar(once(archive))) {
      parts.push(
        ...tarEntry(
          entry.name,
          entry.name.startsWith("images/") ? Buffer.from("<script>alert(1)</script>") : entry.bytes,
        ),
      );
    }
    parts.push(tarEnd());
    await refuses(Buffer.concat(parts), "cannot be used");
  });

  test("a store that fails partway leaves nothing behind", async () => {
    const target = await freshInstall();
    const inner = target.store;
    let puts = 0;
    const failing: ObjectStore = {
      ...inner,
      async put(key, bytes, type) {
        puts += 1;
        if (puts === 2) throw new Error("The store is down");
        await inner.put(key, bytes, type);
      },
    };
    await expect(importArchive(target.db, failing, once(archive))).rejects.toThrow("down");
    expect(await target.owner.select().from(workspace)).toEqual([]);
    expect(await files(target.directory)).toEqual([]);
  });

  test("a failed import can be run again and succeed", async () => {
    const target = await freshInstall();
    await expect(
      importArchive(target.db, target.store, once(archive.subarray(0, 700))),
    ).rejects.toBeInstanceOf(ImportError);
    const result = await importArchive(target.db, target.store, once(archive));
    expect(result.messages).toBe(4);
  });
});

test("an export skips an image deleted since it started, and still imports", async () => {
  const fresh = await makeSource();
  const { install, space } = fresh;
  const rows = await install.owner
    .select()
    .from(attachment)
    .where(eq(attachment.workspaceId, space.id));
  const gone = rows[0];
  if (gone === undefined) throw new Error("No image");
  const removing: ObjectStore = {
    ...install.store,
    get: async (key) => {
      if (key !== gone.storageKey) return install.store.get(key);
      // The delete commits between the export's read and this file.
      await install.owner.delete(attachment).where(eq(attachment.id, gone.id));
      return null;
    },
  };
  const partial = await collect(exportArchive(install.db, removing, space.id));
  const target = await freshInstall();
  const result = await importArchive(target.db, target.store, once(partial));
  expect(result.images).toBe(1);
  expect(result.missingImages).toBe(1);
  expect(result.messages).toBe(4);
});

test("an export fails if a file is missing while its row is still there", async () => {
  const { install, space } = source;
  // As when the export runs with the wrong store settings.
  const wrongStore: ObjectStore = { ...install.store, get: async () => null };
  await expect(collect(exportArchive(install.db, wrongStore, space.id))).rejects.toThrow(
    "is missing",
  );
});

test("a commit whose reply is lost keeps the images, which the committed rows need", async () => {
  const target = await freshInstall();
  let calls = 0;
  const losesReply = new Proxy(target.db, {
    get(real, name, receiver) {
      if (name !== "transaction") return Reflect.get(real, name, receiver);
      return async (...args: Parameters<Database["transaction"]>) => {
        const result = await real.transaction(...args);
        calls += 1;
        // The first call is the check for an existing workspace, and the second is the import.
        if (calls === 2) throw new Error("Connection terminated unexpectedly");
        return result;
      };
    },
  });
  await expect(importArchive(losesReply, target.store, once(archive))).rejects.toThrow(
    "Connection terminated",
  );
  const rows = await target.owner.select().from(attachment);
  expect(rows).toHaveLength(2);
  expect(await files(target.directory)).toHaveLength(2);
});

test("a new generation always fits a cursor and differs from the exported one", () => {
  for (const exported of [1, 2, 999_999_998, 999_999_999]) {
    for (let index = 0; index < 2000; index++) {
      const drawn = newGeneration(exported);
      expect(drawn).not.toBe(exported);
      expect(drawn).toBeGreaterThanOrEqual(1);
      expect(drawn).toBeLessThanOrEqual(999_999_999);
      expect(CURSOR_PATTERN.test(`${drawn}.1`)).toBe(true);
    }
  }
});

test("the export fails, with no end marker, if the store fails", async () => {
  const { install, space } = source;
  const down: ObjectStore = {
    ...install.store,
    get: async () => {
      throw new Error("The store is down");
    },
  };
  await expect(collect(exportArchive(install.db, down, space.id))).rejects.toThrow("down");
});

test("the commands write and read a real file, and a failure leaves no whole-looking file", async () => {
  const target = await freshInstall();
  const folder = await mkdtemp(join(tmpdir(), "dinghy-cli-"));
  const file = join(folder, "export.tar");
  const run = (database: TestDatabase, directory: string, ...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: database.url("app"),
        VALKEY_URL,
        AUTH_SECRET,
        PUBLIC_URL,
        STORAGE_DIR: directory,
      },
    });
  const exported = run(
    source.install.database,
    source.install.directory,
    "export",
    source.space.id,
    file,
  );
  expect(exported.status).toBe(0);
  expect((await readFile(file)).length).toBeGreaterThan(1024);

  const imported = run(target.database, target.directory, "import", file);
  expect(imported.status).toBe(0);
  expect(imported.stdout).toContain("4 messages, 2 images");
  expect(imported.stdout).toContain("chat sign-in-link");

  const again = run(target.database, target.directory, "import", file);
  expect(again.status).toBe(1);
  expect(again.stderr).toContain("Nothing was imported.");

  const missing = run(
    source.install.database,
    source.install.directory,
    "export",
    randomUUID(),
    join(folder, "none.tar"),
  );
  expect(missing.status).not.toBe(0);
  expect((await readdir(folder)).filter((name) => name.includes("none"))).toEqual([]);

  const { mode } = await stat(file);
  expect(mode & 0o077).toBe(0);
  const noFile = run(target.database, target.directory, "import", join(folder, "absent.tar"));
  expect(noFile.status).toBe(1);
  expect(noFile.stderr).toContain("There is no file");

  await writeFile(join(folder, "bad.tar"), "not a tar file at all");
  const bad = run(target.database, target.directory, "import", join(folder, "bad.tar"));
  expect(bad.status).toBe(1);
}, 60_000);
