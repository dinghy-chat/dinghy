import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { S3 } from "../test/env.ts";
import { type App, createApp } from "./app.ts";
import { attachment, visitor, widgetSettings, workspace } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import {
  createImages,
  type Images,
  imageFormat,
  MAX_BYTES,
  MAX_FILE_BYTES,
  MAX_UPLOADS_PER_ADDRESS,
  processImage,
} from "./images.ts";
import { appendMessage, ConversationClosedError } from "./messages.ts";
import { localStore, type ObjectStore, s3Store } from "./storage.ts";
import { purgeDeletedWorkspaces } from "./workspace-delete.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = "https://app.example.com";
const PUBLIC_URL = "https://chat.example.com";
const logger = pino({ level: "silent" });
const ok = async () => {};

function noise(width: number, height: number, channels: 3 | 4 = 3) {
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width, height, channels } });
}

const png = (width = 40, height = 20) => noise(width, height).png().toBuffer();
const jpeg = (width = 40, height = 20) => noise(width, height).jpeg().toBuffer();
const webp = (width = 40, height = 20) => noise(width, height).webp().toBuffer();

/** The smallest bytes each allowed type accepts: its signature, where it has one. */
const zip = Buffer.from("PK\x03\x04 a zip's entries", "latin1");
const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const movie = Buffer.from("\x00\x00\x00\x18ftypisom", "latin1");
const ALLOWED = {
  pdf: Buffer.from("%PDF-1.7\n%%EOF\n"),
  txt: Buffer.from("Order 1042 never arrived."),
  csv: Buffer.from("order,total\n1042,19.90\n"),
  log: Buffer.from("12:00:01 ERROR checkout failed\n"),
  json: Buffer.from('{"order":1042}'),
  zip,
  docx: zip,
  xlsx: zip,
  pptx: zip,
  odt: zip,
  ods: zip,
  doc: ole,
  xls: ole,
  ppt: ole,
  mp4: movie,
  mov: movie,
};

let database: TestDatabase;
let db: Database;
let owner: Database;
let worker: Database;
let a: NewWorkspace;
let b: NewWorkspace;
let directory: string;

async function s3ForTest(): Promise<ObjectStore> {
  const bucket = `dinghy-test-${crypto.randomUUID().slice(0, 8)}`;
  const client = new AwsClient({
    accessKeyId: S3.accessKeyId,
    secretAccessKey: S3.secretAccessKey,
    region: S3.region,
    service: "s3",
  });
  const created = await client.fetch(`${S3.endpoint}/${bucket}`, { method: "PUT" });
  if (!created.ok) throw new Error(`Could not create the bucket: ${created.status}`);
  return s3Store({ ...S3, bucket });
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  // One connection each, because test files share the server's connection limit.
  owner = database.connect("migrator", 1).db;
  worker = database.connect("worker", 1).db;
  a = await createWorkspace(db, "A", [ORIGIN]);
  b = await createWorkspace(db, "B", [ORIGIN]);
  directory = await mkdtemp(join(tmpdir(), "dinghy-images-"));
}, 30_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

