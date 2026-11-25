import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { createRoute, z } from "@hono/zod-openapi";
import { firstBareLink } from "../../../packages/widget/src/markdown.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { MEMBER_WRITE_ERRORS, NOT_FOUND } from "./errors.ts";
import { sha256Hex } from "./identity.ts";
import { conversationParams, OPEN_TO_WELCOME, WORKSPACE_PREFIX as PREFIX } from "./member.ts";
import { findConversation, type StoredLink } from "./messages.ts";
import type { RateLimit } from "./rate-limit.ts";
import {
  imageFormat,
  MAX_BYTES,
  processThumbnail,
  THUMBNAIL_SIZE_PX,
  type Uploads,
} from "./uploads.ts";
import { guardedLookup, hasPrivateLiteral, PUBLIC_ONLY } from "./webhooks.ts";

/** One deadline for a page and its image, DNS and TLS included. */
const FETCH_DEADLINE_MS = 5000;
const MAX_REDIRECTS = 3;
/** A page's head is read and parsed up to this size, so a large page costs little. */
const PAGE_MAX_BYTES = 64 * 1024;
const TITLE_MAX = 200;
/** The fetches one server process runs at once. */
const MAX_FETCHES = 4;
const PREVIEWS_PER_MINUTE = 30;
/** A larger thumbnail goes without, so a reply that sends it back stays small. */
const THUMBNAIL_MAX_BYTES = 24 * 1024;
const TOKEN_MAX = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; DinghyBot/1.0; +https://dinghy.chat)";
const PAGE_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const IMAGE_DATA_PREFIX = "data:image/webp;base64,";
const IMAGE_DATA_MAX = IMAGE_DATA_PREFIX.length + Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4;
/** What `linkPreview` adds to a reply's JSON at most: its token, its image and their keys. */
export const SENT_PREVIEW_MAX_BYTES = TOKEN_MAX + IMAGE_DATA_MAX + 64;

/** Where a fetch connects. Only tests change it, to reach their own server. */
export interface PreviewNetwork {
  lookup: LookupFunction;
  port?: number;
}

/** A page's card as the fetch found it, before it is signed. */
interface FetchedPreview {
  url: string;
  title: string;
  /** The thumbnail, as WebP. */
  image: Buffer | null;
}

const mayFetch = (url: URL) =>
  (url.protocol === "http:" || url.protocol === "https:") &&
  url.port === "" &&
  url.username === "" &&
  url.password === "" &&
  !hasPrivateLiteral(url);

function get(url: URL, network: PreviewNetwork, signal: AbortSignal): Promise<IncomingMessage> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    send(
      url,
      {
        lookup: network.lookup,
        ...(network.port !== undefined && { port: network.port }),
        signal,
        // An answer compressed by the sender could expand far past the limits below.
        headers: { "user-agent": USER_AGENT, "accept-encoding": "identity" },
      },
      resolve,
    )
      .on("error", reject)
      .end();
  });
}

/** The answer at `start`, after at most 3 redirects, each checked as the first address is. */
async function open(start: URL, network: PreviewNetwork, signal: AbortSignal) {
  let url = start;
  for (let redirects = 0; mayFetch(url); redirects += 1) {
    const response = await get(url, network, signal);
    const status = response.statusCode ?? 0;
    const encoding = response.headers["content-encoding"] ?? "identity";
    if (status === 200 && encoding === "identity") return { response, url };
    response.destroy();
    const location = response.headers.location;
    if (status < 300 || status >= 400 || location === undefined) return null;
    if (redirects === MAX_REDIRECTS || !URL.canParse(location, url)) return null;
    url = new URL(location, url);
  }
  return null;
}

/**
 * Reads at most `maxBytes`, or up to `stopAt`, then drops the connection. `complete` is false when
 * the body was longer.
 */
