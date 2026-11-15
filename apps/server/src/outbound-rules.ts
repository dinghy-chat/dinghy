import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { gateOf } from "./bots.ts";
import { type Condition, toSql } from "./conditions.ts";
import {
  apiKey,
  conversation,
  event,
  type OutboundEventKind,
  type OutboundPayload,
  type OutboundStatus,
  type OutboundStatusReason,
  outboundMessage,
  outboundOnce,
  visitor,
  workspaceMember,
} from "./db/schema.ts";
import { type Transaction, workspaceAccess, writable } from "./db/tenant.ts";
import { nextSeq, wantsWebhook } from "./messages.ts";

// What may happen to an outbound message, and the writes that record each change.

type Row = typeof outboundMessage.$inferSelect;

/** The statuses in which a message still waits for the visitor. */
export const WAITING_STATUSES = ["scheduled", "pending", "delivered", "read"] as const;
/** The statuses a cancel or an expiry may end: the visitor has not read it. */
const UNREAD_STATUSES = ["scheduled", "pending", "delivered"] as const;
/** The statuses in which the widget shows a message. */
export const SHOWN_STATUSES = ["pending", "delivered", "read"] as const;

export const isOneOf = (statuses: readonly OutboundStatus[], status: OutboundStatus) =>
  statuses.includes(status);

/** A message that a cancel or an expiry may end: unread, and outside a conversation. */
export const isEndable = (row: Pick<Row, "status" | "conversationId">) =>
  row.conversationId === null && isOneOf(UNREAD_STATUSES, row.status);

/** The rows `isEndable` accepts, as SQL. */
export const endable = and(
  inArray(outboundMessage.status, [...UNREAD_STATUSES]),
  isNull(outboundMessage.conversationId),
);

/** A message whose time ran out before the visitor read it: it ends as expired, and goes nowhere. */
export const hasExpired = (row: Row) =>
  isEndable(row) && row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();

/** Who made a message, as a message author or a status actor names them. */
export function authorRef(row: Pick<Row, "authorApiKeyId" | "authorOperatorId">) {
  if (row.authorApiKeyId !== null) return { kind: "key" as const, apiKeyId: row.authorApiKeyId };
  if (row.authorOperatorId !== null) {
    return { kind: "operator" as const, operatorId: row.authorOperatorId };
  }
  throw new Error("An outbound message has no author");
}

// Changes ------------------------------------------------------------------------------------------

/** Records a change of an outbound message. The worker sends its webhooks. */
async function record(
  tx: Transaction,
  workspaceId: string,
  row: Pick<Row, "id" | "visitorId">,
  kind: OutboundEventKind,
): Promise<void> {
  const seq = await nextSeq(tx, workspaceId);
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind,
    payload: { outboundMessageId: row.id, visitorId: row.visitorId } satisfies OutboundPayload,
    needsWebhook: wantsWebhook(workspaceId),
  });
}

export const ofRow = (workspaceId: string, id: string) =>
  and(eq(outboundMessage.workspaceId, workspaceId), eq(outboundMessage.id, id));

/**
 * Updates one row and answers it as it is now. It changes the row only while its status and its
 * conversation are still those the caller read, so a stale row never overwrites a cancel, a reply or
 * a conversation.
 */
export async function change(
  tx: Transaction,
  workspaceId: string,
  row: Row,
  values: Partial<typeof outboundMessage.$inferInsert>,
  kind?: OutboundEventKind,
): Promise<Row> {
  const [changed] = await tx
    .update(outboundMessage)
    .set(values)
    .where(
      and(
        ofRow(workspaceId, row.id),
        eq(outboundMessage.status, row.status),
        row.conversationId === null
          ? isNull(outboundMessage.conversationId)
          : eq(outboundMessage.conversationId, row.conversationId),
      ),
    )
    .returning();
  if (changed === undefined) throw new Error("The outbound message changed since it was read");
  if (kind !== undefined) await record(tx, workspaceId, changed, kind);
  return changed;
}

/** Ends a message that waited: cancelled, and its `once` key free again, or expired. */
export async function end(
  tx: Transaction,
  workspaceId: string,
  row: Row,
  outcome: { status: "cancelled"; reason: OutboundStatusReason } | { status: "expired" },
): Promise<Row> {
  if (outcome.status === "expired") {
    return change(
      tx,
      workspaceId,
      row,
      { status: "expired", dueAt: null },
      "outbound_message.expired",
    );
  }
  await tx
    .delete(outboundOnce)
    .where(
      and(eq(outboundOnce.workspaceId, workspaceId), eq(outboundOnce.outboundMessageId, row.id)),
    );
  return change(
    tx,
    workspaceId,
    row,
    { status: "cancelled", statusReason: outcome.reason, cancelledAt: new Date(), dueAt: null },
    "outbound_message.cancelled",
  );
}

// The decision -----------------------------------------------------------------------------------

/** What a message may do now, from everything that can stop it. */
interface Situation {
  writable: boolean;
  blocked: boolean;
  botsPaused: boolean;
  /** The key that sent it, or null for a member's. */
  key: KeyState | null;
  /** Whether the member it shows as is still on the team. True for any other sender. */
  senderActive: boolean;
  /** The visitor's open conversation, or null. */
  open: { id: string; humanSince: Date | null } | null;
  /** The `unless` condition matches the contact now. */
  unlessMatched: boolean;
}

