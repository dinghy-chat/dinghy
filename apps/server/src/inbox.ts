import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { type Actor, actorId, type KeyActor, keyStillValid } from "./api-keys.ts";
import { SESSION, SESSION_OR_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { keyGate, takeOver } from "./bots.ts";
import { MESSAGE_KINDS, session, welcomeLink } from "./db/schema.ts";
import {
  type Database,
  type Transaction,
  WORKSPACE_ACCESS,
  type WorkspaceAccess,
  withWorkspace,
} from "./db/tenant.ts";
import { createDraft, DraftSchema, type DraftView } from "./drafts.ts";
import {
  CONVERSATION_CLOSED,
  errorAnswer,
  FORBIDDEN,
  failure,
  IMAGE_UPLOAD_ERRORS,
  INVALID,
  KEY_LIMITED,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  OPERATOR_WRITE_ERRORS,
  okContent,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { ImageSchema, type Images, imageView, lostConnection, refuseImage } from "./images.ts";
import { Body, ClientId } from "./inputs.ts";
import { PageContextSchema, visitorPages } from "./journey.ts";
import { type Limits, STREAM_LIMIT, STREAM_RETRY_SECONDS } from "./limits.ts";
import { type Live, OPERATORS, wakeConversation } from "./live.ts";
import {
  closedFailure,
  OPEN_TO_WELCOME,
  OPEN_WHILE_CLOSED,
  WORKSPACE_PREFIX as PREFIX,
} from "./member.ts";
import { deleteMessage, editMessage, emailedAt, replyReceipts } from "./message-changes.ts";
import {
  type AssigneeFilter,
  type Author,
  appendMessage,
  authorNames,
  CHANNELS,
  ConversationClosedError,
  type ConversationRow,
  type ConversationSummary,
  CURSOR_PATTERN,
  catchClosed,
  countOpenByAssignee,
  countWaiting,
  findConversation,
  findMessage,
  InvalidReplyToError,
  isUnread,
  type KeySource,
  listConversationMessages,
  listConversations,
  listWorkspaceEvents,
  markConversationRead,
  type NewImage,
  parseCursor,
  QuoteSchema,
  quoteView,
  type StoredMessage,
  searchConversations,
  setConversationStatus,
  WorkspaceClosedError,
} from "./messages.ts";
import type { VisitorPresence } from "./presence.ts";
import type { ImageUrls } from "./public-images.ts";
import { CLOSE_REASONS_TEXT, openLiveStream, type StreamOptions, streamLeaseMs } from "./stream.ts";
import { allowed } from "./team.ts";
import { readWorkspaceFace } from "./workspaces.ts";

const INVALID_REPLY_TO = failure(
  "invalid_reply_to",
  "Quote a message that people wrote in this conversation and that was not deleted.",
);
const MESSAGE_SEEN = failure(
  "message_seen",
  "The visitor has read this reply, or an email carried it, so it can no longer change.",
);
const NOT_YOURS = failure("forbidden", "You can change only your own replies.");
const BOTS_PAUSED = failure(
  "bots_paused",
  "An owner or admin paused every bot of this workspace. Only people reply until they resume.",
);
const HUMAN_HANDLING = failure(
  "human_handling",
  "A person handles this conversation now, so a bot may not send. Write a draft or a note instead.",
);
const DRAFTS_TEXT_ONLY = failure(
  "drafts_text_only",
  "This API key writes drafts, and a draft holds text only. Send the image as a person.",
);
const KEY_HAS_NO_ASSIGNMENTS = failure(
  "invalid_request",
  "An API key is assigned nothing. Pass assignee=none, or leave it out.",
);
export const KEY_REPLY_REFUSALS =
  "bots_paused: an owner or admin paused every bot. human_handling: a person handles the conversation, and the key sends directly";
const REPLY_OR_NOTE_ANSWER = {
  409: errorAnswer(
    `conversation_closed: reopen it to reply, though a note does not need it. ${KEY_REPLY_REFUSALS}. Neither refuses a note`,
  ),
};
const INVALID_REPLY_TO_ANSWER = {
  400: errorAnswer(
    "invalid_request: the request is not valid. invalid_reply_to: the quoted message is not in this conversation",
  ),
};

const workspaceParams = z.object({ workspaceId: z.uuid() });
const conversationParams = workspaceParams.extend({ conversationId: z.uuid() });
const messageParams = conversationParams.extend({ messageId: z.uuid() });

const REPLY_TO = z.uuid().optional().openapi({
  description:
    "An earlier message of the same conversation that this one quotes. Not a status line, and not a deleted message. A reply cannot quote a note, and a note can quote any of them.",
});

export const InboxMessage = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    seq: z.string(),
    // `closed` and `reopened` are status lines a close or a reopen writes, with no body. A `note`
    // is text that only the team sees, never the visitor.
    kind: z.enum(MESSAGE_KINDS),
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
    // The message this one quotes, or null.
    replyTo: QuoteSchema.nullable(),
    // When its author last changed its text. Only an operator's text reply or note can change.
    editedAt: z.string().nullable(),
    // An operator deleted it: its body and image are gone, and its row stays in place.
    deleted: z.boolean(),
    // When the visitor first read this reply in the chat, when known.
    readAt: z.string().nullable(),
    // A key's reply: sent through the REST API or through MCP. `draft`: an operator sent a key's
    // draft, and is its author. Null for anyone else's.
    via: z.enum(CHANNELS).nullable(),
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
      replyTo: {
        id: "8c2d7a51-6e0f-4b3a-9d18-5f7e2c4a1b90",
        authorName: "Ada",
        fromVisitor: true,
        text: "Do you have a yearly plan?",
        hasImage: false,
      },
      editedAt: null,
      deleted: false,
      readAt: null,
      via: null,
      createdAt: "2026-11-08T09:31:00.000Z",
    },
  });

