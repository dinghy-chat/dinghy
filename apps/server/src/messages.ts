import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import {
  attachment,
  conversation,
  type EventKind,
  event,
  type MessageCreatedPayload,
  message,
  operator,
  visitor,
  workspace,
} from "./db/schema.ts";
import { type Transaction, type WorkspaceAccess, workspaceAccess, writable } from "./db/tenant.ts";
import { type Limits, NO_LIMITS, StorageFullError } from "./limits.ts";

type Author =
  | { kind: "visitor"; visitorId: string }
  | { kind: "operator"; operatorId: string; conversationId: string };

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: bigint;
  kind: "text" | "image";
  fromVisitor: boolean;
  /** The operator who sent it, or null for a visitor's message. */
  authorOperatorId: string | null;
  /** The sender's own ID, so a client can match a stream copy to its pending line. */
  clientId: string;
  body: string | null;
  image: { attachmentId: string; width: number; height: number } | null;
  /** The image's file was deleted after 12 months, on Dinghy Cloud. */
  imageRemoved: boolean;
  createdAt: Date;
}

const messageColumns = {
  id: message.id,
  conversationId: message.conversationId,
  seq: message.seq,
  kind: message.kind,
  authorOperatorId: message.authorOperatorId,
  authorVisitorId: message.authorVisitorId,
  clientId: message.clientId,
  body: message.body,
  metadata: message.metadata,
  createdAt: message.createdAt,
};

interface MessageRow {
  id: string;
  conversationId: string;
  seq: bigint;
  kind: "text" | "image";
  authorOperatorId: string | null;
  authorVisitorId: string | null;
  clientId: string;
  body: string | null;
  metadata: unknown;
  createdAt: Date;
}

function stored({ authorVisitorId, metadata, ...row }: MessageRow): StoredMessage {
  const meta = metadata as { image?: StoredMessage["image"]; imageRemoved?: boolean } | null;
  return {
    ...row,
    image: meta?.image ?? null,
    imageRemoved: meta?.imageRemoved === true,
    fromVisitor: authorVisitorId !== null,
  };
}

/** The visitor's open conversation, or a new one. The workspace lock makes this safe to race. */
async function openConversationId(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  startedPage: string | null,
): Promise<string> {
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
  if (open !== undefined) return open.id;
  const [created] = await tx
    .insert(conversation)
    .values({ workspaceId, visitorId, startedPage })
    .returning({ id: conversation.id });
  if (created === undefined) throw new Error("The conversation insert returned no row");
  return created.id;
}

export interface NewImage {
  attachmentId: string;
  storageKey: string;
  byteSize: number;
  contentType: string;
  width: number;
  height: number;
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
  input: { clientId: string; body?: string; image?: NewImage; page?: string | null },
  limits: Pick<Limits, "mayStore"> = NO_LIMITS,
): Promise<{ message: StoredMessage; created: boolean }> {
  const seq = await nextSeq(tx, workspaceId);
  // A statement of its own, after the lock: it sees every change committed before the lock.
  const access = await workspaceAccess(tx, workspaceId);
  if (!writable(access)) throw new WorkspaceClosedError(access);

  const sender =
    author.kind === "visitor"
      ? eq(message.authorVisitorId, author.visitorId)
      : eq(message.authorOperatorId, author.operatorId);
  const [existing] = await tx
    .select(messageColumns)
    .from(message)
    .where(and(eq(message.workspaceId, workspaceId), sender, eq(message.clientId, input.clientId)));
  if (existing !== undefined) return { message: stored(existing), created: false };

  // After the retry lookup, and under the lock, so a close cannot slip in before this reply and a
  // retry of a reply that already committed still gets its original message.
  if (author.kind === "operator") {
    const [target] = await tx
      .select({ status: conversation.status })
      .from(conversation)
      .where(
        and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, author.conversationId)),
      );
    if (target?.status !== "open") throw new ConversationClosedError();
  }
  if (
    input.image !== undefined &&
    !(await limits.mayStore(tx, workspaceId, input.image.byteSize))
  ) {
    throw new StorageFullError();
  }

  const conversationId =
    author.kind === "visitor"
      ? await openConversationId(tx, workspaceId, author.visitorId, input.page ?? null)
      : author.conversationId;
  const [row] = await tx
    .insert(message)
    .values({
      workspaceId,
      conversationId,
      seq,
      kind: input.image === undefined ? "text" : "image",
      clientId: input.clientId,
      body: input.body ?? null,
      metadata:
        input.image === undefined
          ? {}
          : {
              image: {
                attachmentId: input.image.attachmentId,
                width: input.image.width,
                height: input.image.height,
              },
            },
      ...(author.kind === "visitor"
        ? { authorVisitorId: author.visitorId }
        : { authorOperatorId: author.operatorId }),
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
    } satisfies MessageCreatedPayload,
    needsAlert: true,
  });
  await tx
    .update(conversation)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  return { message: stored(row), created: true };
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
          isNotNull(message.authorOperatorId),
          gt(message.seq, row.lastReadSeq),
        ),
      ),
  );
  return { lastReadSeq: row.lastReadSeq, unread };
}

