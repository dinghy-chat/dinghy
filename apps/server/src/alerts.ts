import { createHmac, timingSafeEqual } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { escapeHtml, markdownHtml } from "../../../packages/widget/src/markdown.ts";
import { firstName } from "../../../packages/widget/src/shared.ts";
import { CHAT_LINK_DAYS, chatLinkUrl, createChatLink, pruneChatLinks } from "./chat-link.ts";
import {
  alertDelivery,
  CHAT_KINDS,
  conversation,
  emailStop,
  event,
  type MessageCreatedPayload,
  message,
  operator,
  pushSubscription,
  visitor,
  widgetSettings,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, enterWorkspace, type Transaction, withWorkspace } from "./db/tenant.ts";
import { emailAddressHash } from "./identity.ts";
import { prunePageViews } from "./journey.ts";
import { letter, letterHtml } from "./letter.ts";
import {
  conversationVisitor,
  isChat,
  joinVisitor,
  type MessageAuthor,
  messageAuthors,
  messageColumns,
  type Quote,
  requestTranscript,
  type StatusPayload,
  visitorQuote,
} from "./messages.ts";
import { imageUrls } from "./public-images.ts";
import type { Push, PushPayload } from "./push.ts";
import { retryDelayMs } from "./retry.ts";

// A failed send retries after 30 seconds, doubling each time, and stops after this many attempts.
export const MAX_ATTEMPTS = 6;
const MINUTE_MS = 60_000;
// An email to an operator per conversation, so a burst of messages sends one.
const OPERATOR_EMAIL_GAP_MS = 15 * MINUTE_MS;
// The reply email waits, because a visitor who is still on the page reads the reply there.
export const REPLY_EMAIL_DELAY_MS = 5 * MINUTE_MS;
// The limits on reply emails, because anyone can type someone else's address into the widget.
const REPLY_EMAIL_GAP_MS = 15 * MINUTE_MS;
export const REPLY_EMAILS_PER_DAY = 5;
const DAY_MS = 24 * 60 * MINUTE_MS;
const REPLIES_IN_EMAIL = 5;
// The transcript waits, so a quick reopen cancels it.
export const TRANSCRIPT_DELAY_MS = 5 * MINUTE_MS;
// A reply email due while a transcript waits looks again this long after the transcript is due.
const AFTER_TRANSCRIPT_MS = 30_000;
// The most messages a transcript holds, the newest ones. The chat link has the rest.
const TRANSCRIPT_MESSAGES = 500;
const PUSH_BODY_CHARACTERS = 200;
export const RETENTION_MS = 30 * DAY_MS;
const PRUNE_BATCH = 1000;

// Every string a person reads has a key, so a locale can be added later.
const text = {
  anImage: "Sent an image.",
  visitor: "A visitor",
  testTitle: "Dinghy",
  testBody: "Alerts work on this device.",
  operatorSubject: (name: string) => `New message in ${name}`,
  operatorBody: (who: string, place: string, body: string, url: string) => [
    `${who} wrote in ${place}:`,
    body,
    `Open the conversation: ${url}`,
    "You get these because email alerts are on for you. You can turn them off in Settings, " +
      "under Alerts.",
  ],
  transcriptSubject: (name: string) => `Your conversation with ${name}`,
  transcriptIntro: (name: string) => `Here is your conversation with ${name}, for your records.`,
  transcriptYou: "You",
  transcriptImage: "Sent an image. Open the chat to see it.",
  transcriptLine: (who: string, when: string) => `${who}, ${when}`,
  quoteDeleted: "Original message deleted",
  quoteImage: "An image",
  transcriptBody: <Messages>(name: string, messages: Messages, chat: string, stop: string) => [
    text.transcriptIntro(name),
    messages,
    `Continue the chat: ${chat}`,
    `The link works for ${CHAT_LINK_DAYS} days. Anyone who has it can read and reply, so don't forward this email.`,
    `You got this because this address was entered in a chat with ${name}. If that wasn't you, ` +
      `or you'd rather not get these emails, stop them here: ${stop}`,
  ],
  replySubject: (name: string) => `${name} replied to your message`,
  replyBody: <Replies>(name: string, replies: Replies, chat: string, stop: string) => [
    `${name} replied to your message:`,
    replies,
    `Read the conversation and answer here: ${chat}`,
    `The link works for ${CHAT_LINK_DAYS} days. Anyone who has it can read and reply, so don't forward this email.`,
    `You got this because this address was entered in a chat with ${name}. If that wasn't you, ` +
      `or you'd rather not get these emails, stop them here: ${stop}`,
  ],
};

export const testPayload = (id: string): PushPayload => ({
  title: text.testTitle,
  body: text.testBody,
  tag: `test:${id}`,
  url: "/",
});

const threadPath = (workspaceId: string, conversationId: string) =>
  `/?workspace=${workspaceId}&conversation=${conversationId}`;

const messageText = (body: string | null) => body ?? text.anImage;

