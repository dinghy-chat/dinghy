import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import PostalMime, { type Address, type Attachment, type Email } from "postal-mime";
import { MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import type { App } from "./app.ts";
import { asUuid } from "./chat-link.ts";
import { conversation, replyAddress, visitor, widgetSettings } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { errorAnswer, failure, NOT_FOUND } from "./errors.ts";
import { sha256Hex } from "./identity.ts";
import type { Images } from "./images.ts";
import type { Limits } from "./limits.ts";
import { type Signals, wakeConversation } from "./live.ts";
import {
  appendMessage,
  catchClosed,
  type MessageSource,
  type NewAttachment,
  WorkspaceClosedError,
} from "./messages.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { SIGNATURE_TOLERANCE_SECONDS } from "./setup-code.ts";
import { HOUR_SECONDS } from "./time.ts";
import { REPLY_MARKERS, visitorWords } from "./visitor-words.ts";
import { signature } from "./webhooks.ts";

/** The settings for replies by email. */
export interface InboundEmail {
  /** The domain of reply addresses, whose mail reaches this server. */
  domain: string;
  /** Signs each email the forwarder posts. */
  secret: string;
}

const PATH = "/v1/inbound-email";
const REPLY_ADDRESS_DAYS = 90;
const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
/** A signature logo is smaller; a pasted screenshot is larger. */
const INLINE_IMAGE_MIN_BYTES = 16 * 1024;
/** The text goes in as at most this many messages, so one email cannot fill a conversation. */
const MAX_TEXT_PARTS = 10;
/** How far back from a part's end a paragraph or line break may be to end the part there. */
const BREAK_SEARCH_CHARS = 1000;
const MESSAGES_PER_ADDRESS_PER_HOUR = 20;
/** Emails this process holds at once, each up to 25 MB, so many cannot fill its memory. */
const EMAILS_AT_ONCE = 4;
const SIGNATURE_HEADER = "dinghy-inbound-signature";

// The local part may hold 64 characters: "reply+", the workspace in hex, a dot, and 128 random bits
// in base 36, which a mail system that changes the case cannot change.
const ADDRESS = /^reply\+([0-9a-f]{32})\.([0-9a-z]{25})@(.+)$/;
const TOKEN_LENGTH = 25;

// The subjects of out-of-office answers in common mail apps, in a few languages.
const OUT_OF_OFFICE =
  /^\s*(auto(matic)?[ -]?(reply|response)|out of (the )?office|réponse automatique|absen(t|ce)\b|respuesta automática|fuera de la oficina|automatische antwort|abwesenheit)/i;

/** Makes the Reply-To address of an email to a visitor, in the caller's workspace transaction. */
export async function createReplyAddress(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  conversationId: string,
  domain: string,
): Promise<string> {
  const token = BigInt(`0x${randomBytes(16).toString("hex")}`)
    .toString(36)
    .padStart(TOKEN_LENGTH, "0");
  await tx
    .insert(replyAddress)
    .values({ workspaceId, tokenHash: sha256Hex(token), visitorId, conversationId });
  return `reply+${workspaceId.replaceAll("-", "")}.${token}@${domain}`;
}

/** Deletes addresses unused for 90 days across workspaces, for the worker. Returns how many went. */
export async function pruneReplyAddresses(db: Database, limit: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM reply_address WHERE (workspace_id, id) IN (
      SELECT workspace_id, id FROM reply_address
      WHERE last_used_at < now() - make_interval(days => ${REPLY_ADDRESS_DAYS}) LIMIT ${limit})`);
  return result.rowCount ?? 0;
}

const unquoted = (line: string) => line.replace(/^[>\s]+/, "").trimEnd();

// The lines that name a quote: Outlook's From:, Sent:, To: and Subject: in any language, and the
// rule of underscores or dashes above them.
const HEADER_LINE = /^[\p{L} -]{1,20} ?: /u;
const RULE_LINE = /^(_{5,}|-{3,}.*-{3,})$/;

/** The block above a quote names it, such as "On Monday, Acme wrote:", or Outlook's headers. */
const isAttribution = (block: string[]) =>
  block.at(-1)?.endsWith(":") === true ||
  block.every((line) => HEADER_LINE.test(line) || RULE_LINE.test(line));

/**
 * What the visitor wrote: the text above the quote of Dinghy's email. The quote starts at the
 * marker, as a whole line once quote marks go, and the block of lines just above it goes too when
 * it names the quote. Without the marker the whole text stays. Signatures stay too, because no
 * rule finds them without sometimes cutting what people wrote.
 */
export function replyText(text: string): string {
  const original = text.replace(/\r\n?/g, "\n").split("\n");
  const lines = original.map(unquoted);
  const marker = lines.findIndex((line) => REPLY_MARKERS.includes(line.trim()));
  if (marker === -1) return text.trim();
  let cut = marker;
  while (cut > 0 && lines[cut - 1]?.trim() === "") cut -= 1;
  let block = cut;
  while (block > 0 && lines[block - 1]?.trim() !== "") block -= 1;
  if (block < cut && isAttribution(lines.slice(block, cut))) cut = block;
  return original.slice(0, cut).join("\n").trim();
}

// Tags whose contents are no text, and the tags that end a line: a break and a block's end.
const HIDDEN_TAGS = new Set(["head", "style", "script", "title"]);
const LINE_TAGS = /^(br|\/(p|div|li|tr|table|blockquote|h[1-6]))$/;
// HTML's named entities for Latin-1, in code point order from U+00A0, so French, Spanish and
// German text decodes. Postal-mime has a full table but does not export it.
const LATIN_1 = `
  nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn
  sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave
  Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml
  ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN
  szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave
  iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute
  ucirc uuml yacute thorn yuml`
  .trim()
  .split(/\s+/);
const ENTITIES = new Map<string, string>([
  ...LATIN_1.map((name, index): [string, string] => [name, String.fromCodePoint(0xa0 + index)]),
  // A plain space in the chat, as mail apps pad with no-break ones.
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["OElig", "Œ"],
  ["oelig", "œ"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["sbquo", "‚"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bdquo", "„"],
  ["hellip", "…"],
  ["bull", "•"],
  ["euro", "€"],
  ["trade", "™"],
]);

/** A numeric entity, decimal or hex, or a named one from the table. Anything else stays. */
const decodeEntity = (whole: string, name: string) => {
  if (!name.startsWith("#")) return ENTITIES.get(name) ?? whole;
  const code = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
};

/**
 * The text of an email with only HTML: tags go, blocks and breaks end lines, entities decode. It
 * walks the HTML once with indexOf, because anyone can send it, and a regular expression over a
 * tag that never closes can take quadratic time.
 */
function htmlText(html: string): string {
  const lower = html.toLowerCase();
  let text = "";
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    text += html.slice(at, open === -1 ? html.length : open).replace(/\s+/g, " ");
    const close = open === -1 ? -1 : html.indexOf(">", open);
    if (close === -1) break;
    const name = /^\/?[a-z0-9]*/.exec(lower.slice(open + 1, Math.min(close, open + 12)))?.[0] ?? "";
    if (LINE_TAGS.test(name)) text += "\n";
    const end = HIDDEN_TAGS.has(name) ? lower.indexOf(`</${name}`, close) : close + 1;
    at = end === -1 ? html.length : end;
  }
  return text
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,7});/gi, decodeEntity)
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** An answer from another mail system's robot, which must not answer it back. */
function isAutoReply(email: Email): boolean {
  const header = (key: string) =>
    email.headers
      .find((one) => one.key === key)
      ?.value.trim()
      .toLowerCase();
  const submitted = header("auto-submitted")?.split(";")[0]?.trim();
  if (submitted !== undefined && submitted !== "no") return true;
  const precedence = header("precedence");
  if (precedence === "bulk" || precedence === "list") return true;
  return OUT_OF_OFFICE.test(email.subject ?? "");
}

const addresses = (list: Address[] | undefined): string[] =>
  (list ?? []).flatMap((one) =>
    one.group === undefined ? one.address : one.group.map((member) => member.address),
  );

/** The workspace and token of the first recipient at the reply domain, or null. */
function replyTarget(email: Email, domain: string) {
  const recipients = [...addresses(email.to), ...addresses(email.cc), email.deliveredTo ?? ""];
  for (const recipient of recipients) {
    const match = ADDRESS.exec(recipient.toLowerCase());
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] === domain) {
      return { workspaceId: asUuid(match[1]), token: match[2] };
    }
  }
  return null;
}

interface Signed {
  time: number;
  digest: Buffer;
}

/** `Dinghy-Inbound-Signature` is `t=<time>,v1=<HMAC-SHA256 of "time.body">`, as webhooks sign. */
function parseSignature(header: string | undefined): Signed | null {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const time = Number(match[1]);
  return Math.abs(Date.now() / 1000 - time) > SIGNATURE_TOLERANCE_SECONDS
    ? null
    : { time, digest: Buffer.from(match[2], "hex") };
}

// The pattern fixes v1 at 32 bytes, so timingSafeEqual never throws on length.
const signatureMatches = (secret: string, signed: Signed, body: Uint8Array) =>
  timingSafeEqual(
    Buffer.from(signature(secret, signed.time, body).split(",v1=")[1] ?? "", "hex"),
    signed.digest,
  );

/** The reply address, if current, with what the message needs to know about its visitor. */
async function findAddress(tx: Transaction, workspaceId: string, token: string) {
  const [found] = await tx
    .select({
      id: replyAddress.id,
      visitorId: replyAddress.visitorId,
      conversationId: replyAddress.conversationId,
      email: visitor.email,
      locale: visitor.locale,
      blocked: sql<boolean>`${visitor.blockedAt} is not null`,
      filesAllowed: sql<boolean>`coalesce(${widgetSettings.visitorFiles}, false)`,
    })
    .from(replyAddress)
    .innerJoin(
      visitor,
      and(
        eq(visitor.workspaceId, replyAddress.workspaceId),
        eq(visitor.id, replyAddress.visitorId),
      ),
    )
    // The conversation must still be the visitor's own.
    .innerJoin(
      conversation,
      and(
        eq(conversation.workspaceId, replyAddress.workspaceId),
        eq(conversation.id, replyAddress.conversationId),
        eq(conversation.visitorId, replyAddress.visitorId),
      ),
    )
    .leftJoin(widgetSettings, eq(widgetSettings.workspaceId, replyAddress.workspaceId))
    .where(
      and(
        eq(replyAddress.workspaceId, workspaceId),
        eq(replyAddress.tokenHash, sha256Hex(token)),
        gt(replyAddress.lastUsedAt, sql`now() - make_interval(days => ${REPLY_ADDRESS_DAYS})`),
      ),
    );
  if (found === undefined) return null;
  await tx
    .update(replyAddress)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(replyAddress.workspaceId, workspaceId), eq(replyAddress.id, found.id)));
  return found;
}

type FoundAddress = NonNullable<Awaited<ReturnType<typeof findAddress>>>;

const OK = { ok: true as const };
const BAD_SIGNATURE = failure("bad_signature", "The signature is missing, stale or wrong.");
const LENGTH_REQUIRED = failure("length_required", "Send the email with a Content-Length.");
const TOO_LARGE = failure(
  "too_large",
  "An email can be up to 25 MB, with up to 100,000 characters of text.",
);
const BUSY = failure("busy", "Too many emails at once. Try again.");
const BLOCKED = failure("blocked", "This visitor cannot send messages.");
const CLOSED = failure("forbidden", "This workspace takes no messages now.");

const inboundEmailRoute = createRoute({
  method: "post",
  path: PATH,
  summary: "Receive a visitor's reply by email, as raw MIME",
  description:
    'For the mail forwarder, and only on a server with `INBOUND_EMAIL_DOMAIN` and `INBOUND_EMAIL_SECRET` set. The body is the email as it arrived, up to 25 MB, with a `Content-Length`. `Dinghy-Inbound-Signature` is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" under INBOUND_EMAIL_SECRET>`, and the time must be within 5 minutes. The email goes to the conversation of its `reply+…` recipient as the visitor\'s messages, with `via: "email"`. Sending it again adds nothing. Answers from robots, such as out-of-office replies, are dropped with a 200.',
  request: {
    body: { content: { "message/rfc822": { schema: z.string() } }, required: true },
  },
  responses: {
    200: {
      description: "Taken, or dropped as an automatic answer",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: errorAnswer("bad_signature: the signature is missing, more than 5 minutes old, or wrong"),
    403: errorAnswer(
      "blocked: the team blocked this visitor. forbidden: the workspace takes no messages now",
    ),
    404: errorAnswer("not_found: no current reply address among the recipients"),
    411: errorAnswer("length_required: the request has no Content-Length"),
    413: errorAnswer(
      "too_large: the email is over 25 MB, or its text is over 100,000 characters (10 messages)",
    ),
    429: errorAnswer("too_many_requests: over 20 emails to this address in an hour"),
    503: errorAnswer("busy: 4 emails are being received, or the image queue is full"),
  },
});

interface InboundOptions {
  db: Database;
  inbound: InboundEmail;
  images: Images | undefined;
  limits: Limits;
  live: Signals;
  rateLimit: RateLimit;
}

/**
 * The route the mail forwarder posts each reply to. It checks the length, the signature's age and
 * the emails it holds before it reads a byte of the body, so no request makes it hold more.
 */
export function registerInboundEmail(app: App, options: InboundOptions): void {
  let held = 0;
  app.openapi(inboundEmailRoute, async (c) => {
    const length = c.req.header("content-length");
    if (length === undefined || !/^\d{1,12}$/.test(length)) return c.json(LENGTH_REQUIRED, 411);
    if (Number(length) > MAX_EMAIL_BYTES) return c.json(TOO_LARGE, 413);
    const signed = parseSignature(c.req.header(SIGNATURE_HEADER));
    if (signed === null) return c.json(BAD_SIGNATURE, 401);
    if (held >= EMAILS_AT_ONCE) {
      c.header("retry-after", "1");
      return c.json(BUSY, 503);
    }
    held += 1;
    try {
      const body = Buffer.from(await c.req.arrayBuffer());
      if (!signatureMatches(options.inbound.secret, signed, body)) {
        return c.json(BAD_SIGNATURE, 401);
      }
      return await receive(c, options, body);
    } finally {
      held -= 1;
    }
  });
}

async function receive(c: Context, options: InboundOptions, body: Buffer) {
  const { db, inbound, rateLimit, live } = options;
  const email = await PostalMime.parse(body);
  if (isAutoReply(email)) return c.json(OK, 200);
  const target = replyTarget(email, inbound.domain);
  if (target === null) return c.json(NOT_FOUND, 404);
  const { workspaceId } = target;
  const address = await withWorkspace(db, workspaceId, (tx) =>
    findAddress(tx, workspaceId, target.token),
  );
  if (address === null) return c.json(NOT_FOUND, 404);
  if (address.blocked) return c.json(BLOCKED, 403);
  const wait = await rateLimit.hit(
    "inbound-email",
    address.id,
    MESSAGES_PER_ADDRESS_PER_HOUR,
    HOUR_SECONDS,
  );
  if (wait !== null) return tooManyRequests(c, wait);
  const outcome = await catchClosed(addMessages(options, workspaceId, address, email, body));
  if (outcome instanceof WorkspaceClosedError) return c.json(CLOSED, 403);
  if (outcome === "too_long") return c.json(TOO_LARGE, 413);
  if (outcome === "busy") {
    c.header("retry-after", "1");
    return c.json(BUSY, 503);
  }
  if (outcome.created) wakeConversation(live, workspaceId, address.visitorId);
  return c.json(OK, 200);
}

/**
 * The end of the part that starts at `start`: a paragraph break near the limit, else a line break,
 * else the limit. Lengths count UTF-16 units, so a part is within MESSAGE_MAX characters too.
 */
function partEnd(text: string, start: number): number {
  const limit = start + MESSAGE_MAX;
  if (limit >= text.length) return text.length;
  const earliest = limit - BREAK_SEARCH_CHARS;
  const paragraph = text.lastIndexOf("\n\n", limit - 2);
  if (paragraph > earliest) return paragraph;
  const line = text.lastIndexOf("\n", limit - 1);
  if (line > earliest) return line;
  // A cut between the halves of a surrogate pair would break the character on both sides.
  return /[\uD800-\uDBFF]/.test(text[limit - 1] ?? "") ? limit - 1 : limit;
}

/** The text as consecutive messages, or null when it needs more than MAX_TEXT_PARTS of them. */
export function textParts(text: string): string[] | null {
  const parts: string[] = [];
  for (let at = 0; at < text.length; ) {
    if (parts.length === MAX_TEXT_PARTS) return null;
    const end = partEnd(text, at);
    const part = text.slice(at, end).trim();
    if (part !== "") parts.push(part);
    at = end;
  }
  return parts;
}

/** The note goes on the last part when it fits, else after it, so it is never cut. */
const withNote = (parts: string[], note: string) => {
  const last = parts.at(-1);
  if (note === "") return parts;
  if (last === undefined) return [note];
  const joined = `${last}\n\n${note}`;
  return joined.length <= MESSAGE_MAX ? [...parts.slice(0, -1), joined] : [...parts, note];
};

/**
 * Adds the email's attachments, then its text, as the visitor's messages in the address's
 * conversation. The text comes last, so it can say which attachments were left out.
 */
async function addMessages(
  { db, images, limits }: InboundOptions,
  workspaceId: string,
  address: FoundAddress,
  email: Email,
  body: Buffer,
): Promise<{ created: boolean } | "busy" | "too_long"> {
  const text = replyText(email.text ?? htmlText(email.html ?? "")).replaceAll("\0", "");
  const parts = textParts(text);
  if (parts === null) return "too_long";
  const sender = email.from?.address?.toLowerCase();
  const source: MessageSource = {
    via: "email",
    fromOtherAddress: sender === undefined || sender !== address.email?.toLowerCase(),
  };
  const { visitorId, conversationId } = address;
  const append = (clientId: string, input: { body: string } | { attachment: NewAttachment }) =>
    withWorkspace(db, workspaceId, (tx) =>
      appendMessage(
        tx,
        workspaceId,
        { kind: "visitor", visitorId, conversationId },
        { clientId, ...input, source },
        limits,
      ),
    );
  const clientId = `email:${sha256Hex(email.messageId ?? body)}`;
  const files = await addAttachments(images, workspaceId, address, email, (index, attachment) =>
    append(`${clientId}:${index + 1}`, { attachment }),
  );
  if (files === "busy") return files;
  const words = visitorWords(address.locale);
  const note = files.leftOut > 0 ? words.attachmentsLeftOut(files.leftOut, MAX_ATTACHMENTS) : "";
  let created = files.created;
  for (const [index, part] of withNote(parts, note).entries()) {
    const added = await append(`${clientId}:text${index + 1}`, { body: part });
    created ||= added.created;
  }
  return { created };
}

/**
 * Whether an attachment is a small image inside the HTML, such as a signature logo, which
 * would otherwise come with every answer. A larger one, such as a pasted screenshot, stays.
 */
const isSmallInlineImage = ({ related, content }: Attachment) =>
  related === true &&
  (typeof content === "string" ? content.length : content.byteLength) < INLINE_IMAGE_MIN_BYTES;

/**
 * Adds the first 5 attachments through the uploads' checks and image queue, and counts the ones
 * left out. Small inline images are skipped without a count. The body limit bounds their decoded
 * size too, since decoding never makes one larger. A busy image queue stops here, so the
 * forwarder's retry brings the rest.
 */
async function addAttachments(
  images: Images | undefined,
  workspaceId: string,
  address: FoundAddress,
  email: Email,
  append: (index: number, attachment: NewAttachment) => Promise<{ created: boolean }>,
): Promise<{ created: boolean; leftOut: number } | "busy"> {
  let created = false;
  let leftOut = 0;
  const attachments = email.attachments.filter((one) => !isSmallInlineImage(one));
  for (const [index, { content, filename }] of attachments.entries()) {
    if (images === undefined || index >= MAX_ATTACHMENTS) {
      leftOut += 1;
      continue;
    }
    const bytes = typeof content === "string" ? Buffer.from(content) : new Uint8Array(content);
    const kept = await images.receiveBytes(
      bytes,
      workspaceId,
      (upload) => append(index, upload),
      address.filesAllowed ? (filename ?? "") : null,
    );
    if ("result" in kept) created ||= kept.result.created;
    else if (kept.refused === "busy") return "busy";
    else leftOut += 1;
  }
  return { created, leftOut };
}
