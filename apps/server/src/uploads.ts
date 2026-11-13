import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Logger } from "pino";
import sharp, { type OutputInfo, type Sharp } from "sharp";
import type { App } from "./app.ts";
import { attachment } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { failure, NOT_FOUND, safeErrorFields } from "./errors.ts";
import {
  allowedFileName,
  downloadDisposition,
  FILE_TYPE,
  FILE_TYPES_TEXT,
  startsWith,
} from "./files.ts";
import { StorageFullError } from "./limits.ts";
import type { NewAttachment, StoredAttachment } from "./messages.ts";
import type { ObjectStore } from "./storage.ts";
import { MINUTE_MS } from "./time.ts";

/** Whether a database call failed with its outcome unknown, because the connection went away. */
export function lostConnection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Drizzle wraps the driver's error in its own, with the original as the cause.
  if (error.cause !== undefined && lostConnection(error.cause)) return true;
  const code = (error as { code?: unknown }).code;
  // A refused connection never reached the server, so nothing was committed.
  if (code === "ECONNREFUSED" || code === "57P03") return false;
  // 08 is Postgres's connection class, 57P a server shutdown, and E… Node's socket errors.
  if (typeof code === "string" && /^(08|57P|E)/.test(code)) return true;
  // pg's message when the ROLLBACK after a dropped commit cannot run. It has no code.
  return /connection terminated|connection.*closed|not queryable/i.test(error.message);
}

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
/**
 * The bytes one instance holds in uploads at once. It counts bytes and not connections, because a
 * stalled connection holds almost nothing and must not block anyone else's upload.
 */
const MAX_BUFFERED_BYTES = 4 * MAX_FILE_BYTES;
/** One workspace's share of that, so one workspace's visitors cannot block every other's. */
const MAX_WORKSPACE_BUFFERED_BYTES = 2 * MAX_FILE_BYTES;
/**
 * The images waiting to decode. The byte budget cannot limit this, because a tiny file can decode
 * to 16 megapixels, and they would otherwise queue up behind each other for minutes.
 */
const MAX_WAITING_TO_DECODE = 4;
export const MAX_UPLOADS_PER_ADDRESS = 3;
// A slow phone can take minutes over 10 MB, but it keeps sending. Progress is what counts, or one
// byte every so often would hold the budget for the whole of READ_TOTAL_MS.
const READ_IDLE_MS = 30_000;
const READ_PROGRESS_BYTES = 64 * 1024;
const READ_TOTAL_MS = 5 * MINUTE_MS;
const URL_LIFETIME_SECONDS = 15 * 60;
const URL_BUCKET_SECONDS = 5 * 60;

// Decoding is the expensive part, and images take turns, so one thread per image is enough.
sharp.concurrency(1);
// A cache would keep decoded images in memory after the response.
sharp.cache(false);

// One image decodes at a time in this process. A chain of promises is the whole queue.
let turn: Promise<unknown> = Promise.resolve();
const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
  const run = turn.then(work, work);
  turn = run.catch(() => undefined);
  return run;
};

const OUTPUT = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
type Format = keyof typeof OUTPUT;

export type Refusal =
  | "not_an_image"
  | "type_not_allowed"
  | "too_many_pixels"
  | "too_large"
  | "busy"
  | "too_slow"
  | "storage_full";

/**
 * The format from an upload's first bytes, or null for anything else. libvips has loaders for many
 * formats (SVG, HEIF, TIFF, PDF and more), and this keeps every other loader away from untrusted bytes.
 */
export function imageFormat(bytes: Uint8Array): Format | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  // "RIFF", a 4-byte size, then "WEBP".
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "webp";
  }
  return null;
}

interface ProcessedImage {
  data: Uint8Array;
  contentType: string;
  width: number;
  height: number;
}

/**
 * Decodes an upload and encodes it again with `encode`, which drops any payload hidden in it. The
 * format comes from the bytes, never from a file name or a header. Removing the metadata would
 * remove the orientation too, so the image is turned upright first.
 */
