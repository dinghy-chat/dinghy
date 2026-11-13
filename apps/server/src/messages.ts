import { z } from "@hono/zod-openapi";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { plainText } from "../../../packages/widget/src/markdown.ts";
import { firstName, type Locale } from "../../../packages/widget/src/shared.ts";
import {
  apiKey,
  attachment,
  CHAT_KINDS,
  conversation,
  conversationLabel,
  conversationRead,
  draftReply,
  type EventKind,
  event,
  type MessagePayload,
  message,
  operator,
  type VISITOR_KINDS,
  visitor,
  WRITTEN_KINDS,
  webhook,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import {
  type Transaction,
  type WorkspaceAccess,
  welcomeAccess,
  workspaceAccess,
  writable,
  writableFor,
} from "./db/tenant.ts";
import { type Limits, NO_LIMITS, StorageFullError } from "./limits.ts";

type MessageKind = (typeof message.$inferSelect)["kind"];

/**
 * Only what people wrote, without the status lines of a close or a reopen. A statement written by
 * hand passes its own column, such as sql`m.kind`.
 */
export const isChat = (kind: SQLWrapper = message.kind) => inArray(kind, [...CHAT_KINDS]);

/** What people wrote: the chat, and the notes only the team sees. */
export const isWritten = () => inArray(message.kind, [...WRITTEN_KINDS]);

/** Who closed or reopened a conversation, as the author of its status line. */
export type StatusActor =
  | { kind: "operator"; operatorId: string }
  | { kind: "key"; apiKeyId: string }
  | { kind: "visitor"; visitorId: string };

export type Author =
  /** A visitor's message goes to `conversationId` when set, as a reply by email does. */
  | { kind: "visitor"; visitorId: string; conversationId?: string }
  | { kind: "operator"; operatorId: string; conversationId: string }
  | { kind: "key"; apiKeyId: string; conversationId: string };

/** The earlier message a reply quotes, as every list shows it. */
export type Quote = z.infer<typeof QuoteSchema>;

/** A quote as the API shows it. */
export const QuoteSchema = z
  .object({
    // Null when the quoted message was deleted. Show "Original message deleted" then.
    id: z.string().nullable(),
    // The operator's or the API key's name, or the visitor's. Null for a visitor with no name.
    authorName: z.string().nullable(),
    fromVisitor: z.boolean(),
    // Its whole text, with its line breaks and without Markdown marks.
    text: z.string(),
    hasImage: z.boolean(),
  })
  .openapi("Quote");

/** The quote as the database reads it, before its Markdown marks go. */
export interface QuoteRow {
  id: string;
  deleted: boolean;
  fromVisitor: boolean;
  /** An operator who still has an account, whom the widget calls by first name. */
  byOperator: boolean;
  authorName: string | null;
  body: string | null;
  hasImage: boolean;
}

/** A file message's name. Null for any other message, and once the file was removed. */
export const filename = (metadata: SQLWrapper = message.metadata) =>
  sql<string | null>`${metadata} #>> '{file,name}'`;

/** What a list shows for a chat message: its text, or a file's name. Null for an image. */
export const previewBody = (body: SQLWrapper, metadata: SQLWrapper) =>
  sql<string | null>`coalesce(${body}, ${filename(metadata)})`;

/**
 * The quoted message, read in the same statement as each listed row, so a list costs one query.
 * The outer table is named, because a RETURNING clause would otherwise read the inner one.
 */
const quoteColumn = sql<QuoteRow | null>`(
  select json_build_object(
    'id', q.id,
    'deleted', q.deleted_at is not null,
    'fromVisitor', q.author_visitor_id is not null,
    'byOperator', o.id is not null and o.deleted_at is null,
    'authorName', coalesce(o.name, k.name, v.name),
    'body', ${previewBody(sql`q.body`, sql`q.metadata`)},
    'hasImage', q.kind = 'image')
  from message as q
  left join operator as o on o.id = q.author_operator_id
  left join api_key as k on k.workspace_id = q.workspace_id and k.id = q.author_api_key_id
  left join visitor as v on v.workspace_id = q.workspace_id and v.id = q.author_visitor_id
  where q.workspace_id = "message"."workspace_id" and q.id = "message"."reply_to_message_id")`;

/** The quote a client shows. `name` turns the author's name into the one this client uses. */
export function quoteView(
  row: QuoteRow | null,
  name: (row: QuoteRow) => string | null = (one) => one.authorName,
): Quote | null {
  if (row === null) return null;
  const shown = { authorName: name(row), fromVisitor: row.fromVisitor };
  if (row.deleted) return { id: null, ...shown, text: "", hasImage: false };
  return { id: row.id, ...shown, text: plainText(row.body ?? ""), hasImage: row.hasImage };
}

/**
 * The quote as the visitor reads it: an operator by first name, as on replies, and no name for the
 * visitor's own message, which a client calls "You".
 */
export const visitorQuote = (row: QuoteRow | null) =>
  quoteView(row, (quoted) =>
    quoted.fromVisitor
      ? null
      : quoted.byOperator
        ? firstName(quoted.authorName ?? "")
        : quoted.authorName,
  );

/**
 * How a message came: a key's through the REST API or the MCP server, an operator's that sent a
 * key's draft, or a visitor's reply by email.
 */
export const CHANNELS = ["api", "mcp", "draft", "email"] as const;
type Channel = (typeof CHANNELS)[number];

/**
 * A write that did not come the default way: a key's through MCP, an operator's that sent a draft,
 * or a visitor's reply by email, which may come from another address than the visitor's.
 */
export type MessageSource =
  | { via: "mcp" }
  | { via: "draft"; draftId: string }
  | { via: "email"; fromOtherAddress: boolean };

/** How a key's write came, when not through the REST API. */
export type KeySource = Extract<MessageSource, { via: "mcp" }>;

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: bigint;
  kind: MessageKind;
  fromVisitor: boolean;
  /** The operator who sent it, or null for a visitor's message or a key's. */
  authorOperatorId: string | null;
  /** The API key that sent it, or null. */
  authorApiKeyId: string | null;
  /** The sender's own ID, so a client can match a stream copy to its pending line. */
  clientId: string;
  body: string | null;
  image: { attachmentId: string; width: number; height: number } | null;
  /** The image's file was deleted after 12 months, on Dinghy Cloud. */
  imageRemoved: boolean;
  /** A file that is not an image. `size` is in bytes. */
  file: { attachmentId: string; name: string; size: number } | null;
  /** The file was deleted after 12 months, on Dinghy Cloud. */
  fileRemoved: boolean;
  replyTo: QuoteRow | null;
  editedAt: Date | null;
  /** Deleted by an operator: its body and image or file are gone, and it shows as a placeholder. */
  deleted: boolean;
  /** When the visitor's read position first passed this reply, when known. */
  readAt: Date | null;
  /**
   * A key's reply: through the API or MCP. `draft`: an operator sent a key's draft. `email`: a
   * visitor's reply by email. Null for anyone else's message.
   */
  via: Channel | null;
  /** A reply by email from another address than the visitor's. */
  fromOtherAddress: boolean;
  /** A bot's handoff note: who it handed the conversation to, with null for the team. */
  handoff: { operatorId: string | null } | null;
  /** The members a note mentions. Empty for any other message. */
  mentions: string[];
  /** Its own position, or its last edit's or delete's, for a stream that sends changes again. */
  changeSeq: bigint;
  createdAt: Date;
}

/** A message the visitor may get: any kind but a note. */
export type VisitorMessage = StoredMessage & { kind: (typeof VISITOR_KINDS)[number] };

/** The message as a visitor's, for a read that left notes out. Throws on a note, which is a bug. */
export function visitorMessage(one: StoredMessage): VisitorMessage {
  if (one.kind === "note") throw new Error("A note must never reach a visitor");
  return { ...one, kind: one.kind };
}

