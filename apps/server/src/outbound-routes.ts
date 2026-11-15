import { createRoute, z } from "@hono/zod-openapi";
import { SESSION_OR_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import {
  errorAnswer,
  INVALID,
  jsonAnswer,
  jsonBody,
  KEY_LIMITED,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
} from "./errors.ts";
import { OnceKey } from "./inputs.ts";
import { WORKSPACE_PREFIX, workspaceParams } from "./member.ts";
import {
  ListQuery,
  type Outbound,
  OutboundMessageSchema,
  SEND_REFUSALS,
  SendSchema,
  VisitorRef,
} from "./outbound.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { MINUTE_SECONDS } from "./time.ts";

/** Sends a minute for one API key, apart from its rate limit for every request. */
const SENDS_PER_KEY_PER_MINUTE = 60;

const PATH = `${WORKSPACE_PREFIX}/{workspaceId}/outbound-messages`;
const itemParams = workspaceParams.extend({ id: z.uuid() });
const Answer = z.object({ outboundMessage: OutboundMessageSchema });

const sendRoute = createRoute({
  method: "post",
  path: PATH,
  security: SESSION_OR_KEY,
  summary: "Send an outbound message to one visitor, who may have no conversation yet",
  description:
    "The message waits on the contact. With `startConversation: on_reply`, it goes in a conversation when the visitor answers it. With `now`, it goes in one at once. `sendAt` or `delay` holds it until then, and `unless` cancels it when the contact matches at that time. A retry with the same `clientId`, and a send with a `once` key that this visitor already has, answer 200 with the first outbound message.",
  request: { params: workspaceParams, body: jsonBody(SendSchema) },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer("A retry, or a `once` key already used: the first outbound message", Answer),
    201: jsonAnswer("The new outbound message", Answer),
    ...MEMBER_WRITE_ERRORS,
    400: errorAnswer(
      "invalid_request: the request is not valid, the sender is not a member, or expiresAt comes before the send time",
    ),
    403: errorAnswer(
      "send_mode_required: the key drafts replies. send_as_member_required: the key may not send as a member. send_email_required: the key may not send with `email: true`. blocked: the team blocked this visitor. suspended: the server's admin suspended the workspace",
    ),
    404: errorAnswer("not_found: no visitor has this `id`"),
    409: errorAnswer("bots_paused: an owner or admin paused every bot"),
    429: errorAnswer(
      "too_many_requests: over the key's rate limit. too_many_waiting: the visitor has 5 outbound messages waiting",
    ),
  },
});

const listRoute = createRoute({
  method: "get",
  path: PATH,
  security: SESSION_OR_KEY,
  summary: "List outbound messages, newest first",
  request: { params: workspaceParams, query: ListQuery },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer(
      "A page of outbound messages",
      z.object({ outboundMessages: z.array(OutboundMessageSchema), next: z.string().nullable() }),
    ),
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

const readRoute = createRoute({
  method: "get",
  path: `${PATH}/{id}`,
  security: SESSION_OR_KEY,
  summary: "Get one outbound message",
  request: { params: itemParams },
  responses: { ...KEY_LIMITED, 200: jsonAnswer("The outbound message", Answer), ...MEMBER_ERRORS },
});

const CANCEL_TEXT =
  "A message that the visitor has not read ends as `cancelled`, with `statusReason: cancelled_by_api`, and its `once` key is free again. A message already read, answered or ended stays as it is: read its `status`.";

const cancelRoute = createRoute({
  method: "post",
  path: `${PATH}/{id}/cancel`,
  security: SESSION_OR_KEY,
  summary: "Cancel an outbound message",
  description: CANCEL_TEXT,
  request: { params: itemParams },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer("The outbound message after the cancel", Answer),
    ...MEMBER_WRITE_ERRORS,
  },
});

const cancelOnceRoute = createRoute({
  method: "post",
  path: `${PATH}/cancel`,
  security: SESSION_OR_KEY,
  summary: "Cancel the outbound message that a visitor's `once` key names",
  description: `${CANCEL_TEXT} With no such message, \`outboundMessage\` is null.`,
  request: {
    params: workspaceParams,
    body: jsonBody(z.object({ visitor: VisitorRef, once: OnceKey })),
  },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer(
      "The outbound message after the cancel, or null",
      z.object({ outboundMessage: OutboundMessageSchema.nullable() }),
    ),
    ...MEMBER_WRITE_ERRORS,
  },
});

export function registerOutboundRoutes(
  app: App,
  { outbound, rateLimit }: { outbound: Outbound; rateLimit: RateLimit },
): void {
  app.openapi(sendRoute, async (c) => {
    const actor = c.get("actor");
    if (actor.kind === "key") {
      const wait = await rateLimit.hit(
        "outbound-send",
        actor.apiKeyId,
        SENDS_PER_KEY_PER_MINUTE,
        MINUTE_SECONDS,
      );
      if (wait !== null) return tooManyRequests(c, wait);
    }
    const outcome = await outbound.send(c.get("memberWorkspaceId"), actor, c.req.valid("json"));
    if (outcome.kind === "refused") {
      const { status, body } = SEND_REFUSALS[outcome.refusal];
      return c.json(body, status);
    }
    return c.json({ outboundMessage: outcome.outboundMessage }, outcome.created ? 201 : 200);
  });

  app.openapi(listRoute, async (c) =>
    c.json(await outbound.list(c.get("memberWorkspaceId"), c.req.valid("query")), 200),
  );

  app.openapi(readRoute, async (c) => {
    const found = await outbound.get(c.get("memberWorkspaceId"), c.req.valid("param").id);
    return found === null ? c.json(NOT_FOUND, 404) : c.json({ outboundMessage: found }, 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const found = await outbound.cancel(c.get("memberWorkspaceId"), {
      id: c.req.valid("param").id,
    });
    return found === null ? c.json(NOT_FOUND, 404) : c.json({ outboundMessage: found }, 200);
  });

  app.openapi(cancelOnceRoute, async (c) => {
    const found = await outbound.cancel(c.get("memberWorkspaceId"), c.req.valid("json"));
    return c.json({ outboundMessage: found }, 200);
  });
}