/** What the key that sent a message may do now. */
export interface KeyState {
  revoked: boolean;
  replyMode: "send" | "draft";
  mayActAsMember: boolean;
  maySendEmail: boolean;
}

type Verdict =
  | { kind: "go" }
  | { kind: "join"; conversationId: string }
  | { kind: "wait"; reason: OutboundStatusReason }
  | { kind: "cancel"; reason: OutboundStatusReason };

/**
 * The one decision for a message about to show or go in a conversation. A check that can change,
 * such as paused bots, makes it wait. One that holds for good, such as `unless`, cancels it. A key's
 * message follows the reply gate: it never joins a conversation that a person handles.
 */
export function decide(
  message: Pick<Row, "authorApiKeyId" | "senderKind" | "ifOpen" | "email">,
  state: Situation,
): Verdict {
  if (state.blocked) return { kind: "cancel", reason: "blocked" };
  if (state.unlessMatched) return { kind: "cancel", reason: "unless_matched" };
  if (state.key?.revoked === true || !state.senderActive) {
    return { kind: "cancel", reason: "permission_revoked" };
  }
  if (!state.writable) return { kind: "wait", reason: "workspace_inactive" };
  if (message.senderKind === "member" && state.key !== null && !state.key.mayActAsMember) {
    return { kind: "wait", reason: "permission_revoked" };
  }
  if (message.email && state.key !== null && !state.key.maySendEmail) {
    return { kind: "wait", reason: "permission_revoked" };
  }
  if (state.open !== null && message.ifOpen === "skip") {
    return { kind: "cancel", reason: "open_conversation_skipped" };
  }
  if (state.open !== null && message.ifOpen === "hold") {
    return { kind: "wait", reason: "open_conversation" };
  }
  if (message.authorApiKeyId !== null) {
    const gate = gateOf({
      botsPaused: state.botsPaused,
      replyMode: state.key?.replyMode,
      humanSince: state.open?.humanSince ?? null,
    });
    if (gate === "draft") return { kind: "wait", reason: "permission_revoked" };
    if (gate !== "send") return { kind: "wait", reason: gate };
  }
  return state.open === null ? { kind: "go" } : { kind: "join", conversationId: state.open.id };
}

/** Whether a condition matches one contact now: the same SQL as the contacts filter. */
export async function matches(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  condition: Condition,
) {
  const [row] = await tx
    .select({ matched: sql<boolean>`${toSql(condition)}` })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  return row?.matched === true;
}

/** Whether the team blocked the visitor. A visitor that is gone counts as blocked. */
export async function isBlocked(tx: Transaction, workspaceId: string, visitorId: string) {
  const [who] = await tx
    .select({ blockedAt: visitor.blockedAt })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  return who === undefined || who.blockedAt !== null;
}

/** Reads what decides a message now. The caller holds the workspace lock. */
export async function situation(
  tx: Transaction,
  workspaceId: string,
  row: Row,
  { botsPaused, checkUnless }: { botsPaused: boolean; checkUnless: boolean },
): Promise<Situation> {
  const [open] = await tx
    .select({ id: conversation.id, humanSince: conversation.humanSince })
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.visitorId, row.visitorId),
        eq(conversation.status, "open"),
      ),
    )
    .orderBy(desc(conversation.createdAt))
    .limit(1);
  return {
    writable: writable(await workspaceAccess(tx, workspaceId)),
    blocked: await isBlocked(tx, workspaceId, row.visitorId),
    botsPaused,
    key: row.authorApiKeyId === null ? null : await keyState(tx, workspaceId, row.authorApiKeyId),
    senderActive:
      row.senderOperatorId === null || (await isMember(tx, workspaceId, row.senderOperatorId)),
    open: open ?? null,
    unlessMatched:
      checkUnless &&
      row.unless !== null &&
      (await matches(tx, workspaceId, row.visitorId, row.unless)),
  };
}

export async function keyState(
  tx: Transaction,
  workspaceId: string,
  apiKeyId: string,
): Promise<KeyState> {
  const [key] = await tx
    .select({
      revokedAt: apiKey.revokedAt,
      replyMode: apiKey.replyMode,
      permissions: apiKey.permissions,
    })
    .from(apiKey)
    .where(and(eq(apiKey.workspaceId, workspaceId), eq(apiKey.id, apiKeyId)));
  if (key === undefined) {
    return { revoked: true, replyMode: "draft", mayActAsMember: false, maySendEmail: false };
  }
  return {
    revoked: key.revokedAt !== null,
    replyMode: key.replyMode,
    mayActAsMember: key.permissions.includes("send_as_member"),
    maySendEmail: key.permissions.includes("send_email"),
  };
}

export async function isMember(tx: Transaction, workspaceId: string, operatorId: string) {
  const [member] = await tx
    .select({ id: workspaceMember.operatorId })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.operatorId, operatorId),
        isNull(workspaceMember.removedAt),
      ),
    );
  return member !== undefined;
}
