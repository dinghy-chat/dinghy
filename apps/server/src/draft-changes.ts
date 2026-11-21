import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import {
  apiKey,
  type ChangeRequestedPayload,
  conversation,
  draftChangeRequest,
  draftReply,
  event,
} from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import {
  type ChangeRequestView,
  changeRequestsWhere,
  createDraft,
  type DraftView,
  findDraft,
  findDrafts,
  lockDraft,
  ofDraft,
} from "./drafts.ts";
import {
  InvalidReplyToError,
  lockWorkspace,
  nextSeq,
  recordConversationChange,
  wantsWebhook,
} from "./messages.ts";

/** What an operator's "Ask to change" came to. */
export type AskOutcome =
  | { kind: "asked"; changeRequest: ChangeRequestView; created: boolean }
  /** Another request waits on the draft: cancel it first. */
  | { kind: "pending"; changeRequest: ChangeRequestView }
  | { kind: "missing" }
  | { kind: "closed" }
  | { kind: "not_waiting" }
  | { kind: "rewrites_off" };

const ofRequest = (workspaceId: string, id: string) =>
  and(eq(draftChangeRequest.workspaceId, workspaceId), eq(draftChangeRequest.id, id));

const onDraft = (draftId: string, condition: SQL) =>
  and(eq(draftChangeRequest.draftId, draftId), condition);

/** Whether a key answers change requests: it rewrites drafts and is not revoked. */
async function rewritesDrafts(tx: Transaction, workspaceId: string, apiKeyId: string) {
  const [key] = await tx
    .select({ rewritesDrafts: apiKey.rewritesDrafts, revokedAt: apiKey.revokedAt })
    .from(apiKey)
    .where(and(eq(apiKey.workspaceId, workspaceId), eq(apiKey.id, apiKeyId)));
  return key?.rewritesDrafts === true && key.revokedAt === null;
}

async function isOpen(tx: Transaction, workspaceId: string, conversationId: string) {
  const [found] = await tx
    .select({ status: conversation.status })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  return found?.status === "open";
}

/** Writes the event that webhooks, the key's event stream and wait_for_events deliver. */
async function recordChangeRequested(
  tx: Transaction,
  workspaceId: string,
  payload: ChangeRequestedPayload,
) {
  const seq = await nextSeq(tx, workspaceId);
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind: "draft.change_requested",
    payload,
    needsWebhook: wantsWebhook(workspaceId),
  });
}

/**
 * An operator asks the key that wrote an open draft to rewrite it. A retry with the same clientId
 * returns the first request, and only one request waits on a draft at a time.
 */
export async function askToChange(
  tx: Transaction,
  workspaceId: string,
  operatorId: string,
  target: { conversationId: string; draftId: string },
  input: { clientId: string; instruction: string },
): Promise<AskOutcome> {
  const { conversationId, draftId } = target;
  await lockWorkspace(tx, workspaceId);
  const draft = await lockDraft(tx, workspaceId, conversationId, draftId);
  if (draft === undefined) return { kind: "missing" };
  const [same] = await changeRequestsWhere(
    tx,
    workspaceId,
    onDraft(draftId, eq(draftChangeRequest.clientId, input.clientId)),
  );
  if (same !== undefined) return { kind: "asked", changeRequest: same, created: false };
  if (draft.resolved !== null || draft.staleAt !== null) return { kind: "not_waiting" };
  if (!(await isOpen(tx, workspaceId, conversationId))) return { kind: "closed" };
  if (!(await rewritesDrafts(tx, workspaceId, draft.apiKeyId))) return { kind: "rewrites_off" };
  const [pending] = await changeRequestsWhere(
    tx,
    workspaceId,
    onDraft(draftId, eq(draftChangeRequest.status, "pending")),
  );
  if (pending !== undefined) return { kind: "pending", changeRequest: pending };
  const [made] = await tx
    .insert(draftChangeRequest)
    .values({ workspaceId, draftId, operatorId, ...input })
    .returning({ id: draftChangeRequest.id });
  if (made === undefined) throw new Error("The change request insert returned no row");
  const changeRequestId = made.id;
  await recordChangeRequested(tx, workspaceId, {
    conversationId,
    changeRequestId,
    apiKeyId: draft.apiKeyId,
  });
  const [asked] = await changeRequestsWhere(tx, workspaceId, ofRequest(workspaceId, made.id));
  if (asked === undefined) throw new Error("The change request insert left no row");
  return { kind: "asked", changeRequest: asked, created: true };
}