/** A quoted message's lines above a reply: who wrote it, and its start. */
function quoteParts(quote: Quote): [string, string] {
  const who = quote.authorName ?? text.transcriptYou;
  if (quote.id === null) return [who, text.quoteDeleted];
  return [who, quote.excerpt === "" && quote.hasImage ? text.quoteImage : quote.excerpt];
}

/** A reply in an email's plain text: its quote as `> ` lines, then the text. */
function quotedText(quote: Quote | null, body: string): string {
  if (quote === null) return body;
  const [who, excerpt] = quoteParts(quote);
  return `> ${who}:\n> ${excerpt}\n\n${body}`;
}

/** A reply in an email's HTML: its quote as a short indented block with the author's name. */
function quotedHtml(quote: Quote | null, html: string): string {
  if (quote === null) return html;
  const [who, excerpt] = quoteParts(quote);
  return (
    '<div style="margin:8px 0 4px 12px;padding:8px 12px;background:#f3efe4;border-radius:8px;color:#5f6e80;font-size:13px">' +
    `<strong>${escapeHtml(who)}</strong><br>${escapeHtml(excerpt)}</div>${html}`
  );
}

/** Sends to each of the operator's devices. A device that is gone is deleted. */
export async function sendToOperator(
  db: Database,
  push: Push,
  operatorId: string,
  payload: PushPayload,
  signal?: AbortSignal,
): Promise<{ sent: number; failed: number }> {
  const targets = await db
    .select()
    .from(pushSubscription)
    .where(eq(pushSubscription.operatorId, operatorId));
  const results = await Promise.all(
    targets.map(async (target) => {
      const result = await push.send(target, payload, signal);
      if (result === "gone") {
        await db.delete(pushSubscription).where(eq(pushSubscription.id, target.id));
      }
      return result;
    }),
  );
  return {
    sent: results.filter((result) => result === "sent").length,
    failed: results.filter((result) => result === "failed").length,
  };
}

/** Signs the stop link, so nobody can stop the emails of an address they did not receive at. */
const stopSignature = (secret: string, workspaceId: string, addressHash: string) =>
  createHmac("sha256", secret)
    .update(`email-stop/${workspaceId}/${addressHash}`)
    .digest("base64url");

export function emailStopUrl(
  publicUrl: string,
  secret: string,
  workspaceId: string,
  email: string,
): string {
  const hash = emailAddressHash(email);
  const signature = stopSignature(secret, workspaceId, hash);
  return new URL(`/v1/email-stop/${workspaceId}/${hash}?signature=${signature}`, publicUrl).href;
}

export function verifyEmailStop(
  secret: string,
  workspaceId: string,
  addressHash: string,
  signature: string,
): boolean {
  const expected = Buffer.from(stopSignature(secret, workspaceId, addressHash));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface Channels {
  push: boolean;
  email: boolean;
}

type DeliveryRow = typeof alertDelivery.$inferInsert;
type DeliveryBase = Pick<DeliveryRow, "workspaceId" | "eventSeq" | "conversationId" | "messageId">;

/** A visitor wrote: a push and an email for each member who can get them. */
async function operatorAlertRows(
  tx: Transaction,
  channels: Channels,
  base: DeliveryBase,
): Promise<DeliveryRow[]> {
  const { workspaceId, conversationId } = base;
  const rows: DeliveryRow[] = [];
  const members = await tx
    .select({
      operatorId: workspaceMember.operatorId,
      email: workspaceMember.alertEmail,
    })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), isNull(workspaceMember.removedAt)));
  const ids = members.map((member) => member.operatorId);
  const withDevice =
    channels.push && ids.length > 0
      ? await tx
          .selectDistinct({ operatorId: pushSubscription.operatorId })
          .from(pushSubscription)
          .where(inArray(pushSubscription.operatorId, ids))
      : [];
  const recentEmails = channels.email
    ? await tx
        .select({ operatorId: alertDelivery.operatorId })
        .from(alertDelivery)
        .where(
          and(
            eq(alertDelivery.workspaceId, workspaceId),
            eq(alertDelivery.conversationId, conversationId),
            eq(alertDelivery.channel, "email"),
            isNotNull(alertDelivery.operatorId),
            gt(alertDelivery.createdAt, new Date(Date.now() - OPERATOR_EMAIL_GAP_MS)),
          ),
        )
    : [];
  for (const member of members) {
    const { operatorId } = member;
    if (withDevice.some((device) => device.operatorId === operatorId)) {
      rows.push({ ...base, operatorId, channel: "push" });
    }
    if (
      channels.email &&
      member.email &&
      !recentEmails.some((recent) => recent.operatorId === operatorId)
    ) {
      rows.push({ ...base, operatorId, channel: "email" });
    }
  }
  return rows;
}

