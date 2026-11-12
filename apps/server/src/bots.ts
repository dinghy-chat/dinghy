import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  apiKey,
  conversation,
  draftReply,
  event,
  message,
  operator,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { createDraft, type DraftView, findDraft } from "./drafts.ts";
import {
  appendMessage,
  assignConversation,
  lockWorkspace,
  messageColumns,
  nextSeq,
  type StoredMessage,
  stored,
  wantsWebhook,
} from "./messages.ts";

// Every string a person reads has a key, so a locale can be added later.
const text = {
  handoffNote: (reason: string, summary: string | undefined) =>
    summary === undefined ? `Handed off: ${reason}` : `Handed off: ${reason}\n\n${summary}`,
};

/**
 * What a conversation's handler change was: a person took it, by a reply or a bot's handoff, or
 * a person gave it back to the bots. The `conversation.handled` event's payload names it, and the
 * webhooks send `conversation.handoff` and `conversation.given_back`.
 */
type HandledChange = "human" | "handoff" | "given_back";

export interface HandledPayload {
  conversationId: string;
  change: HandledChange;
  /** On a handoff: the note message that holds the reason, and the newest chat line, for the alert. */
  noteId?: string | undefined;
  messageId?: string | undefined;
}

/** What a key's reply may do now, read under the workspace row lock. */
export type KeyGate = "send" | "draft" | "bots_paused" | "human_handling";

/**
 * Takes the workspace row lock and decides what a key's reply does. A retry of a reply that went in
 * gets its first answer, whatever changed since. Then a pause stops every bot, a draft-mode key
 * drafts, which it may while a person handles the conversation, and a send-mode key stays quiet
 * while a person handles it.
 */
export async function keyGate(
  tx: Transaction,
  workspaceId: string,
  apiKeyId: string,
  conversationId: string,
  clientId: string,
): Promise<KeyGate> {
  const { botsPaused } = await lockWorkspace(tx, workspaceId);
  const result = await tx.execute<{ sent: boolean; drafted: boolean }>(sql`
    select exists (
             select 1 from ${message}
             where ${message.workspaceId} = ${workspaceId} and ${message.authorApiKeyId} = ${apiKeyId}
               and ${message.clientId} = ${clientId}
           ) as sent,
           exists (
             select 1 from ${draftReply}
             where ${draftReply.workspaceId} = ${workspaceId} and ${draftReply.apiKeyId} = ${apiKeyId}
               and ${draftReply.clientId} = ${clientId}
           ) as drafted`);
  const retry = result.rows[0];
  if (retry?.sent === true) return "send";
  if (retry?.drafted === true) return "draft";
  if (botsPaused) return "bots_paused";
  const [row] = await tx
    .select({ replyMode: apiKey.replyMode, humanSince: conversation.humanSince })
    .from(apiKey)
    .leftJoin(
      conversation,
      and(eq(conversation.workspaceId, apiKey.workspaceId), eq(conversation.id, conversationId)),
    )
    .where(and(eq(apiKey.workspaceId, workspaceId), eq(apiKey.id, apiKeyId)));
  if (row?.replyMode === "draft") return "draft";
  return row?.humanSince === null || row === undefined ? "send" : "human_handling";
}

/** Writes a `conversation.handled` event. */
async function handled(
  tx: Transaction,
  workspaceId: string,
  payload: HandledPayload,
  alert = false,
) {
  const seq = await nextSeq(tx, workspaceId);
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind: "conversation.handled",
    payload,
    needsAlert: alert,
    needsWebhook: payload.change === "human" ? false : wantsWebhook(workspaceId),
  });
}

const ofConversation = (workspaceId: string, conversationId: string) =>
  and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId));

/** An operator replied: a person handles the conversation from now, so bots stay quiet. */
export async function takeOver(tx: Transaction, workspaceId: string, conversationId: string) {
  const taken = await tx
    .update(conversation)
    .set({ humanSince: sql`now()` })
    .where(and(ofConversation(workspaceId, conversationId), isNull(conversation.humanSince)))
    .returning({ id: conversation.id });
  if (taken.length > 0) await handled(tx, workspaceId, { conversationId, change: "human" });
}

