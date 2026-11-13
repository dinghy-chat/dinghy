// What happens to a message after it is sent: an operator edits or deletes it, and the emails that
// carried it decide whether it may still change and what its receipt says.

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  alertDelivery,
  attachment,
  event,
  type MessagePayload,
  message,
  storageDeletion,
  visitor,
  workspace,
} from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import {
  conversationVisitor,
  isWritten,
  mentionable,
  messageColumns,
  nextSeq,
  type StoredMessage,
  stored,
  wantsWebhook,
} from "./messages.ts";
import { RETENTION_MS } from "./time.ts";

interface EmailCoverage {
  fromSeq: bigint;
  toSeq: bigint;
  /** "sending": planned, and its claim has not run out. */
  state: "sent" | "failed" | "sending";
  finishedAt: Date | null;
}

/**
 * The reply emails and transcripts that carried messages of this conversation, from the range each
 * one recorded when it was planned. A reply email carries replies from every conversation of the
 * visitor, and a transcript its own conversation's. Receipts, the edit lock and a message's info
 * all read this one source. A range is exact: `nextSeq` holds the workspace row until commit, so
 * every message below the newest one a plan read had committed before it, and the plan saw it.
 */
async function emailCoverage(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  visitorId: string,
): Promise<EmailCoverage[]> {
  const rows = await tx
    .select({
      fromSeq: alertDelivery.coveredFromSeq,
      toSeq: alertDelivery.coveredToSeq,
      outcome: alertDelivery.outcome,
      finishedAt: alertDelivery.finishedAt,
    })
    .from(alertDelivery)
    .where(
      and(
        eq(alertDelivery.workspaceId, workspaceId),
        eq(alertDelivery.visitorId, visitorId),
        or(
          eq(alertDelivery.channel, "email"),
          and(
            eq(alertDelivery.channel, "transcript"),
            eq(alertDelivery.conversationId, conversationId),
          ),
        ),
        or(
          inArray(alertDelivery.outcome, ["sent", "failed"]),
          and(isNull(alertDelivery.finishedAt), gt(alertDelivery.claimedUntil, sql`now()`)),
        ),
      ),
    );
  return rows.flatMap(({ fromSeq, toSeq, outcome, finishedAt }): EmailCoverage[] =>
    fromSeq === null || toSeq === null || outcome === "skipped"
      ? []
      : [{ fromSeq, toSeq, finishedAt, state: outcome ?? "sending" }],
  );
}

/** The emails that carried the message at this position. */
const carrying = (coverage: EmailCoverage[], seq: bigint) =>
  coverage.filter((email) => email.fromSeq <= seq && seq <= email.toSeq);

/**
 * How far the visitor has seen the replies in one conversation: read in the chat up to `readSeq`,
 * and the ranges that sent and failed emails carried.
 */
export async function replyReceipts(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  visitorId: string,
): Promise<{ readSeq: bigint; emails: { fromSeq: bigint; toSeq: bigint; sent: boolean }[] }> {
  const [reader] = await tx
    .select({ lastReadSeq: visitor.lastReadSeq })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  const coverage = await emailCoverage(tx, workspaceId, conversationId, visitorId);
  return {
    readSeq: reader?.lastReadSeq ?? 0n,
    emails: coverage
      .filter((email) => email.state !== "sending")
      .map(({ fromSeq, toSeq, state }) => ({ fromSeq, toSeq, sent: state === "sent" })),
  };
}

/**
 * The event of an edit or a delete, as a new message's, so the webhook fan-out reads it alike. An
 * edit that mentions new members alerts them.
 */
async function recordMessageChange(
  tx: Transaction,
  workspaceId: string,
  seq: bigint,
  kind: "message.updated" | "message.deleted",
  row: { id: string; conversationId: string; authorVisitorId: string | null },
  newlyMentioned: string[],
): Promise<void> {
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind,
    payload: {
      messageId: row.id,
      conversationId: row.conversationId,
      fromVisitor: row.authorVisitorId !== null,
      ...(newlyMentioned.length > 0 && { mentions: newlyMentioned }),
    } satisfies MessagePayload,
    needsAlert: newlyMentioned.length > 0,
    needsWebhook: wantsWebhook(workspaceId),
  });
}

