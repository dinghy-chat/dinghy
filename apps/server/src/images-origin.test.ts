import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET } from "../test/env.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { chatLinkUrl, createChatLink } from "./chat-link.ts";
import { loadConfig } from "./config.ts";
import { attachment, message, visitor } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { createImages, type Images } from "./images.ts";
import { appendMessage } from "./messages.ts";
import { localStore } from "./storage.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const APP = "https://chat.example.com";
const FILES = "https://files.example.com";
const SITE = "https://site.example";
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let directory: string;
let images: Images;
let app: App;
let space: NewWorkspace;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 5).db;
  owner = database.connect("migrator", 1).db;
  directory = await mkdtemp(join(tmpdir(), "dinghy-origin-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Dinghy</title>");
  images = createImages({
    store: localStore(directory),
    secret: AUTH_SECRET,
    publicUrl: APP,
    origin: FILES,
  });
  app = createApp({
    auth: createAuth({ db, secret: AUTH_SECRET, baseURL: APP }),
    db,
    images,
    logger,
    operatorDirectory: directory,
    publicUrl: APP,
    checks: { postgres: ok, valkey: ok },
  });
  space = await createWorkspace(db, "Shop", [SITE]);
}, 30_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

/** Stores bytes under a content type, as if the server had, and returns a signed URL. */
async function stored(bytes: Uint8Array, contentType: string): Promise<URL> {
  const attachmentId = randomUUID();
  const storageKey = `${space.id}/${attachmentId}`;
  await images.store.put(storageKey, bytes, contentType);
  await withWorkspace(db, space.id, async (tx) => {
    const [row] = await tx
      .insert(visitor)
      .values({ workspaceId: space.id, externalId: randomUUID() })
      .returning({ id: visitor.id });
    await appendMessage(
      tx,
      space.id,
      { kind: "visitor", visitorId: row?.id ?? "" },
      {
        clientId: randomUUID(),
        attachment: {
          kind: "image",
          attachmentId,
          storageKey,
          byteSize: bytes.byteLength,
          contentType,
          width: 1,
          height: 1,
        },
      },
    );
  });
  return new URL(images.url(space.id, attachmentId));
}

const png = () =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: "#1f6bff" } })
    .png()
    .toBuffer();

describe("a separate origin for user images", () => {
  test("image URLs use it, and it serves the image with headers that stop scripts", async () => {
    const url = await stored(await png(), "image/png");
    expect(url.origin).toBe(FILES);
    const response = await app.request(url.toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
  });

  test("the app's origin does not serve images", async () => {
    const url = await stored(await png(), "image/png");
    const onApp = new URL(`${url.pathname}${url.search}`, APP);
    expect((await app.request(onApp.toString())).status).toBe(404);
  });

  test("the image origin serves nothing else", async () => {
    for (const path of ["/", "/v1/meta", "/v1/operator/me", "/invite?token=x", "/healthz"]) {
      expect((await app.request(new URL(path, FILES).toString())).status, path).toBe(404);
    }
    const url = await stored(await png(), "image/png");
    expect((await app.request(url.toString(), { method: "POST" })).status).toBe(404);
    // The app itself still works on its own origin, and its pages may show these images.
    const page = await app.request(new URL("/", APP).toString());
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(`img-src 'self' data: ${FILES};`);
    // The image viewer reads the file to save it on the device.
    expect(page.headers.get("content-security-policy")).toContain(`connect-src 'self' ${FILES};`);
    // The chat page from a reply email fetches a file to save it, too.
    const token = await withWorkspace(owner, space.id, async (tx) => {
      const [row] = await tx
        .insert(visitor)
        .values({ workspaceId: space.id, externalId: randomUUID() })
        .returning({ id: visitor.id });
      const visitorId = row?.id ?? "";
      const { message: sent } = await appendMessage(
        tx,
        space.id,
        { kind: "visitor", visitorId },
        { clientId: randomUUID(), body: "Hello" },
      );
      return createChatLink(tx, space.id, visitorId, sent.conversationId);
    });
    const chat = await app.request(chatLinkUrl(APP, token));
    expect(chat.status).toBe(200);
    expect(chat.headers.get("content-security-policy")).toContain(`connect-src 'self' ${FILES};`);
  });

  test("an HTML or SVG body is never served, whatever its row says", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    for (const [bytes, type] of [
      [svg, "image/svg+xml"],
      [html, "text/html"],
      [html, "text/html; charset=utf-8"],
    ] as const) {
      const url = await stored(bytes, type);
      const response = await app.request(url.toString());
      expect(response.status, type).toBe(404);
      expect(await response.text()).not.toContain("<script>");
    }
  });

  test("a stored row and message exist for each image, so the checks above are real", async () => {
    const rows = await owner.select({ type: attachment.contentType }).from(attachment);
    expect(rows.map((row) => row.type)).toContain("image/svg+xml");
    expect((await owner.select().from(message)).length).toBeGreaterThan(0);
  });

  test("it must be another host than the app's", () => {
    const base = {
      DATABASE_URL: "postgres://x@localhost/x",
      VALKEY_URL: "redis://localhost",
      AUTH_SECRET,
      PUBLIC_URL: APP,
    };
    expect(loadConfig({ ...base, IMAGES_ORIGIN: FILES }).IMAGES_ORIGIN).toBe(FILES);
    expect(() => loadConfig({ ...base, IMAGES_ORIGIN: `${APP}/files` })).toThrow(/IMAGES_ORIGIN/);
  });
});

describe("with no separate origin", () => {
  test("the app's origin serves images, with the same headers", async () => {
    const plain = createImages({ store: images.store, secret: AUTH_SECRET, publicUrl: APP });
    const server = createApp({ db, images: plain, logger, checks: { postgres: ok, valkey: ok } });
    const attachmentId = randomUUID();
    const url = new URL(plain.url(space.id, attachmentId));
    expect(url.origin).toBe(APP);
    // Unknown here, and still answered by the route on this origin rather than refused for it.
    expect((await server.request(url.toString())).status).toBe(404);
    const real = await stored(await png(), "image/png");
    const onApp = new URL(plain.url(space.id, real.pathname.split("/").at(-1) ?? ""));
    const response = await server.request(onApp.toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });
});
