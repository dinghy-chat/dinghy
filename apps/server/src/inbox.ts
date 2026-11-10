import { createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { type Actor, type KeyActor, keyStillValid } from "./api-keys.ts";
import { SESSION, SESSION_OR_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { session, workspace, workspaceLogo } from "./db/schema.ts";
import {
  type Database,
  type Transaction,
  type WorkspaceAccess,
  withWorkspace,
} from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  IMAGE_UPLOAD_ERRORS,
  INVALID,
  KEY_LIMITED,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  okContent,
} from "./errors.ts";
import { ImageSchema, type Images, imageView, refuseImage } from "./images.ts";
import { PageContextSchema, visitorPages } from "./journey.ts";
import { type Limits, STREAM_LIMIT, STREAM_RETRY_SECONDS } from "./limits.ts";
import { type Live, OPERATORS, wakeConversation } from "./live.ts";
import type { LogoUrl } from "./logo.ts";
import { closedFailure, OPEN_TO_WELCOME, WORKSPACE_PREFIX as PREFIX } from "./member.ts";
import {
  type Author,
  appendMessage,
  authorNames,
  ConversationClosedError,
  type ConversationRow,
  CURSOR_PATTERN,
  catchClosed,
  countWaiting,
  findConversation,
  listConversationMessages,
  listConversations,
  listWorkspaceEvents,
  type NewImage,
  parseCursor,
  type StoredMessage,
  searchConversations,
  setConversationStatus,
  WorkspaceClosedError,
} from "./messages.ts";
import type { VisitorPresence } from "./presence.ts";
import { CLOSE_REASONS_TEXT, openLiveStream, type StreamOptions, streamLeaseMs } from "./stream.ts";

const CLOSED = failure("conversation_closed", "Reopen this conversation to reply.");
const CLOSED_ANSWER = { 409: errorAnswer("conversation_closed: reopen it to reply") };

const workspaceParams = z.object({ workspaceId: z.uuid() });
const conversationParams = workspaceParams.extend({ conversationId: z.uuid() });

const InboxMessage = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    seq: z.string(),
    kind: z.enum(["text", "image"]),
    fromVisitor: z.boolean(),
    // The operator who sent it, or null for a visitor's message or an API key's.
    authorOperatorId: z.string().nullable(),
    // The API key that sent it, or null.
    authorApiKeyId: z.string().nullable(),
    // The operator's current name, or the key's name. Null for a visitor.
    authorName: z.string().nullable(),
    clientId: z.string(),
    body: z.string().nullable(),
    image: ImageSchema.nullable(),
    // The image was deleted after 12 months, on Dinghy Cloud.
    imageRemoved: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("InboxMessage", {
    example: {
      id: "1e4b9c7d-3a52-4f80-8b6e-0c2d9f1a7e35",
      conversationId: "5d0c1f7e-8a3b-4e52-b1f4-2c9e7a6d4b10",
      seq: "43",
      kind: "text",
      fromVisitor: false,
      authorOperatorId: "7a3e5b20-9c1d-4f6a-b8e2-4d0f1c9a6b53",
      authorApiKeyId: null,
      authorName: "Sam",
      clientId: "r_81b3d0",
      body: "Yes, it is two months free.",
      image: null,
      imageRemoved: false,
      createdAt: "2026-11-08T09:31:00.000Z",
    },
  });

const Conversation = z
  .object({
    id: z.string(),
    status: z.enum(["open", "closed"]),
    updatedAt: z.string(),
    assigneeOperatorId: z.string().nullable(),
    // The page where the visitor started it, as origin and path, if the widget reported one.
    startedPage: z.string().nullable(),
    // What the host page last sent with `Dinghy.setContext()`. Unsigned, so not verified.
    pageContext: PageContextSchema.nullable(),
    visitor: z.object({
      id: z.string(),
      email: z.string().nullable(),
      externalId: z.string().nullable(),
      // The name the host site signed, on one line.
      name: z.string().nullable(),
      // Custom attributes the host site signed.
      attributes: z.record(z.string(), z.unknown()).nullable(),
      blocked: z.boolean(),
      // A short line such as "Chrome on macOS", from the widget's last report.
      device: z.string().nullable(),
      // The page the widget last reported, as origin and path, and when the visitor was last seen.
      lastPage: z.string().nullable(),
      lastSeenAt: z.string().nullable(),
    }),
    lastMessage: z
      .object({ body: z.string().nullable(), fromVisitor: z.boolean(), createdAt: z.string() })
      .nullable(),
  })
  .openapi("Conversation");

const workspaceRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}`,
  security: SESSION_OR_KEY,
  summary: "Get a workspace this operator belongs to",
  request: { params: workspaceParams },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "The workspace",
      content: {
        "application/json": {
          schema: z
            .object({
              id: z.string(),
              name: z.string(),
              // The logo's address, which changes with each upload. Null with no logo.
              logoUrl: z.string().nullable(),
            })
            .openapi("InboxWorkspace"),
        },
      },
    },
    ...MEMBER_ERRORS,
  },
});

const listRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/conversations`,
  security: SESSION_OR_KEY,
  summary: "List conversations, newest activity first",
  request: {
    params: workspaceParams,
    query: z.object({
      status: z.enum(["open", "closed"]).default("open"),
      beforeUpdatedAt: z.iso.datetime().optional(),
      beforeId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "A page of conversations",
      content: {
        "application/json": {
          schema: z.object({
            conversations: z.array(Conversation),
            hasMore: z.boolean(),
            // Open conversations whose newest message is from the visitor, across all pages.
            waiting: z.number().int(),
          }),
          example: {
            conversations: [
              {
                id: "5d0c1f7e-8a3b-4e52-b1f4-2c9e7a6d4b10",
                status: "open",
                updatedAt: "2026-11-08T09:30:00.000Z",
                assigneeOperatorId: null,
                startedPage: "https://www.example.com/pricing",
                pageContext: { plan: "pro" },
                visitor: {
                  id: "0b6f1c6e-2f4a-4c1e-9a57-3f1b8f0e6d21",
                  email: "ana@example.com",
                  externalId: null,
                  name: "Ana Lima",
                  attributes: { plan: "pro" },
                  blocked: false,
                  device: "Safari on iPhone",
                  lastPage: "https://www.example.com/pricing",
                  lastSeenAt: "2026-11-08T09:30:00.000Z",
                },
                lastMessage: {
                  body: "Do you have a yearly plan?",
                  fromVisitor: true,
                  createdAt: "2026-11-08T09:30:00.000Z",
                },
              },
            ],
            hasMore: false,
            waiting: 1,
          },
        },
      },
    },
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

/** The other side of a welcome chat, which the visitor panel names instead of the visit. */
const WelcomeChat = z
  .discriminatedUnion("with", [
    // A new workspace's chat with Dinghy's founder.
    z.object({ with: z.literal("founder") }),
    // The founder's side: the workspace, and whether it takes the replies copied to it.
    z.object({
      with: z.literal("workspace"),
      name: z.string(),
      access: z.enum([
        "active",
        "waiting_cloud",
        "read_only",
        "suspended",
        "waiting_payment",
        "deleted",
      ]),
    }),
    // The other side deleted its conversation, or its whole workspace, and with it the link.
    z.object({ with: z.literal("deleted") }),
  ])
  .openapi("WelcomeChat");

/** What a welcome conversation is linked to. The function reads the other workspace for its name. */
async function welcomeChat(
  tx: Transaction,
  conversationId: string,
): Promise<z.infer<typeof WelcomeChat>> {
  const result = await tx.execute<{
    founder_side: boolean;
    workspace_name: string | null;
    access: WorkspaceAccess | null;
  }>(sql`select founder_side, workspace_name, access from welcome_chat(${conversationId})`);
  const row = result.rows[0];
  if (row === undefined) return { with: "deleted" };
  if (!row.founder_side) return { with: "founder" };
  return { with: "workspace", name: row.workspace_name ?? "", access: row.access ?? "deleted" };
}

const conversationRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/messages`,
  security: SESSION_OR_KEY,
  summary: "List one conversation's messages after a position, in commit order",
  request: {
    params: conversationParams,
    query: z.object({
      after: z
        .string()
        .regex(/^\d{1,18}$/)
        .default("0"),
      limit: z.coerce.number().int().min(1).max(100).default(100),
    }),
  },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "The conversation and a page of its messages",
      content: {
        "application/json": {
          schema: z.object({
            conversation: Conversation,
            messages: z.array(InboxMessage),
            hasMore: z.boolean(),
            // A widget stream of the visitor's is open now. Null when the server cannot tell.
            visitorOnline: z.boolean().nullable(),
            // The visitor's newest pages, newest first, at most 20, as the widget reported them.
            visitorPages: z.array(
              z
                .object({
                  // Origin and path, never a query or hash.
                  path: z.string(),
                  title: z.string().nullable(),
                  viewedAt: z.string(),
                })
                .openapi("PageView"),
            ),
            // Cloud only: this is a welcome chat, which has no visit or pages. Null otherwise.
            welcome: WelcomeChat.nullable(),
          }),
        },
      },
    },
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

const replyRoute = createRoute({
  method: "post",
  ...OPEN_TO_WELCOME,
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/messages`,
  security: SESSION_OR_KEY,
  summary: "Reply. A retry with the same clientId returns the original",
  request: {
    params: conversationParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            // Postgres text cannot hold a NUL byte.
            body: z
              .string()
              .trim()
              .min(1)
              .max(10_000)
              .regex(/^[^\0]*$/),
          }),
          example: { clientId: "r_81b3d0", body: "Yes, it is two months free." },
        },
      },
    },
  },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "A retry. This is the original message",
      content: { "application/json": { schema: InboxMessage } },
    },
    201: {
      description: "The new message",
      content: { "application/json": { schema: InboxMessage } },
    },
    ...MEMBER_WRITE_ERRORS,
    ...CLOSED_ANSWER,
  },
});