/**
 * Sends again every reply that quotes this message, so an open chat shows its quote as it is now.
 * Each gets a position of its own, because a stream pages by them. The caller holds the workspace
 * lock, and the positions it takes have no event, a gap that is harmless.
 */
async function resendQuotes(tx: Transaction, workspaceId: string, messageId: string) {
  await tx.execute(sql`
    with quoting as (
      select id, row_number() over (order by seq) as n from ${message}
      where workspace_id = ${workspaceId} and reply_to_message_id = ${messageId}),
    taken as (
      update ${workspace} set event_seq = event_seq + (select count(*) from quoting)
      where id = ${workspaceId}
      returning event_seq - (select count(*) from quoting) as base)
    update ${message} set changed_seq = taken.base + quoting.n
    from quoting, taken
    where ${message.workspaceId} = ${workspaceId} and ${message.id} = quoting.id`);
}

/** One chat line or note of this conversation, locked until commit, or undefined. */
async function lockChatLine(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  messageId: string,
) {
  const [row] = await tx
    .select({
      id: message.id,
      conversationId: message.conversationId,
      seq: message.seq,
      kind: message.kind,
      authorOperatorId: message.authorOperatorId,
      authorVisitorId: message.authorVisitorId,
      metadata: message.metadata,
      deletedAt: message.deletedAt,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.id, messageId),
        eq(message.conversationId, conversationId),
        isWritten(),
      ),
    )
    .for("update");
  return row;
}

/**
 * Whether the visitor may have seen a reply: read it in the chat, or got an email that carried it,
 * sent or being sent now. The caller holds the visitor's row lock, which a read takes too, so a read
 * cannot slip in before the edit commits. An email that has not been planned reads the new body.
 * The record of an email is pruned after RETENTION_MS, and an email always goes after the reply it
 * carries, so a reply older than that counts as seen.
 */
async function visitorMaySee(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  reader: { id: string; lastReadSeq: bigint },
  line: { seq: bigint; createdAt: Date },
): Promise<boolean> {
  if (reader.lastReadSeq >= line.seq) return true;
  if (Date.now() - line.createdAt.getTime() >= RETENTION_MS) return true;
  const coverage = await emailCoverage(tx, workspaceId, conversationId, reader.id);
  return carrying(coverage, line.seq).some((email) => email.state !== "failed");
}

type EditOutcome =
  | { kind: "edited"; message: StoredMessage; visitorId: string }
  | { kind: "missing" }
  | { kind: "not_yours" }
  | { kind: "seen" };

/**
 * A note's metadata with the members it now mentions, and those of them it did not mention before.
 * Removing a mention alerts nobody.
 */
async function changedMentions(
  tx: Transaction,
  workspaceId: string,
  operatorId: string,
  metadata: unknown,
  named: string[],
) {
  const { mentions: before = [], ...rest } = metadata as { mentions?: string[] };
  const mentions = await mentionable(tx, workspaceId, named, operatorId);
  return {
    metadata: mentions.length > 0 ? { ...rest, mentions } : rest,
    added: mentions.filter((id) => !before.includes(id)),
  };
}

/**
 * Changes the text of an operator's own reply while the visitor cannot have seen it, or of their own
 * note at any time, as the visitor never sees one. A note's mentions change with it, and a reply has
 * none. Its event tells the widget, the other operators and the webhooks, in the same transaction.
 */