/** The address followed a stop link in this workspace's emails. */
async function emailStopped(tx: Transaction, workspaceId: string, email: string): Promise<boolean> {
  const [row] = await tx
    .select({ hash: emailStop.addressHash })
    .from(emailStop)
    .where(
      and(
        eq(emailStop.workspaceId, workspaceId),
        eq(emailStop.addressHash, emailAddressHash(email)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** An operator wrote: one delayed email to the visitor, within the limits on reply emails. */
async function replyEmailRows(tx: Transaction, base: DeliveryBase): Promise<DeliveryRow[]> {
  const { workspaceId, conversationId } = base;
  const rows: DeliveryRow[] = [];
  const target = await conversationVisitor(tx, workspaceId, conversationId);
  if (
    target !== undefined &&
    target.email !== null &&
    !(await emailStopped(tx, workspaceId, target.email))
  ) {
    const now = Date.now();
    const past = await tx
      .select({
        channel: alertDelivery.channel,
        createdAt: alertDelivery.createdAt,
        finishedAt: alertDelivery.finishedAt,
        claimedUntil: alertDelivery.claimedUntil,
        outcome: alertDelivery.outcome,
      })
      .from(alertDelivery)
      .where(
        and(
          eq(alertDelivery.workspaceId, workspaceId),
          eq(alertDelivery.visitorId, target.id),
          inArray(alertDelivery.channel, VISITOR_EMAILS),
          gt(alertDelivery.createdAt, new Date(now - DAY_MS)),
        ),
      )
      .orderBy(desc(alertDelivery.createdAt));
    const replyEmails = past.filter((row) => row.channel === "email");
    // A worker may already have read this row's text, so it cannot carry this reply.
    const sending = replyEmails.filter(
      (row) =>
        row.finishedAt === null && row.claimedUntil !== null && row.claimedUntil.getTime() > now,
    );
    // A row still waiting will carry this reply too, because it reads what is unread at send.
    const waiting = replyEmails.some((row) => row.finishedAt === null && !sending.includes(row));
    // Transcripts count toward the daily limit, and only reply emails set the gap.
    const sent = past.filter((row) => row.outcome === "sent");
    const lastReplyEmail = replyEmails.find((row) => row.outcome === "sent");
    // The reply that joins a waiting row gets the same wait as the first one.
    if (waiting) {
      await tx
        .update(alertDelivery)
        .set({
          nextAttemptAt: sql`greatest(${alertDelivery.nextAttemptAt}, ${new Date(now + REPLY_EMAIL_DELAY_MS).toISOString()}::timestamptz)`,
        })
        .where(
          and(
            eq(alertDelivery.workspaceId, workspaceId),
            eq(alertDelivery.visitorId, target.id),
            eq(alertDelivery.channel, "email"),
            isNull(alertDelivery.finishedAt),
          ),
        );
    }
    if (!waiting && sent.length + sending.length < REPLY_EMAILS_PER_DAY) {
      const last = sending.length > 0 ? now : (lastReplyEmail?.finishedAt?.getTime() ?? 0);
      rows.push({
        ...base,
        visitorId: target.id,
        channel: "email",
        nextAttemptAt: new Date(Math.max(now + REPLY_EMAIL_DELAY_MS, last + REPLY_EMAIL_GAP_MS)),
      });
    }
  }
  return rows;
}

/**
 * A close: one transcript to the visitor after a delay, when the visitor has an email, the workspace
 * sends transcripts, someone on the team replied, and no transcript holds every message already.
 */
async function transcriptRows(tx: Transaction, base: DeliveryBase): Promise<DeliveryRow[]> {
  const { workspaceId, conversationId } = base;
  const target = await conversationVisitor(tx, workspaceId, conversationId);
  if (target === undefined || target.email === null) return [];
  const [settings] = await tx
    .select({ wanted: widgetSettings.transcript })
    .from(widgetSettings)
    .where(eq(widgetSettings.workspaceId, workspaceId));
  if (settings?.wanted !== true) return [];
  if (await emailStopped(tx, workspaceId, target.email)) return [];
  const result = await tx.execute<{ last_seq: string | null; replied: boolean }>(sql`
    select max(seq) as last_seq, coalesce(bool_or(author_visitor_id is null), false) as replied
    from ${message}
    where workspace_id = ${workspaceId} and conversation_id = ${conversationId}
      and kind in ('text', 'image')`);
  const stats = result.rows[0];
  if (stats === undefined || !stats.replied || stats.last_seq === null) return [];
  // A sent or waiting transcript from a later close holds every message already.
  const [covered] = await tx
    .select({ id: alertDelivery.id })
    .from(alertDelivery)
    .where(
      and(
        eq(alertDelivery.workspaceId, workspaceId),
        eq(alertDelivery.conversationId, conversationId),
        eq(alertDelivery.channel, "transcript"),
        gt(alertDelivery.eventSeq, BigInt(stats.last_seq)),
        or(isNull(alertDelivery.outcome), eq(alertDelivery.outcome, "sent")),
      ),
    )
    .limit(1);
  if (covered !== undefined) return [];
  return [
    {
      ...base,
      visitorId: target.id,
      channel: "transcript",
      nextAttemptAt: new Date(Date.now() + TRANSCRIPT_DELAY_MS),
    },
  ];
}

/** An operator asked for a transcript now: the worker sends it. */
export async function queueTranscript(
  db: Database,
  workspaceId: string,
  conversationId: string,
): Promise<"queued" | "no_email" | "missing"> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const target = await conversationVisitor(tx, workspaceId, conversationId);
    if (target === undefined) return "missing";
    if (target.email === null) return "no_email";
    return (await requestTranscript(tx, workspaceId, conversationId)) ? "queued" : "missing";
  });
}

/**
 * A transcript an operator asked for: now, unless one asked for the same newest message still waits,
 * or a sent one carried that message already. A failed one does not stop a retry.
 */
async function requestedTranscriptRows(
  tx: Transaction,
  base: DeliveryBase,
): Promise<DeliveryRow[]> {
  const { workspaceId, conversationId, messageId } = base;
  const target = await conversationVisitor(tx, workspaceId, conversationId);
  if (target === undefined || target.email === null) return [];
  const newest = sql`(select ${message.seq} from ${message} where ${message.workspaceId} = ${workspaceId} and ${message.id} = ${messageId})`;
  const [covered] = await tx
    .select({ id: alertDelivery.id })
    .from(alertDelivery)
    .where(
      and(
        eq(alertDelivery.workspaceId, workspaceId),
        eq(alertDelivery.conversationId, conversationId),
        eq(alertDelivery.channel, "transcript"),
        or(
          and(isNull(alertDelivery.finishedAt), eq(alertDelivery.messageId, messageId)),
          and(eq(alertDelivery.outcome, "sent"), gte(alertDelivery.coveredToSeq, newest)),
        ),
      ),
    )
    .limit(1);
  if (covered !== undefined) return [];
  return [{ ...base, visitorId: target.id, channel: "transcript" }];
}

/**
 * Creates the delivery rows for one event, in one transaction with clearing its flag, so a crash
 * here repeats the whole step and the unique key stops a second row. Returns false with no work.
 */
export function fanOutOne(db: Database, channels: Channels): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({
        workspaceId: event.workspaceId,
        seq: event.seq,
        kind: event.kind,
        payload: event.payload,
      })
      .from(event)
      .where(eq(event.needsAlert, true))
      .orderBy(event.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (found === undefined) return false;
    const { workspaceId, seq } = found;
    await enterWorkspace(tx, workspaceId);
    // The email limits read past rows and then write new ones, so two workers must take turns.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
    // Only a message.created event, a close and a transcript request set needsAlert. Each names a
    // message: the new one, the close's status line, or the newest message when it was asked for.
    const { messageId, conversationId } = found.payload as MessageCreatedPayload | StatusPayload;
    const base = { workspaceId, eventSeq: seq, conversationId, messageId };

    const [written] = await tx
      .select({ authorVisitorId: message.authorVisitorId, deletedAt: message.deletedAt })
      .from(message)
      .where(and(eq(message.workspaceId, workspaceId), eq(message.id, messageId)));
    // A message deleted before this step, with its row or only its text, has nothing to alert about.
    const rows =
      written === undefined || (found.kind === "message.created" && written.deletedAt !== null)
        ? []
        : found.kind === "conversation.closed" || found.kind === "transcript.requested"
          ? !channels.email
            ? []
            : found.kind === "conversation.closed"
              ? await transcriptRows(tx, base)
              : await requestedTranscriptRows(tx, base)
          : written.authorVisitorId !== null
            ? await operatorAlertRows(tx, channels, base)
            : channels.email
              ? await replyEmailRows(tx, base)
              : [];
    if (rows.length > 0) await tx.insert(alertDelivery).values(rows).onConflictDoNothing();
    await tx
      .update(event)
      .set({ needsAlert: false })
      .where(and(eq(event.workspaceId, workspaceId), eq(event.seq, seq)));
    return true;
  });
}