/**
 * Moves the read position forward. It never moves back, because tabs can report out of order, and
 * it stops at the feed's position, so a wrong value cannot hide messages that arrive later.
 */
export async function markRead(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  seq: bigint,
): Promise<void> {
  await tx
    .update(visitor)
    .set({
      lastReadSeq: sql`greatest(${visitor.lastReadSeq}, least(${seq}::bigint, (
        select ${workspace.eventSeq} from ${workspace} where ${workspace.id} = ${workspaceId}
      )))`,
    })
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
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
        gt(message.seq, position.seq),
      ),
    )
    .orderBy(asc(message.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    messages: page.map(stored),
    cursor: { generation: current.generation, seq: last?.seq ?? position.seq },
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
  visitorId: string;
  visitorBlockedAt: Date | null;
  visitorEmail: string | null;
  visitorExternalId: string | null;
  visitorName: string | null;
  visitorAttributes: unknown;
  visitorDevice: string | null;
  visitorLastPage: string | null;
  visitorLastSeenAt: Date | null;
}

const conversationColumns = {
  id: conversation.id,
  status: conversation.status,
  updatedAt: conversation.updatedAt,
  assigneeOperatorId: conversation.assigneeOperatorId,
  startedPage: conversation.startedPage,
  visitorId: conversation.visitorId,
  visitorBlockedAt: visitor.blockedAt,
  visitorEmail: visitor.email,
  visitorExternalId: visitor.externalId,
  visitorName: visitor.name,
  visitorAttributes: visitor.attributes,
  visitorDevice: visitor.device,
  visitorLastPage: visitor.lastPage,
  visitorLastSeenAt: visitor.lastSeenAt,
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

/** A page of conversations, newest activity first. */
export async function listConversations(
  tx: Transaction,
  workspaceId: string,
  status: "open" | "closed",
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
    .where(and(eq(message.workspaceId, workspaceId), eq(message.conversationId, conversation.id)))
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
      order by m.seq desc
      limit 1
    ) as newest
    where c.workspace_id = ${workspaceId} and c.status = 'open'
      and newest.author_visitor_id is not null`);
  return result.rows[0]?.count ?? 0;
}

/** The names of these operators, by ID. A removed member keeps a name, so old replies keep it. */
export async function operatorNames(
  tx: Transaction,
  ids: Iterable<string | null>,
): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id) => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: operator.id, name: operator.name })
    .from(operator)
    .where(inArray(operator.id, wanted));
  return new Map(rows.map((row) => [row.id, row.name]));
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

/** Closes or reopens a conversation, and adds an event so other operators catch up on it. */
export async function setConversationStatus(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  status: "open" | "closed",
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
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind: status === "closed" ? "conversation.closed" : "conversation.reopened",
    payload: { conversationId },
  });
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
  // The newest matching message of each conversation. No index helps a substring, so this reads
  // the workspace's messages: fine at a small team's size, and it runs only while someone searches.
  const hit = tx
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
    .where(and(eq(message.workspaceId, workspaceId), eq(message.conversationId, conversation.id)))
    .orderBy(desc(message.seq))
    .limit(1)
    .as("newest");
  const rows = await tx
    .select({
      ...conversationColumns,
      hitBody: hit.body,
      hitAuthorVisitorId: hit.authorVisitorId,
      hitCreatedAt: hit.createdAt,
      lastBody: newest.body,
      lastAuthorVisitorId: newest.authorVisitorId,
      lastCreatedAt: newest.createdAt,
    })
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .leftJoinLateral(hit, sql`true`)
    .leftJoinLateral(newest, sql`true`)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        or(
          ilike(visitor.name, pattern),
          ilike(visitor.email, pattern),
          ilike(visitor.externalId, pattern),
          isNotNull(hit.createdAt),
        ),
      ),
    )
    .orderBy(desc(conversation.updatedAt), desc(conversation.id))
    .limit(limit);
  return rows.map(
    ({
      hitBody,
      hitAuthorVisitorId,
      hitCreatedAt,
      lastBody,
      lastAuthorVisitorId,
      lastCreatedAt,
      ...row
    }) => ({
      ...row,
      lastMessage:
        hitCreatedAt !== null
          ? { body: hitBody, fromVisitor: hitAuthorVisitorId !== null, createdAt: hitCreatedAt }
          : lastCreatedAt === null
            ? null
            : {
                body: lastBody,
                fromVisitor: lastAuthorVisitorId !== null,
                createdAt: lastCreatedAt,
              },
    }),
  );
}
