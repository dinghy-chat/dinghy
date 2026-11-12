import { createRoute, z } from "@hono/zod-openapi";
import type { Logger } from "pino";
import {
  apiKeyToken,
  authenticateApiKey,
  KEY_INVALID,
  KEY_REQUESTS_PER_MINUTE,
  keyStillValid,
} from "./api-keys.ts";
import { API_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { WEBHOOK_EVENTS, type WebhookEvent } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { errorAnswer, INVALID, KEY_LIMITED, WRONG_ORIGIN } from "./errors.ts";
import type { Images } from "./images.ts";
import { type Limits, STREAM_LIMIT, STREAM_RETRY_SECONDS } from "./limits.ts";
import { type Live, OPERATORS, type OperatorNotice } from "./live.ts";
import { closedFailure } from "./member.ts";
import { CURSOR_PATTERN, type Cursor, listWorkspaceEvents, parseCursor } from "./messages.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { CLOSE_REASONS_TEXT, openLiveStream, type StreamOptions, streamLeaseMs } from "./stream.ts";
import { webhookData, webhookTypes } from "./webhooks.ts";

const PATH = "/v1/events";
/** Events read for one page of the stream. */
const PAGE = 100;

const isWebhookEvent = (name: string): name is WebhookEvent =>
  WEBHOOK_EVENTS.some((one) => one === name);

const eventsRoute = createRoute({
  method: "get",
  path: PATH,
  security: API_KEY,
  summary: "Stream the workspace's events to an API key's bot, with no public server",
  description:
    "Server-sent events with the same `type` and `data` as webhook bodies, in the key's workspace. Each event's name is its type, and its data is `{ type, workspaceId, data }`. Its id is a cursor: reconnect with `Last-Event-ID` or `?after=` to resume. With no cursor it starts now. `resync` means the cursor is too old: read the open conversations again. `ready` comes when caught up. Heartbeats come every 25 seconds, the stream ends after 15 minutes, and it takes a slot in the workspace's stream limit. A revoked key's stream ends within 25 seconds.\n\n" +
    'A `notice` has no id and may be lost: `{ kind: "typing", conversationId, draft }`, a visitor\'s unsent text, only while the workspace shows typing previews. Messages from test visitors come with `conversation.visitor.isTest: true`.\n\n' +
    CLOSE_REASONS_TEXT,
  request: {
    query: z.object({
      types: z
        .string()
        .refine((value) => value.split(",").every(isWebhookEvent), "event types, comma separated")
        .optional()
        .openapi({ description: `A comma list of ${WEBHOOK_EVENTS.join(", ")}. All by default.` }),
      after: z.string().regex(CURSOR_PATTERN).optional(),
    }),
  },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "The event stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    ...INVALID,
    401: errorAnswer("unauthorized: the API key is not valid or was revoked"),
    402: errorAnswer("payment_required: the workspace waits for payment"),
    403: errorAnswer("origin_not_allowed: a browser on another site sent this"),
    429: errorAnswer(
      "too_many_requests: over the key's rate limit. too_many_streams: the workspace has too many open streams. Retry after `retry-after`",
    ),
  },
});

/** A visitor's typing preview, as the key's stream passes it on. Other notices stay with operators. */
function keyNotice(raw: string): string | null {
  const notice = JSON.parse(raw) as OperatorNotice;
  if (notice.kind !== "typing") return null;
  const { conversationId, draft } = notice;
  return JSON.stringify({ kind: "typing", conversationId, draft });
}

interface KeyEventsOptions {
  db: Database;
  images: Images | undefined;
  limits: Limits;
  live: Live;
  logger: Logger;
  rateLimit: RateLimit;
  stream: StreamOptions;
  /** The server's own origin. A browser request from any other is refused. */
  publicOrigin: string;
}

export function registerKeyEvents(app: App, options: KeyEventsOptions): void {
  const { db, images, limits, live, logger, rateLimit, stream, publicOrigin } = options;

  /** One page of events after a cursor, as webhook bodies of the wanted types. */
  const readPage = (
    workspaceId: string,
    wanted: Set<WebhookEvent> | null,
    position: Cursor | undefined,
  ) =>
    withWorkspace(db, workspaceId, async (tx) => {
      const page = await listWorkspaceEvents(tx, workspaceId, position, PAGE);
      const items: { event: string; seq: bigint; data: unknown }[] = [];
      for (const one of page.events) {
        const ids = one.payload as { conversationId?: string; messageId?: string; noteId?: string };
        if (ids.conversationId === undefined) continue;
        for (const type of webhookTypes(one.kind, one.payload)) {
          if (wanted !== null && !wanted.has(type)) continue;
          const data = await webhookData(tx, images, workspaceId, {
            conversationId: ids.conversationId,
            messageId: type.startsWith("message.") ? (ids.messageId ?? null) : null,
            noteId: type === "note.created" ? (ids.noteId ?? null) : null,
          });
          // A conversation or message deleted since has nothing to send.
          if (typeof data !== "string")
            items.push({ event: type, seq: one.seq, data: { type, workspaceId, data } });
        }
      }
      return { ...page, items };
    });

  app.openapi(eventsRoute, async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const token = apiKeyToken(c.req.header("authorization"));
    const actor = token === null ? null : await authenticateApiKey(db, token);
    if (actor === null) return c.json(KEY_INVALID, 401);
    const wait = await rateLimit.hit("api-key", actor.apiKeyId, KEY_REQUESTS_PER_MINUTE, 60);
    if (wait !== null) return tooManyRequests(c, wait);
    if (actor.access === "waiting_payment") {
      const refused = closedFailure(actor.access);
      return c.json(refused.body, 402);
    }
    const { types, after } = c.req.valid("query");
    const resume = c.req.header("last-event-id");
    const from = resume !== undefined && CURSOR_PATTERN.test(resume) ? resume : after;
    const wanted = types === undefined ? null : new Set(types.split(",").filter(isWebhookEvent));
    const workspaceId = actor.workspaceId;
    const admitted = await limits.openStream(workspaceId, "operator", streamLeaseMs(stream));
    if (admitted === null) {
      c.header("retry-after", String(STREAM_RETRY_SECONDS));
      return c.json(STREAM_LIMIT, 429);
    }
    return openLiveStream(c, {
      live,
      release: admitted.release,
      logger,
      options: stream,
      workspaceId,
      subscriber: OPERATORS,
      notices: keyNotice,
      stillAllowed: () => keyStillValid(db, actor),
      expiresAt: undefined,
      after: from === undefined ? undefined : parseCursor(from),
      authorized: () => keyStillValid(db, actor),
      read: (position) => readPage(workspaceId, wanted, position),
    });
  });
}