const ConversationHandler = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("bot"), apiKeyId: z.string(), name: z.string() }),
    z.object({
      kind: z.literal("person"),
      operatorId: z.string(),
      name: z.string(),
      since: z.string(),
    }),
    z.object({ kind: z.literal("team"), since: z.string() }),
  ])
  .openapi("ConversationHandler");

const Conversation = z
  .object({
    id: z.string(),
    status: z.enum(["open", "closed"]),
    updatedAt: z.string(),
    assigneeOperatorId: z.string().nullable(),
    // The page where the visitor started it, as origin and path, if the widget reported one.
    startedPage: z.string().nullable(),
    // On Dinghy Cloud, a welcome chat with Dinghy's founder. False everywhere else.
    welcome: z.boolean(),
    // Who handles it. `person`: the assignee, since an operator replied or a bot handed it off,
    // and `team` the same with no assignee; bots that send directly stay quiet. `bot`: no person
    // handles it, and this key took part last. Null: no person handles it and no bot took part.
    handler: ConversationHandler.nullable(),
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
      // ISO 3166-1 alpha-2 and IANA, from the widget's last beat.
      country: z.string().nullable(),
      timeZone: z.string().nullable(),
      // A visitor has no picture. Only Dinghy Cloud's welcome chat shows its founder's here.
      pictureUrl: z.string().nullable(),
      // A test visitor that a bot's simulated message made.
      isTest: z.boolean(),
    }),
    lastMessage: z
      .object({ body: z.string().nullable(), fromVisitor: z.boolean(), createdAt: z.string() })
      .nullable(),
    // A visitor message is past the signed-in operator's read position. Always false for an API
    // key, which has no read position.
    unread: z.boolean(),
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
              // An owner or admin paused every bot: keys may not reply or type.
              botsPaused: z.boolean(),
              // The name of who paused them. Null when bots run, or that person's account is gone.
              botsPausedBy: z.string().nullable(),
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
      assignee: z.enum(["me", "none"]).optional().openapi({
        description:
          "`me`: assigned to the signed-in operator. `none`: assigned to no one. Leave it out for all. An API key has no assignments, so it may pass `none` only.",
      }),
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
            // Open conversations whose newest message is from the visitor, across all pages: for an
            // operator, those assigned to them or to no one.
            waiting: z.number().int(),
            // Open conversations for each assignee filter. `mine` is 0 for an API key.
            openBy: z.object({
              all: z.number().int(),
              mine: z.number().int(),
              unassigned: z.number().int(),
            }),
          }),
          example: {
            conversations: [
              {
                id: "5d0c1f7e-8a3b-4e52-b1f4-2c9e7a6d4b10",
                status: "open",
                updatedAt: "2026-11-08T09:30:00.000Z",
                assigneeOperatorId: null,
                startedPage: "https://www.example.com/pricing",
                welcome: false,
                handler: null,
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
                  country: "PT",
                  timeZone: "Europe/Lisbon",
                  isTest: false,
                },
                lastMessage: {
                  body: "Do you have a yearly plan?",
                  fromVisitor: true,
                  createdAt: "2026-11-08T09:30:00.000Z",
                },
                unread: true,
              },
            ],
            hasMore: false,
            waiting: 1,
            openBy: { all: 1, mine: 0, unassigned: 1 },
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
    // The founder's picture, or null when they have none.
    z.object({ with: z.literal("founder"), pictureUrl: z.string().nullable() }),
    // The founder's side: the workspace, and whether it takes the replies copied to it.
    z.object({
      with: z.literal("workspace"),
      name: z.string(),
      access: z.enum(WORKSPACE_ACCESS),
    }),
    // The other side deleted its conversation, or its whole workspace, and with it the link.
    z.object({ with: z.literal("deleted") }),
  ])
  .openapi("WelcomeChat");

