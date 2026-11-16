// The whole conversation by email: at a close, after a delay, or when an operator asks for it.

import { and, desc, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import { escapeHtml, markdownHtml } from "../../../packages/widget/src/markdown.ts";
import type {
  AlertPlan,
  ClaimedDelivery,
  DeliveryBase,
  DeliveryRow,
  Place,
  PlanOptions,
} from "./alerts.ts";
import { chatLinkUrl, createChatLink } from "./chat-link.ts";
import {
  alertDelivery,
  conversation,
  event,
  message,
  visitor,
  widgetSettings,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { createReplyAddress } from "./inbound-email.ts";
import { EMAIL_COLORS, mailParagraphs } from "./letter.ts";
import {
  conversationVisitor,
  filename,
  isChat,
  joinVisitor,
  type MessageAuthor,
  messageAuthors,
  messageColumns,
  nextSeq,
  type QuoteRow,
  type StatusPayload,
  visitorQuote,
} from "./messages.ts";
import { MINUTE_MS } from "./time.ts";
import {
  emailStopped,
  emailStopUrl,
  quotedHtml,
  quotedText,
  sentToday,
  VISITOR_EMAILS_PER_DAY,
  type VisitorLinks,
  visitorAuthorName,
  visitorLetterHtml,
  visitorLetterText,
} from "./visitor-email.ts";
import { type VisitorWords, visitorWords } from "./visitor-words.ts";

// The transcript waits, so a quick reopen cancels it.
export const TRANSCRIPT_DELAY_MS = 5 * MINUTE_MS;
// A transcript holds the newest messages up to both limits, so Gmail does not clip it at 102 KB
// and hide the footer with the stop link. The chat link has the rest.
const TRANSCRIPT_MESSAGES = 100;
const TRANSCRIPT_CHARACTERS = 40_000;

/**
 * The last message a sent transcript of the conversation carried, or -1 with none. A close's
 * transcript starts after it, so the visitor gets each message once, even when a close sent nothing.
 */
async function lastSentSeq(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
): Promise<bigint> {
  const [row] = await tx
    .select({ seq: sql<string | null>`max(${alertDelivery.coveredToSeq})` })
    .from(alertDelivery)
    .where(
      and(
        eq(alertDelivery.workspaceId, workspaceId),
        eq(alertDelivery.conversationId, conversationId),
        eq(alertDelivery.channel, "transcript"),
        eq(alertDelivery.outcome, "sent"),
      ),
    );
  return row?.seq == null ? -1n : BigInt(row.seq);
}

/** The newest messages that fit both limits, oldest first. The newest one always fits. */
export function newestThatFit<T extends { body: string | null }>(newestFirst: T[]): T[] {
  const kept: T[] = [];
  let characters = 0;
  for (const line of newestFirst.slice(0, TRANSCRIPT_MESSAGES)) {
    characters += line.body?.length ?? 0;
    if (kept.length > 0 && characters > TRANSCRIPT_CHARACTERS) break;
    kept.push(line);
  }
  return kept.reverse();
}

/**
 * A close: one transcript to the visitor after a delay, when the visitor has an email, the workspace
 * sends transcripts, someone on the team replied since the last sent transcript, and no transcript
 * holds every message already.
 */
export async function transcriptRows(tx: Transaction, base: DeliveryBase): Promise<DeliveryRow[]> {
  const { workspaceId, conversationId } = base;
  const target = await conversationVisitor(tx, workspaceId, conversationId);
  if (target === undefined || target.email === null) return [];
  const [settings] = await tx
    .select({ wanted: widgetSettings.transcript })
    .from(widgetSettings)
    .where(eq(widgetSettings.workspaceId, workspaceId));
  if (settings?.wanted !== true) return [];
  if (await emailStopped(tx, workspaceId, target.email)) return [];
  const after = await lastSentSeq(tx, workspaceId, conversationId);
  const result = await tx.execute<{ last_seq: string | null; replied: boolean }>(sql`
    select max(seq) as last_seq, coalesce(bool_or(author_visitor_id is null), false) as replied
    from ${message}
    where workspace_id = ${workspaceId} and conversation_id = ${conversationId}
      and seq > ${after.toString()}::bigint and ${isChat()}`);
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
export async function requestedTranscriptRows(
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
 * The conversation by email. A close's transcript holds the messages since the last sent
 * transcript, and one an operator asks for holds the whole conversation, both within the limits.
 * A close's transcript sends nothing when the conversation was reopened, or when a later close made
 * another. A reply email waits for it, and leaves out the replies it carried once it is sent, so the
 * visitor does not get both.
 */
export async function transcriptPlan(
  tx: Transaction,
  row: ClaimedDelivery,
  visitorId: string,
  place: Place,
  { publicUrl, secret, inboundDomain }: PlanOptions,
): Promise<AlertPlan | null> {
  const { workspaceId, conversationId, messageId, eventSeq } = row;
  const [state] = await tx
    .select({
      status: conversation.status,
      email: visitor.email,
      locale: visitor.locale,
      fromClose: sql<boolean>`exists (select 1 from ${message} where ${message.workspaceId} = ${workspaceId} and ${message.id} = ${messageId} and ${message.kind} = 'closed')`,
      later: sql<boolean>`exists (select 1 from ${alertDelivery} where ${alertDelivery.workspaceId} = ${workspaceId} and ${alertDelivery.conversationId} = ${conversationId} and ${alertDelivery.channel} = 'transcript' and ${alertDelivery.eventSeq} > ${eventSeq}::bigint)`,
    })
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  if (state === undefined || state.email === null) return null;
  if (state.fromClose && (state.status !== "closed" || state.later)) return null;
  if (await emailStopped(tx, workspaceId, state.email)) return null;
  if ((await sentToday(tx, workspaceId, visitorId)).length >= VISITOR_EMAILS_PER_DAY) return null;
  const after = state.fromClose ? await lastSentSeq(tx, workspaceId, conversationId) : -1n;
  const range = and(
    eq(message.workspaceId, workspaceId),
    eq(message.conversationId, conversationId),
    gt(message.seq, after),
    isChat(),
    isNull(message.deletedAt),
  );
  const [counted] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      replied: sql<boolean>`coalesce(bool_or(${message.authorVisitorId} is null), false)`,
    })
    .from(message)
    .where(range);
  if (counted === undefined || (state.fromClose && !counted.replied)) return null;
  // The key share lock makes an edit wait until this transcript's range is recorded, as for a reply
  // email.
  const lines = newestThatFit(
    await tx
      .select({
        seq: message.seq,
        body: message.body,
        filename: filename(),
        kind: message.kind,
        authorVisitorId: message.authorVisitorId,
        authorOperatorId: message.authorOperatorId,
        authorApiKeyId: message.authorApiKeyId,
        replyTo: messageColumns.replyTo,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(range)
      .orderBy(desc(message.seq))
      .limit(TRANSCRIPT_MESSAGES)
      .for("key share", { of: message }),
  );
  if (lines.length === 0) return null;
  const part = { since: after >= 0n, leftOut: counted.total - lines.length };
  const authors = await messageAuthors(tx, workspaceId, lines);
  const chatUrl = chatLinkUrl(
    publicUrl,
    await createChatLink(tx, workspaceId, visitorId, conversationId),
  );
  const stopUrl = emailStopUrl(publicUrl, secret, workspaceId, state.email);
  const replyTo =
    inboundDomain === undefined
      ? undefined
      : {
          name: place.name,
          address: await createReplyAddress(
            tx,
            workspaceId,
            visitorId,
            conversationId,
            inboundDomain,
          ),
        };
  const links = { chatUrl, stopUrl, canReply: replyTo !== undefined };
  return {
    channel: "email",
    to: state.email,
    ...transcriptLetter(place, lines, authors, links, visitorWords(state.locale), part),
    stopUrl,
    replyTo,
    carries: { fromSeq: lines[0]?.seq ?? 0n, toSeq: lines.at(-1)?.seq ?? 0n },
  };
}

/** A message as a transcript shows it. */
interface TranscriptLine {
  body: string | null;
  /** Null for any message but a file, and once the file was removed. */
  filename: string | null;
  kind: (typeof message.$inferSelect)["kind"];
  authorVisitorId: string | null;
  authorOperatorId: string | null;
  authorApiKeyId: string | null;
  replyTo: QuoteRow | null;
  createdAt: Date;
}

/**
 * What a transcript says in place of an image or a file, which the email never carries: the chat
 * has them. Null for text.
 */
const standIn = (line: TranscriptLine, words: VisitorWords) =>
  line.kind === "image"
    ? words.transcriptImage
    : line.kind === "file"
      ? words.transcriptFile(line.filename)
      : null;

/**
 * Which part of the conversation a transcript holds: only what came after the last sent transcript,
 * and how many earlier messages of its range the limits left out.
 */
interface TranscriptPart {
  since: boolean;
  leftOut: number;
}

/** The transcript's words: each message under its author and time, as text and as HTML. */
export function transcriptLetter(
  place: Place,
  lines: TranscriptLine[],
  authors: Map<string, MessageAuthor>,
  links: VisitorLinks,
  words: VisitorWords,
  part: TranscriptPart = { since: false, leftOut: 0 },
): { subject: string; text: string; html: string } {
  const { chatUrl } = links;
  const intro = [
    part.since ? words.transcriptSince(place.name) : words.transcriptIntro(place.name),
    ...(part.leftOut > 0 ? [words.transcriptLeftOut(part.leftOut)] : []),
  ];
  const heads = lines.map(
    (line) =>
      `${visitorAuthorName(line, authors, place.name, words)}, ${words.time(line.createdAt)}`,
  );
  const plain = lines
    .map(
      (line, index) =>
        `${words.lead(heads[index] ?? "")}\n${quotedText(visitorQuote(line.replyTo), standIn(line, words) ?? line.body ?? "", words)}`,
    )
    .join("\n\n");
  const html = [
    ...intro.map((paragraph) => `<p style="margin:0 0 8px">${escapeHtml(paragraph)}</p>`),
    ...lines.map((line, index) => {
      const shown = standIn(line, words);
      return (
        `<p style="margin:16px 0 4px;color:${EMAIL_COLORS.muted};font-size:13px">${escapeHtml(heads[index] ?? "")}</p>` +
        quotedHtml(
          visitorQuote(line.replyTo),
          mailParagraphs(
            shown === null
              ? markdownHtml(line.body ?? "")
              : `<p><a href="${escapeHtml(chatUrl)}">${escapeHtml(shown)}</a></p>`,
          ),
          words,
        )
      );
    }),
  ].join("");
  const paragraphs = [...intro, plain, `${words.lead(words.continueChat)} ${chatUrl}`];
  return {
    subject: words.transcriptSubject(place.name),
    text: visitorLetterText(place.name, paragraphs, links, words),
    html: visitorLetterHtml(
      place.name,
      html,
      { ...links, logoUrl: place.logoUrl, chatLabel: words.continueChat },
      words,
    ),
  };
}

/**
 * Asks the worker to email the visitor this conversation now, through the event table, so it goes
 * at least once. The payload names the newest message that is not deleted, as a transcript carries.
 * False with no message to send.
 */
async function requestTranscript(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  const [newest] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.conversationId, conversationId),
        isChat(),
        isNull(message.deletedAt),
      ),
    )
    .orderBy(desc(message.seq))
    .limit(1);
  if (newest === undefined) return false;
  const seq = await nextSeq(tx, workspaceId);
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind: "transcript.requested",
    payload: { conversationId, messageId: newest.id } satisfies StatusPayload,
    needsAlert: true,
  });
  return true;
}
