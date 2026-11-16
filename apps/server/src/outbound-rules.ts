import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { gateOf } from "./bots.ts";
import { type CampaignCheck, campaignCheck } from "./campaign-checks.ts";
import { tallyChange } from "./campaign-results.ts";
import { matchesContact } from "./conditions.ts";
import {
  apiKey,
  conversation,
  event,
  type OutboundEventKind,
  type OutboundPayload,
  type OutboundStatus,
  type OutboundStatusReason,
  outboundDedupe,
  outboundMessage,
  visitor,
  workspaceMember,
} from "./db/schema.ts";
import { type Transaction, workspaceAccess, writable } from "./db/tenant.ts";
import { nextSeq, wantsWebhook } from "./messages.ts";

// What may happen to an outbound message, and the writes that record each change.

type Row = typeof outboundMessage.$inferSelect;

/** The statuses in which a message still waits for the visitor. */
export const WAITING_STATUSES = ["scheduled", "sent", "delivered", "read"] as const;
/** The statuses a cancel or an expiry may end: the visitor has not read it. */
const UNREAD_STATUSES = ["scheduled", "sent", "delivered"] as const;
/** The statuses in which the widget shows a message. */
export const SHOWN_STATUSES = ["sent", "delivered", "read"] as const;

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
  await tallyChange(tx, workspaceId, row, changed, kind);
  return changed;
}

/** Ends a message that waited: cancelled, and its `dedupeKey` free again, or expired. */
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
    .delete(outboundDedupe)
    .where(
      and(
        eq(outboundDedupe.workspaceId, workspaceId),
        eq(outboundDedupe.outboundMessageId, row.id),
      ),
    );
  return change(
    tx,
    workspaceId,
    row,
    { status: "cancelled", statusReason: outcome.reason, cancelledAt: new Date(), dueAt: null },
    "outbound_message.cancelled",
  );
}

/**
 * Cancels every message that `which` names and a cancel may still end, with the reason. The caller
 * holds the workspace lock. Answers the visitors whose messages ended, each once.
 */
export async function cancelWhere(
  tx: Transaction,
  workspaceId: string,
  which: SQL,
  reason: OutboundStatusReason,
): Promise<string[]> {
  const rows = await tx
    .select()
    .from(outboundMessage)
    .where(and(eq(outboundMessage.workspaceId, workspaceId), endable, which))
    .for("update");
  for (const row of rows) await end(tx, workspaceId, row, { status: "cancelled", reason });
  return [...new Set(rows.map((row) => row.visitorId))];
}

// The decision -----------------------------------------------------------------------------------

