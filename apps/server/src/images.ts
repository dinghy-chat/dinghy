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
import { StorageFullError } from "./limits.ts";
import type { NewImage, StoredMessage } from "./messages.ts";
import type { ObjectStore } from "./storage.ts";

/** Whether a database call failed with its outcome unknown, because the connection went away. */
function lostConnection(error: unknown): boolean {
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
const MAX_PIXELS = 16_000_000;
/**
 * The bytes one instance holds in uploads at once. It counts bytes and not connections, because a
 * stalled connection holds almost nothing and must not block anyone else's image.
 */
const MAX_BUFFERED_BYTES = 8 * MAX_BYTES;
/** One workspace's share of that, so one workspace's visitors cannot block every other's. */
const MAX_WORKSPACE_BUFFERED_BYTES = 2 * MAX_BYTES;
/**
 * The images waiting to decode. The byte budget cannot limit this, because a tiny file can decode
 * to 16 megapixels, and they would otherwise queue up behind each other for minutes.
 */
const MAX_WAITING_TO_DECODE = 4;
export const MAX_UPLOADS_PER_ADDRESS = 3;
// A slow phone can take minutes over 5 MB, but it keeps sending. Progress is what counts, or one
// byte every so often would hold the budget for the whole of READ_TOTAL_MS.
const READ_IDLE_MS = 30_000;
const READ_PROGRESS_BYTES = 64 * 1024;
const READ_TOTAL_MS = 5 * 60_000;
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
  | "too_many_pixels"
  | "too_large"
  | "busy"
  | "too_slow"
  | "storage_full";

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, i) => bytes[at + i] === byte);

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

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_SIZE_PX = 256;
export const LOGO_TYPE = OUTPUT.webp;
export const LOGO_TOO_LARGE = failure("too_large", "This logo is over 2 MB.");

/** Checks a logo, then shrinks it to fit a 256-pixel square and encodes it as WebP. */
export async function processLogo(bytes: Uint8Array): Promise<Buffer | Refusal> {
  const done = await inTurn(() =>
    reencode(bytes, (image) =>
      image.resize(LOGO_SIZE_PX, LOGO_SIZE_PX, { fit: "inside", withoutEnlargement: true }).webp(),
    ),
  );
  return typeof done === "string" ? done : done.data;
}

export interface Images {
  /**
   * Reads, checks and stores an image, then hands it to `commit`. The object stays if `commit`
   * created a message, and goes away if it did not, as on a retry, or if `commit` failed.
   */
  receive<T extends { created: boolean }>(
    request: Request,
    workspaceId: string,
    commit: (image: NewImage) => Promise<T>,
    clientAddress: string,
  ): Promise<{ result: T } | { refused: Refusal }>;
  url(workspaceId: string, attachmentId: string): string;
  verify(workspaceId: string, attachmentId: string, expires: string, signature: string): boolean;
  store: ObjectStore;
  /** The separate origin that serves images, from IMAGES_ORIGIN, or undefined to use the app's. */
  origin: string | undefined;
}

interface ImagesOptions {
  store: ObjectStore;
  secret: string;
  publicUrl: string;
  /**
   * A separate origin for user images, such as https://files.example.com. Image URLs then use it,
   * and the image route answers only there, so a file can never run in the app's origin.
   */
  origin?: string | undefined;
  readIdleMs?: number;
  /** The clock that URLs expire by, which a browser test moves forward. */
  now?: () => number;
}