export interface ClaimedDelivery {
  workspaceId: string;
  id: string;
  eventSeq: string;
  conversationId: string;
  messageId: string;
  operatorId: string | null;
  visitorId: string | null;
  channel: "push" | "email" | "transcript";
  attempts: number;
}

/**
 * Claims due rows and commits, so no transaction stays open during a send. A worker that dies keeps
 * its claim until it expires, and then another worker sends again. The claim counts as an attempt,
 * so a row that kills its worker each time still stops.
 */
export async function claimDeliveries(
  db: Database,
  limit: number,
  claimMs: number,
): Promise<ClaimedDelivery[]> {
  const result = await db.execute<{
    workspace_id: string;
    id: string;
    event_seq: string;
    conversation_id: string;
    message_id: string;
    operator_id: string | null;
    visitor_id: string | null;
    channel: "push" | "email" | "transcript";
    attempts: number;
  }>(sql`
    WITH due AS MATERIALIZED (
      SELECT workspace_id, id FROM alert_delivery
      WHERE finished_at IS NULL
        AND next_attempt_at <= now()
        AND (claimed_until IS NULL OR claimed_until < now())
      ORDER BY next_attempt_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE alert_delivery AS row
    SET attempts = row.attempts + 1,
        claimed_until = now() + ${claimMs}::float8 * interval '1 millisecond'
    FROM due
    WHERE row.workspace_id = due.workspace_id AND row.id = due.id
    RETURNING row.workspace_id, row.id, row.event_seq, row.conversation_id, row.message_id,
      row.operator_id, row.visitor_id, row.channel, row.attempts`);
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    id: row.id,
    eventSeq: row.event_seq,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    operatorId: row.operator_id,
    visitorId: row.visitor_id,
    channel: row.channel,
    attempts: row.attempts,
  }));
}