export async function editMessage(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  messageId: string,
  operatorId: string,
  /** Mentions left out keep the note's. */
  change: { body: string; mentions?: string[] | undefined },
): Promise<EditOutcome> {
  const seq = await nextSeq(tx, workspaceId);
  const reader = await conversationVisitor(tx, workspaceId, conversationId, "no key update");
  if (reader === undefined) return { kind: "missing" };
  const line = await lockChatLine(tx, workspaceId, conversationId, messageId);
  if (line === undefined || line.deletedAt !== null) return { kind: "missing" };
  const isNote = line.kind === "note";
  if (line.authorOperatorId !== operatorId || !(line.kind === "text" || isNote)) {
    return { kind: "not_yours" };
  }
  if (!isNote && (await visitorMaySee(tx, workspaceId, conversationId, reader, line))) {
    return { kind: "seen" };
  }
  const mentions =
    isNote && change.mentions !== undefined
      ? await changedMentions(tx, workspaceId, operatorId, line.metadata, change.mentions)
      : null;
  const [row] = await tx
    .update(message)
    .set({
      body: change.body,
      editedAt: sql`now()`,
      changedSeq: seq,
      ...(mentions !== null && { metadata: mentions.metadata }),
    })
    .where(and(eq(message.workspaceId, workspaceId), eq(message.id, messageId)))
    .returning(messageColumns);
  if (row === undefined) throw new Error("The message update returned no row");
  await recordMessageChange(tx, workspaceId, seq, "message.updated", line, mentions?.added ?? []);
  await resendQuotes(tx, workspaceId, messageId);
  return { kind: "edited", message: stored(row), visitorId: reader.id };
}

type DeleteOutcome =
  | { kind: "deleted"; visitorId: string; isNote: boolean }
  | { kind: "missing" }
  | { kind: "not_yours" };

/**
 * Clears a message's body and image, and keeps its row, so positions, receipts and quotes still
 * work. The worker deletes the image's file, as for a deleted conversation. `mayDeleteAnyone` is
 * set for an owner or an admin; others delete their own.
 */
export async function deleteMessage(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  messageId: string,
  by: { operatorId: string; mayDeleteAnyone: boolean },
): Promise<DeleteOutcome> {
  const seq = await nextSeq(tx, workspaceId);
  const reader = await conversationVisitor(tx, workspaceId, conversationId, "no key update");
  if (reader === undefined) return { kind: "missing" };
  const line = await lockChatLine(tx, workspaceId, conversationId, messageId);
  if (line === undefined) return { kind: "missing" };
  if (!by.mayDeleteAnyone && line.authorOperatorId !== by.operatorId) return { kind: "not_yours" };
  const deleted = { kind: "deleted", visitorId: reader.id, isNote: line.kind === "note" } as const;
  if (line.deletedAt !== null) return deleted;
  await tx
    .update(message)
    .set({
      body: null,
      deletedAt: sql`now()`,
      changedSeq: seq,
      metadata: sql`${message.metadata} - 'image'`,
    })
    .where(and(eq(message.workspaceId, workspaceId), eq(message.id, messageId)));
  const files = await tx
    .delete(attachment)
    .where(and(eq(attachment.workspaceId, workspaceId), eq(attachment.messageId, messageId)))
    .returning({ storageKey: attachment.storageKey });
  if (files.length > 0) {
    await tx
      .insert(storageDeletion)
      .values(files.map(({ storageKey }) => ({ workspaceId, storageKey })));
  }
  await recordMessageChange(tx, workspaceId, seq, "message.deleted", line, []);
  await resendQuotes(tx, workspaceId, messageId);
  return deleted;
}

/** When the first email that carried this message was sent. Null when none did, or it was pruned. */
export async function emailedAt(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  line: { conversationId: string; seq: bigint },
): Promise<Date | null> {
  const coverage = await emailCoverage(tx, workspaceId, line.conversationId, visitorId);
  const times = carrying(coverage, line.seq).flatMap((email) =>
    email.state === "sent" && email.finishedAt !== null ? [email.finishedAt.getTime()] : [],
  );
  return times.length === 0 ? null : new Date(Math.min(...times));
}