async function reencode(
  bytes: Uint8Array,
  encode: (image: Sharp, format: Format) => Sharp,
): Promise<{ data: Buffer; info: OutputInfo; format: Format } | Refusal> {
  const expected = imageFormat(bytes);
  if (expected === null) return "not_an_image";
  try {
    // limitInputPixels stops a small file that decodes to a huge image, before it decodes.
    const input = () => sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false });
    const { format } = await input().metadata();
    if (format !== expected) return "not_an_image";
    const { data, info } = await encode(input().rotate(), expected).toBuffer({
      resolveWithObject: true,
    });
    return { data, info, format: expected };
  } catch (error) {
    return error instanceof Error && error.message.includes("pixel limit")
      ? "too_many_pixels"
      : "not_an_image";
  }
}

/** Checks an image and encodes it again in its own format. */
export async function processImage(bytes: Uint8Array): Promise<ProcessedImage | Refusal> {
  const done = await reencode(bytes, (image, format) => image.toFormat(format));
  if (typeof done === "string") return done;
  return {
    data: done.data,
    contentType: OUTPUT[done.format],
    width: done.info.width,
    height: done.info.height,
  };
}

/** A logo or an operator's picture: public, small, and always WebP. */
export const PUBLIC_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PUBLIC_IMAGE_TYPE = OUTPUT.webp;
export const PUBLIC_IMAGE_TOO_LARGE = failure("too_large", "This image is over 2 MB.");
const LOGO_SIZE_PX = 256;
const PICTURE_SIZE_PX = 128;

/** Checks a public image, then resizes it and encodes it as WebP. */
async function processPublicImage(
  bytes: Uint8Array,
  resize: (image: Sharp) => Sharp,
): Promise<Buffer | Refusal> {
  const done = await inTurn(() => reencode(bytes, (image) => resize(image).webp()));
  return typeof done === "string" ? done : done.data;
}

/** A logo shrinks to fit a 256-pixel square. */
export const processLogo = (bytes: Uint8Array) =>
  processPublicImage(bytes, (image) =>
    image.resize(LOGO_SIZE_PX, LOGO_SIZE_PX, { fit: "inside", withoutEnlargement: true }),
  );

/** A picture fills a 128-pixel square, cut from its middle. */
export const processPicture = (bytes: Uint8Array) =>
  processPublicImage(bytes, (image) => image.resize(PICTURE_SIZE_PX, PICTURE_SIZE_PX));

/** The checked bytes of an upload, before they are stored. */
type Checked = { data: Uint8Array; contentType: string } & (
  | { kind: "image"; width: number; height: number }
  | { kind: "file"; name: string }
);

/** Images and the other files people send in the chat. */
export interface Uploads {
  /**
   * Reads, checks and stores an image or a file, then hands it to `commit`. The object stays if
   * `commit` created a message, and goes away if it did not, as on a retry, or if `commit` failed.
   * `filename` is the name the sender gave a file, or null where only images may come.
   */
  receive<T extends { created: boolean }>(
    request: Request,
    workspaceId: string,
    commit: (upload: NewAttachment) => Promise<T>,
    clientAddress: string,
    filename: string | null,
  ): Promise<{ result: T } | { refused: Refusal }>;
  /** As `receive`, for bytes already in memory, such as an email's attachment. */
  receiveBytes<T extends { created: boolean }>(
    bytes: Uint8Array,
    workspaceId: string,
    commit: (upload: NewAttachment) => Promise<T>,
    filename: string | null,
  ): Promise<{ result: T } | { refused: Refusal }>;
  url(workspaceId: string, attachmentId: string): string;
  verify(workspaceId: string, attachmentId: string, expires: string, signature: string): boolean;
  store: ObjectStore;
  /** The separate origin that serves uploads, from UPLOADS_ORIGIN, or undefined to use the app's. */
  origin: string | undefined;
}

interface UploadsOptions {
  store: ObjectStore;
  secret: string;
  publicUrl: string;
  /**
   * A separate origin for uploads, such as https://files.example.com. Their URLs then
   * use it, and the file route answers only there, so a file can never run in the app's origin.
   */
  origin?: string | undefined;
  readIdleMs?: number;
  /** The clock that URLs expire by, which a browser test moves forward. */
  now?: () => number;
}

