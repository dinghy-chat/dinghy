import { z } from "@hono/zod-openapi";
import { and, desc, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import { apiKey, conversation, draftReply, event } from "./db/schema.ts";
import { type Transaction, workspaceAccess, writable } from "./db/tenant.ts";
import {
  type Author,
  appendMessage,
  ConversationClosedError,
  checkQuote,
  InvalidReplyToError,
  lockWorkspace,
  nextSeq,
  type StoredMessage,
  WorkspaceClosedError,
} from "./messages.ts";

/** At most this many drafts in one list. */
const DRAFTS_LISTED = 100;

const DRAFT_STATUSES = ["open", "stale", "sent", "discarded"] as const;

export const DraftSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    // The key that wrote it, and its name, which a sent draft does not carry: the operator who
    // sends it becomes the author.
    apiKeyId: z.string(),
    authorName: z.string(),
    clientId: z.string(),
    body: z.string(),
    replyToMessageId: z.string().nullable(),
    // `open` waits for an operator. `stale` waits too, but the visitor wrote after it. `sent` and
    // `discarded` are an operator's decision.
    status: z.enum(DRAFT_STATUSES),
    createdAt: z.string(),
    staleAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    // The message an operator sent from it.
    sentMessageId: z.string().nullable(),
  })
  .openapi("Draft");
export type DraftView = z.infer<typeof DraftSchema>;

const draftColumns = {
  id: draftReply.id,
  conversationId: draftReply.conversationId,
  apiKeyId: draftReply.apiKeyId,
  authorName: apiKey.name,
  clientId: draftReply.clientId,
  body: draftReply.body,
  replyToMessageId: draftReply.replyToMessageId,
  createdAt: draftReply.createdAt,
  staleAt: draftReply.staleAt,
  resolved: draftReply.resolved,
  resolvedAt: draftReply.resolvedAt,
  sentMessageId: draftReply.sentMessageId,
};
type DraftRow = Awaited<ReturnType<typeof selectDrafts>>[number];

const statusOf = (row: DraftRow): DraftView["status"] =>
  row.resolved ?? (row.staleAt === null ? "open" : "stale");

function draftView(row: DraftRow): DraftView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    apiKeyId: row.apiKeyId,
    authorName: row.authorName,
    clientId: row.clientId,
    body: row.body,
    replyToMessageId: row.replyToMessageId,
    status: statusOf(row),
    createdAt: row.createdAt.toISOString(),
    staleAt: row.staleAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    sentMessageId: row.sentMessageId,
  };
}

const selectDrafts = (tx: Transaction, workspaceId: string, condition: SQL | undefined) =>
  tx
    .select(draftColumns)
    .from(draftReply)
    .innerJoin(
      apiKey,
      and(eq(apiKey.workspaceId, draftReply.workspaceId), eq(apiKey.id, draftReply.apiKeyId)),
    )
    .where(and(eq(draftReply.workspaceId, workspaceId), condition))
    .orderBy(desc(draftReply.createdAt), desc(draftReply.id))
    .limit(DRAFTS_LISTED);

/** Tells the operator apps that a conversation's drafts changed. Drafts make no webhook. */
async function draftChanged(tx: Transaction, workspaceId: string, conversationId: string) {
  const seq = await nextSeq(tx, workspaceId);
  await tx
    .insert(event)
    .values({ workspaceId, seq, kind: "draft.changed", payload: { conversationId } });
}

/**
 * A draft-mode key's reply, which waits for an operator. A retry with the same clientId returns the
 * first. It runs under the workspace row lock, which the caller took.
 */
export async function createDraft(
  tx: Transaction,
  workspaceId: string,
  apiKeyId: string,
  conversationId: string,
  input: { clientId: string; body: string; replyToMessageId?: string | undefined },
): Promise<{ draft: DraftView; created: boolean }> {
  const same = and(eq(draftReply.apiKeyId, apiKeyId), eq(draftReply.clientId, input.clientId));
  const [existing] = await selectDrafts(tx, workspaceId, same);
  if (existing !== undefined) return { draft: draftView(existing), created: false };
  const access = await workspaceAccess(tx, workspaceId);
  if (!writable(access)) throw new WorkspaceClosedError(access);
  const [target] = await tx
    .select({ status: conversation.status })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  if (target?.status !== "open") throw new ConversationClosedError();
  if (input.replyToMessageId !== undefined) {
    await checkQuote(tx, workspaceId, conversationId, input.replyToMessageId);
  }
  await tx.insert(draftReply).values({
    workspaceId,
    conversationId,
    apiKeyId,
    clientId: input.clientId,
    body: input.body,
    replyToMessageId: input.replyToMessageId ?? null,
  });
  await draftChanged(tx, workspaceId, conversationId);
  const [made] = await selectDrafts(tx, workspaceId, same);
  if (made === undefined) throw new Error("The draft insert left no row");
  return { draft: draftView(made), created: true };
}

