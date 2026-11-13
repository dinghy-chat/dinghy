import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import PostalMime, { type Address, type Email } from "postal-mime";
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
import { HOUR_SECONDS } from "./time.ts";
import { REPLY_MARKERS, visitorWords } from "./visitor-words.ts";

/** Replies by email stay off unless both are set. */
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
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
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

/**
 * The headers of an email that takes replies. Its Message-ID is at the reply domain, so a reply
 * that quotes Dinghy's headers is cut there.
 */
export function replyHeaders(replyTo: string): Record<string, string> {
  const domain = replyTo.slice(replyTo.lastIndexOf("@") + 1);
  return { "reply-to": replyTo, "message-id": `<${randomUUID()}@${domain}>` };
}

/** Deletes addresses unused for 90 days across workspaces, for the worker. Returns how many went. */
export async function pruneReplyAddresses(db: Database, limit: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM reply_address WHERE (workspace_id, id) IN (
      SELECT workspace_id, id FROM reply_address
      WHERE last_used_at < now() - make_interval(days => ${REPLY_ADDRESS_DAYS}) LIMIT ${limit})`);
  return result.rowCount ?? 0;
}

/**
 * What the visitor wrote: the text above the quote of Dinghy's email. The quote starts at the
 * marker line, or at a quoted header with Dinghy's Message-ID. With neither, the whole text stays.
 * Signatures stay too, because no rule finds them without sometimes cutting what people wrote.
 */
export function replyText(text: string, domain: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const ownId = `@${domain.toLowerCase()}>`;
  const marker = lines.findIndex((line) => REPLY_MARKERS.some((words) => line.includes(words)));
  const header = lines.findIndex((line) => line.toLowerCase().includes(ownId));
  const found = [marker, header].filter((index) => index !== -1);
  if (found.length === 0) return text.trim();
  const cut = Math.min(...found);
  const kept = lines.slice(0, cut);
  // A mail app names who it quotes on the line above the quote, such as "On Monday, Acme wrote:".
  const last = kept.findLastIndex((line) => line.trim() !== "");
  if (cut === marker && kept[last]?.trim().endsWith(":")) kept.length = last;
  return kept.join("\n").trim();
}

// Tags whose contents are no text, and the tags that end a line: a break and a block's end.
const HIDDEN_TAGS = new Set(["head", "style", "script", "title"]);
const LINE_TAGS = /^(br|\/(p|div|li|tr|table|blockquote|h[1-6]))$/;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decodeEntity = (whole: string, name: string) => {
  const lower = name.toLowerCase();
  if (!lower.startsWith("#")) return ENTITIES[lower] ?? whole;
  const code = lower.startsWith("#x")
    ? Number.parseInt(lower.slice(2), 16)
    : Number(lower.slice(1));
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
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, decodeEntity)
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
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] === domain.toLowerCase()) {
      return { workspaceId: asUuid(match[1]), token: match[2] };
    }
  }
  return null;
}

/** `Dinghy-Inbound-Signature` is `t=<time>,v1=<HMAC-SHA256 of "time.body">`, as webhooks sign. */
function signedTime(header: string | undefined): { time: string; digest: Buffer } | null {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const age = Math.abs(Date.now() / 1000 - Number(match[1]));
  return age > SIGNATURE_TOLERANCE_SECONDS
    ? null
    : { time: match[1], digest: Buffer.from(match[2], "hex") };
}

const signatureMatches = (secret: string, signed: { time: string; digest: Buffer }, body: Buffer) =>
  timingSafeEqual(
    createHmac("sha256", secret).update(`${signed.time}.`).update(body).digest(),
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
const TOO_LARGE = failure("too_large", "An email can be up to 25 MB.");
const BUSY = failure("busy", "Too many emails at once. Try again.");
const BLOCKED = failure("blocked", "This visitor cannot send messages.");
const CLOSED = failure("forbidden", "This workspace takes no messages now.");

const inboundEmailRoute = createRoute({
  method: "post",
  path: PATH,
  summary: "Receive a visitor's reply by email, as raw MIME",
  description:
    'For the mail forwarder, and only on a server with `INBOUND_EMAIL_DOMAIN` and `INBOUND_EMAIL_SECRET` set. The body is the email as it arrived, up to 25 MB. `Dinghy-Inbound-Signature` is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" under INBOUND_EMAIL_SECRET>`, and the time must be within 5 minutes. The email goes to the conversation of its `reply+…` recipient as the visitor\'s message, with `via: "email"`. Sending it again adds nothing. Answers from robots, such as out-of-office replies, are dropped with a 200.',
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
    413: errorAnswer("too_large: the email is over 25 MB"),
    429: errorAnswer("too_many_requests: over 20 emails to this address in an hour"),
    503: errorAnswer("busy: too many emails at once, or an attachment could not be read yet"),
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

/** The route the mail forwarder posts each reply to. */
export function registerInboundEmail(app: App, options: InboundOptions): void {
  let held = 0;
  app.use(PATH, bodyLimit({ maxSize: MAX_EMAIL_BYTES, onError: (c) => c.json(TOO_LARGE, 413) }));
  app.openapi(inboundEmailRoute, async (c) => {
    const signed = signedTime(c.req.header(SIGNATURE_HEADER));
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
  if (outcome === "busy") {
    c.header("retry-after", "1");
    return c.json(BUSY, 503);
  }
  if (outcome.created) wakeConversation(live, workspaceId, address.visitorId);
  return c.json(OK, 200);
}

type Append = (
  clientId: string,
  input: { body: string } | { attachment: NewAttachment },
) => Promise<{ created: boolean }>;

/**
 * Adds the email's attachments, then its text, as the visitor's messages in the address's
 * conversation. The text comes last, so it can say which attachments were left out.
 */
async function addMessages(
  { db, images, inbound, limits }: InboundOptions,
  workspaceId: string,
  address: FoundAddress,
  email: Email,
  body: Buffer,
): Promise<{ created: boolean } | "busy"> {
  const sender = email.from?.address?.toLowerCase();
  const source: MessageSource = {
    via: "email",
    fromOtherAddress: sender === undefined || sender !== address.email?.toLowerCase(),
  };
  const { visitorId, conversationId } = address;
  const append: Append = (clientId, input) =>
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
  const text = [
    replyText(email.text ?? htmlText(email.html ?? ""), inbound.domain),
    files.leftOut > 0 ? words.attachmentsLeftOut(files.leftOut, MAX_ATTACHMENTS) : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  if (text === "") return { created: files.created };
  const bounded = Array.from(text.replaceAll("\0", "")).slice(0, MESSAGE_MAX).join("").trim();
  const added = await append(clientId, { body: bounded });
  return { created: files.created || added.created };
}

/**
 * Adds the first 5 attachments through the uploads' checks and image queue, and counts the ones
 * left out. The body limit bounds their decoded size too, since decoding never makes one larger.
 * A busy image queue stops here, so the forwarder's retry brings the rest.
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
  for (const [index, { content, filename }] of email.attachments.entries()) {
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