/** An operator gives the conversation back to the bots. False when it does not exist. */
export async function giveBack(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
  await lockWorkspace(tx, workspaceId);
  const [row] = await tx
    .select({ humanSince: conversation.humanSince })
    .from(conversation)
    .where(ofConversation(workspaceId, conversationId));
  if (row === undefined) return false;
  if (row.humanSince === null) return true;
  await tx
    .update(conversation)
    .set({ humanSince: null })
    .where(ofConversation(workspaceId, conversationId));
  await handled(tx, workspaceId, { conversationId, change: "given_back" });
  return true;
}

/**
 * Pauses or resumes every bot of the workspace, under the row lock that each key reply takes.
 * Answers the name of who paused them, or null when bots run.
 */
export async function setBotsPaused(
  tx: Transaction,
  workspaceId: string,
  operatorId: string,
  paused: boolean,
): Promise<string | null> {
  await tx
    .update(workspace)
    .set(
      paused
        ? {
            botsPausedAt: sql`coalesce(${workspace.botsPausedAt}, now())`,
            botsPausedBy: operatorId,
          }
        : { botsPausedAt: null, botsPausedBy: null },
    )
    .where(eq(workspace.id, workspaceId));
  if (!paused) return null;
  const [pauser] = await tx
    .select({ name: operator.name })
    .from(operator)
    .where(eq(operator.id, operatorId));
  return pauser?.name ?? null;
}

export interface HandoffInput {
  clientId: string;
  reason: string;
  summary?: string | undefined;
  operatorId?: string | undefined;
  visitorMessage?: string | undefined;
}

/** What became of the handoff's message to the visitor. */
type HandoffMessage =
  | { status: "sent"; message: StoredMessage }
  | { status: "drafted"; draft: DraftView }
  | { status: "not_sent"; reason: "bots_paused" };

export type HandoffOutcome =
  | { kind: "handed_off"; created: boolean; visitorMessage: HandoffMessage | null }
  | { kind: "missing" }
  | { kind: "closed" }
  | { kind: "not_member" };

/** The key's message to the visitor: sent, drafted or held back, as its reply would be. */
async function handoffMessage(
  tx: Transaction,
  workspaceId: string,
  key: { apiKeyId: string; via?: "mcp" },
  conversationId: string,
  input: HandoffInput,
): Promise<HandoffMessage | null> {
  if (input.visitorMessage === undefined) return null;
  const reply = { clientId: input.clientId, body: input.visitorMessage };
  const gate = await keyGate(tx, workspaceId, key.apiKeyId, conversationId, input.clientId);
  if (gate === "bots_paused") return { status: "not_sent", reason: "bots_paused" };
  if (gate === "draft") {
    const made = await createDraft(tx, workspaceId, key.apiKeyId, conversationId, reply);
    return { status: "drafted", draft: made.draft };
  }
  // The handoff's own message goes even while a person handles it: it tells the visitor who takes over.
  const author = { kind: "key" as const, apiKeyId: key.apiKeyId, conversationId };
  const sent = await appendMessage(tx, workspaceId, author, {
    ...reply,
    ...(key.via !== undefined && { via: key.via }),
  });
  return { status: "sent", message: sent.message };
}

/**
 * The clientId of a handoff's note. The visitor message takes the key's own clientId, and a colon is
 * outside what a client may send, so no reply or note of the key can take this one.
 */
const handoffNoteClientId = (clientId: string) => `handoff:${clientId}`;

/**
 * The first result of a handoff that went in before with this clientId, or undefined when none did.
 * Its note marks it done. Its message went out or became a draft, or else bots were paused.
 */
async function earlierHandoff(
  tx: Transaction,
  workspaceId: string,
  apiKeyId: string,
  input: HandoffInput,
): Promise<HandoffMessage | null | undefined> {
  const byKey = (clientId: string) =>
    and(
      eq(message.workspaceId, workspaceId),
      eq(message.authorApiKeyId, apiKeyId),
      eq(message.clientId, clientId),
    );
  const [noted] = await tx
    .select({ id: message.id })
    .from(message)
    .where(byKey(handoffNoteClientId(input.clientId)));
  if (noted === undefined) return undefined;
  if (input.visitorMessage === undefined) return null;
  const [sent] = await tx.select(messageColumns).from(message).where(byKey(input.clientId));
  if (sent !== undefined) return { status: "sent", message: stored(sent) };
  const draft = await findDraft(tx, workspaceId, apiKeyId, input.clientId);
  if (draft !== undefined) return { status: "drafted", draft };
  return { status: "not_sent", reason: "bots_paused" };
}