/** What a message may do now, from everything that can stop it. */
interface Situation {
  writable: boolean;
  blocked: boolean;
  /** The visitor turned off automatic messages. */
  optedOut: boolean;
  botsPaused: boolean;
  /** The key that sent it, or null for a member's. */
  key: KeyState | null;
  /** Whether the member it shows as is still on the team. True for any other sender. */
  senderActive: boolean;
  /** The visitor's open conversation, or null. */
  open: { id: string; humanSince: Date | null } | null;
  /** The `unless` condition matches the contact now. */
  unlessMatched: boolean;
  /** What its campaign says, checked when it is about to become sent. Null otherwise. */
  campaign: CampaignCheck | null;
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
  // `until` is when to look again: null waits for a change that wakes it, such as a resume, and
  // undefined looks again soon.
  | { kind: "wait"; reason: OutboundStatusReason; until?: Date | null | undefined }
  | { kind: "cancel"; reason: OutboundStatusReason };

type Message = Pick<
  Row,
  "authorApiKeyId" | "campaignId" | "senderKind" | "ifConversationOpen" | "sendEmail"
>;

/** A message that no person wrote: a key's or a campaign's. The opt-out and the reply gate hold. */
const isAutomatic = (message: Pick<Row, "authorApiKeyId" | "campaignId">) =>
  message.authorApiKeyId !== null || message.campaignId !== null;

/** What a campaign's checks say, or null when they let the message go. */
function campaignVerdict(check: CampaignCheck): Verdict | null {
  if (check.status === "ended") return { kind: "cancel", reason: "campaign_ended" };
  if (check.exited) return { kind: "cancel", reason: "unless_matched" };
  if (check.goalReached) return { kind: "cancel", reason: "goal_reached" };
  if (!check.audienceMatched) return { kind: "cancel", reason: "audience_unmatched" };
  if (check.status !== "live") return { kind: "wait", reason: "campaign_paused", until: null };
  if (check.closed !== null) return { kind: "wait", ...check.closed };
  if (check.capped) return { kind: "cancel", reason: "frequency_capped" };
  return null;
}

/**
 * The one decision for a message about to show or go in a conversation. A check that can change,
 * such as paused bots, makes it wait. One that holds for good, such as `unless`, cancels it. A key's
 * message follows the reply gate: it never joins a conversation that a person handles.
 */
export function decide(message: Message, state: Situation): Verdict {
  if (state.blocked) return { kind: "cancel", reason: "blocked" };
  if (state.unlessMatched) return { kind: "cancel", reason: "unless_matched" };
  if (state.optedOut && isAutomatic(message)) return { kind: "cancel", reason: "opted_out" };
  const fromCampaign = state.campaign === null ? null : campaignVerdict(state.campaign);
  if (fromCampaign !== null) return fromCampaign;
  if (state.key?.revoked === true || !state.senderActive) {
    return { kind: "cancel", reason: "permission_revoked" };
  }
  if (!state.writable) return { kind: "wait", reason: "workspace_inactive" };
  if (message.senderKind === "member" && state.key !== null && !state.key.mayActAsMember) {
    return { kind: "wait", reason: "permission_revoked" };
  }
  if (message.sendEmail && state.key !== null && !state.key.maySendEmail) {
    return { kind: "wait", reason: "permission_revoked" };
  }
  if (state.open !== null && message.ifConversationOpen === "skip") {
    return { kind: "cancel", reason: "open_conversation_skipped" };
  }
  if (state.open !== null && message.ifConversationOpen === "hold") {
    return { kind: "wait", reason: "open_conversation" };
  }
  if (isAutomatic(message)) {
    const gate = gateOf({
      // A campaign waits for its own pause, which is apart from the bots'.
      botsPaused: message.campaignId === null && state.botsPaused,
      replyMode: state.key?.replyMode,
      humanSince: state.open?.humanSince ?? null,
    });
    if (gate === "draft") return { kind: "wait", reason: "permission_revoked" };
    if (gate !== "send") return { kind: "wait", reason: gate };
  }
  return state.open === null ? { kind: "go" } : { kind: "join", conversationId: state.open.id };
}

/**
 * Whether the team blocked the visitor, and whether they turned off automatic messages. A visitor
 * that is gone counts as blocked.
 */
export async function visitorFlags(tx: Transaction, workspaceId: string, visitorId: string) {
  const [who] = await tx
    .select({
      blockedAt: visitor.blockedAt,
      optedOutAt: visitor.optedOutAt,
      isTest: visitor.isTest,
    })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  return {
    blocked: who === undefined || who.blockedAt !== null,
    optedOut: who?.optedOutAt != null,
    isTest: who?.isTest === true,
  };
}

/**
 * A message as the decision reads it: a row, or a page campaign's card, which has none until the
 * visitor answers, for a visitor who may not exist yet.
 */
export type Draft = Pick<
  Row,
  "authorApiKeyId" | "senderOperatorId" | "unless" | "campaignId" | "fromCode"
> & { id: string | null; visitorId: string | null };

/** The visitor's open conversation, or null. */
async function openConversation(tx: Transaction, workspaceId: string, visitorId: string) {
  const [open] = await tx
    .select({ id: conversation.id, humanSince: conversation.humanSince })
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.visitorId, visitorId),
        eq(conversation.status, "open"),
      ),
    )
    .orderBy(desc(conversation.createdAt))
    .limit(1);
  return open ?? null;
}

const NOBODY = { blocked: false, optedOut: false, isTest: false };

/**
 * Reads what decides a message now. `atSendTime` also checks its `unless` and its campaign, as it
 * is about to become sent. The caller holds the workspace lock.
 */
export async function situation(
  tx: Transaction,
  workspaceId: string,
  draft: Draft,
  { botsPaused, atSendTime }: { botsPaused: boolean; atSendTime: boolean },
): Promise<Situation> {
  const { campaignId, visitorId } = draft;
  const { blocked, optedOut, isTest } =
    visitorId === null ? NOBODY : await visitorFlags(tx, workspaceId, visitorId);
  return {
    writable: writable(await workspaceAccess(tx, workspaceId)),
    blocked,
    optedOut,
    botsPaused,
    key:
      draft.authorApiKeyId === null ? null : await keyState(tx, workspaceId, draft.authorApiKeyId),
    senderActive:
      draft.senderOperatorId === null || (await isMember(tx, workspaceId, draft.senderOperatorId)),
    open: visitorId === null ? null : await openConversation(tx, workspaceId, visitorId),
    unlessMatched:
      atSendTime &&
      visitorId !== null &&
      draft.unless !== null &&
      (await matchesContact(tx, workspaceId, visitorId, draft.unless)),
    // A test visitor sees a campaign's message whatever its rules say, as "Send a test" shows it.
    campaign:
      atSendTime && campaignId !== null && !isTest
        ? await campaignCheck(tx, workspaceId, { ...draft, campaignId })
        : null,
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