export const messageColumns = {
  id: message.id,
  conversationId: message.conversationId,
  seq: message.seq,
  kind: message.kind,
  authorOperatorId: message.authorOperatorId,
  authorVisitorId: message.authorVisitorId,
  authorApiKeyId: message.authorApiKeyId,
  clientId: message.clientId,
  body: message.body,
  metadata: message.metadata,
  replyTo: quoteColumn,
  editedAt: message.editedAt,
  deletedAt: message.deletedAt,
  readAt: message.readAt,
  changedSeq: message.changedSeq,
  createdAt: message.createdAt,
};

interface MessageRow {
  id: string;
  conversationId: string;
  seq: bigint;
  kind: MessageKind;
  authorOperatorId: string | null;
  authorVisitorId: string | null;
  authorApiKeyId: string | null;
  clientId: string;
  body: string | null;
  metadata: unknown;
  replyTo: QuoteRow | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  readAt: Date | null;
  changedSeq: bigint | null;
  createdAt: Date;
}

interface MessageMetadata {
  image?: StoredMessage["image"];
  imageRemoved?: boolean;
  file?: StoredMessage["file"];
  fileRemoved?: boolean;
  /** Set on a key's reply that came through MCP, an operator's that sent a draft, and an email. */
  via?: "mcp" | "draft" | "email";
  fromOtherAddress?: true;
  /** Set on a bot's handoff note: who it handed the conversation to, or null for the team. */
  handoff?: { operatorId: string | null };
  /** Set on a note that mentions members. */
  mentions?: string[];
}

export function stored({
  authorVisitorId,
  metadata,
  deletedAt,
  changedSeq,
  ...row
}: MessageRow): StoredMessage {
  const meta = metadata as MessageMetadata | null;
  return {
    ...row,
    image: meta?.image ?? null,
    imageRemoved: meta?.imageRemoved === true,
    file: meta?.file ?? null,
    fileRemoved: meta?.fileRemoved === true,
    fromVisitor: authorVisitorId !== null,
    deleted: deletedAt !== null,
    via:
      meta?.via === "draft" || meta?.via === "email"
        ? meta.via
        : row.authorApiKeyId === null
          ? null
          : (meta?.via ?? "api"),
    fromOtherAddress: meta?.fromOtherAddress === true,
    handoff: meta?.handoff ?? null,
    mentions: meta?.mentions ?? [],
    changeSeq: changedSeq ?? row.seq,
  };
}

/**
 * Unassigns a conversation whose assignee left the team. Such an assignee hides it from everyone's
 * waiting count and lists, and a reply would not take it over.
 */
async function dropDepartedAssignee(tx: Transaction, workspaceId: string, conversationId: string) {
  const stillMember = tx
    .select({ operatorId: workspaceMember.operatorId })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.operatorId, conversation.assigneeOperatorId),
        isNull(workspaceMember.removedAt),
      ),
    );
  await tx
    .update(conversation)
    .set({ assigneeOperatorId: null })
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.id, conversationId),
        notExists(stillMember),
      ),
    );
}

/**
 * The conversation a visitor's message goes to: their open one, else their newest closed one,
 * reopened with its assignee, else a new one. No time limit applies, so a visitor keeps one thread.
 * A message for one conversation goes there, reopened if closed, and never to another. The
 * workspace lock makes this safe to race.
 */
async function visitorConversation(
  tx: Transaction,
  workspaceId: string,
  { visitorId, conversationId }: Extract<Author, { kind: "visitor" }>,
  startedPage: string | null,
): Promise<{ id: string; started: "created" | "reopened" | null }> {
  const [newest] = await tx
    .select({ id: conversation.id, status: conversation.status })
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.visitorId, visitorId),
        conversationId === undefined ? undefined : eq(conversation.id, conversationId),
      ),
    )
    .orderBy(sql`${conversation.status} = 'open' desc`, desc(conversation.createdAt))
    .limit(1);
  if (newest?.status === "open") return { id: newest.id, started: null };
  if (newest !== undefined) {
    await setConversationStatus(tx, workspaceId, newest.id, "open", { kind: "visitor", visitorId });
    await dropDepartedAssignee(tx, workspaceId, newest.id);
    return { id: newest.id, started: "reopened" };
  }
  if (conversationId !== undefined) throw new Error("The visitor's conversation is gone");
  const [created] = await tx
    .insert(conversation)
    .values({ workspaceId, visitorId, startedPage })
    .returning({ id: conversation.id });
  if (created === undefined) throw new Error("The conversation insert returned no row");
  return { id: created.id, started: "created" };
}

/**
 * True when the workspace has an enabled webhook, read in the event's own insert, so a workspace
 * with none gives the worker nothing to do.
 */
export const wantsWebhook = (workspaceId: string) =>
  sql<boolean>`exists (select 1 from ${webhook} where ${webhook.workspaceId} = ${workspaceId} and ${webhook.enabled})`;

/** An image or a file that is stored, and waits for its message. */
export type NewAttachment = {
  attachmentId: string;
  storageKey: string;
  byteSize: number;
  contentType: string;
} & ({ kind: "image"; width: number; height: number } | { kind: "file"; name: string });

/** What a message's metadata holds about its image or file. */
const attachmentMetadata = ({ attachmentId, ...upload }: NewAttachment): MessageMetadata =>
  upload.kind === "image"
    ? { image: { attachmentId, width: upload.width, height: upload.height } }
    : { file: { attachmentId, name: upload.name, size: upload.byteSize } };

/**
 * The quoted message is not a message people wrote in this conversation, or it was deleted. A reply
 * cannot quote a note, as the visitor would see the quote.
 */
export class InvalidReplyToError extends Error {
  constructor() {
    super("The quoted message is not in this conversation.");
  }
}

/**
 * Throws InvalidReplyToError unless the quoted message is a live chat line of this conversation, or
 * for a note, a live note too.
 */
export async function checkQuote(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  messageId: string,
  isNote: boolean,
): Promise<void> {
  const [found] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.id, messageId),
        eq(message.conversationId, conversationId),
        isNote ? isWritten() : isChat(),
        isNull(message.deletedAt),
      ),
    );
  if (found === undefined) throw new InvalidReplyToError();
}

export class ConversationClosedError extends Error {
  constructor() {
    super("This conversation is closed.");
  }
}

/** The workspace stopped taking messages: it was suspended, became read-only or was deleted. */
export class WorkspaceClosedError extends Error {
  readonly access: WorkspaceAccess;
  constructor(access: WorkspaceAccess) {
    super(`This workspace takes no messages: ${access}.`);
    this.access = access;
  }
}

/** Waits for a write, and returns a WorkspaceClosedError instead of throwing it. */
export const catchClosed = <T>(write: Promise<T>): Promise<T | WorkspaceClosedError> =>
  write.catch((error: unknown) => {
    if (error instanceof WorkspaceClosedError) return error;
    throw error;
  });

/** Waits for a write, and returns `{ kind: "closed" }` instead of throwing ConversationClosedError. */
export const catchConversationClosed = <T>(write: Promise<T>): Promise<T | { kind: "closed" }> =>
  write.catch((error: unknown) => {
    if (error instanceof ConversationClosedError) return { kind: "closed" as const };
    throw error;
  });

/** Takes the next position and the workspace row lock, which lasts until commit. */
export const nextSeq = (tx: Transaction, workspaceId: string): Promise<bigint> =>
  takeSeqs(tx, workspaceId, 1);

/** Takes `count` positions in a row and the workspace row lock. Answers the first position. */
async function takeSeqs(tx: Transaction, workspaceId: string, count: number): Promise<bigint> {
  const [last] = await tx
    .update(workspace)
    .set({ eventSeq: sql`${workspace.eventSeq} + ${count}` })
    .where(eq(workspace.id, workspaceId))
    .returning({ seq: workspace.eventSeq });
  if (last === undefined) throw new Error("The workspace row is missing");
  return last.seq - BigInt(count - 1);
}

