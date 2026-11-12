import { createRoute, z } from "@hono/zod-openapi";
import type { Actor, KeyActor } from "./api-keys.ts";
import { API_KEY, SESSION, SESSION_OR_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { giveBack, type HandoffInput, handoff, setBotsPaused, typingGate } from "./bots.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { DraftSchema, discardDraft, listDrafts, sendDraft } from "./drafts.ts";
import {
  CONVERSATION_CLOSED,
  errorAnswer,
  FORBIDDEN,
  failure,
  KEY_LIMITED,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  okContent,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import type { Images } from "./images.ts";
import { BODY, BOTS_PAUSED, HUMAN_HANDLING, InboxMessage, messageView } from "./inbox.ts";
import { type Live, OPERATORS, wakeConversation } from "./live.ts";
import { closedFailure, WORKSPACE_PREFIX as PREFIX } from "./member.ts";
import {
  authorNames,
  ConversationClosedError,
  catchClosed,
  findConversation,
  recordWorkspaceChange,
  type StoredMessage,
  WorkspaceClosedError,
} from "./messages.ts";
import { appendNote, NoteSchema } from "./notes.ts";
import { allowed, NOT_A_MEMBER } from "./team.ts";

const workspaceParams = z.object({ workspaceId: z.uuid() });
const conversationParams = workspaceParams.extend({ conversationId: z.uuid() });
const draftParams = conversationParams.extend({ draftId: z.uuid() });
const CLIENT_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** One line or a few, with no NUL byte, which Postgres text cannot hold. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\0]*$/);

const KEYS_ONLY = failure("forbidden", "Only an API key's bot does this.");

const json = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
const answer = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});

const listDraftsRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/drafts`,
  security: SESSION,
  summary: "The drafts that wait in a conversation, newest first",
  description:
    "Replies that API keys in draft mode wrote, which no visitor has seen. A `stale` draft is older than the visitor's newest message.",
  request: { params: conversationParams },
  responses: {
    200: answer("The drafts", z.object({ drafts: z.array(DraftSchema) })),
    ...MEMBER_ERRORS,
  },
});

const sendDraftRoute = createRoute({
  method: "post",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/drafts/{draftId}/send`,
  security: SESSION,
  summary: "Send a draft to the visitor, as is or edited, as your own reply",
  description:
    "The message's author is the operator, and its `via` is `draft`. Sending approves the bot's words, so the bot keeps the conversation. Sending it again returns the same message.",
  request: { params: draftParams, body: json(z.object({ body: BODY.optional() })) },
  responses: {
    200: answer("It was sent before. This is that message", InboxMessage),
    201: answer("The new message", InboxMessage),
    ...MEMBER_WRITE_ERRORS,
    404: errorAnswer("not_found: no such draft here, or it was discarded"),
    409: errorAnswer("conversation_closed: reopen it to reply"),
  },
});

const discardDraftRoute = createRoute({
  method: "post",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/drafts/{draftId}/discard`,
  security: SESSION,
  summary: "Discard a draft. The visitor never sees it",
  request: { params: draftParams },
  responses: {
    200: { description: "Discarded, or it already was", content: okContent },
    ...MEMBER_WRITE_ERRORS,
    404: errorAnswer("not_found: no such draft here, or it was sent"),
  },
});

const noteRoute = createRoute({
  method: "post",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/notes`,
  security: SESSION_OR_KEY,
  summary: "Add an internal note. Only operators and API keys see notes",
  description:
    "A note never reaches the visitor: not the widget, an email, a transcript or a visitor export. It sorts among the messages by `seq`, and webhooks get `note.created`. A retry with the same clientId returns the original.",
  request: {
    params: conversationParams,
    body: json(z.object({ clientId: CLIENT_ID, body: BODY })),
  },
  responses: {
    ...KEY_LIMITED,
    200: answer("A retry. This is the original note", NoteSchema),
    201: answer("The new note", NoteSchema),
    ...MEMBER_WRITE_ERRORS,
  },
});

const HandoffMessageSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("sent"), message: InboxMessage }),
    z.object({ status: z.literal("drafted"), draft: DraftSchema }),
    // Bots are paused, so nothing went to the visitor. The handoff still happened.
    z.object({ status: z.literal("not_sent"), reason: z.literal("bots_paused") }),
  ])
  .nullable()
  .openapi("HandoffMessage");

