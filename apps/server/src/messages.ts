import { z } from "@hono/zod-openapi";
import {
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
  or,
  sql,
} from "drizzle-orm";
import { quoteExcerpt } from "../../../packages/widget/src/markdown.ts";
import { firstName } from "../../../packages/widget/src/shared.ts";
import {
  alertDelivery,
  apiKey,
  attachment,
  CHAT_KINDS,
  conversation,
  type EventKind,
  event,
  type MessageCreatedPayload,
  message,
  operator,
  storageDeletion,
  visitor,
  webhook,
  workspace,
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

/** Only what people wrote, without the status lines of a close or a reopen. */
export const isChat = () => inArray(message.kind, [...CHAT_KINDS]);

/** Who closed or reopened a conversation, as the author of its status line. */
export type StatusActor =
  | { kind: "operator"; operatorId: string }
  | { kind: "key"; apiKeyId: string }
  | { kind: "visitor"; visitorId: string };

export type Author =
  | { kind: "visitor"; visitorId: string }
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
    // The first 140 characters of its text, on one line, without Markdown marks.
    excerpt: z.string(),
    hasImage: z.boolean(),
  })
  .openapi("Quote");

/** The quote as the database reads it, before the excerpt is cut. */
interface QuoteRow {
  id: string;
  deleted: boolean;
  fromVisitor: boolean;
  /** An operator who still has an account, whom the widget calls by first name. */
  byOperator: boolean;
  authorName: string | null;
  body: string | null;
  hasImage: boolean;
}

// Enough to fill the excerpt after the Markdown marks go.
const QUOTE_BODY_CHARACTERS = 600;

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
    'body', left(q.body, ${QUOTE_BODY_CHARACTERS}),
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
  if (row.deleted) return { id: null, ...shown, excerpt: "", hasImage: false };
  return { id: row.id, ...shown, excerpt: quoteExcerpt(row.body ?? ""), hasImage: row.hasImage };
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

/** How a key's reply came: through the REST API or through the MCP server. */
type KeyChannel = "api" | "mcp";

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
  replyTo: QuoteRow | null;
  editedAt: Date | null;
  /** Deleted by an operator: its body and image are gone, and it shows as a placeholder. */
  deleted: boolean;
  /** When the visitor's read position first passed this reply, when known. */
  readAt: Date | null;
  /** A key's reply: through the API or MCP. Null for an operator's or a visitor's message. */
  via: KeyChannel | null;
  /** Its own position, or its last edit's or delete's, for a stream that sends changes again. */
  changeSeq: bigint;
  createdAt: Date;
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
  /** Set on a key's reply that came through MCP. */
  via?: "mcp";
}

function stored({
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
    fromVisitor: authorVisitorId !== null,
    deleted: deletedAt !== null,
    via: row.authorApiKeyId === null ? null : (meta?.via ?? "api"),
    changeSeq: changedSeq ?? row.seq,
  };
}

/** The visitor's open conversation, or a new one. The workspace lock makes this safe to race. */
async function openConversationId(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  startedPage: string | null,
): Promise<{ id: string; created: boolean }> {
  const [open] = await tx
    .select({ id: conversation.id })
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
  if (open !== undefined) return { id: open.id, created: false };
  const [created] = await tx
    .insert(conversation)
    .values({ workspaceId, visitorId, startedPage })
    .returning({ id: conversation.id });
  if (created === undefined) throw new Error("The conversation insert returned no row");
  return { id: created.id, created: true };
}

/**
 * True when the workspace has an enabled webhook, read in the event's own insert, so a workspace
 * with none gives the worker nothing to do.
 */
const wantsWebhook = (workspaceId: string) =>
  sql<boolean>`exists (select 1 from ${webhook} where ${webhook.workspaceId} = ${workspaceId} and ${webhook.enabled})`;

export interface NewImage {
  attachmentId: string;
  storageKey: string;
  byteSize: number;
  contentType: string;
  width: number;
  height: number;
}

/** The quoted message is not a message people wrote in this conversation, or it was deleted. */
export class InvalidReplyToError extends Error {
  constructor() {
    super("The quoted message is not in this conversation.");
  }
}