/**
 * Takes the workspace row lock, which lasts until commit, without taking a position: a write that
 * may take none, such as a key's reply that the gate refuses. It reads whether bots are paused,
 * which the pause changes under the same lock.
 */
export async function lockWorkspace(
  tx: Transaction,
  workspaceId: string,
): Promise<{ botsPaused: boolean }> {
  const [row] = await tx
    .select({ botsPausedAt: workspace.botsPausedAt })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .for("no key update");
  if (row === undefined) throw new Error("The workspace row is missing");
  return { botsPaused: row.botsPausedAt !== null };
}

/**
 * Whether the message goes to a welcome chat. A welcome chat's visitor has no other conversation,
 * so a visitor's message, which is a copy from the other side, is checked by its visitor.
 */
async function inWelcomeChat(tx: Transaction, workspaceId: string, author: Author) {
  const target =
    author.kind === "visitor"
      ? eq(conversation.visitorId, author.visitorId)
      : eq(conversation.id, author.conversationId);
  const [row] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), target, eq(conversation.welcome, true)))
    .limit(1);
  return row !== undefined;
}

/**
 * Writes a message and its event in the caller's transaction. A retry returns the original.
 *
 * The first statement takes the workspace row lock, and the lock lasts until commit. So the order
 * of the sequence matches the order of commits, and a client at cursor N can never miss a message
 * below N that commits later. A retry leaves a gap in the sequence, which is harmless.
 *
 * Keep the caller's transaction short, because this lock serializes writes in the workspace. An
 * image or a file counts against the plan's storage under the same lock, and throws
 * StorageFullError past it.
 *
 * The routes refuse a closed workspace up front, but an upload can take a while to arrive. So this
 * reads the workspace's access again under the lock, which `chat suspend` and the billing change to
 * read-only also take, and throws WorkspaceClosedError.
 */
export async function appendMessage(
  tx: Transaction,
  workspaceId: string,
  author: Author,
  input: {
    clientId: string;
    body?: string;
    page?: string | null;
    /** False for a message that nobody needs to hear about, such as the cloud's welcome. */
    alert?: boolean;
    /** An earlier message of the same conversation that this one quotes. */
    replyToMessageId?: string | undefined;
    source?: MessageSource | undefined;
    /** A bot's handoff note: who takes the conversation, with null for the team. */
    handoffTo?: string | null | undefined;
  } & (
    | { attachment?: NewAttachment; note?: false }
    | { attachment?: undefined; note: true; mentions?: string[] | undefined }
  ),
  limits: Pick<Limits, "mayStore"> = NO_LIMITS,
): Promise<{ message: StoredMessage; created: boolean; conversationStarted: boolean }> {
  const seq = await nextSeq(tx, workspaceId);
  // A statement of its own, after the lock: it sees every change committed before the lock.
  const found = await workspaceAccess(tx, workspaceId);
  const welcome = !writable(found) && (await inWelcomeChat(tx, workspaceId, author));
  const access = welcome ? await welcomeAccess(tx, workspaceId, found) : found;
  if (!writableFor(access, { welcome })) throw new WorkspaceClosedError(access);

  const sender =
    author.kind === "visitor"
      ? eq(message.authorVisitorId, author.visitorId)
      : author.kind === "operator"
        ? eq(message.authorOperatorId, author.operatorId)
        : eq(message.authorApiKeyId, author.apiKeyId);
  const [existing] = await tx
    .select(messageColumns)
    .from(message)
    .where(and(eq(message.workspaceId, workspaceId), sender, eq(message.clientId, input.clientId)));
  if (existing !== undefined) {
    // A retry after a lost answer must still tell the widget, so this asks whether the original
    // was its conversation's first message. Only a visitor's message starts one.
    const original = { message: stored(existing), created: false };
    if (author.kind !== "visitor") return { ...original, conversationStarted: false };
    const [earlier] = await tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.workspaceId, workspaceId),
          eq(message.conversationId, existing.conversationId),
          lt(message.seq, existing.seq),
        ),
      )
      .limit(1);
    return { ...original, conversationStarted: earlier === undefined };
  }

  // After the retry lookup, and under the lock, so a close cannot slip in before this reply and a
  // retry of a reply that already committed still gets its original message. A note goes in a
  // closed conversation too, and never assigns it.
  const isNote = input.note === true;
  let assignsReplier = false;
  if (author.kind !== "visitor" && !isNote) {
    const [target] = await tx
      .select({ status: conversation.status, assignee: conversation.assigneeOperatorId })
      .from(conversation)
      .where(
        and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, author.conversationId)),
      );
    if (target?.status !== "open") throw new ConversationClosedError();
    assignsReplier =
      author.kind === "operator" &&
      target.assignee === null &&
      !(await hasOperatorReply(tx, workspaceId, author.conversationId));
  }
  const { attachment: upload } = input;
  if (upload !== undefined && !(await limits.mayStore(tx, workspaceId, upload.byteSize))) {
    throw new StorageFullError();
  }

  const target =
    author.kind === "visitor"
      ? await visitorConversation(tx, workspaceId, author, input.page ?? null)
      : { id: author.conversationId, started: null };
  const conversationId = target.id;
  const created = target.started === "created";
  // The reopen's status line took a later position than this message's, and must come first.
  const messageSeq = target.started === "reopened" ? await nextSeq(tx, workspaceId) : seq;
  if (input.replyToMessageId !== undefined) {
    await checkQuote(tx, workspaceId, conversationId, input.replyToMessageId, isNote);
  }
  const mentions = isNote
    ? await mentionable(
        tx,
        workspaceId,
        input.mentions ?? [],
        author.kind === "operator" ? author.operatorId : null,
      )
    : [];
  const metadata: MessageMetadata = {
    ...(upload !== undefined && attachmentMetadata(upload)),
    ...(input.source !== undefined && { via: input.source.via }),
    ...(input.source?.via === "email" &&
      input.source.fromOtherAddress && { fromOtherAddress: true }),
    ...(input.handoffTo !== undefined && { handoff: { operatorId: input.handoffTo } }),
    ...(mentions.length > 0 && { mentions }),
  };
  const [row] = await tx
    .insert(message)
    .values({
      workspaceId,
      conversationId,
      seq: messageSeq,
      kind: isNote ? "note" : (upload?.kind ?? "text"),
      clientId: input.clientId,
      body: input.body ?? null,
      metadata,
      replyToMessageId: input.replyToMessageId ?? null,
      ...(author.kind === "visitor"
        ? { authorVisitorId: author.visitorId }
        : author.kind === "operator"
          ? { authorOperatorId: author.operatorId }
          : { authorApiKeyId: author.apiKeyId }),
    })
    .returning(messageColumns);
  if (row === undefined) throw new Error("The message insert returned no row");
  if (upload !== undefined) {
    await tx.insert(attachment).values({
      workspaceId,
      id: upload.attachmentId,
      messageId: row.id,
      storageKey: upload.storageKey,
      byteSize: upload.byteSize,
      contentType: upload.contentType,
      ...(upload.kind === "image"
        ? { width: upload.width, height: upload.height }
        : { filename: upload.name }),
    });
  }

  // The payload holds IDs only, so deleting a message removes its text.
  await tx.insert(event).values({
    workspaceId,
    seq: messageSeq,
    kind: "message.created",
    payload: {
      messageId: row.id,
      conversationId,
      fromVisitor: author.kind === "visitor",
      ...(created ? { conversationCreated: true } : {}),
      ...(mentions.length > 0 && { mentions }),
    } satisfies MessagePayload,
    // A note alerts only the members it mentions, and its visitor never hears of it.
    needsAlert: isNote ? mentions.length > 0 : (input.alert ?? true),
    needsWebhook: wantsWebhook(workspaceId),
  });
  // A note is not activity in the chat, so the inbox keeps the conversation in its place. The
  // visitor writing ends a snooze, under the lock, so a snooze that races this message cannot hide it.
  if (!isNote) {
    await tx
      .update(conversation)
      .set({
        updatedAt: sql`now()`,
        ...(author.kind === "visitor" && { snoozedAt: null, snoozedUntil: null }),
      })
      .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  }
  // The operator who answers an unassigned conversation first takes it. A key's reply never does.
  if (assignsReplier && author.kind === "operator") {
    await assignConversation(tx, workspaceId, conversationId, author.operatorId);
  }
  // A new visitor message, or a person's answer, leaves the drafts that wait behind. A note reaches
  // no visitor, so it answers nothing. A reopened conversation keeps its drafts, so they go stale too.
  if ((author.kind === "visitor" && !created) || (author.kind === "operator" && !isNote)) {
    const sentDraftId = input.source?.via === "draft" ? input.source.draftId : undefined;
    await markDraftsStale(tx, workspaceId, conversationId, sentDraftId);
  }
  return { message: stored(row), created: true, conversationStarted: created };
}

