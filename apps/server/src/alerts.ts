import { and, desc, eq, gt, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { escapeHtml, markdownHtml } from "../../../packages/widget/src/markdown.ts";
import type { HandledPayload } from "./bots.ts";
import { chatLinkUrl, createChatLink, pruneChatLinks } from "./chat-link.ts";
import {
  alertDelivery,
  conversation,
  type EventKind,
  event,
  type MessagePayload,
  message,
  operator,
  pushSubscription,
  visitor,
  widgetSettings,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, enterWorkspace, type Transaction, withWorkspace } from "./db/tenant.ts";
import { prunePageViews } from "./journey.ts";
import { EMAIL_COLORS, letter, letterHtml } from "./letter.ts";
import {
  conversationHasTestVisitor,
  conversationVisitor,
  isChat,
  messageAuthors,
  messageColumns,
  type Quote,
  type StatusPayload,
  visitorQuote,
} from "./messages.ts";
import { imageUrls } from "./public-images.ts";
import type { Push, PushPayload } from "./push.ts";
import { retryDelayMs } from "./retry.ts";
import { MINUTE_MS } from "./time.ts";
import { requestedTranscriptRows, transcriptPlan, transcriptRows } from "./transcripts.ts";
import {
  emailStopped,
  emailStopUrl,
  quotedHtml,
  quotedText,
  sentToday,
  VISITOR_EMAILS_PER_DAY,
  visitorAuthorName,
  visitorEmailText,
  visitorLetterHtml,
} from "./visitor-email.ts";

// A failed send retries after 30 seconds, doubling each time, and stops after this many attempts.
export const MAX_ATTEMPTS = 6;
// An email to an operator per conversation, so a burst of messages sends one.
const OPERATOR_EMAIL_GAP_MS = 15 * MINUTE_MS;
// The reply email waits, because a visitor who is still on the page reads the reply there.
export const REPLY_EMAIL_DELAY_MS = 5 * MINUTE_MS;
// The gap between reply emails, because anyone can type someone else's address into the widget.
const REPLY_EMAIL_GAP_MS = 15 * MINUTE_MS;
const REPLIES_IN_EMAIL = 5;
// A reply email due while a transcript waits looks again this long after the transcript is due.
const AFTER_TRANSCRIPT_MS = 30_000;
const PUSH_BODY_CHARACTERS = 200;
const PRUNE_BATCH = 1000;

// Every string a person reads has a key, so a locale can be added later.
const text = {
  anImage: "Sent an image.",
  visitor: "A visitor",
  testTitle: "Dinghy",
  testBody: "Alerts work on this device.",
  operatorSubject: (name: string) => `New message in ${name}`,
  handoffSubject: (name: string) => `A bot handed a conversation to your team in ${name}`,
  handoffWrote: (place: string) => `A bot handed a conversation in ${place} to a person:`,
  operatorWrote: (who: string, place: string) => `${who} wrote in ${place}:`,
  operatorOpen: "Open the conversation",
  operatorWhy:
    "You get these because email alerts are on for you. You can turn them off in Settings, " +
    "under Alerts.",
  replySubject: (name: string) => `${name} replied to your message`,
  replied: (who: string) => `${who} replied`,
  replyInChat: "Reply in the chat",
  replyBody: (name: string, replies: string, chat: string, stop: string) => [
    `${name} replied to your message:`,
    replies,
    `Read the conversation and answer here: ${chat}`,
    visitorEmailText.linkWarning,
    visitorEmailText.whyYouGotThis(name, stop),
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

interface Channels {
  push: boolean;
  email: boolean;
}

export type DeliveryRow = typeof alertDelivery.$inferInsert;
export type DeliveryBase = Pick<
  DeliveryRow,
  "workspaceId" | "eventSeq" | "conversationId" | "messageId"
>;

/**
 * A visitor wrote, or a bot handed a conversation off: a push and an email for each member who can
 * get them, or only for `assignee` when there is one.
 */
async function operatorAlertRows(
  tx: Transaction,
  channels: Channels,
  base: DeliveryBase,
  assignee: string | null = null,
): Promise<DeliveryRow[]> {
  const { workspaceId, conversationId } = base;
  const rows: DeliveryRow[] = [];
  const members = await tx
    .select({
      operatorId: workspaceMember.operatorId,
      email: workspaceMember.alertEmail,
    })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.removedAt),
        assignee === null ? undefined : eq(workspaceMember.operatorId, assignee),
      ),
    );
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

/** An operator wrote: one delayed email to the visitor, within the limits on reply emails. */
async function replyEmailRows(tx: Transaction, base: DeliveryBase): Promise<DeliveryRow[]> {
  const { workspaceId, conversationId } = base;
  const target = await conversationVisitor(tx, workspaceId, conversationId);
  if (target === undefined || target.email === null) return [];
  if (await emailStopped(tx, workspaceId, target.email)) return [];
  const now = Date.now();
  const unfinished = and(
    eq(alertDelivery.workspaceId, workspaceId),
    eq(alertDelivery.visitorId, target.id),
    eq(alertDelivery.channel, "email"),
    isNull(alertDelivery.finishedAt),
  );
  const open = await tx
    .select({ claimedUntil: alertDelivery.claimedUntil })
    .from(alertDelivery)
    .where(unfinished);
  // A worker may already have read this row's text, so it cannot carry this reply.
  const sending = open.filter((row) => (row.claimedUntil?.getTime() ?? 0) > now).length;
  // A row still waiting will carry this reply too, because it reads what is unread at send. The
  // reply that joins it gets the same wait as the first one.
  if (sending < open.length) {
    await tx
      .update(alertDelivery)
      .set({
        nextAttemptAt: sql`greatest(${alertDelivery.nextAttemptAt}, ${new Date(now + REPLY_EMAIL_DELAY_MS).toISOString()}::timestamptz)`,
      })
      .where(unfinished);
    return [];
  }
  // Transcripts count toward the daily limit, as the planner counts them, and only reply emails
  // set the gap.
  const sent = await sentToday(tx, workspaceId, target.id);
  if (sent.length + sending >= VISITOR_EMAILS_PER_DAY) return [];
  const lastReplyEmail = sent.find((row) => row.channel === "email");
  const last = sending > 0 ? now : (lastReplyEmail?.finishedAt.getTime() ?? 0);
  const row: DeliveryRow = {
    ...base,
    visitorId: target.id,
    channel: "email",
    nextAttemptAt: new Date(Math.max(now + REPLY_EMAIL_DELAY_MS, last + REPLY_EMAIL_GAP_MS)),
  };
  return [row];
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
    // Only a message.created event, a close, a transcript request and a handoff set needsAlert. Each
    // names a message: the new one, the close's status line, or the newest message when it was
    // asked for or handed off.
    const { messageId, conversationId } = found.payload as
      | MessagePayload
      | StatusPayload
      | Extract<HandledPayload, { change: "handoff" }>;
    const base = { workspaceId, eventSeq: seq, conversationId, messageId };

    const [written] = await tx
      .select({
        authorVisitorId: message.authorVisitorId,
        deletedAt: message.deletedAt,
        // A bot's simulated visitor: nobody is told about it.
        fromTest: sql<boolean>`exists (select 1 from conversation c
          where c.workspace_id = message.workspace_id and c.id = message.conversation_id
            and ${conversationHasTestVisitor(sql`c`)})`,
      })
      .from(message)
      .where(and(eq(message.workspaceId, workspaceId), eq(message.id, messageId)));
    // A message whose row was deleted before this step has nothing to alert about.
    const rows =
      written === undefined ? [] : await eventRows(tx, found.kind, written, channels, base);
    if (rows.length > 0) await tx.insert(alertDelivery).values(rows).onConflictDoNothing();
    await tx
      .update(event)
      .set({ needsAlert: false })
      .where(and(eq(event.workspaceId, workspaceId), eq(event.seq, seq)));
    return true;
  });
}