const handoffRoute = createRoute({
  method: "post",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/handoff`,
  security: API_KEY,
  summary: "Hand a conversation to people. API keys only",
  description:
    "In one step: `visitorMessage` goes to the visitor as the key's reply (or a draft in draft mode), the conversation is assigned to `operatorId` if given, a person handles it from now so bots that send directly answer `human_handling`, a note holds `reason` and `summary`, and the assignee, or every member when there is none, gets an alert. Webhooks get `conversation.handoff`. A retry with the same clientId changes nothing again.",
  request: {
    params: conversationParams,
    body: json(
      z.object({
        clientId: CLIENT_ID,
        reason: text(500),
        summary: text(2000).optional(),
        operatorId: z.uuid().optional(),
        visitorMessage: BODY.optional(),
      }),
    ),
  },
  responses: {
    ...KEY_LIMITED,
    200: answer("A retry", z.object({ visitorMessage: HandoffMessageSchema })),
    201: answer("Handed off", z.object({ visitorMessage: HandoffMessageSchema })),
    ...MEMBER_WRITE_ERRORS,
    400: errorAnswer(
      "invalid_request: the request is not valid. not_a_member: operatorId is not in this workspace",
    ),
    403: errorAnswer("forbidden: an operator sent it. People assign a conversation instead"),
    409: errorAnswer("conversation_closed: the conversation is closed"),
  },
});

const giveBackRoute = createRoute({
  method: "post",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/give-back`,
  security: SESSION,
  summary: "Give a conversation back to the bots",
  description:
    "No person handles it any more, so a key that sends directly may reply again. Webhooks get `conversation.given_back`. Only people can do this: a bot cannot take a conversation back.",
  request: { params: conversationParams },
  responses: {
    200: { description: "Bots may answer it", content: okContent },
    ...MEMBER_WRITE_ERRORS,
  },
});

const botsPausedRoute = createRoute({
  method: "put",
  path: `${PREFIX}/{workspaceId}/bots-paused`,
  security: SESSION,
  summary: "Pause or resume every bot of the workspace. Owners and admins only",
  description:
    "While paused, every API key's reply, draft or typing answers 409 `bots_paused`. Reads, notes and handoffs still work, so a bot can still hand a conversation to people.",
  request: { params: workspaceParams, body: json(z.object({ paused: z.boolean() })) },
  responses: {
    200: answer(
      "The new state, and the name of who paused bots, null when they run",
      z.object({ paused: z.boolean(), pausedBy: z.string().nullable() }),
    ),
    ...ROLE_WRITE_ERRORS,
  },
});