/** Cancels a request that waits. Answers the request as it is now, or undefined when there is none. */
export async function cancelChangeRequest(
  tx: Transaction,
  workspaceId: string,
  target: { conversationId: string; draftId: string; changeRequestId: string },
): Promise<ChangeRequestView | undefined> {
  await lockWorkspace(tx, workspaceId);
  const where = and(
    ofRequest(workspaceId, target.changeRequestId),
    eq(draftChangeRequest.draftId, target.draftId),
    eq(draftReply.conversationId, target.conversationId),
  );
  const [found] = await changeRequestsWhere(tx, workspaceId, where);
  if (found?.status !== "pending") return found;
  await tx
    .update(draftChangeRequest)
    .set({ status: "cancelled", resolvedAt: sql`now()` })
    .where(ofRequest(workspaceId, found.id));
  await recordConversationChange(tx, workspaceId, target.conversationId, "draft.changed");
  const [cancelled] = await changeRequestsWhere(tx, workspaceId, where);
  return cancelled;
}

/** A key's answer to a change request: its new draft, or why there is none. */
export type ChangeAnswer =
  | { drafted: { draft: DraftView; created: boolean } }
  | "missing"
  | "bots_paused"
  | "change_request_closed"
  | "client_id_reused";

interface AnswerInput {
  changeRequestId: string;
  clientId: string;
  body: string;
  replyToMessageId?: string | undefined;
}

/**
 * The key that wrote a draft answers an operator's change request with a new draft, which replaces
 * the old one. It always drafts, whatever the key's reply mode and even while a person handles the
 * conversation: an operator asked for it. A retry with the same clientId returns the first new draft,
 * and a clientId of another draft of the key's is refused, so it never stands in for this answer.
 */
export async function answerChangeRequest(
  tx: Transaction,
  workspaceId: string,
  apiKeyId: string,
  conversationId: string,
  input: AnswerInput,
): Promise<ChangeAnswer> {
  const { botsPaused } = await lockWorkspace(tx, workspaceId);
  const [request] = await changeRequestsWhere(
    tx,
    workspaceId,
    ofRequest(workspaceId, input.changeRequestId),
  );
  if (request?.apiKeyId !== apiKeyId || request.conversationId !== conversationId) {
    return "missing";
  }
  const earlier = await findDraft(tx, workspaceId, apiKeyId, input.clientId);
  if (earlier !== undefined) {
    if (request.replacementDraftId !== earlier.id) return "client_id_reused";
    return { drafted: { draft: earlier, created: false } };
  }
  if (botsPaused) return "bots_paused";
  // Every cancel ends a request when its draft stops waiting, so a pending one has an open draft.
  const old = await lockDraft(tx, workspaceId, conversationId, request.draftId);
  if (request.status !== "pending" || old === undefined) return "change_request_closed";
  const made = await newDraft(tx, workspaceId, { apiKeyId, conversationId }, input, old);
  await tx
    .update(draftReply)
    .set({ resolved: "replaced", resolvedAt: new Date() })
    .where(ofDraft(workspaceId, request.draftId));
  await tx
    .update(draftChangeRequest)
    .set({ status: "fulfilled", resolvedAt: sql`now()`, replacementDraftId: made.draft.id })
    .where(ofRequest(workspaceId, request.id));
  return { drafted: made };
}

/**
 * The new draft. Without a quote of its own it keeps the old draft's, unless the quoted message was
 * deleted since: then it goes without.
 */
function newDraft(
  tx: Transaction,
  workspaceId: string,
  key: { apiKeyId: string; conversationId: string },
  input: AnswerInput,
  old: { replyToMessageId: string | null },
) {
  const write = (replyToMessageId: string | undefined) =>
    createDraft(tx, workspaceId, key.apiKeyId, key.conversationId, { ...input, replyToMessageId });
  if (input.replyToMessageId !== undefined || old.replyToMessageId === null) {
    return write(input.replyToMessageId);
  }
  return write(old.replyToMessageId).catch((error: unknown) => {
    if (!(error instanceof InvalidReplyToError)) throw error;
    return write(undefined);
  });
}

/** What a `draft.change_requested` event carries, by request ID: the request and its draft now. */
export async function changeRequestBodies(
  tx: Transaction,
  workspaceId: string,
  ids: string[],
): Promise<Map<string, { changeRequest: ChangeRequestView; draft: DraftView }>> {
  if (ids.length === 0) return new Map();
  const requests = await changeRequestsWhere(tx, workspaceId, inArray(draftChangeRequest.id, ids));
  const drafts = await findDrafts(
    tx,
    workspaceId,
    requests.map((one) => one.draftId),
  );
  return new Map(
    requests.flatMap((changeRequest) => {
      const draft = drafts.get(changeRequest.draftId);
      return draft === undefined ? [] : [[changeRequest.id, { changeRequest, draft }] as const];
    }),
  );
}