/** A bot handed a conversation off: its assignee, or every member when it has none. */
async function handoffRows(tx: Transaction, channels: Channels, base: DeliveryBase) {
  const [row] = await tx
    .select({ assignee: conversation.assigneeOperatorId })
    .from(conversation)
    .where(
      and(eq(conversation.workspaceId, base.workspaceId), eq(conversation.id, base.conversationId)),
    );
  return row === undefined ? [] : operatorAlertRows(tx, channels, base, row.assignee);
}

/**
 * The rows one event makes: a message alerts the other side, a close or a request a transcript, and
 * a handoff the people who take over.
 */
async function eventRows(
  tx: Transaction,
  kind: EventKind,
  written: { authorVisitorId: string | null; deletedAt: Date | null; fromTest: boolean },
  channels: Channels,
  base: DeliveryBase,
): Promise<DeliveryRow[]> {
  if (written.fromTest) return [];
  switch (kind) {
    case "conversation.handled":
      return handoffRows(tx, channels, base);
    case "conversation.closed":
      return channels.email ? transcriptRows(tx, base) : [];
    case "transcript.requested":
      return channels.email ? requestedTranscriptRows(tx, base) : [];
    case "message.created":
      // A message deleted before this step has nothing to alert about.
      if (written.deletedAt !== null) return [];
      if (written.authorVisitorId !== null) return operatorAlertRows(tx, channels, base);
      return channels.email ? replyEmailRows(tx, base) : [];
    default:
      return [];
  }
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
      /** The first and last message a visitor's email carries, which the plan records. */
      carries?: { fromSeq: bigint; toSeq: bigint };
    }
  | { channel: "later"; until: Date };