export function createUploads({
  store,
  secret,
  publicUrl,
  origin,
  readIdleMs = READ_IDLE_MS,
  now = () => Date.now(),
}: UploadsOptions): Uploads {
  const filesOrigin = origin === undefined ? undefined : new URL(origin).origin;
  let buffered = 0;
  let waitingToDecode = 0;
  const bufferedByWorkspace = new Map<string, number>();
  const uploadsByAddress = new Map<string, number>();

  const sign = (workspaceId: string, attachmentId: string, expires: string) =>
    createHmac("sha256", `dinghy-image-url:${secret}`)
      .update(`${workspaceId}/${attachmentId}/${expires}`)
      .digest("base64url");

  /**
   * Only bytes that start as a PNG, JPEG or WebP reach sharp, and they stay images whatever their
   * name. Any other file is stored as it came, so SVG, TIFF and PDF never reach sharp's loaders.
   */
  const check = async (bytes: Uint8Array, filename: string | null): Promise<Checked | Refusal> => {
    if (imageFormat(bytes) === null) {
      if (filename === null) return "not_an_image";
      const name = allowedFileName(filename, bytes);
      return name === null
        ? "type_not_allowed"
        : { kind: "file", name, data: bytes, contentType: FILE_TYPE };
    }
    if (bytes.byteLength > MAX_BYTES) return "too_large";
    if (waitingToDecode >= MAX_WAITING_TO_DECODE) return "busy";
    waitingToDecode += 1;
    const processed = await inTurn(() => processImage(bytes)).finally(() => {
      waitingToDecode -= 1;
    });
    return typeof processed === "string" ? processed : { kind: "image", ...processed };
  };

  /** Checks and stores the bytes, then hands them to `commit`, as `receive` says. */
  const keep = async <T extends { created: boolean }>(
    bytes: Uint8Array,
    workspaceId: string,
    commit: (upload: NewAttachment) => Promise<T>,
    filename: string | null,
  ): Promise<{ result: T } | { refused: Refusal }> => {
    const checked = await check(bytes, filename);
    if (typeof checked === "string") return { refused: checked };

    const { data, ...upload } = checked;
    const attachmentId = randomUUID();
    const storageKey = `${workspaceId}/${attachmentId}`;
    await store.put(storageKey, data, upload.contentType);
    const discard = () => store.delete(storageKey).catch(() => undefined);
    const result = await commit({
      ...upload,
      attachmentId,
      storageKey,
      byteSize: data.byteLength,
    }).catch(async (error: unknown) => {
      // A failed commit frees the object, or one stored as its workspace was purged would stay
      // in the store for good. A lost connection is the exception: the commit may have
      // landed, and a retry then returns that message, so its object must stay.
      if (!lostConnection(error)) await discard();
      // Over the plan's storage, found under the workspace lock: a refusal like the others.
      if (error instanceof StorageFullError) return null;
      throw error;
    });
    if (result === null) return { refused: "storage_full" };
    if (!result.created) await discard();
    return { result };
  };

  return {
    store,
    origin: filesOrigin,
    receiveBytes(bytes, workspaceId, commit, filename) {
      if (bytes.byteLength > MAX_FILE_BYTES) return Promise.resolve({ refused: "too_large" });
      return keep(bytes, workspaceId, commit, filename);
    },
    async receive(request, workspaceId, commit, clientAddress, filename) {
      // Per address, because a few slow uploads could otherwise fill the budget that every
      // workspace on this server shares.
      const fromAddress = uploadsByAddress.get(clientAddress) ?? 0;
      if (fromAddress >= MAX_UPLOADS_PER_ADDRESS) return { refused: "busy" };
      uploadsByAddress.set(clientAddress, fromAddress + 1);
      let held = 0;
      const budget = (bytes: number) => {
        const ours = bufferedByWorkspace.get(workspaceId) ?? 0;
        if (buffered + bytes > MAX_BUFFERED_BYTES) return false;
        if (ours + bytes > MAX_WORKSPACE_BUFFERED_BYTES) return false;
        buffered += bytes;
        bufferedByWorkspace.set(workspaceId, ours + bytes);
        held += bytes;
        return true;
      };
      try {
        const bytes = await readBody(request, budget, readIdleMs);
        if (typeof bytes === "string") return { refused: bytes };
        return await keep(bytes, workspaceId, commit, filename);
      } finally {
        const uploads = (uploadsByAddress.get(clientAddress) ?? 1) - 1;
        if (uploads > 0) uploadsByAddress.set(clientAddress, uploads);
        else uploadsByAddress.delete(clientAddress);
        buffered -= held;
        const remaining = (bufferedByWorkspace.get(workspaceId) ?? 0) - held;
        if (remaining > 0) bufferedByWorkspace.set(workspaceId, remaining);
        else bufferedByWorkspace.delete(workspaceId);
      }
    },
    url(workspaceId, attachmentId) {
      // The same for URL_BUCKET_SECONDS, so the browser's cache serves an image it already has.
      // Each URL still lives at least URL_LIFETIME_SECONDS from when it is handed out.
      const bucket = Math.floor(now() / 1000 / URL_BUCKET_SECONDS) * URL_BUCKET_SECONDS;
      const expires = String(bucket + URL_BUCKET_SECONDS + URL_LIFETIME_SECONDS);
      const signature = sign(workspaceId, attachmentId, expires);
      const base = filesOrigin ?? publicUrl.replace(/\/$/, "");
      return `${base}/v1/files/${workspaceId}/${attachmentId}?expires=${expires}&signature=${signature}`;
    },
    verify(workspaceId, attachmentId, expires, signature) {
      if (!/^\d{1,12}$/.test(expires) || Number(expires) < now() / 1000) return false;
      const expected = Buffer.from(sign(workspaceId, attachmentId, expires));
      const given = Buffer.from(signature);
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}

/** Reads the body up to the limit, counting each chunk against the shared budget. */
async function readBody(
  request: Request,
  budget: (bytes: number) => boolean,
  idleMs: number,
): Promise<Uint8Array | Refusal> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_FILE_BYTES) return "too_large";
  const reader = request.body?.getReader();
  if (reader === undefined) return "not_an_image";
  const startedAt = Date.now();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    let lastProgressAt = startedAt;
    let sinceProgress = 0;
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), idleMs);
      });
      // The timer is cleared each time, or the race would keep every chunk alive until it fired.
      const next = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      const now = Date.now();
      if (next === "stalled" || now - startedAt > READ_TOTAL_MS) return "too_slow";
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_FILE_BYTES) return "too_large";
      if (!budget(next.value.byteLength)) return "busy";
      chunks.push(next.value);
      sinceProgress += next.value.byteLength;
      if (sinceProgress >= READ_PROGRESS_BYTES) {
        sinceProgress = 0;
        lastProgressAt = now;
      } else if (now - lastProgressAt > idleMs) {
        return "too_slow";
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

const REFUSALS: Record<Refusal, { status: 400 | 408 | 413 | 503 | 507; message: string }> = {
  not_an_image: { status: 400, message: "Send a PNG, JPEG or WebP image." },
  type_not_allowed: {
    status: 400,
    message: `Send a PNG, JPEG or WebP image, or a file of one of these types: ${FILE_TYPES_TEXT}.`,
  },
  too_many_pixels: { status: 400, message: "This image is over 16 megapixels." },
  too_large: { status: 413, message: "An image can be up to 5 MB, and another file up to 10 MB." },
  too_slow: { status: 408, message: "The upload took too long." },
  busy: { status: 503, message: "Too many uploads at once. Try again." },
  storage_full: { status: 507, message: "This workspace has no room for more images or files." },
};

export function refuseUpload(c: Context, refusal: Refusal) {
  const { status, message } = REFUSALS[refusal];
  if (refusal === "busy") c.header("retry-after", "1");
  // biome-ignore lint/suspicious/noExplicitAny: the routes declare these statuses.
  return c.json(failure(refusal, message), status) as any;
}

/** The routes that the image origin serves: uploads, and the logos and pictures of public-images.ts. */
const FILES_HOST_PATH = /^\/v1\/(files\/[^/]+\/[^/]+|widget\/[^/]+\/logo|pictures\/[^/]+)$/;

/** The only types the route shows in place. An HTML or SVG body never goes out, whatever is stored. */
const SERVED_TYPES = new Set<string>(Object.values(OUTPUT));

const ImageAttachmentSchema = z
  .object({ type: z.literal("image"), url: z.string(), width: z.number(), height: z.number() })
  .openapi("ImageAttachment");

const FileAttachmentSchema = z
  .object({
    type: z.literal("file"),
    // A download, never shown in place.
    url: z.string(),
    // Cleaned to letters, digits and a few marks, up to 100 characters.
    name: z.string(),
    // In bytes.
    size: z.number(),
  })
  .openapi("FileAttachment");

// Deleted after 12 months, on Dinghy Cloud.
const RemovedAttachmentSchema = z
  .object({ type: z.enum(["image", "file"]), removed: z.literal(true) })
  .openapi("RemovedAttachment");

/** A message's image or file, or what is left of one that was removed. */
export const AttachmentSchema = z
  .union([ImageAttachmentSchema, FileAttachmentSchema, RemovedAttachmentSchema])
  .openapi("Attachment");

/** The attachment as the API shows it, with a signed URL in place of its stored ID. */
export function attachmentView(
  uploads: Uploads | undefined,
  workspaceId: string,
  attachment: StoredAttachment | null,
) {
  if (attachment === null || "removed" in attachment) return attachment;
  if (uploads === undefined) return null;
  const { attachmentId, ...shown } = attachment;
  return { ...shown, url: uploads.url(workspaceId, attachmentId) };
}

const STORE_FAILED = failure("busy", "The file could not be read. Try again.");

/**
 * Serves an image or a file to anyone with a current signed URL, because an <img> or a download
 * link cannot send a bearer token. Only a client that could read the message gets the URL, and it
 * expires in 15 minutes. A file only ever goes out as a download, so it never runs in a browser.
 *
 * With a separate image origin, that origin serves this route and the public images and nothing else,
 * and the app's origin does not serve them. Register this before every other route.
 */
export function registerUploadFiles(app: App, db: Database, uploads: Uploads, logger: Logger) {
  const uuid = z.uuid();
  const filesHost = uploads.origin === undefined ? undefined : new URL(uploads.origin).host;
  const onFilesHost = (url: string) => new URL(url).host === filesHost;
  if (filesHost !== undefined) {
    app.use("*", async (c, next) => {
      const isFile = FILES_HOST_PATH.test(c.req.path);
      if (
        onFilesHost(c.req.url) &&
        !(isFile && (c.req.method === "GET" || c.req.method === "HEAD"))
      ) {
        return c.json(NOT_FOUND, 404);
      }
      await next();
    });
  }
  // The apps read a file to save it. The signed URL is the only key, and no cookie goes along. Every
  // answer has it, a 404 too, so a page on another origin can tell an expired URL from a failure.
  app.use("/v1/files/*", async (c, next) => {
    await next();
    c.res.headers.set("access-control-allow-origin", "*");
  });
  app.get("/v1/files/:workspaceId/:attachmentId", async (c) => {
    if (filesHost !== undefined && !onFilesHost(c.req.url)) return c.json(NOT_FOUND, 404);
    const { workspaceId, attachmentId } = c.req.param();
    const expires = c.req.query("expires") ?? "";
    const signature = c.req.query("signature") ?? "";
    if (
      !uuid.safeParse(workspaceId).success ||
      !uuid.safeParse(attachmentId).success ||
      !uploads.verify(workspaceId, attachmentId, expires, signature)
    ) {
      return c.json(NOT_FOUND, 404);
    }
    const [row] = await withWorkspace(db, workspaceId, (tx) =>
      tx
        .select({
          storageKey: attachment.storageKey,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          filename: attachment.filename,
        })
        .from(attachment)
        .where(and(eq(attachment.workspaceId, workspaceId), eq(attachment.id, attachmentId))),
    );
    if (row === undefined) return c.json(NOT_FOUND, 404);
    const shown =
      row.filename !== null
        ? { "content-type": FILE_TYPE, "content-disposition": downloadDisposition(row.filename) }
        : SERVED_TYPES.has(row.contentType)
          ? { "content-type": row.contentType, "content-disposition": "inline" }
          : null;
    if (shown === null) return c.json(NOT_FOUND, 404);
    const headers = {
      ...shown,
      "content-length": String(row.byteSize),
      "cache-control": "private, max-age=600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
    };
    // Before opening the file, because Hono drops a HEAD response's body without closing it.
    if (c.req.method === "HEAD") return c.body(null, 200, headers);
    // A stream, so slow readers of a large file cannot hold it in memory many times over.
    const contents = await uploads.store.get(row.storageKey).catch((error: unknown) => {
      logger.error(safeErrorFields(error), "could not read an image or a file");
      return undefined;
    });
    // A failed read is not an expired URL, so an app does not ask for new ones and save it later.
    if (contents === undefined) return c.json(STORE_FAILED, 503);
    if (contents === null) return c.json(NOT_FOUND, 404);
    return c.body(contents, 200, headers);
  });
}