/**
 * The members a note may mention, of those it names: the current members, without its author, who
 * needs no alert of their own note.
 */
export async function mentionable(
  tx: Transaction,
  workspaceId: string,
  named: string[],
  authorOperatorId: string | null,
): Promise<string[]> {
  const wanted = [...new Set(named)].filter((id) => id !== authorOperatorId);
  if (wanted.length === 0) return [];
  const members = await tx
    .select({ id: workspaceMember.operatorId })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        inArray(workspaceMember.operatorId, wanted),
        isNull(workspaceMember.removedAt),
      ),
    );
  return wanted.filter((id) => members.some((member) => member.id === id));
}

/**
 * A visitor wrote again, or a person answered, so the drafts that wait may answer an older question.
 * They stay, marked stale, and a `draft.changed` event tells the operator apps. The draft that an
 * operator sends is not one of them.
 */
async function markDraftsStale(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  sentDraftId: string | undefined,
) {
  const marked = await tx
    .update(draftReply)
    .set({ staleAt: sql`now()` })
    .where(
      and(
        eq(draftReply.workspaceId, workspaceId),
        eq(draftReply.conversationId, conversationId),
        isNull(draftReply.resolved),
        isNull(draftReply.staleAt),
        sentDraftId === undefined ? undefined : ne(draftReply.id, sentDraftId),
      ),
    )
    .returning({ id: draftReply.id });
  if (marked.length > 0)
    await recordConversationChange(tx, workspaceId, conversationId, "draft.changed");
}

/** Whether an operator has replied in this conversation. */
async function hasOperatorReply(tx: Transaction, workspaceId: string, conversationId: string) {
  const [found] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.conversationId, conversationId),
        isNotNull(message.authorOperatorId),
        isChat(),
      ),
    )
    .limit(1);
  return found !== undefined;
}

interface ReadState {
  lastReadSeq: bigint;
  unread: number;
}

/** How many operator messages this visitor has not read. */
export async function readState(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
): Promise<ReadState> {
  const [row] = await tx
    .select({ lastReadSeq: visitor.lastReadSeq })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  if (row === undefined) return { lastReadSeq: 0n, unread: 0 };
  const unread = await tx.$count(
    tx
      .select({ id: message.id })
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
          gt(message.seq, row.lastReadSeq),
        ),
      ),
  );
  return { lastReadSeq: row.lastReadSeq, unread };
}

/**
 * Moves the read position forward. It never moves back, because tabs can report out of order, and
 * it stops at the feed's position, so a wrong value cannot hide messages that arrive later. True
 * when it passed a team reply, the only lines whose receipts change.
 */
export async function markRead(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  seq: bigint,
): Promise<boolean> {
  const target = sql`least(${seq}::bigint, (
    select ${workspace.eventSeq} from ${workspace} where ${workspace.id} = ${workspaceId}
  ))`;
  const one = and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId));
  const [before] = await tx
    .select({ lastReadSeq: visitor.lastReadSeq })
    .from(visitor)
    .where(one)
    .for("no key update");
  if (before === undefined) return false;
  const [moved] = await tx
    .update(visitor)
    .set({ lastReadSeq: target })
    .where(and(one, sql`${visitor.lastReadSeq} < ${target}`))
    .returning({ lastReadSeq: visitor.lastReadSeq });
  if (moved === undefined) return false;
  // The replies this read passed, so their info can say when the visitor read them.
  const passed = await tx
    .update(message)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        inArray(message.conversationId, visitorConversations(tx, workspaceId, visitorId)),
        isNull(message.authorVisitorId),
        isChat(),
        gt(message.seq, before.lastReadSeq),
        lte(message.seq, moved.lastReadSeq),
      ),
    )
    .returning({ id: message.id });
  return passed.length > 0;
}

const visitorConversations = (tx: Transaction, workspaceId: string, visitorId: string) =>
  tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.visitorId, visitorId)));

export interface Cursor {
  generation: number;
  seq: bigint;
}

export function formatCursor({ generation, seq }: Cursor): string {
  return `${generation}.${seq}`;
}

// 18 digits always fit a Postgres bigint, and 9 always fit an integer.
export const CURSOR_PATTERN = /^\d{1,9}\.\d{1,18}$/;

export function parseCursor(value: string): Cursor {
  const [generation = "", seq = ""] = value.split(".");
  return { generation: Number(generation), seq: BigInt(seq) };
}

interface MessagePage {
  messages: VisitorMessage[];
  cursor: Cursor;
  hasMore: boolean;
  /** The cursor is from before a restore or an import, so the client must load from the start. */
  resync: boolean;
}

/** One visitor's messages after a cursor, in commit order. */
export async function listVisitorMessages(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  after: Cursor | undefined,
  limit: number,
): Promise<MessagePage> {
  const [current] = await tx
    .select({ generation: workspace.feedGeneration })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  if (current === undefined) throw new Error("The workspace row is missing");
  const start = { generation: current.generation, seq: 0n };
  if (after !== undefined && after.generation !== current.generation) {
    return { messages: [], cursor: start, hasMore: false, resync: true };
  }

  const position = after ?? start;
  // An edit or a delete sends the message again, at its change's position. New rows and changed
  // rows are read apart, so each read follows an index: message_seq_key and message_changed_idx.
  // A note is the team's own, so the visitor never gets it.
  const read = (condition: SQL | undefined, order: AnyColumn) =>
    tx
      .select(messageColumns)
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
          ne(message.kind, "note"),
          condition,
        ),
      )
      .orderBy(asc(order))
      .limit(limit + 1);
  const fresh = await read(
    and(gt(message.seq, position.seq), isNull(message.changedSeq)),
    message.seq,
  );
  const changed = await read(gt(message.changedSeq, position.seq), message.changedSeq);
  const rows = [...fresh, ...changed]
    .map((row) => visitorMessage(stored(row)))
    .sort((one, other) => (one.changeSeq < other.changeSeq ? -1 : 1));
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    messages: page,
    cursor: { generation: current.generation, seq: last?.changeSeq ?? position.seq },
    hasMore: rows.length > limit,
    resync: false,
  };
}