/** What a welcome conversation is linked to. The function reads the other workspace for its name. */
async function welcomeChat(
  tx: Transaction,
  conversationId: string,
  founderPicture: FounderPicture,
): Promise<z.infer<typeof WelcomeChat>> {
  const result = await tx.execute<{
    founder_side: boolean;
    workspace_name: string | null;
    access: WorkspaceAccess | null;
  }>(sql`select founder_side, workspace_name, access from welcome_chat(${conversationId})`);
  const row = result.rows[0];
  if (row === undefined) return { with: "deleted" };
  if (!row.founder_side) return { with: "founder", pictureUrl: await founderPicture(tx) };
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
            // How far the visitor has seen the replies: read in the chat up to `readSeq`, and
            // carried by the emails in `emails`, each from `fromSeq` to `toSeq`. A reply that a sent
            // email carried was emailed, one only a failed email carried was not. A reply in none
            // and above `readSeq` is only stored.
            receipts: z
              .object({
                readSeq: z.string(),
                emails: z.array(
                  z.object({ fromSeq: z.string(), toSeq: z.string(), sent: z.boolean() }),
                ),
              })
              .openapi("ReplyReceipts"),
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
  summary: "Reply, or add a note. A retry with the same clientId returns the original",
  description:
    "With `note: true` the message is a note that only the team sees. It never reaches the visitor, an alert or an email. A note goes in a closed conversation too, and never assigns the conversation.",
  request: {
    params: conversationParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            clientId: ClientId,
            body: Body,
            replyToMessageId: REPLY_TO,
            note: z.boolean().default(false).openapi({
              description: "True for a note that only the team sees. A note is text only.",
            }),
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
    202: {
      description:
        "An API key in draft mode wrote a draft, which waits for an operator. Nothing reached the visitor",
      content: { "application/json": { schema: z.object({ draft: DraftSchema }) } },
    },
    ...MEMBER_WRITE_ERRORS,
    ...REPLY_OR_NOTE_ANSWER,
    ...INVALID_REPLY_TO_ANSWER,
  },
});

const editRoute = createRoute({
  method: "patch",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/messages/{messageId}`,
  security: SESSION,
  summary: "Change the text of your own reply, before the visitor has seen it, or of your own note",
  description:
    "Only the operator who wrote a text reply can change it, and only while the visitor has not read it and no reply email or transcript carried it. A note's author can change it at any time. API keys cannot edit.",
  request: {
    params: messageParams,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ body: Body }) } },
    },
  },
  responses: {
    200: {
      description: "The changed message",
      content: { "application/json": { schema: InboxMessage } },
    },
    ...MEMBER_WRITE_ERRORS,
    403: errorAnswer("forbidden: not your own text reply or note, or an API key"),
    409: errorAnswer("message_seen: the visitor read it, or an email carried it"),
  },
});

const deleteMessageRoute = createRoute({
  method: "delete",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/messages/{messageId}`,
  security: SESSION,
  summary: "Delete a message: its text and image go, and a placeholder stays",
  description:
    "An operator deletes their own messages. An owner or an admin deletes anyone's, a visitor's too. API keys cannot delete.",
  request: { params: messageParams },
  responses: {
    200: { description: "Deleted, or it already was", content: okContent },
    ...ROLE_WRITE_ERRORS,
  },
});

const receiptRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/messages/{messageId}/receipt`,
  security: SESSION_OR_KEY,
  summary: "When the visitor saw a reply: read in the chat, or sent by email",
  request: { params: messageParams },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "Each time, or null when it did not happen or is not known",
      content: {
        "application/json": {
          schema: z
            .object({ readAt: z.string().nullable(), emailedAt: z.string().nullable() })
            .openapi("MessageReceipt"),
        },
      },
    },
    ...MEMBER_ERRORS,
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
    // Strict, so a `note` here is refused rather than sent to the visitor: a note is text only.
    query: z.strictObject({
      clientId: ClientId,
      replyToMessageId: REPLY_TO,
    }),
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
    400: errorAnswer(
      `${IMAGE_UPLOAD_ERRORS[400].description}. invalid_reply_to: the quoted message is not in this conversation`,
    ),
    409: errorAnswer(
      `conversation_closed: reopen it to reply. ${KEY_REPLY_REFUSALS}. drafts_text_only: the key writes drafts, which hold text only`,
    ),
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

const readRoute = createRoute({
  method: "post",
  // Reading is still allowed while the workspace is read-only or suspended.
  ...OPEN_WHILE_CLOSED,
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/read`,
  security: SESSION,
  summary: "Mark a conversation read up to a message, for the signed-in operator",
  description:
    "Moves the operator's read position forward to `seq`, a message's `seq`. It never moves back, and it stops at the conversation's newest message. API keys have no read position.",
  request: {
    params: conversationParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ seq: z.string().regex(/^\d{1,18}$/) }),
          example: { seq: "43" },
        },
      },
    },
  },
  responses: {
    200: { description: "The position is at least `seq`", content: okContent },
    ...MEMBER_ERRORS,
    ...OPERATOR_WRITE_ERRORS,
  },
});

const streamRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/stream`,
  security: SESSION,
  summary: "Stream the workspace's changes after a cursor",
  description:
    "Server-sent events: `change` (its id is the new cursor), `ready` when caught up, `resync` to load everything again, `notice` for something live that is not stored, and `close` with a reason. With no cursor, the stream starts at the present, so load the lists after `ready`.\n\n" +
    "A `change` event's data is `{ kind, conversationId }`, with `conversationId` null for a workspace change. A `message.created` change also has `fromVisitor`, true when the visitor wrote it. The kinds are `message.created`, `message.updated` (an operator edited a reply), `message.deleted`, `conversation.closed`, `conversation.reopened`, `conversation.assigned`, `conversation.deleted`, `conversation.moderated`, `conversation.handled` (a person or a bot took it), `draft.changed`, `transcript.requested`, `team.changed`, `billing.changed` and `workspace.changed`. A client reloads what the kind names, and ignores a kind it does not know.\n\n" +
    'A `notice` has no id and may be lost. Its data is `{ kind: "typing", conversationId, visitorId, draft }`, a visitor\'s unsent text, empty when they stopped, `{ kind: "bot_typing", conversationId, name, typing }` when an API key types or stops, or `{ kind: "receipts", visitorId }` when a visitor read replies or a reply email went out, so load the conversation\'s messages again.\n\n' +
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
  {
    seq,
    changeSeq: _change,
    createdAt,
    editedAt,
    readAt,
    image,
    replyTo,
    ...message
  }: StoredMessage,
) {
  const author = message.authorOperatorId ?? message.authorApiKeyId;
  return {
    ...message,
    authorName: author === null ? null : (names.get(author) ?? null),
    seq: seq.toString(),
    createdAt: createdAt.toISOString(),
    editedAt: editedAt?.toISOString() ?? null,
    readAt: readAt?.toISOString() ?? null,
    image: imageView(images, workspaceId, image),
    replyTo: quoteView(replyTo),
  };
}
type MessageView = ReturnType<typeof messageView>;

/** The founder's picture's address, or null with none or off Dinghy Cloud. */
type FounderPicture = (tx: Transaction) => Promise<string | null>;

/**
 * The founder's picture for the new workspace's side of each listed welcome chat, by conversation.
 * One read of the links for the whole page, and one of the picture.
 */
async function welcomePictures(
  tx: Transaction,
  workspaceId: string,
  rows: ConversationRow[],
  founderPicture: FounderPicture,
): Promise<Map<string, string>> {
  const ids = rows.filter((row) => row.welcome).map((row) => row.id);
  if (ids.length === 0) return new Map();
  const ours = await tx
    .select({ id: welcomeLink.customerConversationId })
    .from(welcomeLink)
    .where(
      and(
        eq(welcomeLink.customerWorkspaceId, workspaceId),
        inArray(welcomeLink.customerConversationId, ids),
      ),
    );
  const url = ours.length === 0 ? null : await founderPicture(tx);
  return url === null ? new Map() : new Map(ours.map((one) => [one.id, url]));
}

/** Who handles a conversation: its assignee or the team, the bot that took part last, or nobody. */
function handlerOf(row: ConversationRow): z.infer<typeof ConversationHandler> | null {
  if (row.humanSince !== null) {
    const since = row.humanSince.toISOString();
    if (row.assigneeOperatorId === null || row.assigneeName === null)
      return { kind: "team", since };
    return { kind: "person", operatorId: row.assigneeOperatorId, name: row.assigneeName, since };
  }
  if (row.botKey === null) return null;
  return { kind: "bot", apiKeyId: row.botKey.id, name: row.botKey.name };
}

/** A conversation as the operator API and webhooks show it. */
export function conversationView(
  row: ConversationRow,
  lastMessage: { body: string | null; fromVisitor: boolean; createdAt: Date } | null,
  pictureUrl: string | null = null,
) {
  return {
    id: row.id,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    assigneeOperatorId: row.assigneeOperatorId,
    startedPage: row.startedPage,
    welcome: row.welcome,
    handler: handlerOf(row),
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
      country: row.visitorCountry,
      timeZone: row.visitorTimeZone,
      pictureUrl,
      isTest: row.visitorIsTest,
    },
    lastMessage:
      lastMessage === null
        ? null
        : { ...lastMessage, createdAt: lastMessage.createdAt.toISOString() },
  };
}

/** A conversation in a list, with whether the signed-in operator has read it. */
const listedView = (row: ConversationSummary, pictureUrl: string | null) => ({
  ...conversationView(row, row.lastMessage, pictureUrl),
  unread: row.unread,
});

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

/** Wakes the operators, and the visitor's stream too unless the message is a note. */
const wakeFor = (live: Live, workspaceId: string, visitorId: string, isNote: boolean) =>
  isNote ? live.wake(workspaceId, OPERATORS) : wakeConversation(live, workspaceId, visitorId);

/** The operator whose read positions apply, or null for an API key, which has none. */
const readerId = (actor: Actor) => (actor.kind === "operator" ? actor.operatorId : null);

type Appended = Awaited<ReturnType<typeof appendMessage>>;

/** On Dinghy Cloud, the operator whose picture a new workspace's welcome chat shows. */
export type WelcomeFace = (
  tx: Transaction,
) => Promise<{ operatorId: string; pictureUpdatedAt: Date | null } | null>;

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
  /** After the transaction, with what came of it. It must not throw. */
  finish(outcome: CommitOutcome): Promise<void>;
}

/**
 * What came of a transaction. `unknown` is a connection lost during it, maybe after Postgres
 * committed, so whatever the transaction may point to must stay.
 */
type CommitOutcome = "committed" | "rolled_back" | "unknown";

/** What a reply came to. The routes and the MCP tools answer each the same way. */
export type ReplyOutcome =
  | { kind: "sent"; created: boolean; message: MessageView }
  | { kind: "drafted"; created: boolean; draft: DraftView }
  | { kind: "missing" }
  | { kind: "closed" }
  | { kind: "invalid_reply_to" }
  | { kind: "bots_paused" }
  | { kind: "human_handling" }
  | { kind: "drafts_text_only" }
  | { kind: "refused"; access: WorkspaceAccess };

/** What a key's reply asks for: its text, or an image's clientId with no text. */
interface KeyRequest {
  clientId: string;
  body?: string | undefined;
  replyToMessageId?: string | undefined;
}

type Written =
  | "missing"
  | "bots_paused"
  | "human_handling"
  | "drafts_text_only"
  | { drafted: { draft: DraftView; created: boolean } }
  | (Appended & { visitorId: string });

/**
 * A key's gate, under the workspace row lock: a refusal, a draft, or null to send. A draft holds
 * text only.
 */
async function keyTurn(
  tx: Transaction,
  workspaceId: string,
  actor: KeyActor,
  conversationId: string,
  request: KeyRequest,
): Promise<Exclude<Written, Appended & { visitorId: string }> | null> {
  const gate = await keyGate(tx, workspaceId, actor.apiKeyId, conversationId, request.clientId);
  if (gate === "send") return null;
  if (gate !== "draft") return gate;
  if (request.body === undefined) return "drafts_text_only";
  const body = request.body;
  return {
    drafted: await createDraft(tx, workspaceId, actor.apiKeyId, conversationId, {
      ...request,
      body,
    }),
  };
}

interface InboxOptions {
  db: Database;
  images: Images | undefined;
  limits: Limits;
  live: Live;
  logger: Logger;
  stream: StreamOptions;
  visitorPresence: VisitorPresence;
  copyReply?: CopyReply | undefined;
  /** The founder's picture, on Dinghy Cloud only. */
  founderPicture?: FounderPicture | undefined;
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
  founderPicture = async () => null,
}: Pick<
  InboxOptions,
  "db" | "images" | "live" | "visitorPresence" | "copyReply" | "founderPicture"
>) {
  /**
   * Writes a reply or a note in the caller's transaction, and wakes the clients after the commit. A
   * key's reply passes its gate first, and an operator's marks the conversation as handled by a
   * person. A note reaches no visitor, so it skips both, and a welcome chat does not copy it.
   */
  const reply = async (
    workspaceId: string,
    actor: Actor,
    conversationId: string,
    content: { image: NewImage | undefined; isNote: boolean },
    request: KeyRequest,
    write: (tx: Transaction, author: Author) => Promise<Appended>,
  ): Promise<ReplyOutcome> => {
    const copy = content.isNote
      ? null
      : ((await copyReply?.(workspaceId, conversationId, content.image)) ?? null);
    let outcome: CommitOutcome = "rolled_back";
    const result = await catchClosed(
      withWorkspace(db, workspaceId, async (tx): Promise<Written> => {
        const found = await findConversation(tx, workspaceId, conversationId);
        if (found === null) return "missing";
        if (actor.kind === "key" && !content.isNote) {
          const turn = await keyTurn(tx, workspaceId, actor, conversationId, request);
          if (turn !== null) return turn;
        }
        const append = () => write(tx, replyAuthor(actor, conversationId));
        const appended = copy === null ? await append() : await copy.write(tx, append);
        if (actor.kind === "operator" && appended.created && !content.isNote) {
          await takeOver(tx, workspaceId, conversationId);
        }
        return { ...appended, visitorId: found.visitorId };
      })
        .then((done) => {
          if (typeof done !== "string" && !("drafted" in done)) outcome = "committed";
          return done;
        })
        .catch((error: unknown) => {
          if (error instanceof ConversationClosedError) return "closed" as const;
          if (error instanceof InvalidReplyToError) return "invalid_reply_to" as const;
          if (lostConnection(error)) outcome = "unknown";
          throw error;
        }),
    ).finally(() => copy?.finish(outcome));
    if (typeof result === "string") return { kind: result };
    if (result instanceof WorkspaceClosedError) return { kind: "refused", access: result.access };
    if ("drafted" in result) {
      if (result.drafted.created) live.wake(workspaceId, OPERATORS);
      return { kind: "drafted", ...result.drafted };
    }
    // After the commit. A lost signal only delays delivery, because a stream reads from Postgres.
    if (result.created) wakeFor(live, workspaceId, result.visitorId, content.isNote);
    const names = new Map([[actorId(actor), actor.name]]);
    return {
      kind: "sent",
      created: result.created,
      message: messageView(images, workspaceId, names, result.message),
    };
  };

  return {
    /**
     * `operatorId` counts the operator's own open conversations and reads their unread ones. It is
     * null for an API key.
     */
    async list(
      workspaceId: string,
      operatorId: string | null,
      status: "open" | "closed",
      assignee: AssigneeFilter,
      before: { updatedAt: Date; id: string } | undefined,
      limit: number,
    ) {
      const page = await withWorkspace(db, workspaceId, async (tx) => {
        const listed = await listConversations(
          tx,
          workspaceId,
          operatorId,
          status,
          assignee,
          before,
          limit,
        );
        return {
          ...listed,
          pictures: await welcomePictures(tx, workspaceId, listed.conversations, founderPicture),
          waiting: await countWaiting(tx, workspaceId, operatorId),
          openBy: await countOpenByAssignee(tx, workspaceId, operatorId),
        };
      });
      return {
        conversations: page.conversations.map((row) =>
          listedView(row, page.pictures.get(row.id) ?? null),
        ),
        hasMore: page.hasMore,
        waiting: page.waiting,
        openBy: page.openBy,
      };
    },

    /**
     * One conversation with a page of its messages, or null when it does not exist. `operatorId`
     * reads whether it is unread, and is null for an API key.
     */
    async read(
      workspaceId: string,
      operatorId: string | null,
      conversationId: string,
      after: bigint,
      limit: number,
    ) {
      const result = await withWorkspace(db, workspaceId, async (tx) => {
        const found = await findConversation(tx, workspaceId, conversationId);
        if (found === null) return null;
        const unread = await isUnread(tx, workspaceId, conversationId, operatorId);
        const page = await listConversationMessages(tx, workspaceId, conversationId, after, limit);
        const names = await authorNames(tx, workspaceId, page.messages);
        const pages = await visitorPages(tx, workspaceId, found.visitorId);
        const welcome = found.welcome
          ? await welcomeChat(tx, conversationId, founderPicture)
          : null;
        const receipts = await replyReceipts(tx, workspaceId, conversationId, found.visitorId);
        return { found, unread, page, names, pages, welcome, receipts };
      });
      if (result === null) return null;
      const view = {
        conversation: {
          ...conversationView(
            result.found,
            null,
            result.welcome?.with === "founder" ? result.welcome.pictureUrl : null,
          ),
          unread: result.unread,
        },
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
        receipts: {
          readSeq: result.receipts.readSeq.toString(),
          emails: result.receipts.emails.map((email) => ({
            fromSeq: email.fromSeq.toString(),
            toSeq: email.toSeq.toString(),
            sent: email.sent,
          })),
        },
      };
      // The MCP transcript names the assignee, which the view holds only while they handle it.
      return { view, assigneeName: result.found.assigneeName };
    },

    /** `operatorId` reads which conversations are unread, and is null for an API key. */
    async search(workspaceId: string, operatorId: string | null, q: string) {
      const { rows, pictures } = await withWorkspace(db, workspaceId, async (tx) => {
        const found = await searchConversations(tx, workspaceId, operatorId, q, 50);
        return {
          rows: found,
          pictures: await welcomePictures(tx, workspaceId, found, founderPicture),
        };
      });
      return {
        conversations: rows.map((row) => listedView(row, pictures.get(row.id) ?? null)),
      };
    },

    /** A text reply, or with `note` a note that only the team sees. */
    reply(
      workspaceId: string,
      actor: Actor,
      conversationId: string,
      input: {
        clientId: string;
        body: string;
        replyToMessageId?: string | undefined;
        source?: KeySource;
        note: boolean;
      },
    ) {
      const { note, ...text } = input;
      const content = { image: undefined, isNote: note };
      return reply(workspaceId, actor, conversationId, content, text, (tx, author) =>
        appendMessage(tx, workspaceId, author, note ? { ...text, note } : text),
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
      input: { clientId: string; image: NewImage; replyToMessageId?: string | undefined },
      limits: Limits,
      check: (tx: Transaction) => Promise<void>,
    ): Promise<Exclude<ReplyOutcome, { kind: "drafted" }> & { created: boolean }> {
      const outcome = await reply(
        workspaceId,
        actor,
        conversationId,
        { image: input.image, isNote: false },
        { clientId: input.clientId },
        async (tx, author) => {
          await check(tx);
          return appendMessage(tx, workspaceId, author, input, limits);
        },
      );
      // With no text, a draft-mode key's reply stops at drafts_text_only, so it never drafts.
      if (outcome.kind === "drafted") throw new Error("An image reply made a draft");
      return { ...outcome, created: outcome.kind === "sent" && outcome.created };
    },

    /** Closes or reopens a conversation. False when it does not exist. */
    async setStatus(
      workspaceId: string,
      actor: Actor,
      conversationId: string,
      status: "open" | "closed",
    ) {
      const row = await withWorkspace(db, workspaceId, async (tx) => {
        const found = await findConversation(tx, workspaceId, conversationId);
        if (found === null) return null;
        await setConversationStatus(tx, workspaceId, conversationId, status, actor);
        return found;
      });
      if (row === null) return false;
      live.wake(workspaceId, OPERATORS);
      // The visitor's stream delivers the status line.
      live.wake(workspaceId, row.visitorId);
      return true;
    },
  };
}
export type Inbox = ReturnType<typeof createInbox>;

/** The answer for a reply that did not go in. */
export function refusedReply(outcome: Exclude<ReplyOutcome, { kind: "sent" | "drafted" }>) {
  if (outcome.kind === "missing") return { body: NOT_FOUND, status: 404 as const };
  if (outcome.kind === "closed") return { body: CONVERSATION_CLOSED, status: 409 as const };
  if (outcome.kind === "invalid_reply_to") return { body: INVALID_REPLY_TO, status: 400 as const };
  if (outcome.kind === "bots_paused") return { body: BOTS_PAUSED, status: 409 as const };
  if (outcome.kind === "human_handling") return { body: HUMAN_HANDLING, status: 409 as const };
  if (outcome.kind === "drafts_text_only") return { body: DRAFTS_TEXT_ONLY, status: 409 as const };
  return closedFailure(outcome.access);
}

/** A key that was revoked during an upload. Its transaction rolls back. */
async function keyStillHolds(db: Database, actor: KeyActor) {
  if (!(await keyStillValid(db, actor))) throw new AccessEndedError();
}

export function registerInboxRoutes(app: App, options: InboxOptions & { imageUrls: ImageUrls }) {
  const { db, images, imageUrls, limits, live, logger, stream } = options;
  const inbox = createInbox(options);

  app.openapi(workspaceRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const face = await withWorkspace(db, id, (tx) => readWorkspaceFace(tx, imageUrls, id));
    if (face === undefined) return c.json(NOT_FOUND, 404);
    return c.json({ id, ...face }, 200);
  });

  app.openapi(listRoute, async (c) => {
    const { status, assignee, beforeUpdatedAt, beforeId, limit } = c.req.valid("query");
    const actor = c.get("actor");
    if (assignee === "me" && actor.kind === "key") return c.json(KEY_HAS_NO_ASSIGNMENTS, 400);
    const filter: AssigneeFilter =
      assignee === undefined
        ? { kind: "all" }
        : assignee === "none"
          ? { kind: "none" }
          : { kind: "operator", operatorId: c.get("operatorId") };
    const before =
      beforeUpdatedAt === undefined || beforeId === undefined
        ? undefined
        : { updatedAt: new Date(beforeUpdatedAt), id: beforeId };
    const page = await inbox.list(
      c.get("memberWorkspaceId"),
      readerId(actor),
      status,
      filter,
      before,
      limit,
    );
    return c.json(page, 200);
  });

  app.openapi(conversationRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const { after, limit } = c.req.valid("query");
    const result = await inbox.read(
      c.get("memberWorkspaceId"),
      readerId(c.get("actor")),
      conversationId,
      BigInt(after),
      limit,
    );
    if (result === null) return c.json(NOT_FOUND, 404);
    return c.json(result.view, 200);
  });

  app.openapi(searchRoute, async (c) => {
    const { q } = c.req.valid("query");
    return c.json(await inbox.search(c.get("memberWorkspaceId"), readerId(c.get("actor")), q), 200);
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
    if (outcome.kind === "drafted") return c.json({ draft: outcome.draft }, 202);
    const refused = refusedReply(outcome);
    return c.json(refused.body, refused.status);
  });

  if (images !== undefined) {
    app.openapi(replyImageRoute, async (c) => {
      const id = c.get("memberWorkspaceId");
      const { conversationId } = c.req.valid("param");
      const { clientId, replyToMessageId } = c.req.valid("query");
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
            inbox.replyImage(
              id,
              actor,
              conversationId,
              { clientId, image, replyToMessageId },
              limits,
              check,
            ),
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

  app.openapi(editRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId, messageId } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const outcome = await withWorkspace(db, id, async (tx) => {
      const edited = await editMessage(
        tx,
        id,
        conversationId,
        messageId,
        c.get("operatorId"),
        body,
      );
      if (edited.kind !== "edited") return edited;
      const names = await authorNames(tx, id, [edited.message]);
      return { ...edited, view: messageView(images, id, names, edited.message) };
    });
    if (outcome.kind === "missing") return c.json(NOT_FOUND, 404);
    if (outcome.kind === "not_yours") return c.json(NOT_YOURS, 403);
    if (outcome.kind === "seen") return c.json(MESSAGE_SEEN, 409);
    wakeFor(live, id, outcome.visitorId, outcome.message.kind === "note");
    return c.json(outcome.view, 200);
  });

  app.openapi(deleteMessageRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId, messageId } = c.req.valid("param");
    const by = {
      operatorId: c.get("operatorId"),
      mayDeleteAnyone: allowed.settings(c.get("memberRole")),
    };
    const outcome = await withWorkspace(db, id, (tx) =>
      deleteMessage(tx, id, conversationId, messageId, by),
    );
    if (outcome.kind === "missing") return c.json(NOT_FOUND, 404);
    if (outcome.kind === "not_yours") return c.json(FORBIDDEN, 403);
    wakeFor(live, id, outcome.visitorId, outcome.isNote);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(receiptRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId, messageId } = c.req.valid("param");
    const receipt = await withWorkspace(db, id, async (tx) => {
      const found = await findConversation(tx, id, conversationId);
      const line = await findMessage(tx, id, messageId);
      if (found === null || line === null || line.conversationId !== conversationId) return null;
      // An email can carry a range that a note is inside, but never the note.
      const sent = line.kind === "note" ? null : await emailedAt(tx, id, found.visitorId, line);
      return { readAt: line.readAt?.toISOString() ?? null, emailedAt: sent?.toISOString() ?? null };
    });
    if (receipt === null) return c.json(NOT_FOUND, 404);
    return c.json(receipt, 200);
  });

  app.openapi(statusRoute, async (c) => {
    const { conversationId } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const found = await inbox.setStatus(
      c.get("memberWorkspaceId"),
      c.get("actor"),
      conversationId,
      status,
    );
    if (!found) return c.json(NOT_FOUND, 404);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(readRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const { seq } = c.req.valid("json");
    const found = await withWorkspace(db, id, (tx) =>
      markConversationRead(tx, id, conversationId, c.get("operatorId"), BigInt(seq)),
    );
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
      notices: (notice) => notice,
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
