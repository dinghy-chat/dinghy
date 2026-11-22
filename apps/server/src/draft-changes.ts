import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { type ChangeRequestedPayload, draftChangeRequest, draftReply, event } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import {
  type ChangeRequestView,
  createDraft,
  type DraftView,
  findDraft,
  findDrafts,
  lockDraft,
  ofDraft,
} from "./drafts.ts";
import {
  conversationIsOpen,
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

/** A change request's own columns. Its draft's conversation and key come from a join. */
const requestColumns = {
  id: draftChangeRequest.id,
  draftId: draftChangeRequest.draftId,
  instruction: draftChangeRequest.instruction,
  status: draftChangeRequest.status,
  createdAt: draftChangeRequest.createdAt,
  resolvedAt: draftChangeRequest.resolvedAt,
  replacementDraftId: draftChangeRequest.replacementDraftId,
};
type ChangeRequestRow = Awaited<ReturnType<typeof selectChangeRequests>>[number];

const changeRequestView = (row: ChangeRequestRow): ChangeRequestView => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
});

/** Change requests with their draft's conversation and key. */
const selectChangeRequests = (tx: Transaction, workspaceId: string, condition: SQL | undefined) =>
  tx
    .select({
      ...requestColumns,
      conversationId: draftReply.conversationId,
      apiKeyId: draftReply.apiKeyId,
    })
    .from(draftChangeRequest)
    .innerJoin(
      draftReply,
      and(
        eq(draftReply.workspaceId, draftChangeRequest.workspaceId),
        eq(draftReply.id, draftChangeRequest.draftId),
      ),
    )
    .where(and(eq(draftChangeRequest.workspaceId, workspaceId), condition));

/** The change requests that match, with their draft's conversation and key. */
async function changeRequestsWhere(
  tx: Transaction,
  workspaceId: string,
  condition: SQL | undefined,
): Promise<ChangeRequestView[]> {
  return (await selectChangeRequests(tx, workspaceId, condition)).map(changeRequestView);
}

const ofRequest = (workspaceId: string, id: string) =>
  and(eq(draftChangeRequest.workspaceId, workspaceId), eq(draftChangeRequest.id, id));

/** A change request goes only to the key that wrote its draft. Every other event goes to every key. */
export const isForKey = (kind: string, payload: unknown, apiKeyId: string) =>
  kind !== "draft.change_requested" || (payload as ChangeRequestedPayload).apiKeyId === apiKeyId;

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
  if ((await lockDraft(tx, workspaceId, conversationId, draftId)) === undefined) {
    return { kind: "missing" };
  }
  const [same] = await changeRequestsWhere(
    tx,
    workspaceId,
    and(eq(draftChangeRequest.draftId, draftId), eq(draftChangeRequest.clientId, input.clientId)),
  );
  if (same !== undefined) return { kind: "asked", changeRequest: same, created: false };
  const draft = (await findDrafts(tx, workspaceId, [draftId])).get(draftId);
  if (draft === undefined) throw new Error("A locked draft has no row");
  if (draft.status !== "open") return { kind: "not_waiting" };
  if (!(await conversationIsOpen(tx, workspaceId, conversationId))) return { kind: "closed" };
  if (!draft.canAskToChange) return { kind: "rewrites_off" };
  if (draft.changeRequest !== null) return { kind: "pending", changeRequest: draft.changeRequest };
  const { apiKeyId } = draft;
  const [made] = await tx
    .insert(draftChangeRequest)
    .values({ workspaceId, draftId, operatorId, ...input })
    .returning(requestColumns);
  if (made === undefined) throw new Error("The change request insert returned no row");
  await recordChangeRequested(tx, workspaceId, {
    conversationId,
    changeRequestId: made.id,
    apiKeyId,
  });
  const changeRequest = changeRequestView({ ...made, conversationId, apiKeyId });
  return { kind: "asked", changeRequest, created: true };
}

/** Cancels a request that waits. Answers the request as it is now, or undefined when there is none. */
export async function cancelChangeRequest(
  tx: Transaction,
  workspaceId: string,
  target: { conversationId: string; draftId: string; changeRequestId: string },
): Promise<ChangeRequestView | undefined> {
  await lockWorkspace(tx, workspaceId);
  const [found] = await changeRequestsWhere(
    tx,
    workspaceId,
    and(
      eq(draftChangeRequest.id, target.changeRequestId),
      eq(draftChangeRequest.draftId, target.draftId),
      eq(draftReply.conversationId, target.conversationId),
    ),
  );
  if (found?.status !== "pending") return found;
  const [cancelled] = await tx
    .update(draftChangeRequest)
    .set({ status: "cancelled", resolvedAt: sql`now()` })
    .where(ofRequest(workspaceId, found.id))
    .returning(requestColumns);
  if (cancelled === undefined) throw new Error("The change request update returned no row");
  await recordConversationChange(tx, workspaceId, target.conversationId, "draft.changed");
  const { conversationId, apiKeyId } = found;
  return changeRequestView({ ...cancelled, conversationId, apiKeyId });
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
    eq(draftChangeRequest.id, input.changeRequestId),
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
    .set({ resolved: "replaced", resolvedAt: sql`now()` })
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