export interface ConversationRow {
  id: string;
  status: "open" | "closed";
  updatedAt: Date;
  assigneeOperatorId: string | null;
  startedPage: string | null;
  welcome: boolean;
  visitorId: string;
  visitorBlockedAt: Date | null;
  visitorEmail: string | null;
  visitorExternalId: string | null;
  visitorName: string | null;
  visitorAttributes: unknown;
  visitorPageContext: unknown;
  visitorDevice: string | null;
  visitorLastPage: string | null;
  visitorLastSeenAt: Date | null;
  visitorCountry: string | null;
  visitorTimeZone: string | null;
  visitorLocale: Locale | null;
  /** A test visitor, made by a bot's simulated message. */
  visitorIsTest: boolean;
  /** Since when a person handles it, so bots stay quiet. */
  humanSince: Date | null;
  /** The assignee's name, for the handler. */
  assigneeName: string | null;
  /** The key that took part last, whoever handles it now, or null when none did. */
  botKey: KeyName | null;
  /** Null unless it is snoozed now. */
  snooze: Snooze | null;
  /** Its labels' IDs. */
  labelIds: string[];
}

/** How long a snooze lasts: until a time, or with null until the visitor writes. */
export interface Snooze {
  until: Date | null;
}

/** A key's ID and name. */
interface KeyName {
  id: string;
  name: string;
}

/** The assignee's name, read in the same statement as each listed row. */
const assigneeName = sql<string | null>`(
  select o.name from operator as o where o.id = "conversation"."assignee_operator_id")`;

/**
 * The key that wrote the conversation's newest message, draft or note, or handed it off. A note is a
 * message, so one probe reads both. Read in the same statement as each listed row, with one backward
 * index probe per table and no sort.
 */
const botKey = sql<KeyName | null>`(
  select json_build_object('id', k.id, 'name', k.name) from api_key as k
  where k.workspace_id = "conversation"."workspace_id" and k.id = coalesce((
    select case greatest(by_message.at, by_draft.at)
      when by_message.at then by_message.key_id
      when by_draft.at then by_draft.key_id end
    from (select 1) as one
    left join lateral (
      select m.author_api_key_id as key_id, m.created_at as at from message as m
      where m.workspace_id = "conversation"."workspace_id" and m.conversation_id = "conversation"."id"
        and m.author_api_key_id is not null
      order by m.seq desc limit 1) as by_message on true
    left join lateral (
      select d.api_key_id as key_id, d.created_at as at from draft_reply as d
      where d.workspace_id = "conversation"."workspace_id" and d.conversation_id = "conversation"."id"
      order by d.created_at desc limit 1) as by_draft on true
  ), "conversation"."handoff_by_api_key_id"))`;

/**
 * Whether a conversation is snoozed now: an operator snoozed it and its time, if any, has not come.
 * A visitor message, a close and a reopen clear the snooze, so only the time is read here. `row` names
 * the conversation in a statement written by hand, such as sql`c`.
 */
const snoozedNow = (row: SQLWrapper = conversation) =>
  sql<boolean>`(${row}.snoozed_at is not null and (${row}.snoozed_until is null or ${row}.snoozed_until > now()))`;

/**
 * The conversation's labels, read in the same statement as each listed row. The primary key's order,
 * so the probe needs no sort.
 */
const labelIds = sql<string[]>`array(
  select l.label_id from conversation_label as l
  where l.workspace_id = "conversation"."workspace_id" and l.conversation_id = "conversation"."id"
  order by l.label_id)`;

const conversationColumns = {
  id: conversation.id,
  status: conversation.status,
  updatedAt: conversation.updatedAt,
  assigneeOperatorId: conversation.assigneeOperatorId,
  startedPage: conversation.startedPage,
  welcome: conversation.welcome,
  visitorId: conversation.visitorId,
  visitorBlockedAt: visitor.blockedAt,
  visitorEmail: visitor.email,
  visitorExternalId: visitor.externalId,
  visitorName: visitor.name,
  visitorAttributes: visitor.attributes,
  visitorPageContext: visitor.pageContext,
  visitorDevice: visitor.device,
  visitorLastPage: visitor.lastPage,
  visitorLastSeenAt: visitor.lastSeenAt,
  visitorCountry: visitor.country,
  visitorTimeZone: visitor.timeZone,
  visitorLocale: visitor.locale,
  visitorIsTest: visitor.isTest,
  humanSince: conversation.humanSince,
  assigneeName,
  botKey,
  snoozed: snoozedNow(),
  snoozedUntil: conversation.snoozedUntil,
  labelIds,
};

/** A row with its snooze as one value, so an ended snooze's time never reads as a snooze. */
function withSnooze<Row extends { snoozed: boolean; snoozedUntil: Date | null }>({
  snoozed,
  snoozedUntil,
  ...row
}: Row) {
  return { ...row, snooze: snoozed ? { until: snoozedUntil } : null };
}

/** Joins a conversation to its visitor, inside the same workspace. */
export function joinVisitor() {
  return and(
    eq(visitor.workspaceId, conversation.workspaceId),
    eq(visitor.id, conversation.visitorId),
  );
}

/**
 * A conversation's visitor, or undefined. With `lock`, the visitor's row stays locked until commit.
 * A change to a message takes this lock before the message's, as a read does. FOR NO KEY UPDATE still
 * orders edits and reads, and lets a planner's chat link pass its foreign key check on this row.
 */
export async function conversationVisitor(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  lock?: "no key update",
) {
  const query = tx
    .select({ id: visitor.id, email: visitor.email, lastReadSeq: visitor.lastReadSeq })
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  const [row] = lock === undefined ? await query : await query.for(lock, { of: visitor });
  return row;
}

type ChatKind = (typeof CHAT_KINDS)[number];

/** A chat message's kind, for a subquery that `isChat` already filtered. */
const chatKind = () => sql<ChatKind>`${message.kind}`.as("kind");

/** The newest chat message of a conversation, as a list shows it. */
export interface LastMessage {
  body: string | null;
  /** A file that was removed has no body, and only its kind tells it from an image. */
  kind: ChatKind;
  fromVisitor: boolean;
  createdAt: Date;
}

export interface ConversationSummary extends ConversationRow {
  lastMessage: LastMessage | null;
  unread: boolean;
}

/**
 * Whether a conversation, named by its alias in the query, is a bot's test visitor's. Nobody is
 * told about one: it alerts nobody, is never unread and stays out of the numbers.
 */
export const conversationHasTestVisitor = (alias: SQL) => sql<boolean>`exists (
  select 1 from ${visitor} as tv
  where tv.workspace_id = ${alias}.workspace_id and tv.id = ${alias}.visitor_id and tv.is_test
)`;

/**
 * Whether the conversation in the query has a visitor message, or a note that mentions this
 * operator, past their read position. An API key, null here, has no position, so nothing is unread
 * for it. A bot's test visitor is never unread, as it alerts nobody. Any other note is not a
 * message, so it is never unread. The probe walks message_conversation_idx from the position up.
 */
function unreadBy(operatorId: string | null) {
  if (operatorId === null) return sql<boolean>`false`;
  // Aliased, because Drizzle leaves the table off a column when a query has no join.
  return sql<boolean>`not ${conversationHasTestVisitor(sql`${conversation}`)} and exists (
    select 1 from ${message} as m
    where m.workspace_id = ${conversation}.workspace_id and m.conversation_id = ${conversation}.id
      and (m.author_visitor_id is not null or m.kind = 'note' and m.metadata->'mentions' ? ${operatorId})
      and m.deleted_at is null
      and m.seq > coalesce((
        select r.read_seq from ${conversationRead} as r
        where r.workspace_id = ${conversation}.workspace_id and r.conversation_id = ${conversation}.id
          and r.operator_id = ${operatorId}
      ), 0)
  )`;
}

/** Whether one conversation is unread for this operator. False for an API key, as null. */
export async function isUnread(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  operatorId: string | null,
): Promise<boolean> {
  const [row] = await tx
    .select({ unread: unreadBy(operatorId) })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  return row?.unread === true;
}

/**
 * Moves an operator's read position in a conversation forward to `seq`. It never moves back, as
 * tabs can report out of order, and it stops at the conversation's newest message. False when the
 * conversation does not exist.
 */
