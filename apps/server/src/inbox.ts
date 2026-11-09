import { createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { session, workspace } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  IMAGE_UPLOAD_ERRORS,
  INVALID,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  okContent,
} from "./errors.ts";
import { ImageSchema, type Images, imageView, refuseImage } from "./images.ts";
import { visitorPages } from "./journey.ts";
import { type Limits, STREAM_LIMIT, STREAM_RETRY_SECONDS } from "./limits.ts";
import { type Live, OPERATORS, wakeConversation } from "./live.ts";
import { closedFailure, WORKSPACE_PREFIX as PREFIX } from "./member.ts";
import {
  appendMessage,
  ConversationClosedError,
  type ConversationRow,
  CURSOR_PATTERN,
  catchClosed,
  countWaiting,
  findConversation,
  listConversationMessages,
  listConversations,
  listWorkspaceEvents,
  operatorNames,
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
    // The operator who sent it, and that operator's current name. Both null for a visitor.
    authorOperatorId: z.string().nullable(),
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
  security: SESSION,
  summary: "Get a workspace this operator belongs to",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), name: z.string() }).openapi("InboxWorkspace"),
        },
      },
    },
    ...MEMBER_ERRORS,
  },
});

const listRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/conversations`,
  security: SESSION,
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

const conversationRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/messages`,
  security: SESSION,
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
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/messages`,
  security: SESSION,
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
  security: SESSION,
  summary:
    "Reply with an image as the raw request body. A retry with the same clientId returns the original",
  request: {
    params: conversationParams,
    query: z.object({ clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
  },
  responses: {
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
  security: SESSION,
  summary: "Search open and closed conversations, newest activity first",
  description:
    "Matches the visitor's name, email or user ID, or the text of a message, ignoring case. A conversation found by a message shows that message as its `lastMessage`.",
  request: {
    params: workspaceParams,
    query: z.object({ q: z.string().trim().min(2).max(100) }),
  },
  responses: {
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
  security: SESSION,
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

function messageView(
  images: Images | undefined,
  workspaceId: string,
  names: Map<string, string>,
  { seq, createdAt, image, ...message }: StoredMessage,
) {
  return {
    ...message,
    authorName:
      message.authorOperatorId === null ? null : (names.get(message.authorOperatorId) ?? null),
    seq: seq.toString(),
    createdAt: createdAt.toISOString(),
    image: imageView(images, workspaceId, image),
  };
}

function conversationView(
  row: ConversationRow,
  lastMessage: { body: string | null; fromVisitor: boolean; createdAt: Date } | null,
) {
  return {
    id: row.id,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    assigneeOperatorId: row.assigneeOperatorId,
    startedPage: row.startedPage,
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

interface InboxOptions {
  db: Database;
  images: Images | undefined;
  limits: Limits;
  live: Live;
  logger: Logger;
  stream: StreamOptions;
  visitorPresence: VisitorPresence;
}

export function registerInboxRoutes(
  app: App,
  { db, images, limits, live, logger, stream, visitorPresence }: InboxOptions,
) {
  app.openapi(workspaceRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const [row] = await withWorkspace(db, id, (tx) =>
      tx
        .select({ id: workspace.id, name: workspace.name })
        .from(workspace)
        .where(eq(workspace.id, id)),
    );
    if (row === undefined) return c.json(NOT_FOUND, 404);
    return c.json(row, 200);
  });

  app.openapi(listRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { status, beforeUpdatedAt, beforeId, limit } = c.req.valid("query");
    const before =
      beforeUpdatedAt === undefined || beforeId === undefined
        ? undefined
        : { updatedAt: new Date(beforeUpdatedAt), id: beforeId };
    const page = await withWorkspace(db, id, async (tx) => ({
      ...(await listConversations(tx, id, status, before, limit)),
      waiting: await countWaiting(tx, id),
    }));
    return c.json(
      {
        conversations: page.conversations.map((row) => conversationView(row, row.lastMessage)),
        hasMore: page.hasMore,
        waiting: page.waiting,
      },
      200,
    );
  });

  app.openapi(conversationRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const { after, limit } = c.req.valid("query");
    const result = await withWorkspace(db, id, async (tx) => {
      const found = await findConversation(tx, id, conversationId);
      if (found === null) return null;
      const page = await listConversationMessages(tx, id, conversationId, BigInt(after), limit);
      const names = await operatorNames(
        tx,
        page.messages.map((message) => message.authorOperatorId),
      );
      const pages = await visitorPages(tx, id, found.visitorId);
      return { found, page, names, pages };
    });
    if (result === null) return c.json(NOT_FOUND, 404);
    return c.json(
      {
        conversation: conversationView(result.found, null),
        messages: result.page.messages.map((message) =>
          messageView(images, id, result.names, message),
        ),
        hasMore: result.page.hasMore,
        visitorOnline: await visitorPresence.online(id, result.found.visitorId),
        visitorPages: result.pages.map((row) => ({
          ...row,
          viewedAt: row.viewedAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(searchRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { q } = c.req.valid("query");
    const rows = await withWorkspace(db, id, (tx) => searchConversations(tx, id, q, 50));
    return c.json(
      { conversations: rows.map((row) => conversationView(row, row.lastMessage)) },
      200,
    );
  });

  app.openapi(replyRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const operatorId = c.get("operatorId");
    const result = await catchClosed(
      withWorkspace(db, id, async (tx) => {
        const found = await findConversation(tx, id, conversationId);
        if (found === null) return "missing" as const;
        const appended = await appendMessage(
          tx,
          id,
          { kind: "operator", operatorId, conversationId },
          input,
        );
        return { ...appended, visitorId: found.visitorId };
      }).catch((error: unknown) => {
        if (error instanceof ConversationClosedError) return "closed" as const;
        throw error;
      }),
    );
    if (result === "missing") return c.json(NOT_FOUND, 404);
    if (result instanceof WorkspaceClosedError) {
      const refused = closedFailure(result.access);
      return c.json(refused.body, refused.status);
    }
    if (result === "closed") return c.json(CLOSED, 409);
    // After the commit. A lost signal only delays delivery, because a stream reads from Postgres.
    if (result.created) {
      wakeConversation(live, id, result.visitorId);
    }
    const names = new Map([[operatorId, c.get("operatorName")]]);
    return c.json(messageView(images, id, names, result.message), result.created ? 201 : 200);
  });

  if (images !== undefined) {
    app.openapi(replyImageRoute, async (c) => {
      const id = c.get("memberWorkspaceId");
      const { conversationId } = c.req.valid("param");
      const { clientId } = c.req.valid("query");
      const operatorId = c.get("operatorId");
      const visitorId = await withWorkspace(
        db,
        id,
        async (tx) => (await findConversation(tx, id, conversationId))?.visitorId ?? null,
      );
      if (visitorId === null) return c.json(NOT_FOUND, 404);
      const outcome = await catchClosed(
        images
          .receive(
            c.req.raw,
            id,
            // The upload can take minutes, so the session and membership are read again here.
            (image) =>
              withWorkspace(db, id, async (tx) => {
                if (!(await mayStillRead(tx, c.get("sessionId"), operatorId, id))) {
                  throw new AccessEndedError();
                }
                return appendMessage(
                  tx,
                  id,
                  { kind: "operator", operatorId, conversationId },
                  { clientId, image },
                  limits,
                );
              }),
            c.get("clientIp"),
          )
          .catch((error: unknown) => {
            if (error instanceof ConversationClosedError) return "closed" as const;
            if (error instanceof AccessEndedError) return "ended" as const;
            throw error;
          }),
      );
      if (outcome === "closed") return c.json(CLOSED, 409);
      if (outcome === "ended") return c.json(NOT_FOUND, 404);
      if (outcome instanceof WorkspaceClosedError) {
        const refused = closedFailure(outcome.access);
        return c.json(refused.body, refused.status);
      }
      if ("refused" in outcome) return refuseImage(c, outcome.refused);
      if (outcome.result.created) {
        wakeConversation(live, id, visitorId);
      }
      return c.json(
        messageView(
          images,
          id,
          new Map([[operatorId, c.get("operatorName")]]),
          outcome.result.message,
        ),
        outcome.result.created ? 201 : 200,
      );
    });
  }

  app.openapi(statusRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const found = await withWorkspace(db, id, async (tx) => {
      const row = await findConversation(tx, id, conversationId);
      if (row === null) return false;
      await setConversationStatus(tx, id, conversationId, status);
      return true;
    });
    if (!found) return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
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