async function readUpTo(response: IncomingMessage, maxBytes: number, stopAt?: string) {
  const parts: Buffer[] = [];
  let size = 0;
  let tail = "";
  try {
    for await (const part of response as AsyncIterable<Buffer>) {
      parts.push(part);
      size += part.length;
      if (size > maxBytes) {
        return { bytes: Buffer.concat(parts).subarray(0, maxBytes), complete: false };
      }
      if (stopAt !== undefined) {
        const seen = (tail + part.toString("latin1")).toLowerCase();
        if (seen.includes(stopAt)) break;
        tail = seen.slice(-stopAt.length);
      }
    }
    return { bytes: Buffer.concat(parts), complete: true };
  } finally {
    response.destroy();
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const ENTITY = /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,6}));/gi;

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number(decimal);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : "�";
  });
}

// Control characters, and the marks that change the direction of text, so a title cannot reorder
// the card around it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are what it removes
const HIDDEN = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

function cleanTitle(raw: string): string {
  const title = decodeEntities(raw).replace(/\s+/g, " ").replace(HIDDEN, "").trim();
  return Array.from(title).slice(0, TITLE_MAX).join("").trim();
}

const SPACES = new Set([" ", "\t", "\n", "\r", "\f"]);
const isSpace = (char: string) => SPACES.has(char);

/** The position of the first character from `from` that passes `stop`, or the end. */
function scanTo(html: string, from: number, stop: (char: string) => boolean) {
  let at = from;
  while (at < html.length && !stop(html.charAt(at))) at += 1;
  return at;
}

/** An attribute's value from `start`, quoted or not. Null when the input cuts off its quote. */
function readValue(html: string, start: number) {
  const quote = html.charAt(start);
  if (quote === '"' || quote === "'") {
    const close = html.indexOf(quote, start + 1);
    return close === -1 ? null : { value: html.slice(start + 1, close), end: close + 1 };
  }
  const end = scanTo(html, start, (char) => isSpace(char) || char === ">");
  return { value: html.slice(start, end), end };
}

/**
 * The tag that opens at `start`, read forward once, so no input makes it backtrack. A quoted value
 * may hold a ">". Null for a tag that the input cuts off.
 */
function readTag(html: string, start: number) {
  const nameEnd = scanTo(html, start + 1, (char) => isSpace(char) || char === "/" || char === ">");
  const name = html.slice(start + 1, nameEnd).toLowerCase();
  const attributes = new Map<string, string>();
  let at = nameEnd;
  for (;;) {
    at = scanTo(html, at, (char) => !isSpace(char) && char !== "/");
    if (at === html.length) return null;
    if (html.charAt(at) === ">") return { name, attributes, end: at + 1 };
    const keyStart = at;
    at = scanTo(html, at + 1, (char) => isSpace(char) || "/>=".includes(char));
    const key = html.slice(keyStart, at).toLowerCase();
    at = scanTo(html, at, (char) => !isSpace(char));
    let value = "";
    if (html.charAt(at) === "=") {
      const read = readValue(
        html,
        scanTo(html, at + 1, (char) => !isSpace(char)),
      );
      if (read === null) return null;
      ({ value, end: at } = read);
    }
    if (!attributes.has(key)) attributes.set(key, value);
  }
}

/** The charset that a Content-Type value names, such as `text/html; charset=utf-8`. */
function charsetOf(contentType: string | undefined) {
  const parameter = contentType
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("charset="));
  return parameter?.slice("charset=".length).replace(/["']/g, "").trim() || undefined;
}

/**
 * The first value of each meta tag, the first title and the declared charset, in one forward pass.
 * A comment hides what it holds, and a title runs to its `</title>`, or to the end.
 */
function scanHead(html: string) {
  const meta = new Map<string, string>();
  let title: string | undefined;
  let charset: string | undefined;
  for (let at = html.indexOf("<"); at !== -1; ) {
    let next = at + 1;
    if (html.startsWith("<!--", at)) {
      const close = html.indexOf("-->", at + 4);
      if (close === -1) break;
      next = close + 3;
    } else if (/^[a-z]$/i.test(html.charAt(at + 1))) {
      const tag = readTag(html, at);
      if (tag === null) break;
      next = tag.end;
      const { attributes } = tag;
      if (tag.name === "title" && title === undefined) {
        const closing = /<\/title/gi;
        closing.lastIndex = tag.end;
        next = closing.exec(html)?.index ?? html.length;
        title = html.slice(tag.end, next);
      } else if (tag.name === "meta") {
        const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
        const content = attributes.get("content");
        if (key !== undefined && content !== undefined && !meta.has(key)) meta.set(key, content);
        const isContentType = attributes.get("http-equiv")?.toLowerCase() === "content-type";
        charset ??= attributes.get("charset") ?? (isContentType ? charsetOf(content) : undefined);
      }
    }
    at = html.indexOf("<", next);
  }
  return { meta, title, charset };
}

/** The page's text, in the charset its Content-Type or its meta tags name, else UTF-8. */
function decodePage(bytes: Uint8Array, contentType: string | undefined): string {
  // Latin-1 keeps every byte, so the meta tags read the same in any charset that extends ASCII.
  const charset = charsetOf(contentType) ?? scanHead(Buffer.from(bytes).toString("latin1")).charset;
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    // An unknown charset.
    return new TextDecoder().decode(bytes);
  }
}