export async function markConversationRead(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  operatorId: string,
  seq: bigint,
): Promise<boolean> {
  const result = await tx.execute(sql`
    insert into ${conversationRead} (workspace_id, conversation_id, operator_id, read_seq)
    select c.workspace_id, c.id, ${operatorId}, least(${seq}::bigint, coalesce((
             select max(m.seq) from ${message} as m
             where m.workspace_id = c.workspace_id and m.conversation_id = c.id
           ), 0))
    from ${conversation} as c
    where c.workspace_id = ${workspaceId} and c.id = ${conversationId}
    on conflict (workspace_id, conversation_id, operator_id) do update
      set read_seq = greatest(${conversationRead}.read_seq, excluded.read_seq)
    returning 1`);
  return result.rows.length > 0;
}

/**
 * Marks these conversations read up to their newest message, for one operator, in one statement. A
 * position never moves back. The conversations whose position moved, or that had none.
 */
export async function markConversationsRead(
  tx: Transaction,
  workspaceId: string,
  conversationIds: string[],
  operatorId: string,
): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const result = await tx.execute<{ conversation_id: string }>(sql`
    insert into ${conversationRead} (workspace_id, conversation_id, operator_id, read_seq)
    select c.workspace_id, c.id, ${operatorId}, coalesce((
             select max(m.seq) from ${message} as m
             where m.workspace_id = c.workspace_id and m.conversation_id = c.id
           ), 0)
    from ${conversation} as c
    where c.workspace_id = ${workspaceId} and c.id in ${conversationIds}
    on conflict (workspace_id, conversation_id, operator_id) do update
      set read_seq = greatest(${conversationRead}.read_seq, excluded.read_seq)
      where ${conversationRead}.read_seq < excluded.read_seq
    returning conversation_id`);
  return new Set(result.rows.map((row) => row.conversation_id));
}

/**
 * Marks every conversation read up to its newest message, for one member or for every current one,
 * so a teammate who joins or a workspace that arrives by import does not start with all its
 * history unread. A position never moves back.
 */
export async function markHistoryRead(
  tx: Transaction,
  workspaceId: string,
  operatorId?: string,
): Promise<void> {
  await tx.execute(sql`
    insert into ${conversationRead} (workspace_id, conversation_id, operator_id, read_seq)
    select ${workspaceId}, newest.conversation_id, member.operator_id, newest.seq
    from (
      select m.conversation_id, max(m.seq) as seq from ${message} as m
      where m.workspace_id = ${workspaceId} group by m.conversation_id
    ) as newest
    join ${workspaceMember} as member
      on member.workspace_id = ${workspaceId} and member.removed_at is null
      ${operatorId === undefined ? sql`` : sql`and member.operator_id = ${operatorId}`}
    on conflict (workspace_id, conversation_id, operator_id) do update
      set read_seq = greatest(${conversationRead}.read_seq, excluded.read_seq)`);
}

/** Whose conversations a list holds: everyone's, one operator's, or no one's. */
export type AssigneeFilter =
  | { kind: "all" }
  | { kind: "operator"; operatorId: string }
  | { kind: "none" };

/** What a list holds: whose conversations, and with a label ID only those with that label. */
export interface ListFilter {
  assignee: AssigneeFilter;
  labelId?: string | undefined;
}

/** Only when the filter names a label, so a list without one never reads the labels. */
function labelCondition(workspaceId: string, labelId: string | undefined) {
  if (labelId === undefined) return undefined;
  return inArray(
    conversation.id,
    sql`(select l.conversation_id from ${conversationLabel} as l
         where l.workspace_id = ${workspaceId} and l.label_id = ${labelId})`,
  );
}

function assigneeCondition(assignee: AssigneeFilter) {
  if (assignee.kind === "all") return undefined;
  if (assignee.kind === "none") return isNull(conversation.assigneeOperatorId);
  return eq(conversation.assigneeOperatorId, assignee.operatorId);
}

/** A page of conversations, newest activity first. */
export async function listConversations(
  tx: Transaction,
  workspaceId: string,
  operatorId: string | null,
  status: "open" | "closed",
  filter: ListFilter,
  before: { updatedAt: Date; id: string } | undefined,
  limit: number,
): Promise<{ conversations: ConversationSummary[]; hasMore: boolean }> {
  // One index probe per listed conversation, through message_conversation_idx backwards.
  const newest = tx
    .select({
      body: message.body,
      kind: chatKind(),
      metadata: message.metadata,
      authorVisitorId: message.authorVisitorId,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.conversationId, conversation.id),
        isChat(),
        isNull(message.deletedAt),
      ),
    )
    .orderBy(desc(message.seq))
    .limit(1)
    .as("newest");
  const rows = await tx
    .select({
      ...conversationColumns,
      unread: unreadBy(operatorId),
      lastBody: previewBody(newest.body, newest.metadata),
      lastKind: newest.kind,
      lastAuthorVisitorId: newest.authorVisitorId,
      lastCreatedAt: newest.createdAt,
    })
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .leftJoinLateral(newest, sql`true`)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.status, status),
        assigneeCondition(filter.assignee),
        labelCondition(workspaceId, filter.labelId),
        // A row comparison bounds the scan of conversation_list_idx, where an OR would not.
        before === undefined
          ? undefined
          : sql`(${conversation.updatedAt}, ${conversation.id}) < (${before.updatedAt.toISOString()}::timestamptz, ${before.id}::uuid)`,
      ),
    )
    .orderBy(desc(conversation.updatedAt), desc(conversation.id))
    .limit(limit + 1);
  return {
    conversations: rows
      .slice(0, limit)
      .map(({ lastBody, lastKind, lastAuthorVisitorId, lastCreatedAt, ...row }) => ({
        ...withSnooze(row),
        lastMessage:
          lastCreatedAt === null || lastKind === null
            ? null
            : {
                body: lastBody,
                kind: lastKind,
                fromVisitor: lastAuthorVisitorId !== null,
                createdAt: lastCreatedAt,
              },
      })),
    hasMore: rows.length > limit,
  };
}

/** Open conversations for each assignee filter, across all pages: one scan of the workspace's. */
export interface OpenCounts {
  all: number;
  /** The operator's own. Always 0 for an API key, which has no assignments. */
  mine: number;
  unassigned: number;
}

export async function countOpenByAssignee(
  tx: Transaction,
  workspaceId: string,
  operatorId: string | null,
): Promise<OpenCounts> {
  const result = await tx.execute<{ every: number; mine: number; unassigned: number }>(sql`
    select count(*)::int as every,
           count(*) filter (where assignee_operator_id = ${operatorId}::uuid)::int as mine,
           count(*) filter (where assignee_operator_id is null)::int as unassigned
    from ${conversation}
    where workspace_id = ${workspaceId} and status = 'open'`);
  const row = result.rows[0];
  return { all: row?.every ?? 0, mine: row?.mine ?? 0, unassigned: row?.unassigned ?? 0 };
}

/**
 * How many open conversations wait for a reply: their newest message is from the visitor, and they
 * are not snoozed. For an operator, only the ones assigned to them or to no one, as a teammate's are
 * not theirs to answer. An API key, with no assignments, counts them all. It is not a per-operator
 * read state.
 */