describe("processing an image", () => {
  test.each([
    ["PNG", png, "image/png"],
    ["JPEG", jpeg, "image/jpeg"],
    ["WebP", webp, "image/webp"],
  ])("a %s keeps its format", async (_name, make, type) => {
    const result = await processImage(await make());
    expect(result).toMatchObject({ contentType: type, width: 40, height: 20 });
  });

  test("the format comes from the bytes, not a name", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    expect(await processImage(svg)).toBe("not_an_image");
  });

  test.each([
    ["GIF", () => noise(10, 10).gif().toBuffer()],
    ["TIFF", () => noise(10, 10).tiff().toBuffer()],
    ["AVIF", () => noise(10, 10).avif().toBuffer()],
    ["plain text", async () => Buffer.from("hello, this is not an image")],
    ["an empty body", async () => Buffer.alloc(0)],
  ])("%s is refused", async (_name, make) => {
    expect(await processImage(await make())).toBe("not_an_image");
  });

  test.each([
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["GIF", Buffer.from("GIF89a")],
    ["TIFF", Buffer.from([0x49, 0x49, 0x2a, 0x00])],
    ["PDF", Buffer.from("%PDF-1.7")],
    ["HEIF", Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])],
    ["a RIFF that is not WebP", Buffer.from("RIFF\0\0\0\0WAVEfmt ")],
  ])("%s never reaches the decoder", (_name, bytes) => {
    expect(imageFormat(bytes)).toBeNull();
  });

  test.each([
    ["png", png],
    ["jpeg", jpeg],
    ["webp", webp],
  ])("the first bytes of a %s name its format", async (format, make) => {
    expect(imageFormat(await make())).toBe(format);
  });

  test("a truncated image is refused", async () => {
    const whole = await png(200, 200);
    expect(await processImage(whole.subarray(0, whole.length / 3))).toBe("not_an_image");
  });

  test("an image over 16 megapixels is refused before it decodes", async () => {
    // Highly compressible, so it is small on disk and huge when decoded.
    const bomb = await sharp({
      create: { width: 5000, height: 4000, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer();
    expect(bomb.length).toBeLessThan(MAX_BYTES);
    expect(await processImage(bomb)).toBe("too_many_pixels");
  });

  test("a photo with EXIF orientation 6 stays upright, and its EXIF data is gone", async () => {
    // Stored sideways: 40 wide and 20 tall, with a tag that says to turn it.
    const sideways = await noise(40, 20)
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "secret-location" } } })
      .jpeg()
      .toBuffer();
    const result = await processImage(sideways);
    if (typeof result === "string") throw new Error(result);
    expect(result).toMatchObject({ width: 20, height: 40 });
    const metadata = await sharp(result.data).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(Buffer.from(result.data).includes("secret-location")).toBe(false);
  });

  test("bytes appended after an image do not survive", async () => {
    const payload = Buffer.concat([await png(), Buffer.from("<script>alert(1)</script>")]);
    const result = await processImage(payload);
    if (typeof result === "string") throw new Error(result);
    expect(Buffer.from(result.data).includes("<script>")).toBe(false);
  });
});