/** The page's title and image address, from its Open Graph or Twitter tags, else its <title>. */
export function pageFields(html: string): { title: string | null; image: string | null } {
  const { meta, title: titleTag } = scanHead(html);
  const titles = [meta.get("og:title"), meta.get("twitter:title"), titleTag];
  const title = titles.map((one) => (one === undefined ? "" : cleanTitle(one))).find(Boolean);
  const image = meta.get("og:image") ?? meta.get("twitter:image");
  return {
    title: title ?? null,
    image: image === undefined ? null : decodeEntities(image).trim(),
  };
}

/** The page's image as a WebP thumbnail, through the same checks as the page. */
async function thumbnail(source: string, base: URL, network: PreviewNetwork, signal: AbortSignal) {
  if (!URL.canParse(source, base)) return null;
  const opened = await open(new URL(source, base), network, signal);
  if (opened === null) return null;
  const { bytes, complete } = await readUpTo(opened.response, MAX_BYTES);
  if (!complete || imageFormat(bytes) === null) return null;
  const done = await processThumbnail(bytes);
  return typeof done === "string" || done.byteLength > THUMBNAIL_MAX_BYTES ? null : done;
}

/** The card for a link, or null when the page cannot be read or has no title. */
export async function fetchPreview(
  url: string,
  network: PreviewNetwork = { lookup: guardedLookup(PUBLIC_ONLY) },
): Promise<FetchedPreview | null> {
  if (!URL.canParse(url)) return null;
  const signal = AbortSignal.timeout(FETCH_DEADLINE_MS);
  try {
    const page = await open(new URL(url), network, signal);
    if (page === null) return null;
    const type = page.response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (type === undefined || !PAGE_TYPES.has(type)) {
      page.response.destroy();
      return null;
    }
    const { bytes } = await readUpTo(page.response, PAGE_MAX_BYTES, "</head>");
    const fields = pageFields(decodePage(bytes, page.response.headers["content-type"]));
    if (fields.title === null) return null;
    const image =
      fields.image === null
        ? null
        : await thumbnail(fields.image, page.url, network, signal).catch(() => null);
    return { url, title: fields.title, image };
  } catch {
    // A refused address, a timeout or a broken connection: the link gets no card.
    return null;
  }
}

/** What a token holds. The server keeps nothing between the preview and the reply. */
interface TokenFields {
  url: string;
  title: string;
  /** The SHA-256 of the thumbnail's bytes. */
  image: string | null;
}

function signedPreview(uploads: Uploads, workspaceId: string, preview: FetchedPreview) {
  const { url, title, image } = preview;
  const fields: TokenFields = { url, title, image: image && sha256Hex(image) };
  const payload = Buffer.from(JSON.stringify(fields)).toString("base64url");
  return {
    url,
    title,
    image: image && {
      data: `${IMAGE_DATA_PREFIX}${image.toString("base64")}`,
      width: THUMBNAIL_SIZE_PX,
      height: THUMBNAIL_SIZE_PX,
    },
    token: `${payload}.${uploads.signPreview(`${workspaceId}.${payload}`)}`,
  };
}