export async function countWaiting(
  tx: Transaction,
  workspaceId: string,
  operatorId: string | null,
): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
    from ${conversation} as c
    cross join lateral (
      select m.author_visitor_id from ${message} as m
      where m.workspace_id = c.workspace_id and m.conversation_id = c.id
        and ${isChat(sql`m.kind`)} and m.deleted_at is null
      order by m.seq desc
      limit 1
    ) as newest
    where c.workspace_id = ${workspaceId} and c.status = 'open'
      and newest.author_visitor_id is not null and not ${snoozedNow(sql`c`)}
      ${operatorId === null ? sql`` : sql`and (c.assignee_operator_id is null or c.assignee_operator_id = ${operatorId})`}`);
  return result.rows[0]?.count ?? 0;
}

/**
 * How long until the workspace's next timed snooze ends, by the database's clock, or null with none.
 * A snooze ends with no event, so a client loads the list again then. Only an open conversation has
 * a snooze, which the conversation_snooze check holds, so conversation_snooze_end_idx serves this.
 */
export async function nextSnoozeEndMs(
  tx: Transaction,
  workspaceId: string,
): Promise<number | null> {
  const result = await tx.execute<{ ms: number | null }>(sql`
    select ceil(extract(epoch from min(snoozed_until) - now()) * 1000)::float8 as ms
    from ${conversation}
    where workspace_id = ${workspaceId} and snoozed_until > now()`);
  return result.rows[0]?.ms ?? null;
}

/** A reply's author: its operator's or API key's name, and an operator picture's time. */
export interface MessageAuthor {
  name: string;
  pictureUpdatedAt: Date | null;
  /** A deleted account, whose name is the placeholder for a former team member. */
  isDeleted: boolean;
}

/** These operators, by ID. A removed member keeps a name, so old replies keep it. */
async function operatorAuthors(
  tx: Transaction,
  ids: Iterable<string | null>,
): Promise<Map<string, MessageAuthor>> {
  const wanted = [...new Set([...ids].filter((id) => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({
      id: operator.id,
      name: operator.name,
      pictureUpdatedAt: operator.pictureUpdatedAt,
      deletedAt: operator.deletedAt,
    })
    .from(operator)
    .where(inArray(operator.id, wanted));
  return new Map(
    rows.map(({ id, deletedAt, ...author }) => [id, { ...author, isDeleted: deletedAt !== null }]),
  );
}

/** The names of these API keys, by ID. A revoked key keeps its row, so old replies keep its name. */
async function apiKeyNames(
  tx: Transaction,
  workspaceId: string,
  ids: Iterable<string | null>,
): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id) => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: apiKey.id, name: apiKey.name })
    .from(apiKey)
    .where(and(eq(apiKey.workspaceId, workspaceId), inArray(apiKey.id, wanted)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Each message's author, by the operator's or the key's ID. Both are random UUIDs. */
export async function messageAuthors(
  tx: Transaction,
  workspaceId: string,
  messages: Pick<StoredMessage, "authorOperatorId" | "authorApiKeyId">[],
): Promise<Map<string, MessageAuthor>> {
  const operators = await operatorAuthors(
    tx,
    messages.map((one) => one.authorOperatorId),
  );
  const keys = await apiKeyNames(
    tx,
    workspaceId,
    messages.map((one) => one.authorApiKeyId),
  );
  const keyAuthors = [...keys].map(
    ([id, name]) => [id, { name, pictureUpdatedAt: null, isDeleted: false }] as const,
  );
  return new Map([...operators, ...keyAuthors]);
}

/** Each message's author name, by the operator's or the key's ID. */
export async function authorNames(
  tx: Transaction,
  workspaceId: string,
  messages: Pick<StoredMessage, "authorOperatorId" | "authorApiKeyId">[],
): Promise<Map<string, string>> {
  const authors = await messageAuthors(tx, workspaceId, messages);
  return new Map([...authors].map(([id, author]) => [id, author.name]));
}

/** One message, or null when it does not exist. A deleted one is found, with `deleted` set. */
export async function findMessage(
  tx: Transaction,
  workspaceId: string,
  messageId: string,
): Promise<StoredMessage | null> {
  return (await findMessages(tx, workspaceId, [messageId])).get(messageId) ?? null;
}

/** The messages of these IDs that exist, by ID, in one query. */
export async function findMessages(
  tx: Transaction,
  workspaceId: string,
  messageIds: string[],
): Promise<Map<string, StoredMessage>> {
  if (messageIds.length === 0) return new Map();
  const rows = await tx
    .select(messageColumns)
    .from(message)
    .where(and(eq(message.workspaceId, workspaceId), inArray(message.id, messageIds)));
  return new Map(rows.map((row) => [row.id, stored(row)]));
}

export async function findConversation(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  return (await findConversations(tx, workspaceId, [conversationId])).get(conversationId) ?? null;
}

/** The conversations of these IDs that exist, by ID, in one query. */
export async function findConversations(
  tx: Transaction,
  workspaceId: string,
  conversationIds: string[],
): Promise<Map<string, ConversationRow>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await tx
    .select(conversationColumns)
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .where(
      and(eq(conversation.workspaceId, workspaceId), inArray(conversation.id, conversationIds)),
    );
  return new Map(rows.map((row) => [row.id, withSnooze(row)]));
}

/** One conversation's messages after a position, in commit order. */
export async function listConversationMessages(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  after: bigint,
  limit: number,
): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
  const rows = await tx
    .select(messageColumns)
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.conversationId, conversationId),
        gt(message.seq, after),
      ),
    )
    .orderBy(asc(message.seq))
    .limit(limit + 1);
  return { messages: rows.slice(0, limit).map(stored), hasMore: rows.length > limit };
}

/**
 * Closes or reopens a conversation. Its event tells other operators, and a status line with the
 * event's sequence tells the visitor, in the same transaction, so both see it in order. The line has
 * no message.created event, so it raises no reply alert and no message webhook. A close asks the
 * worker whether to email the visitor a transcript. False when it already had this status.
 */
export async function setConversationStatus(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  status: "open" | "closed",
  actor: StatusActor,
): Promise<boolean> {
  const seq = await nextSeq(tx, workspaceId);
  const changed = await tx
    .update(conversation)
    // A close ends a snooze, and a reopen starts with none.
    .set({ status, updatedAt: sql`now()`, snoozedAt: null, snoozedUntil: null })
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.id, conversationId),
        ne(conversation.status, status),
      ),
    )
    .returning({ id: conversation.id });
  if (changed.length === 0) return false;
  const [line] = await tx
    .insert(message)
    .values({
      workspaceId,
      conversationId,
      seq,
      kind: status === "closed" ? "closed" : "reopened",
      // One line per change, so the sequence makes it unique.
      clientId: `status-${seq}`,
      ...(actor.kind === "visitor"
        ? { authorVisitorId: actor.visitorId }
        : actor.kind === "operator"
          ? { authorOperatorId: actor.operatorId }
          : { authorApiKeyId: actor.apiKeyId }),
    })
    .returning({ id: message.id });
  if (line === undefined) throw new Error("The status line insert returned no row");
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind: status === "closed" ? "conversation.closed" : "conversation.reopened",
    payload: { conversationId, messageId: line.id } satisfies StatusPayload,
    // A close may email the visitor a transcript, which the worker decides.
    needsAlert: status === "closed",
    needsWebhook: wantsWebhook(workspaceId),
  });
  return true;
}

/**
 * Snoozes an open conversation, or ends its snooze with null. An event tells other operators, and
 * the visitor hears nothing. False when no open conversation has this ID.
 */
export async function snoozeConversation(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  snooze: Snooze | null,
): Promise<boolean> {
  const seq = await nextSeq(tx, workspaceId);
  const changed = await tx
    .update(conversation)
    .set({
      snoozedAt: snooze === null ? null : sql`now()`,
      snoozedUntil: snooze?.until ?? null,
    })
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.id, conversationId),
        eq(conversation.status, "open"),
      ),
    )
    .returning({ id: conversation.id });
  if (changed.length === 0) return false;
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind: "conversation.snoozed",
    payload: { conversationId },
  });
  return true;
}

/**
 * The payload of a close, a reopen or a transcript request: the conversation, and its status line,
 * or for a request the newest message that is not deleted.
 */
export interface StatusPayload {
  conversationId: string;
  messageId: string;
}

/** Sets or clears the assignee. An event tells other operators. Returns false with no such row. */
export async function assignConversation(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  operatorId: string | null,
): Promise<boolean> {
  const seq = await nextSeq(tx, workspaceId);
  const changed = await tx
    .update(conversation)
    .set({ assigneeOperatorId: operatorId })
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)))
    .returning({ id: conversation.id });
  if (changed.length === 0) return false;
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind: "conversation.assigned",
    payload: { conversationId },
    needsWebhook: wantsWebhook(workspaceId),
  });
  return true;
}

type ConversationChange = Extract<EventKind, `conversation.${string}` | "draft.changed">;

/** Tells every open operator app that this conversation, or its drafts, changed. It holds no text. */
export const recordConversationChange = (
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  kind: ConversationChange,
): Promise<void> => recordConversationChanges(tx, workspaceId, [conversationId], kind);

/** The same change to several conversations, with an event each, in one insert. */
export async function recordConversationChanges(
  tx: Transaction,
  workspaceId: string,
  conversationIds: string[],
  kind: ConversationChange,
): Promise<void> {
  if (conversationIds.length === 0) return;
  const first = await takeSeqs(tx, workspaceId, conversationIds.length);
  await tx.insert(event).values(
    conversationIds.map((conversationId, index) => ({
      workspaceId,
      seq: first + BigInt(index),
      kind,
      payload: { conversationId },
    })),
  );
}

/** Tells every open operator app to read the team again. It holds no names. */
export async function recordTeamChange(tx: Transaction, workspaceId: string): Promise<void> {
  const seq = await nextSeq(tx, workspaceId);
  await tx.insert(event).values({ workspaceId, seq, kind: "team.changed" });
}

/** Tells every open operator app to read the workspace's billing state and `me` again. */
export async function recordBillingChange(tx: Transaction, workspaceId: string): Promise<void> {
  const seq = await nextSeq(tx, workspaceId);
  await tx.insert(event).values({ workspaceId, seq, kind: "billing.changed" });
}

/**
 * Tells every open operator app to read `me` again, for a new name or logo, and the saved replies.
 */
export async function recordWorkspaceChange(tx: Transaction, workspaceId: string): Promise<void> {
  const seq = await nextSeq(tx, workspaceId);
  await tx.insert(event).values({ workspaceId, seq, kind: "workspace.changed" });
}

interface FeedEvent {
  seq: bigint;
  kind: EventKind;
  // Null for a team or billing change.
  conversationId: string | null;
  /** On a new message: whether the visitor wrote it. */
  fromVisitor: boolean;
  /** The IDs the event names, which the key event stream reads back. */
  payload: unknown;
}

/**
 * The workspace's events after a cursor. They name what changed and hold no text, and a client
 * loads what it needs. With no cursor it starts at the present, because a client loads its lists
 * after the stream is ready.
 */
export async function listWorkspaceEvents(
  tx: Transaction,
  workspaceId: string,
  after: Cursor | undefined,
  limit: number,
): Promise<{ events: FeedEvent[]; cursor: Cursor; hasMore: boolean; resync: boolean }> {
  const [current] = await tx
    .select({ generation: workspace.feedGeneration, seq: workspace.eventSeq })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  if (current === undefined) throw new Error("The workspace row is missing");
  const present = { generation: current.generation, seq: current.seq };
  if (after === undefined) return { events: [], cursor: present, hasMore: false, resync: false };
  if (after.generation !== current.generation) {
    return { events: [], cursor: present, hasMore: false, resync: true };
  }
  // Pruning removed the events after this cursor, so the client must load again.
  if (after.seq < current.seq) {
    const [oldest] = await tx
      .select({ seq: event.seq })
      .from(event)
      .where(eq(event.workspaceId, workspaceId))
      .orderBy(asc(event.seq))
      .limit(1);
    if (oldest === undefined || oldest.seq > after.seq + 1n) {
      return { events: [], cursor: present, hasMore: false, resync: true };
    }
  }
  const rows = await tx
    .select({ seq: event.seq, kind: event.kind, payload: event.payload })
    .from(event)
    .where(and(eq(event.workspaceId, workspaceId), gt(event.seq, after.seq)))
    .orderBy(asc(event.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    events: page.map((row) => ({
      seq: row.seq,
      kind: row.kind,
      conversationId: (row.payload as { conversationId?: string }).conversationId ?? null,
      fromVisitor: (row.payload as { fromVisitor?: boolean }).fromVisitor === true,
      payload: row.payload,
    })),
    cursor: { generation: current.generation, seq: page.at(-1)?.seq ?? after.seq },
    hasMore: rows.length > limit,
    resync: false,
  };
}

/** `%` and `_` match anything in a LIKE pattern, so a search for them must escape them. */
export const containing = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Conversations, open and closed, whose visitor's name, email or user ID, or one of whose messages,
 * holds the text, newest activity first. A match in a message becomes the preview.
 */
export async function searchConversations(
  tx: Transaction,
  workspaceId: string,
  operatorId: string | null,
  text: string,
  limit: number,
): Promise<ConversationSummary[]> {
  const pattern = containing(text);
  // The matches first, so the previews below are read for one page of them only. The trigram index
  // on (workspace_id, body) serves this. Under row-level security Postgres uses only its workspace
  // part, because ILIKE is not leakproof, so a search reads its own workspace's messages only.
  const inMessages = tx
    .select({ id: message.conversationId })
    .from(message)
    .where(and(eq(message.workspaceId, workspaceId), ilike(message.body, pattern)));
  const matched = tx
    .select({ id: conversation.id })
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        or(
          ilike(visitor.name, pattern),
          ilike(visitor.email, pattern),
          ilike(visitor.externalId, pattern),
          inArray(conversation.id, inMessages),
        ),
      ),
    )
    .orderBy(desc(conversation.updatedAt), desc(conversation.id))
    .limit(limit);
  // The newest matching message of each conversation. A note matches the search, but the preview
  // shows chat only.
  const hit = tx
    .select({ body: message.body })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.conversationId, conversation.id),
        isChat(),
        ilike(message.body, pattern),
      ),
    )
    .orderBy(desc(message.seq))
    .limit(1)
    .as("hit");
  const newest = tx
    .select({
      body: message.body,
      kind: chatKind(),
      metadata: message.metadata,
      authorVisitorId: message.authorVisitorId,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.conversationId, conversation.id),
        isChat(),
        isNull(message.deletedAt),
      ),
    )
    .orderBy(desc(message.seq))
    .limit(1)
    .as("newest");
  const rows = await tx
    .select({
      ...conversationColumns,
      unread: unreadBy(operatorId),
      hitBody: hit.body,
      lastBody: previewBody(newest.body, newest.metadata),
      lastKind: newest.kind,
      lastAuthorVisitorId: newest.authorVisitorId,
      lastCreatedAt: newest.createdAt,
    })
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .leftJoinLateral(hit, sql`true`)
    .leftJoinLateral(newest, sql`true`)
    .where(and(eq(conversation.workspaceId, workspaceId), inArray(conversation.id, matched)))
    .orderBy(desc(conversation.updatedAt), desc(conversation.id));
  // The matching message's text is the preview. Who wrote last and when still come from the
  // newest message, so a conversation shows as waiting only when the visitor wrote last.
  return rows.map(
    ({ hitBody, lastBody, lastKind, lastAuthorVisitorId, lastCreatedAt, ...row }) => ({
      ...withSnooze(row),
      lastMessage:
        lastCreatedAt === null || lastKind === null
          ? null
          : {
              body: hitBody ?? lastBody,
              kind: hitBody === null ? lastKind : "text",
              fromVisitor: lastAuthorVisitorId !== null,
              createdAt: lastCreatedAt,
            },
    }),
  );
}