describe.each([
  ["local storage", async () => localStore(directory)],
  ["S3-compatible storage", s3ForTest],
])("with %s", (_name, makeStore) => {
  let store: ObjectStore;
  let images: Images;
  let app: App;

  const newVisitor = async (key = a.publicKey) => {
    const response = await app.request(`/v1/widget/${key}/visitors`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    return ((await response.json()) as { token: string }).token;
  };

  const upload = (
    token: string,
    body: Uint8Array | undefined,
    clientId: string = crypto.randomUUID(),
    key = a.publicKey,
  ) =>
    app.request(`/v1/widget/${key}/images?clientId=${clientId}`, {
      method: "POST",
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: body as Uint8Array<ArrayBuffer> }),
    });

  interface Sent {
    id: string;
    kind: string;
    body: string | null;
    image: { url: string; width: number; height: number };
  }

  const uploadFile = (token: string, body: Uint8Array, filename?: string, key = a.publicKey) =>
    app.request(
      `/v1/widget/${key}/images?clientId=${crypto.randomUUID()}${filename === undefined ? "" : `&filename=${encodeURIComponent(filename)}`}`,
      {
        method: "POST",
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
        body: body as Uint8Array<ArrayBuffer>,
      },
    );

  interface SentFile {
    id: string;
    file: { name: string; size: number; url: string };
  }

  const fetchFile = (url: string) => app.request(url.replace(PUBLIC_URL, ""));

  const exists = async (key: string) => {
    const stream = await store.get(key);
    await stream?.cancel();
    return stream !== null;
  };

  beforeAll(async () => {
    store = await makeStore();
    images = createImages({ store, secret: "a-test-secret", publicUrl: PUBLIC_URL });
    app = createApp({ db, images, logger, checks: { postgres: ok, valkey: ok } });
  });

  test("a valid image becomes a message, and its signed URL serves the re-encoded bytes", async () => {
    const response = await upload(await newVisitor(), await png());
    expect(response.status).toBe(201);
    const sent = (await response.json()) as Sent;
    expect(sent).toMatchObject({ kind: "image", body: null });
    expect(sent.image).toMatchObject({ width: 40, height: 20 });
    expect(sent.image.url.startsWith(PUBLIC_URL)).toBe(true);
    const file = await fetchFile(sent.image.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");
    // The app reads the file to save it on the device.
    expect(file.headers.get("access-control-allow-origin")).toBe("*");
    // An expired URL's 404 too, so a page on another origin can tell it from a failure.
    const expired = new URL(sent.image.url);
    expired.searchParams.set("expires", "1");
    const gone = await fetchFile(expired.toString());
    expect(gone.status).toBe(404);
    expect(gone.headers.get("access-control-allow-origin")).toBe("*");
    const metadata = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
    expect(metadata.format).toBe("png");
  });

  test("a retry returns the original and leaves one object", async () => {
    const token = await newVisitor();
    const first = (await (await upload(token, await png(), "retry-image")).json()) as Sent;
    const second = await upload(token, await png(), "retry-image");
    expect(second.status).toBe(200);
    expect(((await second.json()) as Sent).id).toBe(first.id);
    const attachmentId = new URL(first.image.url).pathname.split("/").at(-1) ?? "";
    const rows = await withWorkspace(db, a.id, (tx) =>
      tx.select().from(attachment).where(eq(attachment.id, attachmentId)),
    );
    expect(rows).toHaveLength(1);
    await expect(exists(rows[0]?.storageKey ?? "")).resolves.toBe(true);
    // The retry's own copy was discarded, so the file serves the original.
    expect((await fetchFile(first.image.url)).status).toBe(200);
  });

  test.each([
    ["no body", undefined, 400],
    ["text", new TextEncoder().encode("not an image"), 400],
    ["an SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 400],
  ])("%s is refused", async (_name, body, status) => {
    expect((await upload(await newVisitor(), body)).status).toBe(status);
  });

  test("an upload over 10 MB is refused before it is read", async () => {
    const response = await upload(await newVisitor(), new Uint8Array(MAX_FILE_BYTES + 1));
    expect(response.status).toBe(413);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  test("an image over 5 MB is refused, whatever its name", async () => {
    const big = Buffer.alloc(MAX_BYTES + 1);
    (await png()).copy(big);
    const response = await uploadFile(await newVisitor(), big, "big.pdf");
    expect(response.status).toBe(413);
  });

  describe("files", () => {
    test.each(Object.entries(ALLOWED))(
      "a %s is stored as it came, and only downloads",
      async (extension, bytes) => {
        const response = await uploadFile(
          await newVisitor(),
          bytes,
          `Notes.${extension.toUpperCase()}`,
        );
        expect(response.status).toBe(201);
        const sent = (await response.json()) as SentFile;
        expect(sent).toMatchObject({
          kind: "file",
          body: null,
          image: null,
          file: { name: `Notes.${extension}`, size: bytes.length },
        });
        const download = await fetchFile(sent.file.url);
        expect(download.status).toBe(200);
        expect(download.headers.get("content-type")).toBe("application/octet-stream");
        expect(download.headers.get("content-disposition")).toBe(
          `attachment; filename="Notes.${extension}"; filename*=UTF-8''Notes.${extension}`,
        );
        expect(download.headers.get("x-content-type-options")).toBe("nosniff");
        expect(download.headers.get("content-security-policy")).toContain("sandbox");
        expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
      },
    );

    test.each([
      [
        "an SVG named .pdf",
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        "a.pdf",
      ],
      ["HTML named .docx", "<!doctype html><script>alert(1)</script>", "a.docx"],
      ["a type outside the list", '<svg xmlns="http://www.w3.org/2000/svg"/>', "logo.svg"],
      ["an executable", "MZ\x90\x00", "setup.exe"],
      ["a file with no name", "%PDF-1.7", undefined],
    ])("%s is refused with the list of types", async (_name, text, filename) => {
      const response = await uploadFile(await newVisitor(), Buffer.from(text), filename);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "type_not_allowed", message: expect.stringContaining("PDF, TXT, CSV") },
      });
    });

    test("HTML named .txt has no signature to check, so it only ever downloads", async () => {
      const page = Buffer.from("<!doctype html><script>alert(1)</script>");
      const sent = (await (
        await uploadFile(await newVisitor(), page, "page.txt")
      ).json()) as SentFile;
      const download = await fetchFile(sent.file.url);
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(download.headers.get("content-security-policy")).toContain("sandbox");
    });

    test("an image named as a file is still an image, encoded again", async () => {
      const response = await uploadFile(await newVisitor(), await png(), "report.pdf");
      expect(response.status).toBe(201);
      const sent = (await response.json()) as Sent & { file: null };
      expect(sent).toMatchObject({ kind: "image", file: null, image: { width: 40, height: 20 } });
      const shown = await fetchFile(sent.image.url);
      expect(shown.headers.get("content-type")).toBe("image/png");
      expect(shown.headers.get("content-disposition")).toBe("inline");
    });

    test("a name outside ASCII downloads under its own name, with a plain one for old clients", async () => {
      const sent = (await (
        await uploadFile(await newVisitor(), ALLOWED.pdf, "../Résumé (été)\u202e.pdf")
      ).json()) as SentFile;
      expect(sent.file.name).toBe("_Résumé (été)_.pdf");
      const download = await fetchFile(sent.file.url);
      expect(download.headers.get("content-disposition")).toBe(
        `attachment; filename="_R_sum_ (_t_)_.pdf"; filename*=UTF-8''_R%C3%A9sum%C3%A9%20%28%C3%A9t%C3%A9%29_.pdf`,
      );
    });

    test("with Visitors can send files off, a visitor's file is refused and an image still goes", async () => {
      const closed = await createWorkspace(db, "Images only", [ORIGIN]);
      await withWorkspace(db, closed.id, (tx) =>
        tx
          .update(widgetSettings)
          .set({ visitorFiles: false })
          .where(eq(widgetSettings.workspaceId, closed.id)),
      );
      const token = await newVisitor(closed.publicKey);
      const refused = await uploadFile(token, ALLOWED.pdf, "notes.pdf", closed.publicKey);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: { code: "not_an_image" } });
      expect((await uploadFile(token, await png(), "photo.png", closed.publicKey)).status).toBe(
        201,
      );
    });
  });

  test("an upload with no token or from another site is refused", async () => {
    expect((await upload("dbt_wrong", await png())).status).toBe(401);
    const response = await app.request(`/v1/widget/${a.publicKey}/images?clientId=x`, {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
      body: (await png()) as Uint8Array<ArrayBuffer>,
    });
    expect(response.status).toBe(403);
  });

  test("a bad client ID is refused", async () => {
    expect((await upload(await newVisitor(), await png(), "a b")).status).toBe(400);
  });

  describe("when a commit fails", () => {
    const attempt = async (error: Error) => {
      const put: string[] = [];
      const watching: ObjectStore = {
        ...store,
        put: async (key, bytes, type) => {
          put.push(key);
          await store.put(key, bytes, type);
        },
      };
      const failing = createImages({ store: watching, secret: "s", publicUrl: PUBLIC_URL });
      await expect(
        failing.receive(
          new Request("http://x", { method: "POST", body: await png() }),
          a.id,
          () => Promise.reject(error),
          randomUUID(),
          null,
        ),
      ).rejects.toBe(error);
      return put[0] ?? "";
    };

    test("a known rollback leaves no object", async () => {
      await expect(exists(await attempt(new ConversationClosedError()))).resolves.toBe(false);
    });

    test("a commit that the database refused leaves no object", async () => {
      const refused = Object.assign(new Error("duplicate key"), { code: "23505" });
      await expect(exists(await attempt(refused))).resolves.toBe(false);
    });

    test("a commit whose connection dropped keeps the object, because it may have landed", async () => {
      const dropped = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      await expect(exists(await attempt(dropped))).resolves.toBe(true);
      const wrapped = new Error("Failed query", {
        cause: new Error("Connection terminated unexpectedly"),
      });
      await expect(exists(await attempt(wrapped))).resolves.toBe(true);
      // Drizzle's ROLLBACK after the drop replaces the first error with this one.
      const rollback = new Error("Client has encountered a connection error and is not queryable");
      await expect(exists(await attempt(rollback))).resolves.toBe(true);
    });

    test("a commit that could not reach the database leaves no object", async () => {
      const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      await expect(exists(await attempt(refused))).resolves.toBe(false);
    });

    test("an upload that a workspace's purge overtakes leaves no object", async () => {
      const doomed = await createWorkspace(db, "Doomed", [ORIGIN]);
      const visitorId = await withWorkspace(db, doomed.id, async (tx) => {
        const [row] = await tx
          .insert(visitor)
          .values({ workspaceId: doomed.id, externalId: "v" })
          .returning({ id: visitor.id });
        return row?.id ?? "";
      });
      let stored = "";
      // The owner deletes the workspace, and the worker purges it, while the image is stored.
      const racing: ObjectStore = {
        ...store,
        put: async (key, bytes, type) => {
          await store.put(key, bytes, type);
          stored = key;
          await owner
            .update(workspace)
            .set({ deletedAt: new Date() })
            .where(eq(workspace.id, doomed.id));
          await purgeDeletedWorkspaces(worker);
        },
      };
      const racingImages = createImages({ store: racing, secret: "s", publicUrl: PUBLIC_URL });
      await expect(
        racingImages.receive(
          new Request("http://x", { method: "POST", body: await png() }),
          doomed.id,
          (attachment) =>
            withWorkspace(db, doomed.id, (tx) =>
              appendMessage(
                tx,
                doomed.id,
                { kind: "visitor", visitorId },
                { clientId: "c", attachment },
              ),
            ),
          randomUUID(),
          null,
        ),
      ).rejects.toThrow();
      expect(stored).not.toBe("");
      await expect(exists(stored)).resolves.toBe(false);
    });
  });

  describe("signed URLs", () => {
    let sent: Sent;
    beforeAll(async () => {
      sent = (await (await upload(await newVisitor(), await png())).json()) as Sent;
    });
    const parts = () => new URL(sent.image.url);

    test("HEAD answers the headers and opens no file", async () => {
      let opened = 0;
      const counting = createApp({
        db,
        logger,
        checks: { postgres: ok, valkey: ok },
        images: createImages({
          store: {
            ...store,
            get: (key) => {
              opened += 1;
              return store.get(key);
            },
          },
          secret: "a-test-secret",
          publicUrl: PUBLIC_URL,
        }),
      });
      const response = await counting.request(sent.image.url.replace(PUBLIC_URL, ""), {
        method: "HEAD",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(opened).toBe(0);
    });

    test("a failed read answers 503, not the 404 of an expired URL", async () => {
      const failing = createApp({
        db,
        logger,
        checks: { postgres: ok, valkey: ok },
        images: createImages({
          store: { ...store, get: () => Promise.reject(new Error("The store timed out")) },
          secret: "a-test-secret",
          publicUrl: PUBLIC_URL,
        }),
      });
      const response = await failing.request(sent.image.url.replace(PUBLIC_URL, ""));
      expect(response.status).toBe(503);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    test("a changed signature fails", async () => {
      const url = parts();
      url.searchParams.set("signature", "forged");
      expect((await fetchFile(url.toString())).status).toBe(404);
    });

    test("a later expiry fails, because the signature covers it", async () => {
      const url = parts();
      url.searchParams.set("expires", String(Math.floor(Date.now() / 1000) + 99_999));
      expect((await fetchFile(url.toString())).status).toBe(404);
    });

    test("an image keeps its URL for minutes, so the browser's cache serves it again", () => {
      const [workspaceId = "", attachmentId = ""] = parts().pathname.split("/").slice(3);
      const start = Date.parse("2026-11-08T12:00:00Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(start);
        const first = images.url(workspaceId, attachmentId);
        vi.setSystemTime(start + 4 * 60_000 + 59_000);
        expect(images.url(workspaceId, attachmentId)).toBe(first);
        // Even the last moment of its bucket hands out a URL with 15 minutes left.
        const expires = Number(new URL(first).searchParams.get("expires"));
        expect(expires * 1000 - Date.now()).toBeGreaterThanOrEqual(15 * 60_000);
        vi.setSystemTime(start + 5 * 60_000);
        expect(images.url(workspaceId, attachmentId)).not.toBe(first);
      } finally {
        vi.useRealTimers();
      }
    });

    test("an expired URL fails", async () => {
      const [workspaceId, attachmentId] = parts().pathname.split("/").slice(3);
      expect(images.verify(workspaceId ?? "", attachmentId ?? "", "1000", "x")).toBe(false);
    });

    test("a signature for one image does not open another", async () => {
      const other = (await (await upload(await newVisitor(), await png())).json()) as Sent;
      const url = parts();
      const [workspaceId] = url.pathname.split("/").slice(3);
      const otherId = new URL(other.image.url).pathname.split("/").at(-1);
      url.pathname = `/v1/files/${workspaceId}/${otherId}`;
      expect((await fetchFile(url.toString())).status).toBe(404);
    });

    test("a signature cannot move to another workspace", async () => {
      const url = parts();
      const attachmentId = url.pathname.split("/").at(-1);
      url.pathname = `/v1/files/${b.id}/${attachmentId}`;
      expect((await fetchFile(url.toString())).status).toBe(404);
    });

    test("a malformed path is a 404, not a server error", async () => {
      expect(
        (await app.request("/v1/files/not-a-uuid/also-not?expires=1&signature=x")).status,
      ).toBe(404);
    });
  });

  test("a visitor gets no URL for an image in another conversation", async () => {
    const owner = await newVisitor();
    const sent = (await (await upload(owner, await png())).json()) as Sent;
    const other = await newVisitor();
    const history = await app.request(`/v1/widget/${a.publicKey}/messages`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${other}` },
    });
    expect(await history.text()).not.toContain(new URL(sent.image.url).pathname);
  });
});

describe("uploads that stall or crawl", () => {
  const images = () =>
    createImages({
      store: localStore(directory),
      secret: "s",
      publicUrl: PUBLIC_URL,
      readIdleMs: 150,
    });

  /** A body that sends its chunks with a pause between them, and may never end. */
  const paced = (chunks: Uint8Array[], pauseMs: number, end = true) =>
    new Request("http://x", {
      method: "POST",
      duplex: "half",
      body: new ReadableStream({
        async pull(controller) {
          const chunk = chunks.shift();
          if (chunk !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, pauseMs));
            controller.enqueue(chunk);
          } else if (end) {
            controller.close();
          }
        },
      }),
    } as RequestInit);

  const commit = async () => ({ created: true });

  test("one address cannot hold more uploads than its limit, and another still can", async () => {
    const shared = images();
    const address = "198.51.100.7";
    const stalled = Array.from({ length: MAX_UPLOADS_PER_ADDRESS }, () =>
      shared.receive(paced([], 0, false), a.id, commit, address, null),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const body = await png();
    const request = () => new Request("http://x", { method: "POST", body });
    // Another workspace does not help, because the budget this protects is shared by all of them.
    expect(await shared.receive(request(), b.id, commit, address, null)).toEqual({
      refused: "busy",
    });
    expect(await shared.receive(request(), a.id, commit, "198.51.100.8", null)).toEqual({
      result: { created: true },
    });
    const outcomes = await Promise.all(stalled);
    expect(outcomes.every((outcome) => "refused" in outcome)).toBe(true);
    // A finished upload frees its place.
    expect(await shared.receive(request(), a.id, commit, address, null)).toEqual({
      result: { created: true },
    });
  });

  test("a stalled upload times out", async () => {
    const started = Date.now();
    const outcome = await images().receive(paced([], 0, false), a.id, commit, randomUUID(), null);
    expect(outcome).toEqual({ refused: "too_slow" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a slow upload that keeps sending succeeds, past the idle time", async () => {
    // Random pixels do not compress, so each chunk below is more than the progress needed.
    const bytes = await sharp(randomBytes(500 * 500 * 3), {
      raw: { width: 500, height: 500, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(6 * 70 * 1024);
    const size = Math.ceil(bytes.length / 6);
    const chunks = Array.from({ length: 6 }, (_, i) => bytes.subarray(i * size, (i + 1) * size));
    const outcome = await images().receive(paced(chunks, 80), a.id, commit, randomUUID(), null);
    expect(outcome).toEqual({ result: { created: true } });
  });

  test("one byte at a time cannot hold the budget past the idle time", async () => {
    const started = Date.now();
    const drip = Array.from({ length: 200 }, () => new Uint8Array(1));
    const outcome = await images().receive(paced(drip, 50), a.id, commit, randomUUID(), null);
    expect(outcome).toEqual({ refused: "too_slow" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("uploads in one workspace cannot block another", async () => {
    const shared = images();
    const big = new Uint8Array(MAX_FILE_BYTES);
    const holders = Array.from({ length: 2 }, () =>
      shared.receive(paced([big], 0, false), a.id, commit, randomUUID(), null),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    // That is this workspace's whole share, so its next upload waits for those to go.
    const request = () => new Request("http://x", { method: "POST", body: Buffer.alloc(1000) });
    expect(await shared.receive(request(), a.id, commit, randomUUID(), null)).toEqual({
      refused: "busy",
    });
    // Another workspace still has its own.
    const other = new Request("http://x", { method: "POST", body: await png() });
    expect(await shared.receive(other, b.id, commit, randomUUID(), null)).toEqual({
      result: { created: true },
    });
    await Promise.all(holders);
  });

  test("the global budget refuses uploads once it is full, across workspaces", async () => {
    const shared = images();
    const big = new Uint8Array(MAX_FILE_BYTES);
    // Four files' worth, held by uploads that stall after sending their bytes.
    const holders = Array.from({ length: 4 }, (_, i) =>
      shared.receive(paced([big], 0, false), `workspace-${i}`, commit, randomUUID(), null),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const request = new Request("http://x", { method: "POST", body: Buffer.alloc(1000) });
    expect(await shared.receive(request, "another-workspace", commit, randomUUID(), null)).toEqual({
      refused: "busy",
    });
    await Promise.all(holders);
  });

  test("stalled connections do not block another image", async () => {
    const shared = images();
    const stalled = Array.from({ length: 20 }, () =>
      shared.receive(paced([], 0, false), a.id, commit, randomUUID(), null),
    );
    const request = new Request("http://x", { method: "POST", body: await png() });
    expect(await shared.receive(request, a.id, commit, randomUUID(), null)).toEqual({
      result: { created: true },
    });
    await Promise.all(stalled);
  });
});

describe("many small files that decode to large images", () => {
  test("the decode queue is limited, whatever the file size", async () => {
    const images = createImages({
      store: localStore(directory),
      secret: "s",
      publicUrl: PUBLIC_URL,
    });
    // Tiny on disk, and 16 megapixels when decoded.
    const tiny = await sharp({
      create: { width: 4000, height: 4000, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    expect(tiny.length).toBeLessThan(300_000);
    const outcomes = await Promise.all(
      Array.from({ length: 30 }, () =>
        images.receive(
          new Request("http://x", { method: "POST", body: tiny }),
          a.id,
          async () => ({
            created: true,
          }),
          randomUUID(),
          null,
        ),
      ),
    );
    const refused = outcomes.filter((outcome) => "refused" in outcome);
    expect(refused.length).toBeGreaterThan(20);
    expect(refused.every((outcome) => "refused" in outcome && outcome.refused === "busy")).toBe(
      true,
    );
  }, 60_000);
});

describe("a burst of uploads", () => {
  test("it is refused past the limit and stays inside a set memory limit", async () => {
    const images = createImages({
      store: localStore(directory),
      secret: "s",
      publicUrl: PUBLIC_URL,
    });
    const app = createApp({ db, images, logger, checks: { postgres: ok, valkey: ok } });
    const created = await app.request(`/v1/widget/${a.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    const { token } = (await created.json()) as { token: string };
    // About 5 MB of JPEG that decodes to 16 million pixels, the worst that passes the limits.
    const worst = await noise(4000, 4000).jpeg({ quality: 30 }).toBuffer();
    expect(worst.length).toBeLessThanOrEqual(MAX_BYTES);

    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 20);
    // Across several workspaces, so the global budget refuses them, not one workspace's share.
    const others = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createWorkspace(db, `Burst ${i}`, [ORIGIN])),
    );
    const senders = await Promise.all(
      [a, ...others].map(async (workspace) => {
        const made = await app.request(`/v1/widget/${workspace.publicKey}/visitors`, {
          method: "POST",
          headers: { origin: ORIGIN },
        });
        return {
          publicKey: workspace.publicKey,
          token: ((await made.json()) as { token: string }).token,
        };
      }),
    );
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const sender = senders[i % senders.length] ?? { publicKey: "", token };
        return app.request(
          `/v1/widget/${sender.publicKey}/images?clientId=${crypto.randomUUID()}`,
          {
            method: "POST",
            headers: { origin: ORIGIN, authorization: `Bearer ${sender.token}` },
            body: worst as Uint8Array<ArrayBuffer>,
          },
        );
      }),
    );
    clearInterval(sampler);
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201).length).toBeGreaterThan(0);
    const busy = responses.filter((response) => response.status === 503);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy[0]?.headers.get("retry-after")).toBe("1");
    expect(statuses.every((status) => status === 201 || status === 503)).toBe(true);
    // Four files' worth of bytes held, and one decoding. Far below what 30 at once would need.
    expect((peak - before) / 1024 / 1024).toBeLessThan(700);
    const files = await readdir(join(directory, a.id));
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  }, 60_000);
});