async function isMember(tx: Transaction, workspaceId: string, operatorId: string) {
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

/** The newest message of the conversation that is not a note, which a handoff's alert names. */
async function newestMessageId(tx: Transaction, workspaceId: string, conversationId: string) {
  const [row] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.conversationId, conversationId),
        ne(message.kind, "note"),
      ),
    )
    .orderBy(desc(message.seq))
    .limit(1);
  return row?.id;
}

/**
 * A bot hands a conversation to people, in one transaction: its message to the visitor, the
 * assignee, the handler, a note with the reason, and an event that alerts the assignee, or every
 * member when there is none. A retry with the same clientId changes nothing and answers the first
 * result, even after the conversation or the pause changed.
 */
export async function handoff(
  tx: Transaction,
  workspaceId: string,
  key: { apiKeyId: string; via?: "mcp" },
  conversationId: string,
  input: HandoffInput,
): Promise<HandoffOutcome> {
  await lockWorkspace(tx, workspaceId);
  const earlier = await earlierHandoff(tx, workspaceId, key.apiKeyId, input);
  if (earlier !== undefined) return { kind: "handed_off", created: false, visitorMessage: earlier };
  const [target] = await tx
    .select({ status: conversation.status })
    .from(conversation)
    .where(ofConversation(workspaceId, conversationId));
  if (target === undefined) return { kind: "missing" };
  if (target.status !== "open") return { kind: "closed" };
  if (input.operatorId !== undefined && !(await isMember(tx, workspaceId, input.operatorId))) {
    return { kind: "not_member" };
  }
  const visitorMessage = await handoffMessage(tx, workspaceId, key, conversationId, input);
  // A note alerts nobody: the handoff's own event alerts the people who take over.
  const noted = await appendMessage(
    tx,
    workspaceId,
    { kind: "key", apiKeyId: key.apiKeyId, conversationId },
    {
      clientId: handoffNoteClientId(input.clientId),
      body: text.handoffNote(input.reason, input.summary),
      note: true,
      ...(key.via !== undefined && { via: key.via }),
    },
  );
  if (input.operatorId !== undefined) {
    await assignConversation(tx, workspaceId, conversationId, input.operatorId);
  }
  await tx
    .update(conversation)
    .set({
      humanSince: sql`coalesce(${conversation.humanSince}, now())`,
      handoffByApiKeyId: key.apiKeyId,
    })
    .where(ofConversation(workspaceId, conversationId));
  const messageId = await newestMessageId(tx, workspaceId, conversationId);
  const payload = {
    conversationId,
    change: "handoff" as const,
    noteId: noted.message.id,
    messageId,
  };
  // The alert names a message, which a conversation always has: the visitor's first.
  await handled(tx, workspaceId, payload, messageId !== undefined);
  return { kind: "handed_off", created: true, visitorMessage };
}

/**
 * Whether a key's typing may show to the visitor, as its send would go. Null when the conversation
 * does not exist or is closed.
 */
export async function typingGate(
  tx: Transaction,
  workspaceId: string,
  apiKeyId: string,
  conversationId: string,
): Promise<{ gate: KeyGate; visitorId: string } | null> {
  const [row] = await tx
    .select({
      visitorId: conversation.visitorId,
      humanSince: conversation.humanSince,
      botsPausedAt: workspace.botsPausedAt,
      replyMode: apiKey.replyMode,
    })
    .from(conversation)
    .innerJoin(workspace, eq(workspace.id, conversation.workspaceId))
    .innerJoin(
      apiKey,
      and(eq(apiKey.workspaceId, conversation.workspaceId), eq(apiKey.id, apiKeyId)),
    )
    .where(and(ofConversation(workspaceId, conversationId), eq(conversation.status, "open")));
  if (row === undefined) return null;
  const gate: KeyGate =
    row.botsPausedAt !== null
      ? "bots_paused"
      : row.replyMode === "draft"
        ? "draft"
        : row.humanSince !== null
          ? "human_handling"
          : "send";
  return { gate, visitorId: row.visitorId };
}