/** The workspace that a visitor's email comes from, as its header shows it. */
export interface Place {
  name: string;
  logoUrl: string | null;
}

export interface PlanOptions {
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
      .select({
        name: workspace.name,
        publicKey: workspace.publicKey,
        logoUpdatedAt: widgetSettings.logoUpdatedAt,
      })
      .from(workspace)
      .leftJoin(widgetSettings, eq(widgetSettings.workspaceId, workspace.id))
      .where(eq(workspace.id, workspaceId));
    const [written] = await tx
      .select({ body: message.body, deletedAt: message.deletedAt })
      .from(message)
      .where(and(eq(message.workspaceId, workspaceId), eq(message.id, row.messageId)));
    if (place === undefined || written === undefined) return null;
    const from: Place = {
      name: place.name,
      logoUrl: imageUrls(options.imageOrigin).logo(place.publicKey, place.logoUpdatedAt),
    };
    if (row.visitorId !== null) {
      // A reply email is not skipped when its own reply was deleted: it carries every unread one.
      const plan =
        row.channel === "transcript"
          ? await transcriptPlan(tx, row, row.visitorId, from, options)
          : await replyEmailPlan(tx, row, row.visitorId, from, options);
      if (plan?.channel === "email" && plan.carries !== undefined) {
        await recordCoverage(tx, row, plan.carries);
      }
      return plan;
    }
    const threadUrl = new URL(threadPath(workspaceId, conversationId), publicUrl).href;
    const handoff = await handoffNote(tx, workspaceId, row.eventSeq);
    if (handoff !== null) return operatorPlan(tx, row, from, { handoff }, threadUrl);
    // A visitor's message deleted while its alert waited has nothing to alert about.
    if (written.deletedAt !== null) return null;
    return operatorPlan(tx, row, from, { body: written.body }, threadUrl);
  });
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

/**
 * Records the first and last message an email carries, in the transaction that read them, which
 * receipts and edits read.
 */
async function recordCoverage(
  tx: Transaction,
  row: ClaimedDelivery,
  carries: { fromSeq: bigint; toSeq: bigint },
): Promise<void> {
  await tx
    .update(alertDelivery)
    .set({ coveredFromSeq: carries.fromSeq, coveredToSeq: carries.toSeq })
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
  place: Place,
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
  // Every unread reply to this visitor, because other replies waited for this row to send. The key
  // share lock makes an edit or a delete wait until this email's range is recorded. It is no
  // stronger, so a read or a resent quote, which update other columns, never waits in a cycle.
  const replies = await tx
    .select({
      seq: message.seq,
      body: message.body,
      replyTo: messageColumns.replyTo,
      authorVisitorId: message.authorVisitorId,
      authorOperatorId: message.authorOperatorId,
      authorApiKeyId: message.authorApiKeyId,
    })
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
    .for("key share", { of: message });
  // The visitor came back and read everything, or a transcript carried it.
  if (replies.length === 0) return null;
  // Fan-out set the due time, but a slow retry of an earlier row can have sent since then.
  const sent = await sentToday(tx, workspaceId, visitorId);
  if (sent.length >= VISITOR_EMAILS_PER_DAY) return null;
  const lastReplyEmail = sent.find((one) => one.channel === "email");
  const earliest = (lastReplyEmail?.finishedAt.getTime() ?? 0) + REPLY_EMAIL_GAP_MS;
  if (earliest > Date.now()) return { channel: "later", until: new Date(earliest) };
  replies.reverse();
  const stopUrl = emailStopUrl(publicUrl, secret, workspaceId, target.email);
  // A new link for each email. Older ones keep working until they expire.
  const chatUrl = chatLinkUrl(
    publicUrl,
    await createChatLink(tx, workspaceId, visitorId, conversationId),
  );
  const authors = await messageAuthors(tx, workspaceId, replies);
  const written = replies.map((reply) => ({
    author: visitorAuthorName(reply, authors, place.name),
    body: reply.body,
    quote: visitorQuote(reply.replyTo),
  }));
  return {
    channel: "email",
    to: target.email,
    ...replyLetter(place, written, { chatUrl, stopUrl }),
    stopUrl,
    carries: { fromSeq: replies[0]?.seq ?? 0n, toSeq: replies.at(-1)?.seq ?? 0n },
  };
}

// Markdown's paragraphs come bare, and a mail app's default margins would pad the bubble unevenly.
const bubbleParagraphs = (html: string) => html.replaceAll("<p>", '<p style="margin:0 0 8px">');