const typingRoute = createRoute({
  method: "post",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/typing`,
  security: API_KEY,
  summary: "Show the visitor that the key's bot is typing. API keys only",
  description:
    "Nothing is stored. The visitor's chat shows `<name> is typing` for 6 seconds, or until the next message, so repeat it while you write. Operators see it too. A key in draft mode shows it to operators only. Refused like a reply: `bots_paused`, and `human_handling` for a key that sends directly.",
  request: {
    params: conversationParams,
    body: json(z.object({ typing: z.boolean().default(true) })),
  },
  responses: {
    ...KEY_LIMITED,
    200: { description: "Passed on", content: okContent },
    ...MEMBER_WRITE_ERRORS,
    403: errorAnswer("forbidden: an operator sent it"),
    409: errorAnswer(
      "bots_paused: an owner or admin paused every bot. human_handling: a person handles the conversation",
    ),
  },
});

interface HandlingOptions {
  db: Database;
  images: Images | undefined;
  live: Live;
}

/** The message as the operator API shows it, named after its author. */
const viewOf =
  (images: Images | undefined, workspaceId: string, actor: Actor) => (message: StoredMessage) => {
    const id = actor.kind === "operator" ? actor.operatorId : actor.apiKeyId;
    return messageView(images, workspaceId, new Map([[id, actor.name]]), message);
  };

/** Sets a typing notice for the visitor, and for operators. */
export async function setTyping(
  db: Database,
  live: Live,
  workspaceId: string,
  actor: KeyActor,
  conversationId: string,
  typing: boolean,
): Promise<"ok" | "missing" | "bots_paused" | "human_handling"> {
  const found = await withWorkspace(db, workspaceId, (tx) =>
    typingGate(tx, workspaceId, actor.apiKeyId, conversationId),
  );
  if (found === null) return "missing";
  if (found.gate === "bots_paused" || found.gate === "human_handling") return found.gate;
  live.tell(workspaceId, { kind: "bot_typing", conversationId, name: actor.name, typing });
  if (found.gate === "send") {
    live.tellVisitor(workspaceId, found.visitorId, { kind: "typing", name: actor.name, typing });
  }
  return "ok";
}

/** A bot's handoff to people, with the clients woken after the commit. */
export async function handOff(
  db: Database,
  live: Live,
  workspaceId: string,
  actor: KeyActor,
  conversationId: string,
  input: HandoffInput,
  via?: "mcp",
) {
  const key = { apiKeyId: actor.apiKeyId, ...(via !== undefined && { via }) };
  const outcome = await catchClosed(
    withWorkspace(db, workspaceId, async (tx) => {
      const done = await handoff(tx, workspaceId, key, conversationId, input);
      const found = await findConversation(tx, workspaceId, conversationId);
      return { done, visitorId: found?.visitorId };
    }),
  );
  if (outcome instanceof WorkspaceClosedError)
    return { kind: "refused" as const, access: outcome.access };
  if (outcome.done.kind === "handed_off" && outcome.visitorId !== undefined) {
    wakeConversation(live, workspaceId, outcome.visitorId);
  }
  return outcome.done;
}

export function registerHandlingRoutes(app: App, { db, images, live }: HandlingOptions): void {
  app.openapi(listDraftsRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const drafts = await withWorkspace(db, id, async (tx) =>
      (await findConversation(tx, id, conversationId)) === null
        ? null
        : listDrafts(tx, id, conversationId, "waiting"),
    );
    if (drafts === null) return c.json(NOT_FOUND, 404);
    return c.json({ drafts }, 200);
  });

  app.openapi(sendDraftRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId, draftId } = c.req.valid("param");
    const author = { kind: "operator" as const, operatorId: c.get("operatorId"), conversationId };
    const outcome = await catchClosed(
      withWorkspace(db, id, async (tx) => {
        const sent = await sendDraft(tx, id, author, draftId, c.req.valid("json").body);
        if (sent.kind !== "sent") return sent;
        const names = await authorNames(tx, id, [sent.message]);
        const found = await findConversation(tx, id, conversationId);
        return {
          ...sent,
          view: messageView(images, id, names, sent.message),
          visitorId: found?.visitorId,
        };
      }).catch((error: unknown) => {
        if (error instanceof ConversationClosedError) return { kind: "closed" as const };
        throw error;
      }),
    );
    if (outcome instanceof WorkspaceClosedError) {
      const refused = closedFailure(outcome.access);
      return c.json(refused.body, refused.status);
    }
    if (outcome.kind === "closed") return c.json(CONVERSATION_CLOSED, 409);
    if (outcome.kind !== "sent") return c.json(NOT_FOUND, 404);
    if (outcome.created && outcome.visitorId !== undefined) {
      wakeConversation(live, id, outcome.visitorId);
    }
    return c.json(outcome.view, outcome.created ? 201 : 200);
  });

  app.openapi(discardDraftRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId, draftId } = c.req.valid("param");
    const done = await withWorkspace(db, id, (tx) =>
      discardDraft(tx, id, c.get("operatorId"), conversationId, draftId),
    );
    if (!done) return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(noteRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const actor = c.get("actor");
    const author =
      actor.kind === "operator"
        ? { kind: "operator" as const, operatorId: actor.operatorId }
        : { kind: "key" as const, apiKeyId: actor.apiKeyId };
    const noted = await withWorkspace(db, id, (tx) =>
      appendNote(tx, id, author, conversationId, c.req.valid("json")),
    );
    if (noted === null) return c.json(NOT_FOUND, 404);
    if (noted.created) live.wake(id, OPERATORS);
    return c.json(noted.note, noted.created ? 201 : 200);
  });

  app.openapi(handoffRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const actor = c.get("actor");
    if (actor.kind !== "key") return c.json(KEYS_ONLY, 403);
    const { conversationId } = c.req.valid("param");
    const outcome = await handOff(db, live, id, actor, conversationId, c.req.valid("json"));
    if (outcome.kind === "refused") {
      const refused = closedFailure(outcome.access);
      return c.json(refused.body, refused.status);
    }
    if (outcome.kind === "missing") return c.json(NOT_FOUND, 404);
    if (outcome.kind === "closed") return c.json(CONVERSATION_CLOSED, 409);
    if (outcome.kind === "not_member") return c.json(NOT_A_MEMBER, 400);
    const sent = outcome.visitorMessage;
    const visitorMessage =
      sent?.status === "sent"
        ? { ...sent, message: viewOf(images, id, actor)(sent.message) }
        : sent;
    return c.json({ visitorMessage }, outcome.created ? 201 : 200);
  });

  app.openapi(giveBackRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const found = await withWorkspace(db, id, (tx) => giveBack(tx, id, conversationId));
    if (!found) return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(botsPausedRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { paused } = c.req.valid("json");
    const pausedBy = await withWorkspace(db, id, async (tx) => {
      const name = await setBotsPaused(tx, id, c.get("operatorId"), paused);
      await recordWorkspaceChange(tx, id);
      return name;
    });
    live.wake(id, OPERATORS);
    return c.json({ paused, pausedBy }, 200);
  });

  app.openapi(typingRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const actor = c.get("actor");
    if (actor.kind !== "key") return c.json(KEYS_ONLY, 403);
    const { conversationId } = c.req.valid("param");
    const result = await setTyping(db, live, id, actor, conversationId, c.req.valid("json").typing);
    if (result === "missing") return c.json(NOT_FOUND, 404);
    if (result === "bots_paused") return c.json(BOTS_PAUSED, 409);
    if (result === "human_handling") return c.json(HUMAN_HANDLING, 409);
    return c.json({ ok: true as const }, 200);
  });
}