/** Which drafts a list holds: the ones that wait (open and stale), one of those, or all. */
export type DraftFilter = "waiting" | "open" | "stale" | "all";

const filterCondition = (filter: DraftFilter) => {
  if (filter === "all") return undefined;
  const waiting = isNull(draftReply.resolved);
  if (filter === "open") return and(waiting, isNull(draftReply.staleAt));
  if (filter === "stale") return and(waiting, isNotNull(draftReply.staleAt));
  return waiting;
};

/** Drafts, newest first, of one conversation or of the whole workspace. */
export async function listDrafts(
  tx: Transaction,
  workspaceId: string,
  conversationId: string | undefined,
  filter: DraftFilter,
): Promise<DraftView[]> {
  const rows = await selectDrafts(
    tx,
    workspaceId,
    and(
      conversationId === undefined ? undefined : eq(draftReply.conversationId, conversationId),
      filterCondition(filter),
    ),
  );
  return rows.map(draftView);
}

/** The draft that waits in this conversation, locked until commit, or why there is none. */
async function waitingDraft(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  draftId: string,
) {
  const [row] = await tx
    .select({
      resolved: draftReply.resolved,
      body: draftReply.body,
      replyToMessageId: draftReply.replyToMessageId,
      sentMessageId: draftReply.sentMessageId,
    })
    .from(draftReply)
    .where(
      and(
        eq(draftReply.workspaceId, workspaceId),
        eq(draftReply.id, draftId),
        eq(draftReply.conversationId, conversationId),
      ),
    )
    .for("update");
  return row;
}

const ofDraft = (workspaceId: string, draftId: string) =>
  and(eq(draftReply.workspaceId, workspaceId), eq(draftReply.id, draftId));

export type SentDraft =
  | { kind: "sent"; message: StoredMessage; created: boolean }
  | { kind: "missing" }
  | { kind: "discarded" };

/**
 * Sends a draft as the operator's own message, with `via: "draft"`. The operator approves the bot's
 * words, so this does not mark the conversation as handled by a person. Sending it again returns
 * the message it sent.
 */
export async function sendDraft(
  tx: Transaction,
  workspaceId: string,
  author: Extract<Author, { kind: "operator" }>,
  draftId: string,
  body: string | undefined,
): Promise<SentDraft> {
  // The workspace row lock first, as every write takes it, then the draft's row.
  await lockWorkspace(tx, workspaceId);
  const draft = await waitingDraft(tx, workspaceId, author.conversationId, draftId);
  if (draft === undefined) return { kind: "missing" };
  if (draft.resolved === "discarded") return { kind: "discarded" };
  const reply = { clientId: `draft-${draftId}`, body: body ?? draft.body, via: "draft" as const };
  const quote = draft.replyToMessageId ?? undefined;
  // The quoted message may have been deleted since the draft: then it goes without the quote.
  const appended = await appendMessage(tx, workspaceId, author, {
    ...reply,
    replyToMessageId: quote,
  }).catch((error: unknown) => {
    if (!(error instanceof InvalidReplyToError)) throw error;
    return appendMessage(tx, workspaceId, author, reply);
  });
  if (draft.resolved === null) {
    await tx
      .update(draftReply)
      .set({
        resolved: "sent",
        resolvedAt: new Date(),
        resolvedByOperatorId: author.operatorId,
        sentMessageId: appended.message.id,
      })
      .where(ofDraft(workspaceId, draftId));
    await draftChanged(tx, workspaceId, author.conversationId);
  }
  return { kind: "sent", message: appended.message, created: appended.created };
}

/** Discards a draft that waits. False when there is no such draft, or it was sent. */
export async function discardDraft(
  tx: Transaction,
  workspaceId: string,
  operatorId: string,
  conversationId: string,
  draftId: string,
): Promise<boolean> {
  await lockWorkspace(tx, workspaceId);
  const draft = await waitingDraft(tx, workspaceId, conversationId, draftId);
  if (draft === undefined || draft.resolved === "sent") return false;
  if (draft.resolved === "discarded") return true;
  await tx
    .update(draftReply)
    .set({ resolved: "discarded", resolvedAt: new Date(), resolvedByOperatorId: operatorId })
    .where(ofDraft(workspaceId, draftId));
  await draftChanged(tx, workspaceId, conversationId);
  return true;
}