/** Throws InvalidReplyToError unless the quoted message is a live chat line of this conversation. */
async function checkQuote(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const [found] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.id, messageId),
        eq(message.conversationId, conversationId),
        isChat(),
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

/** Takes the next position and the workspace row lock, which lasts until commit. */
async function nextSeq(tx: Transaction, workspaceId: string): Promise<bigint> {
  const [next] = await tx
    .update(workspace)
    .set({ eventSeq: sql`${workspace.eventSeq} + 1` })
    .where(eq(workspace.id, workspaceId))
    .returning({ seq: workspace.eventSeq });
  if (next === undefined) throw new Error("The workspace row is missing");
  return next.seq;
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
 * Keep the caller's transaction short, because this lock serializes writes in the workspace. An image
 * counts against the plan's storage under the same lock, and throws StorageFullError past it.
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
    image?: NewImage;
    page?: string | null;
    /** False for a message that nobody needs to hear about, such as the cloud's welcome. */
    alert?: boolean;
    /** An earlier message of the same conversation that this one quotes. */
    replyToMessageId?: string | undefined;
    /** A key's reply that came through MCP, which the message's info names. */
    via?: "mcp";
  },
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
  // retry of a reply that already committed still gets its original message.
  let assignsReplier = false;
  if (author.kind !== "visitor") {
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
  if (
    input.image !== undefined &&
    !(await limits.mayStore(tx, workspaceId, input.image.byteSize))
  ) {
    throw new StorageFullError();
  }

  const target =
    author.kind === "visitor"
      ? await openConversationId(tx, workspaceId, author.visitorId, input.page ?? null)
      : { id: author.conversationId, created: false };
  const conversationId = target.id;
  if (input.replyToMessageId !== undefined) {
    await checkQuote(tx, workspaceId, conversationId, input.replyToMessageId);
  }
  const metadata: MessageMetadata = {
    ...(input.image !== undefined && {
      image: {
        attachmentId: input.image.attachmentId,
        width: input.image.width,
        height: input.image.height,
      },
    }),
    ...(input.via !== undefined && { via: input.via }),
  };
  const [row] = await tx
    .insert(message)
    .values({
      workspaceId,
      conversationId,
      seq,
      kind: input.image === undefined ? "text" : "image",
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
  if (input.image !== undefined) {
    await tx.insert(attachment).values({
      workspaceId,
      id: input.image.attachmentId,
      messageId: row.id,
      storageKey: input.image.storageKey,
      byteSize: input.image.byteSize,
      contentType: input.image.contentType,
      width: input.image.width,
      height: input.image.height,
    });
  }

  // The payload holds IDs only, so deleting a message removes its text.
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind: "message.created",
    payload: {
      messageId: row.id,
      conversationId,
      fromVisitor: author.kind === "visitor",
      ...(target.created ? { conversationCreated: true } : {}),
    } satisfies MessageCreatedPayload,
    needsAlert: input.alert ?? true,
    needsWebhook: wantsWebhook(workspaceId),
  });
  await tx
    .update(conversation)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  // The operator who answers an unassigned conversation first takes it. A key's reply never does.
  if (assignsReplier && author.kind === "operator") {
    await assignConversation(tx, workspaceId, conversationId, author.operatorId);
  }
  return { message: stored(row), created: true, conversationStarted: target.created };
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
 * when it moved.
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
    .for("update");
  if (before === undefined) return false;
  const [moved] = await tx
    .update(visitor)
    .set({ lastReadSeq: target })
    .where(and(one, sql`${visitor.lastReadSeq} < ${target}`))
    .returning({ lastReadSeq: visitor.lastReadSeq });
  if (moved === undefined) return false;
  // The replies this read passed, so their info can say when the visitor read them.
  await tx
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
    );
  return true;
}

const visitorConversations = (tx: Transaction, workspaceId: string, visitorId: string) =>
  tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.visitorId, visitorId)));

/**
 * How far the visitor has seen the replies in one conversation: read in the chat up to `readSeq`,
 * sent by email up to `emailedSeq`, and up to `emailFailedSeq` when the newest reply email failed.
 * An email carries every reply the visitor had not read when it went, so it covers each reply
 * written before it. One statement, for the whole conversation.
 */