const replyImageRoute = createRoute({
  method: "post",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/images`,
  security: SESSION_OR_KEY,
  summary:
    "Reply with an image as the raw request body. A retry with the same clientId returns the original",
  request: {
    params: conversationParams,
    query: z.object({ clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
  },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "A retry. This is the original message",
      content: { "application/json": { schema: InboxMessage } },
    },
    201: {
      description: "The new message",
      content: { "application/json": { schema: InboxMessage } },
    },
    ...MEMBER_WRITE_ERRORS,
    ...IMAGE_UPLOAD_ERRORS,
    ...CLOSED_ANSWER,
  },
});

const searchRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/conversations/search`,
  security: SESSION_OR_KEY,
  summary: "Search open and closed conversations, newest activity first",
  description:
    "Matches the visitor's name, email or user ID, or the text of a message, ignoring case. A conversation found by a message shows that message as its `lastMessage`.",
  request: {
    params: workspaceParams,
    query: z.object({ q: z.string().trim().min(3).max(100) }),
  },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "At most 50 conversations",
      content: {
        "application/json": { schema: z.object({ conversations: z.array(Conversation) }) },
      },
    },
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

const statusRoute = createRoute({
  method: "patch",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}`,
  security: SESSION_OR_KEY,
  summary: "Close or reopen a conversation",
  request: {
    params: conversationParams,
    body: {
      required: true,
      content: {
        "application/json": { schema: z.object({ status: z.enum(["open", "closed"]) }) },
      },
    },
  },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "The status is now as requested",
      content: okContent,
    },
    ...MEMBER_WRITE_ERRORS,
  },
});

const streamRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/stream`,
  security: SESSION,
  summary: "Stream the workspace's changes after a cursor",
  description:
    "Server-sent events: `change` (its id is the new cursor), `ready` when caught up, `resync` to load everything again, and `close` with a reason. With no cursor, the stream starts at the present, so load the lists after `ready`.\n\n" +
    "A `change` event's data is `{ kind, conversationId }`, with `conversationId` null for a workspace change. A `message.created` change also has `fromVisitor`, true when the visitor wrote it. The kinds are `message.created`, `conversation.closed`, `conversation.reopened`, `conversation.assigned`, `conversation.deleted`, `conversation.moderated`, `team.changed` and `billing.changed`. A client reloads what the kind names, and ignores a kind it does not know.\n\n" +
    CLOSE_REASONS_TEXT,
  request: {
    params: workspaceParams,
    query: z.object({ after: z.string().regex(CURSOR_PATTERN).optional() }),
  },
  responses: {
    200: {
      description: "The event stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    ...MEMBER_ERRORS,
    ...INVALID,
    429: errorAnswer(
      "too_many_streams: the workspace has too many open streams. Retry after `retry-after`",
    ),
  },
});

/** A message as the operator API shows it. `names` holds author names by operator or key ID. */
export function messageView(
  images: Images | undefined,
  workspaceId: string,
  names: Map<string, string>,
  { seq, createdAt, image, ...message }: StoredMessage,
) {
  const author = message.authorOperatorId ?? message.authorApiKeyId;
  return {
    ...message,
    authorName: author === null ? null : (names.get(author) ?? null),
    seq: seq.toString(),
    createdAt: createdAt.toISOString(),
    image: imageView(images, workspaceId, image),
  };
}
type MessageView = ReturnType<typeof messageView>;

/** A conversation as the operator API shows it. */
export function conversationView(
  row: ConversationRow,
  lastMessage: { body: string | null; fromVisitor: boolean; createdAt: Date } | null,
) {
  return {
    id: row.id,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    assigneeOperatorId: row.assigneeOperatorId,
    startedPage: row.startedPage,
    pageContext: PageContextSchema.nullable().catch(null).parse(row.visitorPageContext),
    visitor: {
      id: row.visitorId,
      blocked: row.visitorBlockedAt !== null,
      email: row.visitorEmail,
      externalId: row.visitorExternalId,
      name: row.visitorName,
      attributes: (row.visitorAttributes as Record<string, unknown> | null) ?? null,
      device: row.visitorDevice,
      lastPage: row.visitorLastPage,
      lastSeenAt: row.visitorLastSeenAt?.toISOString() ?? null,
    },
    lastMessage:
      lastMessage === null
        ? null
        : { ...lastMessage, createdAt: lastMessage.createdAt.toISOString() },
  };
}

/** The session ended or the operator left the workspace during an upload. Its transaction rolls back. */
class AccessEndedError extends Error {}

/** The session is current and its operator is still a member: one statement, as each wake runs it. */
async function mayStillRead(
  tx: Transaction,
  sessionId: string,
  operatorId: string,
  workspaceId: string,
): Promise<boolean> {
  const result = await tx.execute<{ ok: boolean }>(sql`
    select exists (
             select 1 from ${session}
             where ${session.id} = ${sessionId} and ${session.userId} = ${operatorId}
               and ${session.expiresAt} > now()
           )
       and exists (
             select 1 from operator_workspaces(${operatorId}) where workspace_id = ${workspaceId}
           ) as ok`);
  return result.rows[0]?.ok === true;
}

/** The message author for a reply from this actor. */
const replyAuthor = (actor: Actor, conversationId: string): Author =>
  actor.kind === "operator"
    ? { kind: "operator", operatorId: actor.operatorId, conversationId }
    : { kind: "key", apiKeyId: actor.apiKeyId, conversationId };

const actorId = (actor: Actor) => (actor.kind === "operator" ? actor.operatorId : actor.apiKeyId);

type Appended = Awaited<ReturnType<typeof appendMessage>>;

/**
 * Cloud only: copies a reply into another workspace, in the reply's own transaction. It runs before
 * that transaction, where it can copy an image's file, and returns what runs in it, or null.
 */
export type CopyReply = (
  workspaceId: string,
  conversationId: string,
  image: NewImage | undefined,
) => Promise<ReplyCopy | null>;

interface ReplyCopy {
  /** In the reply's transaction: runs the reply's write, and may add to the transaction. */
  write(tx: Transaction, append: () => Promise<Appended>): Promise<Appended>;
  /** After the transaction, with whether the reply committed. It must not throw. */
  finish(committed: boolean): Promise<void>;
}

/** What a reply came to. The routes and the MCP tools answer each the same way. */
export type ReplyOutcome =
  | { kind: "sent"; created: boolean; message: MessageView }
  | { kind: "missing" }
  | { kind: "closed" }
  | { kind: "refused"; access: WorkspaceAccess };

interface InboxOptions {
  db: Database;
  images: Images | undefined;
  limits: Limits;
  live: Live;
  logger: Logger;
  stream: StreamOptions;
  visitorPresence: VisitorPresence;
  copyReply?: CopyReply | undefined;
}

/**
 * The inbox's reads and writes, which the operator routes and the MCP tools share, so an API key and
 * a signed-in operator get the same behavior.
 */
export function createInbox({
  db,
  images,
  live,
  visitorPresence,
  copyReply,
}: Pick<InboxOptions, "db" | "images" | "live" | "visitorPresence" | "copyReply">) {
  /** Writes a reply in the caller's transaction, and wakes the clients after the commit. */
  const reply = async (
    workspaceId: string,
    actor: Actor,
    conversationId: string,
    image: NewImage | undefined,
    write: (tx: Transaction, author: Author) => Promise<Appended>,
  ): Promise<ReplyOutcome> => {
    const copy = (await copyReply?.(workspaceId, conversationId, image)) ?? null;
    let committed = false;
    const result = await catchClosed(
      withWorkspace(db, workspaceId, async (tx) => {
        const found = await findConversation(tx, workspaceId, conversationId);
        if (found === null) return "missing" as const;
        const append = () => write(tx, replyAuthor(actor, conversationId));
        const appended = copy === null ? await append() : await copy.write(tx, append);
        return { ...appended, visitorId: found.visitorId };
      })
        .then((done) => {
          committed = done !== "missing";
          return done;
        })
        .catch((error: unknown) => {
          if (error instanceof ConversationClosedError) return "closed" as const;
          throw error;
        }),
    ).finally(() => copy?.finish(committed));
    if (result === "missing" || result === "closed") return { kind: result };
    if (result instanceof WorkspaceClosedError) return { kind: "refused", access: result.access };
    // After the commit. A lost signal only delays delivery, because a stream reads from Postgres.
    if (result.created) wakeConversation(live, workspaceId, result.visitorId);
    const names = new Map([[actorId(actor), actor.name]]);
    return {
      kind: "sent",
      created: result.created,
      message: messageView(images, workspaceId, names, result.message),
    };
  };

  return {
    async list(
      workspaceId: string,
      status: "open" | "closed",
      before: { updatedAt: Date; id: string } | undefined,
      limit: number,
    ) {
      const page = await withWorkspace(db, workspaceId, async (tx) => ({
        ...(await listConversations(tx, workspaceId, status, before, limit)),
        waiting: await countWaiting(tx, workspaceId),
      }));
      return {
        conversations: page.conversations.map((row) => conversationView(row, row.lastMessage)),
        hasMore: page.hasMore,
        waiting: page.waiting,
      };
    },

    /** One conversation with a page of its messages, or null when it does not exist. */
    async read(workspaceId: string, conversationId: string, after: bigint, limit: number) {
      const result = await withWorkspace(db, workspaceId, async (tx) => {
        const found = await findConversation(tx, workspaceId, conversationId);
        if (found === null) return null;
        const page = await listConversationMessages(tx, workspaceId, conversationId, after, limit);
        const names = await authorNames(tx, workspaceId, page.messages);
        const pages = await visitorPages(tx, workspaceId, found.visitorId);
        const welcome = found.welcome ? await welcomeChat(tx, conversationId) : null;
        return { found, page, names, pages, welcome };
      });
      if (result === null) return null;
      return {
        conversation: conversationView(result.found, null),
        messages: result.page.messages.map((message) =>
          messageView(images, workspaceId, result.names, message),
        ),
        hasMore: result.page.hasMore,
        visitorOnline: await visitorPresence.online(workspaceId, result.found.visitorId),
        visitorPages: result.pages.map((row) => ({
          ...row,
          viewedAt: row.viewedAt.toISOString(),
        })),
        welcome: result.welcome,
      };
    },

    async search(workspaceId: string, q: string) {
      const rows = await withWorkspace(db, workspaceId, (tx) =>
        searchConversations(tx, workspaceId, q, 50),
      );
      return { conversations: rows.map((row) => conversationView(row, row.lastMessage)) };
    },

    reply(
      workspaceId: string,
      actor: Actor,
      conversationId: string,
      input: { clientId: string; body: string },
    ) {
      return reply(workspaceId, actor, conversationId, undefined, (tx, author) =>
        appendMessage(tx, workspaceId, author, input),
      );
    },

    /**
     * An image reply, whose upload has arrived. `check` runs in its transaction first. `created` tells
     * the upload whether to keep the stored file.
     */
    async replyImage(
      workspaceId: string,
      actor: Actor,
      conversationId: string,
      input: { clientId: string; image: NewImage },
      limits: Limits,
      check: (tx: Transaction) => Promise<void>,
    ): Promise<ReplyOutcome & { created: boolean }> {
      const outcome = await reply(
        workspaceId,
        actor,
        conversationId,
        input.image,
        async (tx, author) => {
          await check(tx);
          return appendMessage(tx, workspaceId, author, input, limits);
        },
      );
      return { ...outcome, created: outcome.kind === "sent" && outcome.created };
    },

    /** Closes or reopens a conversation. False when it does not exist. */
    async setStatus(workspaceId: string, conversationId: string, status: "open" | "closed") {
      const found = await withWorkspace(db, workspaceId, async (tx) => {
        const row = await findConversation(tx, workspaceId, conversationId);
        if (row === null) return false;
        await setConversationStatus(tx, workspaceId, conversationId, status);
        return true;
      });
      if (found) live.wake(workspaceId, OPERATORS);
      return found;
    },
  };
}
export type Inbox = ReturnType<typeof createInbox>;

/** The answer for a reply that did not go in. */
function refusedReply(outcome: Exclude<ReplyOutcome, { kind: "sent" }>) {
  if (outcome.kind === "missing") return { body: NOT_FOUND, status: 404 as const };
  if (outcome.kind === "closed") return { body: CLOSED, status: 409 as const };
  return closedFailure(outcome.access);
}

/** A key that was revoked during an upload. Its transaction rolls back. */
async function keyStillHolds(db: Database, actor: KeyActor) {
  if (!(await keyStillValid(db, actor))) throw new AccessEndedError();
}

export function registerInboxRoutes(app: App, options: InboxOptions & { logoUrl: LogoUrl }) {
  const { db, images, limits, live, logger, logoUrl, stream } = options;
  const inbox = createInbox(options);

  app.openapi(workspaceRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const [row] = await withWorkspace(db, id, (tx) =>
      tx
        .select({
          id: workspace.id,
          name: workspace.name,
          publicKey: workspace.publicKey,
          logoUpdatedAt: workspaceLogo.updatedAt,
        })
        .from(workspace)
        .leftJoin(workspaceLogo, eq(workspaceLogo.workspaceId, workspace.id))
        .where(eq(workspace.id, id)),
    );
    if (row === undefined) return c.json(NOT_FOUND, 404);
    return c.json(
      { id: row.id, name: row.name, logoUrl: logoUrl(row.publicKey, row.logoUpdatedAt) },
      200,
    );
  });

  app.openapi(listRoute, async (c) => {
    const { status, beforeUpdatedAt, beforeId, limit } = c.req.valid("query");
    const before =
      beforeUpdatedAt === undefined || beforeId === undefined
        ? undefined
        : { updatedAt: new Date(beforeUpdatedAt), id: beforeId };
    return c.json(await inbox.list(c.get("memberWorkspaceId"), status, before, limit), 200);
  });

  app.openapi(conversationRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const { after, limit } = c.req.valid("query");
    const result = await inbox.read(
      c.get("memberWorkspaceId"),
      conversationId,
      BigInt(after),
      limit,
    );
    if (result === null) return c.json(NOT_FOUND, 404);
    return c.json(result, 200);
  });

  app.openapi(searchRoute, async (c) => {
    const { q } = c.req.valid("query");
    return c.json(await inbox.search(c.get("memberWorkspaceId"), q), 200);
  });

  app.openapi(replyRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const outcome = await inbox.reply(
      c.get("memberWorkspaceId"),
      c.get("actor"),
      conversationId,
      c.req.valid("json"),
    );
    if (outcome.kind === "sent") return c.json(outcome.message, outcome.created ? 201 : 200);
    const refused = refusedReply(outcome);
    return c.json(refused.body, refused.status);
  });

  if (images !== undefined) {
    app.openapi(replyImageRoute, async (c) => {
      const id = c.get("memberWorkspaceId");
      const { conversationId } = c.req.valid("param");
      const { clientId } = c.req.valid("query");
      const actor = c.get("actor");
      const exists = await withWorkspace(
        db,
        id,
        async (tx) => (await findConversation(tx, id, conversationId)) !== null,
      );
      if (!exists) return c.json(NOT_FOUND, 404);
      // The upload can take minutes, so the session and membership, or the key, are read again.
      const check = async (tx: Transaction) => {
        if (actor.kind === "key") return keyStillHolds(db, actor);
        if (!(await mayStillRead(tx, c.get("sessionId"), actor.operatorId, id))) {
          throw new AccessEndedError();
        }
      };
      const outcome = await images
        .receive(
          c.req.raw,
          id,
          (image) =>
            inbox.replyImage(id, actor, conversationId, { clientId, image }, limits, check),
          c.get("clientIp"),
        )
        .catch((error: unknown) => {
          if (error instanceof AccessEndedError) return "ended" as const;
          throw error;
        });
      if (outcome === "ended") return c.json(NOT_FOUND, 404);
      if ("refused" in outcome) return refuseImage(c, outcome.refused);
      const result = outcome.result;
      if (result.kind === "sent") return c.json(result.message, result.created ? 201 : 200);
      const refused = refusedReply(result);
      return c.json(refused.body, refused.status);
    });
  }

  app.openapi(statusRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const found = await inbox.setStatus(c.get("memberWorkspaceId"), conversationId, status);
    if (!found) return c.json(NOT_FOUND, 404);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(streamRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { after } = c.req.valid("query");
    const operatorId = c.get("operatorId");
    const sessionId = c.get("sessionId");
    const admitted = await limits.openStream(id, "operator", streamLeaseMs(stream));
    if (admitted === null) {
      c.header("retry-after", String(STREAM_RETRY_SECONDS));
      return c.json(STREAM_LIMIT, 429);
    }
    return openLiveStream(c, {
      live,
      release: admitted.release,
      logger,
      options: stream,
      workspaceId: id,
      subscriber: OPERATORS,
      expiresAt: undefined,
      after: after === undefined ? undefined : parseCursor(after),
      read: async (position) => {
        // The session and the membership, read again before each page in the read's own
        // transaction, so a sign-out or a removal ends this at the next wake. It never renews the
        // session, because a new cookie would be lost on this response.
        const page = await withWorkspace(db, id, async (tx) =>
          (await mayStillRead(tx, sessionId, operatorId, id))
            ? listWorkspaceEvents(tx, id, position, 100)
            : null,
        );
        if (page === null) return null;
        return {
          ...page,
          items: page.events.map((event) => ({
            event: "change",
            seq: event.seq,
            data: {
              kind: event.kind,
              conversationId: event.conversationId,
              ...(event.kind === "message.created" ? { fromVisitor: event.fromVisitor } : {}),
            },
          })),
        };
      },
    });
  });
}