// The quiet line above a chat bubble that says who wrote it.
const authorLineHtml = (words: string, top: number) =>
  `<p style="margin:${top}px 0 6px;color:${EMAIL_COLORS.muted};font-size:13px">${escapeHtml(words)}</p>`;

/** A message in an email's HTML: a chat bubble with its quote and its Markdown as formatting. */
const bubbleHtml = (body: string, quote: Quote | null) =>
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px"><tr>' +
  `<td style="background:${EMAIL_COLORS.bubble};border-radius:4px 18px 18px 18px;padding:12px 16px 4px;font-size:16px;line-height:1.45">` +
  `${quotedHtml(quote, bubbleParagraphs(markdownHtml(body)))}</td></tr></table>`;

/**
 * A reply in the HTML: its bubble, under who replied when the reply before it had another author,
 * as a chat groups one person's messages.
 */
const replyHtml = (
  reply: { author: string; body: string; quote: Quote | null },
  index: number,
  replies: { author: string }[],
) =>
  (replies[index - 1]?.author === reply.author
    ? ""
    : authorLineHtml(text.replied(reply.author), index === 0 ? 0 : 12)) +
  bubbleHtml(reply.body, reply.quote);

/**
 * The reply email's words: each reply under its quote. The visitor typed this address, and nobody
 * proved it, so it greets no name. The HTML leaves out the greeting and the sign-off, because its
 * header and its subject say who wrote.
 */
export function replyLetter(
  place: Place,
  replies: { author: string; body: string | null; quote: Quote | null }[],
  links: { chatUrl: string; stopUrl: string },
): { subject: string; text: string; html: string } {
  const written = replies.map((reply) => ({ ...reply, body: messageText(reply.body) }));
  const plain = written.map((reply) => quotedText(reply.quote, reply.body)).join("\n\n");
  return {
    subject: text.replySubject(place.name),
    text: letter(
      text.replyBody(place.name, plain, links.chatUrl, links.stopUrl),
      undefined,
      place.name,
    ),
    // The replies' Markdown shows as formatting here, and stays as typed in the text version.
    html: visitorLetterHtml(place.name, written.map(replyHtml).join(""), {
      ...links,
      logoUrl: place.logoUrl,
      chatLabel: text.replyInChat,
    }),
  };
}

/**
 * The handoff note that a row's event names, or null when its event is not a handoff. The event is
 * pruned long after its alerts are sent, and without it the alert reads as a message's.
 */
async function handoffNote(tx: Transaction, workspaceId: string, eventSeq: string) {
  const [row] = await tx
    .select({ body: message.body })
    .from(event)
    .innerJoin(
      message,
      and(
        eq(message.workspaceId, event.workspaceId),
        sql`${message.id} = (${event.payload}->>'noteId')::uuid`,
      ),
    )
    .where(
      and(
        eq(event.workspaceId, workspaceId),
        eq(event.seq, BigInt(eventSeq)),
        eq(event.kind, "conversation.handled"),
      ),
    );
  return row?.body ?? null;
}

/** What an operator's alert says: a message's text, or a handoff's note. */
type AlertText = { body: string | null } | { handoff: string };

/** A push or an email to the operator this row is for, if they are still a member who wants it. */
async function operatorPlan(
  tx: Transaction,
  row: ClaimedDelivery,
  place: Place,
  said: AlertText,
  threadUrl: string,
): Promise<AlertPlan | null> {
  const placeName = place.name;
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
        body: Array.from("handoff" in said ? said.handoff : messageText(said.body))
          .slice(0, PUSH_BODY_CHARACTERS)
          .join(""),
        tag: `${workspaceId}:${row.eventSeq}`,
        url: threadPath(workspaceId, conversationId),
      },
    };
  }
  // The operator may have turned email off while this row waited for a retry.
  if (!member.wantsEmail) return null;
  const isHandoff = "handoff" in said;
  const body = isHandoff ? said.handoff : messageText(said.body);
  const wrote = isHandoff
    ? text.handoffWrote(placeName)
    : text.operatorWrote(
        (await conversationVisitor(tx, workspaceId, conversationId))?.email ?? text.visitor,
        placeName,
      );
  return {
    channel: "email",
    to: member.email,
    subject: isHandoff ? text.handoffSubject(placeName) : text.operatorSubject(placeName),
    text: letter(
      [wrote, body, `${text.operatorOpen}: ${threadUrl}`, text.operatorWhy],
      member.name,
    ),
    // The message sits in a bubble, so it stands out from the lines around it.
    html: letterHtml({
      team: placeName,
      logoUrl: place.logoUrl,
      html: authorLineHtml(wrote, 0) + bubbleHtml(body, null),
      action: { label: text.operatorOpen, url: threadUrl },
      footer: [escapeHtml(text.operatorWhy)],
    }),
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