export async function replyReceipts(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  visitorId: string,
): Promise<{ readSeq: bigint; emailedSeq: bigint | null; emailFailedSeq: bigint | null }> {
  const result = await tx.execute<{
    read_seq: string | null;
    emailed_seq: string | null;
    failed_seq: string | null;
  }>(sql`
    with email as (
      select max(finished_at) filter (where outcome = 'sent') as sent_at,
             max(finished_at) filter (where outcome = 'failed') as failed_at
      from alert_delivery
      where workspace_id = ${workspaceId} and visitor_id = ${visitorId} and channel = 'email'
    ),
    covered as (
      select max(m.seq) filter (where m.created_at <= email.sent_at) as emailed_seq,
             max(m.seq) filter (where m.created_at <= email.failed_at
               and email.failed_at > coalesce(email.sent_at, '-infinity')) as failed_seq
      from email
      left join message as m on m.workspace_id = ${workspaceId}
        and m.conversation_id = ${conversationId} and m.author_visitor_id is null
        and m.kind in ('text', 'image')
    )
    select (select last_read_seq from visitor
            where workspace_id = ${workspaceId} and id = ${visitorId}) as read_seq,
           covered.emailed_seq, covered.failed_seq
    from covered`);
  const row = result.rows[0];
  const big = (value: string | null | undefined) => (value == null ? null : BigInt(value));
  return {
    readSeq: big(row?.read_seq) ?? 0n,
    emailedSeq: big(row?.emailed_seq),
    emailFailedSeq: big(row?.failed_seq),
  };
}

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
  messages: StoredMessage[];
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
  // An edit or a delete sends the message again, at its change's position.
  const changePosition = sql<bigint>`coalesce(${message.changedSeq}, ${message.seq})`;
  const rows = await tx
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
        gt(changePosition, position.seq),
      ),
    )
    .orderBy(asc(changePosition))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map(stored);
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
}

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
};

/** Joins a conversation to its visitor, inside the same workspace. */
export function joinVisitor() {
  return and(
    eq(visitor.workspaceId, conversation.workspaceId),
    eq(visitor.id, conversation.visitorId),
  );
}

interface ConversationSummary extends ConversationRow {
  lastMessage: { body: string | null; fromVisitor: boolean; createdAt: Date } | null;
}

/** Whose conversations a list holds: everyone's, one operator's, or no one's. */
export type AssigneeFilter =
  | { kind: "all" }
  | { kind: "operator"; operatorId: string }
  | { kind: "none" };

function assigneeCondition(assignee: AssigneeFilter) {
  if (assignee.kind === "all") return undefined;
  if (assignee.kind === "none") return isNull(conversation.assigneeOperatorId);
  return eq(conversation.assigneeOperatorId, assignee.operatorId);
}