// The attempts check means a worker that outlived its claim cannot change the next worker's row.
const held = (row: ClaimedDelivery) =>
  and(
    eq(alertDelivery.workspaceId, row.workspaceId),
    eq(alertDelivery.id, row.id),
    eq(alertDelivery.attempts, row.attempts),
    isNull(alertDelivery.finishedAt),
  );

export async function finishDelivery(
  db: Database,
  row: ClaimedDelivery,
  outcome: "sent" | "skipped" | "failed",
): Promise<void> {
  await db
    .update(alertDelivery)
    .set({ outcome, finishedAt: new Date(), claimedUntil: null })
    .where(held(row));
}

export async function retryDelivery(
  db: Database,
  row: ClaimedDelivery,
  retryMs: number,
): Promise<void> {
  const wait = retryDelayMs(retryMs, row.attempts);
  await db
    .update(alertDelivery)
    .set({ claimedUntil: null, nextAttemptAt: new Date(Date.now() + wait) })
    .where(held(row));
}

/** Moves a row to a later time. Waiting for a limit is not a failed attempt. */
export async function postponeDelivery(
  db: Database,
  row: ClaimedDelivery,
  until: Date,
): Promise<void> {
  await db
    .update(alertDelivery)
    .set({ claimedUntil: null, attempts: row.attempts - 1, nextAttemptAt: until })
    .where(held(row));
}

/** Gives a claim back when a worker stops, so the next worker sends at once. */
export async function releaseDelivery(db: Database, row: ClaimedDelivery): Promise<void> {
  await db
    .update(alertDelivery)
    .set({ claimedUntil: null, attempts: row.attempts - 1 })
    .where(held(row));
}

export type AlertPlan =
  | { channel: "push"; operatorId: string; payload: PushPayload }
  | {
      channel: "email";
      to: string;
      subject: string;
      text: string;
      /** A second version for mail apps that show HTML, with the replies' formatting. */
      html?: string;
      stopUrl?: string;
    }
  | { channel: "later"; until: Date };

interface PlanOptions {
  publicUrl: string;
  secret: string;
  /** Where the workspace's logo is served: the image origin, or the app's. */
  imageOrigin: string;
}

/** Reads what this row should send now, or null if it should send nothing. */
export function planDelivery(
  db: Database,
  row: ClaimedDelivery,
  options: PlanOptions,
): Promise<AlertPlan | null> {
  const { workspaceId, conversationId } = row;
  const { publicUrl } = options;
  return withWorkspace(db, workspaceId, async (tx) => {
    const [place] = await tx
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    const [written] = await tx
      .select({ body: message.body, deletedAt: message.deletedAt })
      .from(message)
      .where(and(eq(message.workspaceId, workspaceId), eq(message.id, row.messageId)));
    if (place === undefined || written === undefined) return null;
    if (row.channel === "transcript" && row.visitorId !== null) {
      return transcriptPlan(tx, row, row.visitorId, place.name, options);
    }
    // Not skipped when its own reply was deleted: it also carries the replies that joined it.
    if (row.visitorId !== null) {
      return replyEmailPlan(tx, row, row.visitorId, place.name, options);
    }
    // A visitor's message deleted while its alert waited has nothing to alert about.
    if (written.deletedAt !== null) return null;
    const threadUrl = new URL(threadPath(workspaceId, conversationId), publicUrl).href;
    return operatorPlan(tx, row, place.name, written.body, threadUrl);
  });
}

/** The channels that email a visitor, which share the daily limit. */
const VISITOR_EMAILS: ClaimedDelivery["channel"][] = ["email", "transcript"];

/** The emails sent to this visitor in the last day, newest first. */
async function sentToday(tx: Transaction, workspaceId: string, visitorId: string) {
  const rows = await tx
    .select({ channel: alertDelivery.channel, finishedAt: alertDelivery.finishedAt })
    .from(alertDelivery)
    .where(
      and(
        eq(alertDelivery.workspaceId, workspaceId),
        eq(alertDelivery.visitorId, visitorId),
        inArray(alertDelivery.channel, VISITOR_EMAILS),
        eq(alertDelivery.outcome, "sent"),
        gt(alertDelivery.finishedAt, new Date(Date.now() - DAY_MS)),
      ),
    )
    .orderBy(desc(alertDelivery.finishedAt));
  return rows.map((one) => ({ channel: one.channel, finishedAt: one.finishedAt ?? new Date(0) }));
}