/** The card that a reply sends back, as the preview route gave it. */
export const SentPreview = z
  .object({
    token: z.string().max(TOKEN_MAX),
    // The preview's `image.data`, or null.
    image: z.string().max(IMAGE_DATA_MAX).nullable(),
  })
  .openapi("SentLinkPreview");

/**
 * The card a reply carries, when its token holds, its image is the one that was signed, and its
 * link is still the body's first bare link. Null sends the reply without one. The token binds the
 * workspace, the link and the image, so it needs no expiry.
 */
export function previewFromToken(
  uploads: Uploads,
  workspaceId: string,
  body: string,
  sent: z.infer<typeof SentPreview>,
): FetchedPreview | null {
  const [payload = "", signature = ""] = sent.token.split(".");
  if (!uploads.verifyPreview(`${workspaceId}.${payload}`, signature)) return null;
  const fields = JSON.parse(Buffer.from(payload, "base64url").toString()) as TokenFields;
  if (firstBareLink(body) !== fields.url) return null;
  const image = sent.image?.startsWith(IMAGE_DATA_PREFIX)
    ? Buffer.from(sent.image.slice(IMAGE_DATA_PREFIX.length), "base64")
    : null;
  if ((image && sha256Hex(image)) !== fields.image) return null;
  return { url: fields.url, title: fields.title, image };
}

/** A reply's link card, which the operator app and the widget show under its text. */
export const LinkSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    image: z.object({ url: z.string(), width: z.number(), height: z.number() }).nullable(),
  })
  .openapi("LinkCard");

/** The card as the apps show it, with a signed URL in place of its thumbnail's stored ID. */
export function linkView(
  uploads: Uploads | undefined,
  workspaceId: string,
  link: StoredLink | null,
) {
  if (link === null) return null;
  const { image, ...shown } = link;
  return {
    ...shown,
    image:
      image === null || uploads === undefined
        ? null
        : {
            url: uploads.url(workspaceId, image.attachmentId),
            width: image.width,
            height: image.height,
          },
  };
}

const previewRoute = createRoute({
  method: "post",
  ...OPEN_TO_WELCOME,
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/link-preview`,
  security: SESSION,
  summary: "Preview a link for a reply: the page's title and a thumbnail",
  description:
    "The server fetches the page. `preview` is null when the page has no title, cannot be read, or the workspace asked for more than 30 previews this minute. Send `token` and `image.data` back with the reply as `linkPreview` to show the card under it.",
  request: {
    params: conversationParams,
    body: {
      required: true,
      content: {
        "application/json": { schema: z.object({ url: z.string().max(2000) }) },
      },
    },
  },
  responses: {
    200: {
      description: "The card, or null",
      content: {
        "application/json": {
          schema: z.object({
            preview: z
              .object({
                url: z.string(),
                title: z.string(),
                image: z
                  .object({ data: z.string(), width: z.number(), height: z.number() })
                  .nullable(),
                token: z.string(),
              })
              .nullable(),
          }),
        },
      },
    },
    ...MEMBER_WRITE_ERRORS,
  },
});

export function registerLinkPreviewRoute(
  app: App,
  {
    db,
    uploads,
    rateLimit,
    network,
  }: { db: Database; uploads: Uploads; rateLimit: RateLimit; network?: PreviewNetwork | undefined },
) {
  let fetching = 0;
  app.openapi(previewRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    // Over a limit, the link gets no card, which is not an error. The slot is taken before the
    // first await, so requests that arrive together cannot all pass the check.
    if (fetching >= MAX_FETCHES) return c.json({ preview: null }, 200);
    fetching += 1;
    try {
      const found = await withWorkspace(db, id, (tx) => findConversation(tx, id, conversationId));
      if (found === null) return c.json(NOT_FOUND, 404);
      if ((await rateLimit.hit("link-preview", id, PREVIEWS_PER_MINUTE, 60)) !== null) {
        return c.json({ preview: null }, 200);
      }
      const fetched = await fetchPreview(c.req.valid("json").url, network);
      return c.json({ preview: fetched && signedPreview(uploads, id, fetched) }, 200);
    } finally {
      fetching -= 1;
    }
  });
}