/** A page of conversations, newest activity first. */
export async function listConversations(
  tx: Transaction,
  workspaceId: string,
  status: "open" | "closed",
  assignee: AssigneeFilter,
  before: { updatedAt: Date; id: string } | undefined,
  limit: number,
): Promise<{ conversations: ConversationSummary[]; hasMore: boolean }> {
  // One index probe per listed conversation, through message_conversation_idx backwards.
  const newest = tx
    .select({
      body: message.body,
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
      lastBody: newest.body,
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
        assigneeCondition(assignee),
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
      .map(({ lastBody, lastAuthorVisitorId, lastCreatedAt, ...row }) => ({
        ...row,
        lastMessage:
          lastCreatedAt === null
            ? null
            : {
                body: lastBody,
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
 * How many open conversations wait for a reply: their newest message is from the visitor. It is
 * one number for the whole workspace, not a per-operator read state.
 */
export async function countWaiting(tx: Transaction, workspaceId: string): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
    from ${conversation} as c
    cross join lateral (
      select m.author_visitor_id from ${message} as m
      where m.workspace_id = c.workspace_id and m.conversation_id = c.id
        and m.kind in ('text', 'image')
      order by m.seq desc
      limit 1
    ) as newest
    where c.workspace_id = ${workspaceId} and c.status = 'open'
      and newest.author_visitor_id is not null`);
  return result.rows[0]?.count ?? 0;
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

/** One message, or null when it was deleted. */
export async function findMessage(
  tx: Transaction,
  workspaceId: string,
  messageId: string,
): Promise<StoredMessage | null> {
  const [row] = await tx
    .select(messageColumns)
    .from(message)
    .where(and(eq(message.workspaceId, workspaceId), eq(message.id, messageId)));
  return row === undefined ? null : stored(row);
}

export async function findConversation(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select(conversationColumns)
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  return row ?? null;
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
 * worker whether to email the visitor a transcript.
 */
export async function setConversationStatus(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  status: "open" | "closed",
  actor: StatusActor,
): Promise<void> {
  const seq = await nextSeq(tx, workspaceId);
  const changed = await tx
    .update(conversation)
    .set({ status, updatedAt: sql`now()` })
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.id, conversationId),
        ne(conversation.status, status),
      ),
    )
    .returning({ id: conversation.id });
  if (changed.length === 0) return;
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
}

/**
 * Asks the worker to email the visitor this conversation now, through the event table, so it goes
 * at least once. The payload names the newest message. False with no message to send.
 */
export async function requestTranscript(
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

/** The payload of a close or a reopen: the conversation, and its status line. */
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

/** Tells every open operator app that this conversation changed. It holds no text. */
export async function recordConversationChange(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  kind: Extract<EventKind, `conversation.${string}`>,
): Promise<void> {
  const seq = await nextSeq(tx, workspaceId);
  await tx.insert(event).values({ workspaceId, seq, kind, payload: { conversationId } });
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

/** Tells every open operator app to read `me` again, for a new name or logo. */
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
    })),
    cursor: { generation: current.generation, seq: page.at(-1)?.seq ?? after.seq },
    hasMore: rows.length > limit,
    resync: false,
  };
}

/** `%` and `_` match anything in a LIKE pattern, so a search for them must escape them. */
const containing = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Conversations, open and closed, whose visitor's name, email or user ID, or one of whose messages,
 * holds the text, newest activity first. A match in a message becomes the preview.
 */
export async function searchConversations(
  tx: Transaction,
  workspaceId: string,
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
  // The newest matching message of each conversation.
  const hit = tx
    .select({ body: message.body })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.conversationId, conversation.id),
        ilike(message.body, pattern),
      ),
    )
    .orderBy(desc(message.seq))
    .limit(1)
    .as("hit");
  const newest = tx
    .select({
      body: message.body,
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
      hitBody: hit.body,
      lastBody: newest.body,
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
  return rows.map(({ hitBody, lastBody, lastAuthorVisitorId, lastCreatedAt, ...row }) => ({
    ...row,
    lastMessage:
      lastCreatedAt === null
        ? null
        : {
            body: hitBody ?? lastBody,
            fromVisitor: lastAuthorVisitorId !== null,
            createdAt: lastCreatedAt,
          },
  }));
}

/** The event of an edit or a delete, as a new message's, so the webhook fan-out reads it alike. */
async function recordMessageChange(
  tx: Transaction,
  workspaceId: string,
  seq: bigint,
  kind: "message.updated" | "message.deleted",
  row: { id: string; conversationId: string; authorVisitorId: string | null },
): Promise<void> {
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind,
    payload: {
      messageId: row.id,
      conversationId: row.conversationId,
      fromVisitor: row.authorVisitorId !== null,
    } satisfies MessageCreatedPayload,
    needsWebhook: wantsWebhook(workspaceId),
  });
}

/** One chat line of this conversation, locked until commit, or undefined. */
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
      deletedAt: message.deletedAt,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.workspaceId, workspaceId),
        eq(message.id, messageId),
        eq(message.conversationId, conversationId),
        isChat(),
      ),
    )
    .for("update");
  return row;
}

/**
 * Whether the visitor may have seen a reply: read it in the chat, or got an email that may carry it,
 * sent or being sent now. It locks the visitor's row, which a read takes too, so a read cannot slip
 * in before the edit commits. An email row still waiting reads the body when it goes.
 */
async function visitorMaySee(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  line: { seq: bigint; createdAt: Date },
): Promise<boolean> {
  const [reader] = await tx
    .select({ id: visitor.id, lastReadSeq: visitor.lastReadSeq })
    .from(visitor)
    .innerJoin(conversation, joinVisitor())
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)))
    .for("update", { of: visitor });
  if (reader === undefined) return true;
  if (reader.lastReadSeq >= line.seq) return true;
  const [email] = await tx
    .select({ channel: alertDelivery.channel })
    .from(alertDelivery)
    .where(
      and(
        eq(alertDelivery.workspaceId, workspaceId),
        eq(alertDelivery.visitorId, reader.id),
        inArray(alertDelivery.channel, ["email", "transcript"]),
        or(
          and(
            eq(alertDelivery.outcome, "sent"),
            sql`${alertDelivery.finishedAt} >= ${line.createdAt.toISOString()}::timestamptz`,
          ),
          and(isNull(alertDelivery.finishedAt), sql`${alertDelivery.claimedUntil} > now()`),
        ),
      ),
    )
    .limit(1);
  return email !== undefined;
}

export type EditOutcome =
  | { kind: "edited"; message: StoredMessage; visitorId: string }
  | { kind: "missing" }
  | { kind: "not_yours" }
  | { kind: "seen" };

/**
 * Changes the text of an operator's own reply while the visitor cannot have seen it. Its event tells
 * the widget, the other operators and the webhooks, in the same transaction.
 */
export async function editMessage(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  messageId: string,
  operatorId: string,
  body: string,
): Promise<EditOutcome> {
  const seq = await nextSeq(tx, workspaceId);
  const line = await lockChatLine(tx, workspaceId, conversationId, messageId);
  if (line === undefined || line.deletedAt !== null) return { kind: "missing" };
  if (line.authorOperatorId !== operatorId || line.kind !== "text") return { kind: "not_yours" };
  if (await visitorMaySee(tx, workspaceId, conversationId, line)) return { kind: "seen" };
  const [row] = await tx
    .update(message)
    .set({ body, editedAt: sql`now()`, changedSeq: seq })
    .where(and(eq(message.workspaceId, workspaceId), eq(message.id, messageId)))
    .returning(messageColumns);
  if (row === undefined) throw new Error("The message update returned no row");
  await recordMessageChange(tx, workspaceId, seq, "message.updated", line);
  const found = await findConversation(tx, workspaceId, conversationId);
  return { kind: "edited", message: stored(row), visitorId: found?.visitorId ?? "" };
}

export type DeleteOutcome =
  | { kind: "deleted"; visitorId: string }
  | { kind: "missing" }
  | { kind: "not_yours" };

/**
 * Clears a message's body and image, and keeps its row, so positions, receipts and quotes still
 * work. The worker deletes the image's file, as for a deleted conversation. `any` lets an owner or
 * an admin delete anyone's message; others delete their own.
 */
export async function deleteMessage(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  messageId: string,
  by: { operatorId: string; any: boolean },
): Promise<DeleteOutcome> {
  const seq = await nextSeq(tx, workspaceId);
  const line = await lockChatLine(tx, workspaceId, conversationId, messageId);
  if (line === undefined) return { kind: "missing" };
  if (!by.any && line.authorOperatorId !== by.operatorId) return { kind: "not_yours" };
  const found = await findConversation(tx, workspaceId, conversationId);
  const visitorId = found?.visitorId ?? "";
  if (line.deletedAt !== null) return { kind: "deleted", visitorId };
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
  await recordMessageChange(tx, workspaceId, seq, "message.deleted", line);
  return { kind: "deleted", visitorId };
}

/**
 * When the first email that may carry this reply went: a reply email or a transcript, sent after it
 * was written. Null when none did, or when its row was pruned.
 */
export async function emailedAt(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  line: { conversationId: string; createdAt: Date },
): Promise<Date | null> {
  const [first] = await tx
    .select({ at: alertDelivery.finishedAt })
    .from(alertDelivery)
    .where(
      and(
        eq(alertDelivery.workspaceId, workspaceId),
        eq(alertDelivery.visitorId, visitorId),
        eq(alertDelivery.outcome, "sent"),
        or(
          eq(alertDelivery.channel, "email"),
          and(
            eq(alertDelivery.channel, "transcript"),
            eq(alertDelivery.conversationId, line.conversationId),
          ),
        ),
        sql`${alertDelivery.finishedAt} >= ${line.createdAt.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(alertDelivery.finishedAt))
    .limit(1);
  return first?.at ?? null;
}