/** When the visitor's transcript that has not finished is due, or null with none. */
async function waitingTranscript(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
): Promise<Date | null> {
  const [found] = await tx
    .select({
      due: sql<string>`greatest(${alertDelivery.nextAttemptAt}, ${alertDelivery.claimedUntil}, now())`,
    })
    .from(alertDelivery)
    .where(
      and(
        eq(alertDelivery.workspaceId, workspaceId),
        eq(alertDelivery.visitorId, visitorId),
        eq(alertDelivery.channel, "transcript"),
        isNull(alertDelivery.finishedAt),
      ),
    )
    .orderBy(desc(alertDelivery.nextAttemptAt))
    .limit(1);
  return found === undefined ? null : new Date(found.due);
}

/** A sent transcript of the message's conversation carried this message. */
const carriedByTranscript = (workspaceId: string, visitorId: string) =>
  sql`(select 1 from ${alertDelivery} as carried
       where carried.workspace_id = ${workspaceId} and carried.visitor_id = ${visitorId}
         and carried.channel = 'transcript' and carried.outcome = 'sent'
         and carried.conversation_id = ${message.conversationId}
         and ${message.seq} between carried.covered_from_seq and carried.covered_to_seq)`;

/** Records the first and last message this email carries, which receipts and edits read. */
async function recordCoverage(
  tx: Transaction,
  row: ClaimedDelivery,
  carried: { seq: bigint }[],
): Promise<void> {
  await tx
    .update(alertDelivery)
    .set({ coveredFromSeq: carried[0]?.seq ?? null, coveredToSeq: carried.at(-1)?.seq ?? null })
    .where(held(row));
}

/**
 * The email to a visitor with every reply they have not read, unless a limit says later. A transcript
 * still waiting goes first, and the replies a sent transcript carried are left out, so the visitor
 * never gets the same reply twice. When the transcript fails or is cancelled, this carries them.
 */
async function replyEmailPlan(
  tx: Transaction,
  row: ClaimedDelivery,
  visitorId: string,
  placeName: string,
  { publicUrl, secret }: PlanOptions,
): Promise<AlertPlan | null> {
  const { workspaceId, conversationId } = row;
  const [target] = await tx
    .select({ email: visitor.email, lastReadSeq: visitor.lastReadSeq })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  if (target === undefined || target.email === null) return null;
  if (await emailStopped(tx, workspaceId, target.email)) return null;
  const transcriptDue = await waitingTranscript(tx, workspaceId, visitorId);
  if (transcriptDue !== null) {
    return { channel: "later", until: new Date(transcriptDue.getTime() + AFTER_TRANSCRIPT_MS) };
  }
  // Every unread reply to this visitor, because other replies waited for this row to send. The
  // share lock makes an edit wait until this email's range is recorded, or this read wait for it.
  const replies = await tx
    .select({ seq: message.seq, body: message.body, replyTo: messageColumns.replyTo })
    .from(message)
    .innerJoin(
      conversation,
      and(
        eq(conversation.workspaceId, message.workspaceId),
        eq(conversation.id, message.conversationId),
      ),
    )
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(conversation.visitorId, visitorId),
        isNull(message.authorVisitorId),
        isChat(),
        isNull(message.deletedAt),
        gt(message.seq, target.lastReadSeq),
        notExists(carriedByTranscript(workspaceId, visitorId)),
      ),
    )
    .orderBy(desc(message.seq))
    .limit(REPLIES_IN_EMAIL)
    .for("share", { of: message });
  // The visitor came back and read everything, or a transcript carried it.
  if (replies.length === 0) return null;
  // Fan-out set the due time, but a slow retry of an earlier row can have sent since then.
  const sent = await sentToday(tx, workspaceId, visitorId);
  if (sent.length >= REPLY_EMAILS_PER_DAY) return null;
  const lastReplyEmail = sent.find((one) => one.channel === "email");
  const earliest = (lastReplyEmail?.finishedAt.getTime() ?? 0) + REPLY_EMAIL_GAP_MS;
  if (earliest > Date.now()) return { channel: "later", until: new Date(earliest) };
  replies.reverse();
  await recordCoverage(tx, row, replies);
  const stopUrl = emailStopUrl(publicUrl, secret, workspaceId, target.email);
  const written = replies.map((reply) => ({
    body: messageText(reply.body),
    quote: visitorQuote(reply.replyTo),
  }));
  // A new link for each email. Older ones keep working until they expire.
  const chatUrl = chatLinkUrl(
    publicUrl,
    await createChatLink(tx, workspaceId, visitorId, conversationId),
  );
  return {
    channel: "email",
    to: target.email,
    subject: text.replySubject(placeName),
    // The visitor typed this address, and nobody proved it, so it greets no name.
    text: letter(
      text.replyBody(
        placeName,
        written.map((reply) => quotedText(reply.quote, reply.body)).join("\n\n"),
        chatUrl,
        stopUrl,
      ),
      undefined,
      placeName,
    ),
    // The replies' Markdown shows as formatting here, and stays as typed in the text version.
    html: letterHtml(
      text.replyBody(
        placeName,
        {
          html: written.map((reply) => quotedHtml(reply.quote, markdownHtml(reply.body))).join(""),
        },
        chatUrl,
        stopUrl,
      ),
      placeName,
    ),
    stopUrl,
  };
}

