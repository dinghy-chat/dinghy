import { createRoute, z } from "@hono/zod-openapi";
import type { Logger } from "pino";
import { authenticateRequest, keyStillValid } from "./api-keys.ts";
import { API_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { WEBHOOK_EVENTS, type WebhookEvent } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { errorAnswer, INVALID, KEY_LIMITED, WRONG_ORIGIN } from "./errors.ts";
import type { Images } from "./images.ts";
import { type Limits, STREAM_LIMIT, STREAM_RETRY_SECONDS } from "./limits.ts";
import { type Live, OPERATORS, type OperatorNotice } from "./live.ts";
import { closedFailure } from "./member.ts";
import { type Cursor, formatCursor, listWorkspaceEvents, parseCursor } from "./messages.ts";
import type { RateLimit } from "./rate-limit.ts";
import { CLOSE_REASONS_TEXT, openLiveStream, type StreamOptions, streamLeaseMs } from "./stream.ts";
import { isWebhookEvent, labelChange, webhookData, webhookTypes } from "./webhooks.ts";

const PATH = "/v1/events";
/** Events read for one page of the stream. */
const PAGE = 100;
/**
 * Where a client stands: a cursor, or a cursor and a part. One feed row can make several events,
 * such as `conversation.created` and `message.created`. The last one's id is the row's cursor,
 * `generation.seq`, and each earlier one's is `generation.seq.part`, its place in the row's list.
 */
const POSITION_PATTERN = /^\d{1,9}\.\d{1,18}(\.\d)?$/;

interface Position {
  after: Cursor;
  /** The row whose events up to `part` the client has. */
  partOf: { generation: number; seq: bigint; part: number } | null;
}

function parsePosition(value: string): Position {
  const [generation = "", seq = "", part] = value.split(".");
  const cursor = parseCursor(`${generation}.${seq}`);
  if (part === undefined) return { after: cursor, partOf: null };
  // Read the row again, and skip what the client has of it.
  return {
    after: { generation: cursor.generation, seq: cursor.seq - 1n },
    partOf: { ...cursor, part: Number(part) },
  };
}

const eventsRoute = createRoute({
  method: "get",
  path: PATH,
  security: API_KEY,
  summary: "Stream the workspace's events to an API key's bot, with no public server",
  description:
    "Server-sent events with the same `type` and `data` as webhook bodies, in the key's workspace. Each event's name is its type, and its data is `{ type, workspaceId, data }`. Its id is its position: reconnect with `Last-Event-ID` or `?after=` to resume after it. When one change makes several events, such as `conversation.created` then `message.created`, each has its own position, `generation.seq.part`, and the last has the change's cursor, `generation.seq`. With no cursor it starts now. `resync` means the cursor is too old: read the open conversations again. `ready` comes when caught up. Heartbeats come every 25 seconds, the stream ends after 15 minutes, and it takes a slot in the workspace's stream limit. A revoked key's stream ends within 25 seconds.\n\n" +
    'A `notice` has no id and may be lost: `{ kind: "typing", conversationId, draft }`, a visitor\'s unsent text, only while the workspace shows typing previews. Messages from test visitors come with `conversation.visitor.isTest: true`.\n\n' +
    CLOSE_REASONS_TEXT,
  request: {
    query: z.object({
      types: z
        .string()
        .refine((value) => value.split(",").every(isWebhookEvent), "event types, comma separated")
        .optional()
        .openapi({ description: `A comma list of ${WEBHOOK_EVENTS.join(", ")}. All by default.` }),
      after: z.string().regex(POSITION_PATTERN).optional(),
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

/**
 * One page of events after a cursor, as webhook bodies of the wanted types, without the parts of
 * a row that the client has.
 */
const readPage = (
  { db, images }: Pick<KeyEventsOptions, "db" | "images">,
  workspaceId: string,
  wanted: Set<WebhookEvent> | null,
  position: Cursor | undefined,
  partOf: Position["partOf"],
) =>
  withWorkspace(db, workspaceId, async (tx) => {
    const page = await listWorkspaceEvents(tx, workspaceId, position, PAGE);
    const has = (seq: bigint, part: number) =>
      partOf !== null &&
      partOf.generation === page.cursor.generation &&
      partOf.seq === seq &&
      part <= partOf.part;
    const wantedEvents = page.events.flatMap((one) => {
      const ids = one.payload as { conversationId?: string; messageId?: string };
      const { conversationId } = ids;
      if (conversationId === undefined) return [];
      const types = webhookTypes(one.kind, one.payload);
      const cursor = formatCursor({ generation: page.cursor.generation, seq: one.seq });
      return [...types.entries()]
        .filter(([part, type]) => (wanted === null || wanted.has(type)) && !has(one.seq, part))
        .map(([part, type]) => ({
          type,
          seq: one.seq,
          id: part === types.length - 1 ? cursor : `${cursor}.${part}`,
          subject: {
            conversationId,
            messageId: type.startsWith("message.") ? (ids.messageId ?? null) : null,
            label: labelChange(type, one.payload),
          },
        }));
    });
    const bodies = await webhookData(
      tx,
      images,
      workspaceId,
      wantedEvents.map((one) => one.subject),
    );
    const items = wantedEvents.flatMap(({ type, seq, id }, index) => {
      const data = bodies[index];
      // A conversation or message deleted since has nothing to send.
      if (typeof data !== "object") return [];
      return [{ event: type, seq, id, data: { type, workspaceId, data } }];
    });
    return { ...page, items };
  });

export function registerKeyEvents(app: App, options: KeyEventsOptions): void {
  const { db, limits, live, logger, rateLimit, stream, publicOrigin } = options;

  app.openapi(eventsRoute, async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const actor = await authenticateRequest(c, db, rateLimit);
    if (actor instanceof Response) return actor;
    if (actor.access === "waiting_payment") {
      const refused = closedFailure(actor.access);
      return c.json(refused.body, refused.status);
    }
    const { types, after } = c.req.valid("query");
    const resume = c.req.header("last-event-id");
    const from = resume !== undefined && POSITION_PATTERN.test(resume) ? resume : after;
    const position = from === undefined ? null : parsePosition(from);
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
      after: position?.after,
      authorized: () => keyStillValid(db, actor),
      read: (cursor) => readPage(options, workspaceId, wanted, cursor, position?.partOf ?? null),
    });
  });
}
