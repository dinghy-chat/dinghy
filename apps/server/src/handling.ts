import { createRoute, z } from "@hono/zod-openapi";
import { BOT_TYPING_MS } from "../../../packages/widget/src/shared.ts";
import type { KeyActor } from "./api-keys.ts";
import { API_KEY, SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { giveBack, type HandoffInput, setBotsPaused, typingGate, writeHandoff } from "./bots.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { DraftSchema, discardDraft, listDrafts, sendDraft } from "./drafts.ts";
import {
  CONVERSATION_CLOSED,
  errorAnswer,
  FORBIDDEN,
  failure,
  jsonAnswer,
  jsonBody,
  KEY_LIMITED,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  okContent,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import type { Images } from "./images.ts";
import { InboxMessage, KEY_REPLY_REFUSALS, messageView, refusedReply } from "./inbox.ts";
import { Body, ClientId, HandoffReason, HandoffSummary } from "./inputs.ts";
import { type Live, OPERATORS, wakeConversation } from "./live.ts";
import { closedFailure, WORKSPACE_PREFIX as PREFIX } from "./member.ts";
import {
  authorNames,
  catchClosed,
  catchConversationClosed,
  changeWorkspace,
  conversationVisitor,
  type KeySource,
  WorkspaceClosedError,
} from "./messages.ts";
import { allowed, NOT_A_MEMBER } from "./team.ts";

const workspaceParams = z.object({ workspaceId: z.uuid() });
const conversationParams = workspaceParams.extend({ conversationId: z.uuid() });
const draftParams = conversationParams.extend({ draftId: z.uuid() });

const KEYS_ONLY = failure("forbidden", "Only an API key's bot does this.");

const listDraftsRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/conversations/{conversationId}/drafts`,
  security: SESSION,
  summary: "The drafts that wait in a conversation, newest first",
  description:
    "Replies that API keys in draft mode wrote, which no visitor has seen. A `stale` draft is older than the visitor's newest message.",
  request: { params: conversationParams },
  responses: {
    200: jsonAnswer("The drafts", z.object({ drafts: z.array(DraftSchema) })),
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
  request: { params: draftParams, body: jsonBody(z.object({ body: Body.optional() })) },
  responses: {
    200: jsonAnswer("It was sent before. This is that message", InboxMessage),
    201: jsonAnswer("The new message", InboxMessage),
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
    body: jsonBody(
      z.object({
        clientId: ClientId,
        reason: HandoffReason,
        summary: HandoffSummary.optional(),
        operatorId: z.uuid().optional(),
        visitorMessage: Body.optional(),
      }),
    ),
  },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer("A retry", z.object({ visitorMessage: HandoffMessageSchema })),
    201: jsonAnswer("Handed off", z.object({ visitorMessage: HandoffMessageSchema })),
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
    "No person handles it any more and its assignee is cleared, so a key that sends directly may reply again. Webhooks get `conversation.given_back`, and `conversation.assigned` when it had an assignee. Only people can do this: a bot cannot take a conversation back.",
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
  request: { params: workspaceParams, body: jsonBody(z.object({ paused: z.boolean() })) },
  responses: {
    200: jsonAnswer(
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
  description: `Nothing is stored. The visitor's chat shows \`<name> is typing\` for ${BOT_TYPING_MS / 1000} seconds, or until the next message, so repeat it while you write. Operators see it too. A key in draft mode shows it to operators only. Refused like a reply: \`bots_paused\`, and \`human_handling\` for a key that sends directly.`,
  request: {
    params: conversationParams,
    body: jsonBody(z.object({ typing: z.boolean().default(true) })),
  },
  responses: {
    ...KEY_LIMITED,
    200: { description: "Passed on", content: okContent },
    ...MEMBER_WRITE_ERRORS,
    403: errorAnswer("forbidden: an operator sent it"),
    409: errorAnswer(KEY_REPLY_REFUSALS),
  },
});

interface HandlingOptions {
  db: Database;
  images: Images | undefined;
  live: Live;
}