/** "2026-11-11 20:20 UTC": the date and time, so the transcript reads the same anywhere. */
const utcTime = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Who wrote a message, as the visitor knows them: themself, a first name, or a key's name. */
function transcriptAuthor(
  line: {
    authorVisitorId: string | null;
    authorOperatorId: string | null;
    authorApiKeyId: string | null;
  },
  authors: Map<string, MessageAuthor>,
): string {
  if (line.authorVisitorId !== null) return text.transcriptYou;
  const id = line.authorOperatorId ?? line.authorApiKeyId ?? "";
  const author = authors.get(id);
  if (author === undefined) return text.visitor;
  return line.authorApiKeyId !== null || author.isDeleted ? author.name : firstName(author.name);
}

/**
 * The whole conversation by email. A close's transcript sends nothing when the conversation was
 * reopened, or when a later close made another. A reply email waits for it, and leaves out the
 * replies it carried once it is sent, so the visitor does not get both.
 */
async function transcriptPlan(
  tx: Transaction,
  row: ClaimedDelivery,
  visitorId: string,
  placeName: string,
  { publicUrl, secret, imageOrigin }: PlanOptions,
): Promise<AlertPlan | null> {
  const { workspaceId, conversationId, messageId, eventSeq } = row;
  const [state] = await tx
    .select({
      status: conversation.status,
      email: visitor.email,
      publicKey: workspace.publicKey,
      logoUpdatedAt: widgetSettings.logoUpdatedAt,
      fromClose: sql<boolean>`exists (select 1 from ${message} where ${message.workspaceId} = ${workspaceId} and ${message.id} = ${messageId} and ${message.kind} = 'closed')`,
      later: sql<boolean>`exists (select 1 from ${alertDelivery} where ${alertDelivery.workspaceId} = ${workspaceId} and ${alertDelivery.conversationId} = ${conversationId} and ${alertDelivery.channel} = 'transcript' and ${alertDelivery.eventSeq} > ${eventSeq}::bigint)`,
    })
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .innerJoin(workspace, eq(workspace.id, conversation.workspaceId))
    .innerJoin(widgetSettings, eq(widgetSettings.workspaceId, conversation.workspaceId))
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  if (state === undefined || state.email === null) return null;
  if (state.fromClose && (state.status !== "closed" || state.later)) return null;
  if (await emailStopped(tx, workspaceId, state.email)) return null;
  if ((await sentToday(tx, workspaceId, visitorId)).length >= REPLY_EMAILS_PER_DAY) return null;
  // The share lock makes an edit wait until this transcript's range is recorded, as for a reply email.
  const lines = (
    await tx
      .select({
        seq: message.seq,
        body: message.body,
        kind: message.kind,
        authorVisitorId: message.authorVisitorId,
        authorOperatorId: message.authorOperatorId,
        authorApiKeyId: message.authorApiKeyId,
        replyTo: messageColumns.replyTo,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(
        and(
          eq(message.workspaceId, workspaceId),
          eq(message.conversationId, conversationId),
          inArray(message.kind, [...CHAT_KINDS]),
          isNull(message.deletedAt),
        ),
      )
      .orderBy(desc(message.seq))
      .limit(TRANSCRIPT_MESSAGES)
      .for("share", { of: message })
  ).reverse();
  if (lines.length === 0) return null;
  await recordCoverage(tx, row, lines);
  const authors = await messageAuthors(tx, workspaceId, lines);
  const chatUrl = chatLinkUrl(
    publicUrl,
    await createChatLink(tx, workspaceId, visitorId, conversationId),
  );
  const stopUrl = emailStopUrl(publicUrl, secret, workspaceId, state.email);
  const heads = lines.map((line) =>
    text.transcriptLine(transcriptAuthor(line, authors), utcTime(line.createdAt)),
  );
  const plain = lines
    .map(
      (line, index) =>
        `${heads[index]}:\n${quotedText(visitorQuote(line.replyTo), line.kind === "image" ? text.transcriptImage : (line.body ?? ""))}`,
    )
    .join("\n\n");
  const logoUrl = imageUrls(imageOrigin).logo(state.publicKey, state.logoUpdatedAt);
  const html = [
    logoUrl === null
      ? ""
      : `<p><img src="${escapeHtml(logoUrl)}" width="48" height="48" alt="" style="border-radius:10px"></p>`,
    ...lines.map(
      (line, index) =>
        `<p style="margin:18px 0 2px;color:#5f6e80;font-size:13px">${escapeHtml(heads[index] ?? "")}</p>` +
        quotedHtml(
          visitorQuote(line.replyTo),
          line.kind === "image"
            ? `<p><a href="${escapeHtml(chatUrl)}">${escapeHtml(text.transcriptImage)}</a></p>`
            : markdownHtml(line.body ?? ""),
        ),
    ),
  ].join("");
  return {
    channel: "email",
    to: state.email,
    subject: text.transcriptSubject(placeName),
    text: letter(text.transcriptBody(placeName, plain, chatUrl, stopUrl), undefined, placeName),
    html: letterHtml(text.transcriptBody(placeName, { html }, chatUrl, stopUrl), placeName),
    stopUrl,
  };
}

/** A push or an email to the operator this row is for, if they are still a member who wants it. */
async function operatorPlan(
  tx: Transaction,
  row: ClaimedDelivery,
  placeName: string,
  body: string | null,
  threadUrl: string,
): Promise<AlertPlan | null> {
  const { workspaceId, conversationId } = row;
  const operatorId = row.operatorId;
  if (operatorId === null) return null;
  // A removed operator receives nothing, even from a row made before the removal.
  const [member] = await tx
    .select({
      email: operator.email,
      name: operator.name,
      wantsEmail: workspaceMember.alertEmail,
    })
    .from(workspaceMember)
    .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.operatorId, operatorId),
        isNull(workspaceMember.removedAt),
      ),
    );
  if (member === undefined) return null;
  if (row.channel === "push") {
    return {
      channel: "push",
      operatorId,
      payload: {
        title: placeName,
        body: Array.from(messageText(body)).slice(0, PUSH_BODY_CHARACTERS).join(""),
        tag: `${workspaceId}:${row.eventSeq}`,
        url: threadPath(workspaceId, conversationId),
      },
    };
  }
  // The operator may have turned email off while this row waited for a retry.
  if (!member.wantsEmail) return null;
  const from = await conversationVisitor(tx, workspaceId, conversationId);
  return {
    channel: "email",
    to: member.email,
    subject: text.operatorSubject(placeName),
    text: letter(
      text.operatorBody(from?.email ?? text.visitor, placeName, messageText(body), threadUrl),
      member.name,
    ),
  };
}