export function createImages({
  store,
  secret,
  publicUrl,
  origin,
  readIdleMs = READ_IDLE_MS,
  now = () => Date.now(),
}: ImagesOptions): Images {
  const filesOrigin = origin === undefined ? undefined : new URL(origin).origin;
  let buffered = 0;
  let waitingToDecode = 0;
  const bufferedByWorkspace = new Map<string, number>();
  const uploadsByAddress = new Map<string, number>();

  const sign = (workspaceId: string, attachmentId: string, expires: string) =>
    createHmac("sha256", `dinghy-image-url:${secret}`)
      .update(`${workspaceId}/${attachmentId}/${expires}`)
      .digest("base64url");

  return {
    store,
    origin: filesOrigin,
    async receive(request, workspaceId, commit, clientAddress) {
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
        if (waitingToDecode >= MAX_WAITING_TO_DECODE) return { refused: "busy" };
        waitingToDecode += 1;
        const processed = await inTurn(() => processImage(bytes)).finally(() => {
          waitingToDecode -= 1;
        });
        if (typeof processed === "string") return { refused: processed };

        const attachmentId = randomUUID();
        const storageKey = `${workspaceId}/${attachmentId}`;
        await store.put(storageKey, processed.data, processed.contentType);
        const discard = () => store.delete(storageKey).catch(() => undefined);
        const result = await commit({
          attachmentId,
          storageKey,
          byteSize: processed.data.byteLength,
          contentType: processed.contentType,
          width: processed.width,
          height: processed.height,
        }).catch(async (error: unknown) => {
          // A failed commit frees the object, or one stored as its workspace was purged would stay
          // in the store for good. A lost connection is the exception: the commit may have
          // landed, and a retry then returns that message, so its image must stay.
          if (!lostConnection(error)) await discard();
          // Over the plan's storage, found under the workspace lock: a refusal like the others.
          if (error instanceof StorageFullError) return null;
          throw error;
        });
        if (result === null) return { refused: "storage_full" };
        if (!result.created) await discard();
        return { result };
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
  if (declared > MAX_BYTES) return "too_large";
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
      if (total > MAX_BYTES) return "too_large";
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
  too_many_pixels: { status: 400, message: "This image is over 16 megapixels." },
  too_large: { status: 413, message: "This image is over 5 MB." },
  too_slow: { status: 408, message: "The upload took too long." },
  busy: { status: 503, message: "Too many images at once. Try again." },
  storage_full: { status: 507, message: "This workspace has no room for more images." },
};

export function refuseImage(c: Context, refusal: Refusal) {
  const { status, message } = REFUSALS[refusal];
  if (refusal === "busy") c.header("retry-after", "1");
  // biome-ignore lint/suspicious/noExplicitAny: the routes declare these statuses.
  return c.json(failure(refusal, message), status) as any;
}

/** The routes that the image origin serves: images, and the logos that logo.ts serves. */
const FILES_HOST_PATH = /^\/v1\/(files\/[^/]+\/[^/]+|widget\/[^/]+\/logo)$/;

/** The only types the image route serves. An HTML or SVG body never goes out, whatever is stored. */
const SERVED_TYPES = new Set<string>(Object.values(OUTPUT));

export const ImageSchema = z
  .object({ url: z.string(), width: z.number(), height: z.number() })
  .openapi("Image");

export function imageView(
  images: Images | undefined,
  workspaceId: string,
  image: StoredMessage["image"],
) {
  if (image === null || images === undefined) return null;
  return {
    url: images.url(workspaceId, image.attachmentId),
    width: image.width,
    height: image.height,
  };
}

/**
 * Serves an image to anyone with a current signed URL, because an <img> cannot send a bearer token.
 * Only a client that could read the message gets the URL, and it expires in 15 minutes.
 *
 * With a separate image origin, that origin serves this route and the logo route and nothing else,
 * and the app's origin does not serve them. Register this before every other route.
 */
export function registerImageFiles(app: App, db: Database, images: Images, logger: Logger) {
  const uuid = z.uuid();
  const filesHost = images.origin === undefined ? undefined : new URL(images.origin).host;
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
  app.get("/v1/files/:workspaceId/:attachmentId", async (c) => {
    if (filesHost !== undefined && !onFilesHost(c.req.url)) return c.json(NOT_FOUND, 404);
    const { workspaceId, attachmentId } = c.req.param();
    const expires = c.req.query("expires") ?? "";
    const signature = c.req.query("signature") ?? "";
    if (
      !uuid.safeParse(workspaceId).success ||
      !uuid.safeParse(attachmentId).success ||
      !images.verify(workspaceId, attachmentId, expires, signature)
    ) {
      return c.json(NOT_FOUND, 404);
    }
    const [row] = await withWorkspace(db, workspaceId, (tx) =>
      tx
        .select({
          storageKey: attachment.storageKey,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
        })
        .from(attachment)
        .where(and(eq(attachment.workspaceId, workspaceId), eq(attachment.id, attachmentId))),
    );
    if (row === undefined || !SERVED_TYPES.has(row.contentType)) return c.json(NOT_FOUND, 404);
    const headers = {
      "content-type": row.contentType,
      "content-length": String(row.byteSize),
      "cache-control": "private, max-age=600",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
    };
    // Before opening the file, because Hono drops a HEAD response's body without closing it.
    if (c.req.method === "HEAD") return c.body(null, 200, headers);
    // A stream, so slow readers of a large image cannot hold it in memory many times over.
    const contents = await images.store.get(row.storageKey).catch((error: unknown) => {
      logger.error(safeErrorFields(error), "could not read an image");
      return null;
    });
    if (contents === null) return c.json(NOT_FOUND, 404);
    return c.body(contents, 200, headers);
  });
}