/** Sets a typing notice for the visitor, and for operators. */
export async function setTyping(
  db: Database,
  live: Live,
  workspaceId: string,
  actor: KeyActor,
  conversationId: string,
  typing: boolean,
): Promise<{ kind: "ok" } | { kind: "missing" } | { kind: "bots_paused" | "human_handling" }> {
  const found = await withWorkspace(db, workspaceId, (tx) =>
    typingGate(tx, workspaceId, actor.apiKeyId, conversationId),
  );
  if (found === null) return { kind: "missing" };
  if (found.gate === "bots_paused" || found.gate === "human_handling") return { kind: found.gate };
  live.tell(workspaceId, { kind: "bot_typing", conversationId, name: actor.name, typing });
  if (found.gate === "send") {
    live.tellVisitor(workspaceId, found.visitorId, { kind: "typing", name: actor.name, typing });
  }
  return { kind: "ok" };
}

/**
 * A bot's handoff to people, with its message to the visitor as the operator API shows it. The
 * clients wake after the commit.
 */
export async function handOff(
  { db, images, live }: HandlingOptions,
  workspaceId: string,
  actor: KeyActor,
  conversationId: string,
  input: HandoffInput,
  source?: KeySource,
) {
  const key = { apiKeyId: actor.apiKeyId, source };
  const outcome = await catchClosed(
    catchConversationClosed(
      withWorkspace(db, workspaceId, (tx) =>
        writeHandoff(tx, workspaceId, key, conversationId, input),
      ),
    ),
  );
  if (outcome instanceof WorkspaceClosedError) {
    return { kind: "failed" as const, ...closedFailure(outcome.access) };
  }
  if (outcome.kind === "not_member") {
    return { kind: "failed" as const, body: NOT_A_MEMBER, status: 400 as const };
  }
  if (outcome.kind === "missing" || outcome.kind === "closed") {
    return { kind: "failed" as const, ...refusedReply(outcome) };
  }
  if (outcome.kind === "handed_off") wakeConversation(live, workspaceId, outcome.visitorId);
  const sent = outcome.visitorMessage;
  const names = new Map([[actor.apiKeyId, actor.name]]);
  return {
    kind: "done" as const,
    created: outcome.kind === "handed_off",
    visitorMessage:
      sent?.status === "sent"
        ? { ...sent, message: messageView(images, workspaceId, names, sent.message) }
        : sent,
  };
}

export function registerHandlingRoutes(app: App, options: HandlingOptions): void {
  const { db, images, live } = options;
  app.openapi(listDraftsRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const drafts = await withWorkspace(db, id, async (tx) =>
      (await conversationVisitor(tx, id, conversationId)) === undefined
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
      catchConversationClosed(
        withWorkspace(db, id, async (tx) => {
          const sent = await sendDraft(tx, id, author, draftId, c.req.valid("json").body);
          if (sent.kind !== "sent") return sent;
          const names = await authorNames(tx, id, [sent.message]);
          const found = await conversationVisitor(tx, id, conversationId);
          return {
            ...sent,
            view: messageView(images, id, names, sent.message),
            visitorId: found?.id,
          };
        }),
      ),
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

  app.openapi(handoffRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const actor = c.get("actor");
    if (actor.kind !== "key") return c.json(KEYS_ONLY, 403);
    const { conversationId } = c.req.valid("param");
    const outcome = await handOff(options, id, actor, conversationId, c.req.valid("json"));
    if (outcome.kind === "failed") return c.json(outcome.body, outcome.status);
    return c.json({ visitorMessage: outcome.visitorMessage }, outcome.created ? 201 : 200);
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
    const saved = await changeWorkspace(db, live, id, async (tx) => ({
      paused,
      pausedBy: await setBotsPaused(tx, id, c.get("operatorId"), paused),
    }));
    return c.json(saved, 200);
  });

  app.openapi(typingRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const actor = c.get("actor");
    if (actor.kind !== "key") return c.json(KEYS_ONLY, 403);
    const { conversationId } = c.req.valid("param");
    const result = await setTyping(db, live, id, actor, conversationId, c.req.valid("json").typing);
    if (result.kind === "ok") return c.json({ ok: true as const }, 200);
    const refused = refusedReply(result);
    return c.json(refused.body, refused.status);
  });
}