/**
 * Deletes old events and finished rows in batches. It removes events only from the start of a
 * workspace's feed, because a client detects a gap by comparing its cursor with the oldest event.
 */
export async function pruneOnce(db: Database, before: Date): Promise<number> {
  let removed = 0;
  const cutoff = sql`${before.toISOString()}::timestamptz`;
  for (;;) {
    // Each workspace's first event that must stay is found once, and everything before it goes.
    // Checking every old event against all earlier ones instead cost time in the square of their
    // number: 30 seconds for 58,000 events, against under a second this way.
    const events = await db.execute(sql`
      DELETE FROM event
      WHERE (workspace_id, seq) IN (
        SELECT old.workspace_id, old.seq
        FROM (
          SELECT DISTINCT workspace_id FROM event
          WHERE created_at < ${cutoff} AND NOT needs_alert AND NOT needs_webhook
        ) AS candidate
        LEFT JOIN LATERAL (
          SELECT kept.seq FROM event AS kept
          WHERE kept.workspace_id = candidate.workspace_id
            AND (kept.needs_alert OR kept.needs_webhook OR kept.created_at >= ${cutoff})
          ORDER BY kept.seq
          LIMIT 1
        ) AS first_kept ON true
        JOIN event AS old ON old.workspace_id = candidate.workspace_id
          AND (first_kept.seq IS NULL OR old.seq < first_kept.seq)
        ORDER BY old.workspace_id, old.seq
        LIMIT ${PRUNE_BATCH})`);
    const deliveries = await db.execute(sql`
      DELETE FROM alert_delivery
      WHERE (workspace_id, id) IN (
        SELECT workspace_id, id FROM alert_delivery
        WHERE finished_at < ${cutoff}
        LIMIT ${PRUNE_BATCH})`);
    const hooks = await db.execute(sql`
      DELETE FROM webhook_delivery
      WHERE (workspace_id, id) IN (
        SELECT workspace_id, id FROM webhook_delivery
        WHERE finished_at < ${cutoff}
        LIMIT ${PRUNE_BATCH})`);
    const blocks = await db.execute(sql`
      DELETE FROM ip_block
      WHERE (workspace_id, ip_hash, visitor_id) IN (
        SELECT workspace_id, ip_hash, visitor_id FROM ip_block
        WHERE expires_at < now()
        LIMIT ${PRUNE_BATCH})`);
    const links = await pruneChatLinks(db, PRUNE_BATCH);
    const pages = await prunePageViews(db, PRUNE_BATCH);
    const counts = [
      events.rowCount ?? 0,
      deliveries.rowCount ?? 0,
      hooks.rowCount ?? 0,
      blocks.rowCount ?? 0,
      links,
      pages,
    ];
    removed += counts.reduce((sum, count) => sum + count, 0);
    // A full batch of any of them may have more behind it.
    if (counts.every((count) => count < PRUNE_BATCH)) return removed;
  }
}
