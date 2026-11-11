// The whole conversation by email: at a close, after a delay, or when an operator asks for it.

import { and, desc, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import { escapeHtml, markdownHtml } from "../../../packages/widget/src/markdown.ts";
import { firstName } from "../../../packages/widget/src/shared.ts";
import type {
  AlertPlan,
  ClaimedDelivery,
  DeliveryBase,
  DeliveryRow,
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
  workspace,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { EMAIL_COLORS, letter, letterHtml } from "./letter.ts";
import {
  conversationVisitor,
  isChat,
  joinVisitor,
  type MessageAuthor,
  messageAuthors,
  messageColumns,
  nextSeq,
  type StatusPayload,
  visitorQuote,
} from "./messages.ts";
import { imageUrls } from "./public-images.ts";
import { MINUTE_MS } from "./time.ts";
import {
  emailStopped,
  emailStopUrl,
  quotedHtml,
  quotedText,
  sentToday,
  VISITOR_EMAILS_PER_DAY,
  visitorEmailText,
} from "./visitor-email.ts";

// The transcript waits, so a quick reopen cancels it.
export const TRANSCRIPT_DELAY_MS = 5 * MINUTE_MS;
// The most messages a transcript holds, the newest ones. The chat link has the rest.
const TRANSCRIPT_MESSAGES = 500;

// Every string a person reads has a key, so a locale can be added later.
const text = {
  someone: "A visitor",
  subject: (name: string) => `Your conversation with ${name}`,
  intro: (name: string) => `Here is your conversation with ${name}, for your records.`,
  image: "Sent an image. Open the chat to see it.",
  line: (who: string, when: string) => `${who}, ${when}`,
  body: <Messages>(name: string, messages: Messages, chat: string, stop: string) => [
    text.intro(name),
    messages,
    `Continue the chat: ${chat}`,
    visitorEmailText.linkWarning,
    visitorEmailText.whyYouGotThis(name, stop),
  ],
};

/**
 * A close: one transcript to the visitor after a delay, when the visitor has an email, the workspace
 * sends transcripts, someone on the team replied, and no transcript holds every message already.
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
  const result = await tx.execute<{ last_seq: string | null; replied: boolean }>(sql`
    select max(seq) as last_seq, coalesce(bool_or(author_visitor_id is null), false) as replied
    from ${message}
    where workspace_id = ${workspaceId} and conversation_id = ${conversationId}
      and ${isChat()}`);
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
  if (line.authorVisitorId !== null) return visitorEmailText.you;
  const id = line.authorOperatorId ?? line.authorApiKeyId ?? "";
  const author = authors.get(id);
  if (author === undefined) return text.someone;
  return line.authorApiKeyId !== null || author.isDeleted ? author.name : firstName(author.name);
}

/**
 * The whole conversation by email. A close's transcript sends nothing when the conversation was
 * reopened, or when a later close made another. A reply email waits for it, and leaves out the
 * replies it carried once it is sent, so the visitor does not get both.
 */
export async function transcriptPlan(
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
  if ((await sentToday(tx, workspaceId, visitorId)).length >= VISITOR_EMAILS_PER_DAY) return null;
  // The key share lock makes an edit wait until this transcript's range is recorded, as for a reply
  // email.
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
          isChat(),
          isNull(message.deletedAt),
        ),
      )
      .orderBy(desc(message.seq))
      .limit(TRANSCRIPT_MESSAGES)
      .for("key share", { of: message })
  ).reverse();
  if (lines.length === 0) return null;
  const authors = await messageAuthors(tx, workspaceId, lines);
  const chatUrl = chatLinkUrl(
    publicUrl,
    await createChatLink(tx, workspaceId, visitorId, conversationId),
  );
  const stopUrl = emailStopUrl(publicUrl, secret, workspaceId, state.email);
  const heads = lines.map((line) =>
    text.line(transcriptAuthor(line, authors), utcTime(line.createdAt)),
  );
  const plain = lines
    .map(
      (line, index) =>
        `${heads[index]}:\n${quotedText(visitorQuote(line.replyTo), line.kind === "image" ? text.image : (line.body ?? ""))}`,
    )
    .join("\n\n");
  const logoUrl = imageUrls(imageOrigin).logo(state.publicKey, state.logoUpdatedAt);
  const html = [
    logoUrl === null
      ? ""
      : `<p><img src="${escapeHtml(logoUrl)}" width="48" height="48" alt="" style="border-radius:10px"></p>`,
    ...lines.map(
      (line, index) =>
        `<p style="margin:18px 0 2px;color:${EMAIL_COLORS.muted};font-size:13px">${escapeHtml(heads[index] ?? "")}</p>` +
        quotedHtml(
          visitorQuote(line.replyTo),
          line.kind === "image"
            ? `<p><a href="${escapeHtml(chatUrl)}">${escapeHtml(text.image)}</a></p>`
            : markdownHtml(line.body ?? ""),
        ),
    ),
  ].join("");
  return {
    channel: "email",
    to: state.email,
    subject: text.subject(placeName),
    text: letter(text.body(placeName, plain, chatUrl, stopUrl), undefined, placeName),
    html: letterHtml(text.body(placeName, { html }, chatUrl, stopUrl), placeName),
    stopUrl,
    carries: { fromSeq: lines[0]?.seq ?? 0n, toSeq: lines.at(-1)?.seq ?? 0n },
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
