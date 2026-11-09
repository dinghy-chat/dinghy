import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Context, Input } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { Logger } from "pino";
import { VISITOR_TOKEN } from "./api-security.ts";
import type { App, AppEnv } from "./app.ts";
import { chatLinkVisitor, chatLinkWorkspace, isChatLinkToken } from "./chat-link.ts";
import { conversation, visitor, workspace } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { deviceLine } from "./device.ts";
import {
  BUSY,
  errorAnswer,
  failure,
  IMAGE_UPLOAD_ERRORS,
  INVALID,
  okContent,
  WIDGET_ERRORS,
  WIDGET_TOKEN_ERRORS,
  WIDGET_WRITE_ERRORS,
} from "./errors.ts";
import {
  type HostIdentity,
  isBrowserToken,
  newBrowserToken,
  sha256Hex,
  verifyHostToken,
} from "./identity.ts";
import { ImageSchema, type Images, imageView, refuseImage } from "./images.ts";
import { pageTitle, recordPage } from "./journey.ts";
import { type Limits, STREAM_LIMIT, STREAM_RETRY_SECONDS } from "./limits.ts";
import { type Live, wakeConversation } from "./live.ts";
import {
  appendMessage,
  CURSOR_PATTERN,
  catchClosed,
  formatCursor,
  listVisitorMessages,
  markRead,
  parseCursor,
  readState,
  type StoredMessage,
  WorkspaceClosedError,
} from "./messages.ts";
import { hashIp, isAddressBlocked, isBlocked, noteVisitorAddress } from "./moderation.ts";
import type { VisitorPresence } from "./presence.ts";
import { type RateLimit, type Slots, tooManyRequests } from "./rate-limit.ts";
import { CLOSE_REASONS_TEXT, openLiveStream, type StreamOptions, streamLeaseMs } from "./stream.ts";
import { type WidgetWorkspace, widgetWorkspace } from "./workspaces.ts";

// Checked before the lookup, because Postgres rejects some bytes that a URL can decode to.
const PUBLIC_KEY = /^wk_[0-9a-f]{32}$/;
const CLIENT_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const params = z.object({ key: z.string().regex(PUBLIC_KEY) });

const createVisitorRoute = createRoute({
  method: "post",
  path: "/v1/widget/{key}/visitors",
  summary: "Create a signed-out visitor and its browser token",
  request: { params },
  responses: {
    201: {
      description: "The visitor. The token is shown only here.",
      content: {
        "application/json": {
          schema: z.object({ visitorId: z.string(), token: z.string() }).openapi("NewVisitor", {
            example: { visitorId: "0b6f1c6e-2f4a-4c1e-9a57-3f1b8f0e6d21", token: "vt_…" },
          }),
        },
      },
    },
    ...WIDGET_ERRORS,
    403: errorAnswer(
      "origin_not_allowed: the site may not use this workspace, or its widget is off. blocked: an operator blocked this address",
    ),
  },
});

const VisitorSchema = z
  .object({
    visitorId: z.string(),
    signedIn: z.boolean(),
    openConversation: z.boolean(),
    // The visitor has a conversation, open or closed. Only then does the widget report pages.
    chatted: z.boolean(),
    lastReadSeq: z.string(),
    unread: z.number(),
    // A stream from here reads only what follows the read position, as a closed panel needs.
    readCursor: z.string(),
  })
  .openapi("Visitor");

const markReadRoute = createRoute({
  method: "post",
  path: "/v1/widget/{key}/read",
  security: VISITOR_TOKEN,
  summary: "Move the visitor's read position forward",
  request: {
    params,
    body: {
      required: true,
      // 18 digits always fit a Postgres bigint.
      content: {
        "application/json": { schema: z.object({ seq: z.string().regex(/^\d{1,18}$/) }) },
      },
    },
  },
  responses: {
    200: {
      description: "The position moved, or it was already further along",
      content: okContent,
    },
    ...WIDGET_WRITE_ERRORS,
  },
});

const saveEmailRoute = createRoute({
  method: "patch",
  path: "/v1/widget/{key}/me",
  security: VISITOR_TOKEN,
  summary: "Save a signed-out visitor's email",
  request: {
    params,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ email: z.email().max(320) }) } },
    },
  },
  responses: {
    200: {
      description: "The visitor",
      content: { "application/json": { schema: VisitorSchema } },
    },
    ...WIDGET_WRITE_ERRORS,
    403: errorAnswer(
      "origin_not_allowed: the site may not use this workspace, or its widget is off. signed_in: the host site sets this visitor's email",
    ),
  },
});

const meRoute = createRoute({
  method: "get",
  path: "/v1/widget/{key}/me",
  security: VISITOR_TOKEN,
  summary: "Get the visitor that the bearer token identifies",
  request: { params },
  responses: {
    200: {
      description: "The visitor",
      content: {
        "application/json": {
          schema: VisitorSchema,
        },
      },
    },
    ...WIDGET_TOKEN_ERRORS,
  },
});

// The host page's address. Only its origin and path are kept, when a conversation starts.
const PAGE = z.string().max(4096).optional();

const pageRoute = createRoute({
  method: "post",
  path: "/v1/widget/{key}/page",
  security: VISITOR_TOKEN,
  summary: "Report the page the visitor is on, for operators",
  description:
    "The widget sends this when it loads and when the page's address changes, and only for a visitor who already has a token because they used the chat. The server stores something only for a visitor who has a conversation, and never creates a visitor here. It keeps the origin and path, never the query or hash, the title, when it came, and a short device line made from the User-Agent, which it does not keep. Each report adds a row to the visitor's page journey, unless it repeats the newest one, and a visitor keeps the newest 100.",
  request: {
    params,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            page: z.string().max(4096),
            // The document's title. The server keeps one line of 200 characters at most.
            title: z.string().max(2000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Noted", content: okContent },
    ...WIDGET_WRITE_ERRORS,
  },
});

/** The page's origin and path, or null unless it is on the site that sent the request. */
function startedPage(page: string | undefined, origin: string | undefined): string | null {
  if (page === undefined || origin === undefined || !URL.canParse(page)) return null;
  const url = new URL(page);
  if (url.origin !== origin) return null;
  return `${url.origin}${url.pathname}`.slice(0, 2048);
}

const MessageSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    // The position in commit order, as a string because it can exceed a JSON number.
    seq: z.string(),
    kind: z.enum(["text", "image"]),
    fromVisitor: z.boolean(),
    clientId: z.string().nullable(),
    body: z.string().nullable(),
    image: ImageSchema.nullable(),
    // The image was deleted after 12 months, on Dinghy Cloud.
    imageRemoved: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("Message", {
    example: {
      id: "8c2d7a51-6e0f-4b3a-9d18-5f7e2c4a1b90",
      conversationId: "5d0c1f7e-8a3b-4e52-b1f4-2c9e7a6d4b10",
      seq: "42",
      kind: "text",
      fromVisitor: true,
      clientId: "m_4f9a2c",
      body: "Do you have a yearly plan?",
      image: null,
      imageRemoved: false,
      createdAt: "2026-11-08T09:30:00.000Z",
    },
  });

/** A send's 403: the access check, or a block on this visitor. */
const SEND_REFUSED = {
  403: errorAnswer(
    "origin_not_allowed: the site may not use this workspace, or its widget is off. blocked: an operator blocked this visitor",
  ),
};

const sendMessageRoute = createRoute({
  method: "post",
  path: "/v1/widget/{key}/messages",
  security: VISITOR_TOKEN,
  summary: "Send a message. A retry with the same clientId returns the original",
  request: {
    params,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            clientId: CLIENT_ID,
            page: PAGE,
            // Postgres text cannot hold a NUL byte.
            body: z
              .string()
              .trim()
              .min(1)
              .max(10_000)
              .regex(/^[^\0]*$/),
          }),
          example: {
            clientId: "m_4f9a2c",
            page: "https://www.example.com/pricing",
            body: "Do you have a yearly plan?",
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "A retry. This is the original message",
      content: { "application/json": { schema: MessageSchema } },
    },
    201: {
      description: "The new message",
      content: { "application/json": { schema: MessageSchema } },
    },
    ...WIDGET_WRITE_ERRORS,
    ...BUSY,
    ...SEND_REFUSED,
  },
});

const sendImageRoute = createRoute({
  method: "post",
  path: "/v1/widget/{key}/images",
  security: VISITOR_TOKEN,
  summary:
    "Send an image as the raw request body. A retry with the same clientId returns the original",
  request: { params, query: z.object({ clientId: CLIENT_ID, page: PAGE }) },
  responses: {
    200: {
      description: "A retry. This is the original message",
      content: { "application/json": { schema: MessageSchema } },
    },
    201: {
      description: "The new message",
      content: { "application/json": { schema: MessageSchema } },
    },
    ...WIDGET_TOKEN_ERRORS,
    ...IMAGE_UPLOAD_ERRORS,
    ...SEND_REFUSED,
  },
});

const listMessagesRoute = createRoute({
  method: "get",
  path: "/v1/widget/{key}/messages",
  security: VISITOR_TOKEN,
  summary: "List the visitor's messages after a cursor, in commit order",
  request: {
    params,
    query: z.object({
      after: z.string().regex(CURSOR_PATTERN).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  },
  responses: {
    200: {
      description:
        "A page of messages. If resync is true, the cursor is from before a restore, so load from the start",
      content: {
        "application/json": {
          schema: z
            .object({
              messages: z.array(MessageSchema),
              cursor: z.string(),
              hasMore: z.boolean(),
              resync: z.boolean(),
            })
            .openapi("MessagePage"),
        },
      },
    },
    ...WIDGET_TOKEN_ERRORS,
    ...INVALID,
  },
});

const streamRoute = createRoute({
  method: "get",
  path: "/v1/widget/{key}/stream",
  security: VISITOR_TOKEN,
  summary: "Stream the visitor's messages after a cursor",
  description:
    "Server-sent events: `message` (its id is the new cursor, its data a Message), `ready` when caught up, `resync` to load from the start, and `close` with a reason. Read this with fetch, because EventSource cannot send the bearer token.\n\n" +
    CLOSE_REASONS_TEXT,
  request: {
    params,
    query: z.object({ after: z.string().regex(CURSOR_PATTERN).optional() }),
  },
  responses: {
    200: {
      description: "The event stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    ...WIDGET_TOKEN_ERRORS,
    ...INVALID,
    429: errorAnswer(
      "too_many_requests: over the rate limit. too_many_streams: the workspace has too many open streams. Retry after `retry-after`",
    ),
  },
});

function messageView(
  images: Images | undefined,
  workspaceId: string,
  // A visitor never learns which operator sent a reply, or that operator's ID.
  { seq, createdAt, clientId, image, authorOperatorId: _author, ...message }: StoredMessage,
) {
  return {
    ...message,
    // A visitor gets only its own client IDs, to match a stream copy to a pending line.
    clientId: message.fromVisitor ? clientId : null,
    seq: seq.toString(),
    createdAt: createdAt.toISOString(),
    image: imageView(images, workspaceId, image),
  };
}

const UNAUTHORIZED = failure("unauthorized", "The token is not valid.");

const ORIGIN_NOT_ALLOWED = failure("origin_not_allowed", "This site may not use this workspace.");

function forbidden() {
  return Response.json(ORIGIN_NOT_ALLOWED, { status: 403 });
}

/**
 * A chat link's page runs on this server's own origin, where a browser leaves Origin out of a GET.
 * Only a chat link's token gets in from there, so the rest of the widget API stays closed to it.
 */
const fromChatPage = (origin: string | undefined, ownOrigin: string | undefined, token: string) =>
  isChatLinkToken(token) &&
  ownOrigin !== undefined &&
  (origin === undefined || origin === ownOrigin);

/** Finds the workspace, checks the Origin header exactly, and answers CORS for the allowed site. */
function widgetAccess(db: Database, ownOrigin: string | undefined) {
  return createMiddleware<{ Variables: { workspace: WidgetWorkspace } }>(async (c, next) => {
    const key = c.req.param("key");
    const origin = c.req.header("origin");
    if (key === undefined || !PUBLIC_KEY.test(key)) return forbidden();
    if (fromChatPage(origin, ownOrigin, bearerToken(c.req.header("authorization")))) {
      const found = await widgetWorkspace(db, key);
      if (found === null) return forbidden();
      c.set("workspace", found);
      return next();
    }
    // A browser sends Origin on these requests. An unknown key gets the same answer as a bad site.
    if (origin === undefined || isChatLinkToken(bearerToken(c.req.header("authorization")))) {
      return forbidden();
    }
    const found = await widgetWorkspace(db, key);
    if (found === null || !found.allowedOrigins.includes(origin)) return forbidden();

    c.header("access-control-allow-origin", origin);
    c.header("access-control-expose-headers", "retry-after");
    c.header("vary", "origin");
    if (c.req.method === "OPTIONS") {
      c.header("access-control-allow-methods", "GET, POST, PATCH");
      c.header("access-control-allow-headers", "authorization, content-type");
      c.header("access-control-max-age", "600");
      return c.body(null, 204);
    }
    c.set("workspace", found);
    await next();
  });
}

/** Finds or updates a signed-in visitor. The first request for a user creates its row. */
async function signedInVisitor(
  db: Database,
  workspaceId: string,
  identity: HostIdentity,
): Promise<string> {
  // A token's iat can be fractional, as `Date.now() / 1000` makes it.
  const issuedAt = BigInt(Math.floor(identity.issuedAt));
  const context = {
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.name === undefined ? {} : { name: identity.name }),
    ...(identity.attributes === undefined ? {} : { attributes: identity.attributes }),
    identityIssuedAt: issuedAt,
  };
  const isThisUser = and(
    eq(visitor.workspaceId, workspaceId),
    eq(visitor.externalId, identity.externalId),
  );
  const columns = { id: visitor.id, identityIssuedAt: visitor.identityIssuedAt };
  return withWorkspace(db, workspaceId, async (tx) => {
    let [existing] = await tx.select(columns).from(visitor).where(isThisUser);
    if (existing === undefined) {
      const [created] = await tx
        .insert(visitor)
        .values({ workspaceId, externalId: identity.externalId, ...context })
        .onConflictDoNothing()
        .returning({ id: visitor.id });
      if (created !== undefined) return created.id;
      // Two first requests arrived together, and the other one created the row.
      [existing] = await tx.select(columns).from(visitor).where(isThisUser);
      if (existing === undefined) throw new Error("The visitor row is missing");
    }
    // Only a newer token updates this, or a request from an older tab would overwrite newer data.
    // The check is in the update too, because two requests can both pass the one above.
    if (issuedAt > (existing.identityIssuedAt ?? -1n)) {
      await tx
        .update(visitor)
        .set(context)
        .where(
          and(
            isThisUser,
            or(isNull(visitor.identityIssuedAt), lt(visitor.identityIssuedAt, issuedAt)),
          ),
        );
    }
    return existing.id;
  });
}

interface Identified {
  visitorId: string;
  signedIn: boolean;
  expiresAt?: Date;
  /** Came through a reply email's link, on this server's own page. */
  link?: true;
}

function bearerToken(authorization: string | undefined): string {
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
}

/**
 * The anonymous visitor that holds this browser token, or null. A token unused for a year has
 * expired. Each use renews it, with one write a day at most, unless `renew` is false.
 */
async function browserVisitor(
  db: Database,
  workspaceId: string,
  token: string,
  renew = true,
): Promise<string | null> {
  const tokenHash = sha256Hex(token);
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        id: visitor.id,
        stale: sql<boolean>`${visitor.tokenUsedAt} < now() - interval '1 day'`,
      })
      .from(visitor)
      .where(
        and(
          eq(visitor.workspaceId, workspaceId),
          eq(visitor.tokenHash, tokenHash),
          gt(visitor.tokenUsedAt, sql`now() - interval '1 year'`),
        ),
      );
    if (row === undefined) return null;
    if (renew && row.stale) {
      await tx
        .update(visitor)
        .set({ tokenUsedAt: sql`now()` })
        .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, row.id)));
    }
    return row.id;
  });
}

async function authenticate(
  db: Database,
  found: WidgetWorkspace,
  publicKey: string,
  authorization: string | undefined,
): Promise<Identified | null> {
  const token = bearerToken(authorization);
  if (token === "") return null;

  if (isBrowserToken(token)) {
    const visitorId = await browserVisitor(db, found.id, token);
    return visitorId === null ? null : { visitorId, signedIn: false };
  }

  if (isChatLinkToken(token)) {
    if (chatLinkWorkspace(token) !== found.id) return null;
    const link = await withWorkspace(db, found.id, (tx) => chatLinkVisitor(tx, found.id, token));
    return link === null ? null : { visitorId: link.visitorId, signedIn: false, link: true };
  }

  const identity = await verifyHostToken(token, found.signingSecret, publicKey);
  if (identity === null) return null;
  return {
    visitorId: await signedInVisitor(db, found.id, identity),
    signedIn: true,
    expiresAt: identity.expiresAt,
  };
}

/**
 * The visitor a token names, without creating one: a page report must not store a signed-in user
 * who never chatted. Undefined for a token that does not work, and null for no visitor yet.
 */
async function knownVisitor(
  db: Database,
  found: WidgetWorkspace,
  publicKey: string,
  authorization: string | undefined,
): Promise<string | null | undefined> {
  const token = bearerToken(authorization);
  if (token === "") return undefined;
  if (isBrowserToken(token)) return (await browserVisitor(db, found.id, token)) ?? undefined;
  const identity = await verifyHostToken(token, found.signingSecret, publicKey);
  if (identity === null) return undefined;
  const [row] = await withWorkspace(db, found.id, (tx) =>
    tx
      .select({ id: visitor.id })
      .from(visitor)
      .where(and(eq(visitor.workspaceId, found.id), eq(visitor.externalId, identity.externalId))),
  );
  return row?.id ?? null;
}

/**
 * A read-only check of a token that already identified this stream's visitor. It writes nothing,
 * or an older tab's token would overwrite newer user data on every wake.
 */
async function stillValid(
  db: Database,
  found: WidgetWorkspace,
  publicKey: string,
  authorization: string | undefined,
): Promise<boolean> {
  const token = bearerToken(authorization);
  if (isChatLinkToken(token)) {
    return (
      (await withWorkspace(db, found.id, (tx) => chatLinkVisitor(tx, found.id, token))) !== null
    );
  }
  if (!isBrowserToken(token)) {
    return (await verifyHostToken(token, found.signingSecret, publicKey)) !== null;
  }
  return (await browserVisitor(db, found.id, token, false)) !== null;
}

async function visitorView(db: Database, workspaceId: string, identified: Identified) {
  const { visitorId, signedIn } = identified;
  return withWorkspace(db, workspaceId, async (tx) => {
    // The open one first, if there is one.
    const [newest] = await tx
      .select({ status: conversation.status })
      .from(conversation)
      .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.visitorId, visitorId)))
      .orderBy(sql`${conversation.status} = 'open' desc`)
      .limit(1);
    const { lastReadSeq, unread } = await readState(tx, workspaceId, visitorId);
    const [current] = await tx
      .select({ generation: workspace.feedGeneration })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    return {
      visitorId,
      signedIn,
      openConversation: newest?.status === "open",
      chatted: newest !== undefined,
      lastReadSeq: lastReadSeq.toString(),
      unread,
      readCursor: formatCursor({ generation: current?.generation ?? 0, seq: lastReadSeq }),
    };
  });
}

const BLOCKED = failure("blocked", "You cannot send messages in this chat.");

// name, largest count and window in seconds. Each is per workspace and client address, so a busy
// office shares one count and another site's visitors never share it.
function limitFor(method: string, path: string): [string, number, number] {
  if (method === "GET") return ["widget-read", 600, 60];
  if (path.endsWith("/visitors")) return ["widget-visitors", 20, 3600];
  if (path.endsWith("/messages")) return ["widget-send", 60, 60];
  if (path.endsWith("/images")) return ["widget-image", 20, 60];
  // A single-page site reports each change of address, and a page should not need more.
  if (path.endsWith("/page")) return ["widget-page", 30, 60];
  return ["widget-write", 120, 60];
}

interface WidgetOptions {
  db: Database;
  images: Images | undefined;
  ipSecret: string;
  limits: Limits;
  live: Live;
  logger: Logger;
  rateLimit: RateLimit;
  /** Counts open streams per visitor and per address, on every install. */
  slots: Slots;
  stream: StreamOptions;
  /** Which visitors have a stream open, for the operator app. */
  visitorPresence: VisitorPresence;
  /** This server's own origin, where a chat link's page runs. */
  ownOrigin: string | undefined;
}

/** A person with several tabs open. */
const STREAMS_PER_VISITOR = 10;
/** An office behind one address. */
const STREAMS_PER_ADDRESS = 50;

const CLIENT_STREAM_LIMIT = failure(
  "too_many_streams",
  "Too many connections are open from this browser or network. Try again later.",
);

export function registerWidgetRoutes(
  app: App,
  {
    db,
    images,
    ipSecret,
    limits,
    live,
    logger,
    rateLimit,
    slots,
    stream,
    visitorPresence,
    ownOrigin,
  }: WidgetOptions,
): void {
  const view = (workspaceId: string, message: StoredMessage) =>
    messageView(images, workspaceId, message);

  /**
   * The visitor behind the request's token, or null, which each route answers with its own 401.
   * Not a middleware, because creating a visitor needs no token.
   */
  const identify = <P extends string, I extends Input>(c: Context<AppEnv, P, I>) =>
    authenticate(db, c.get("workspace"), c.req.param("key") ?? "", c.req.header("authorization"));

  app.use("/v1/widget/:key/*", widgetAccess(db, ownOrigin));
  // After the access check, so a refusal here also carries the CORS headers the browser needs.
  app.use("/v1/widget/:key/*", async (c, next) => {
    const [name, max, windowSeconds] = limitFor(c.req.method, c.req.path);
    const subject = `${c.get("workspace").id}|${c.get("clientIp")}`;
    const wait = await rateLimit.hit(name, subject, max, windowSeconds);
    return wait === null ? next() : tooManyRequests(c, wait);
  });

  app.openapi(createVisitorRoute, async (c) => {
    const { id: workspaceId } = c.get("workspace");
    const token = newBrowserToken();
    const ipHash = hashIp(ipSecret, workspaceId, c.get("clientIp"));
    const row = await withWorkspace(db, workspaceId, async (tx) => {
      // Someone blocked by address must not get a new identity by clearing their browser.
      if (await isAddressBlocked(tx, workspaceId, ipHash)) return "blocked" as const;
      const [created] = await tx
        .insert(visitor)
        .values({
          workspaceId,
          tokenHash: sha256Hex(token),
          lastIpHash: ipHash,
          device: deviceLine(c.req.header("user-agent")),
        })
        .returning({ id: visitor.id });
      return created;
    });
    if (row === "blocked") return c.json(BLOCKED, 403);
    if (row === undefined) throw new Error("The visitor insert returned no row");
    return c.json({ visitorId: row.id, token }, 201);
  });

  // The longest message is well under this, and it stops an oversized body before it is parsed.
  const smallBody = bodyLimit({ maxSize: 64 * 1024 });
  app.use("/v1/widget/:key/*", (c, next) =>
    c.req.path.endsWith("/images") ? next() : smallBody(c, next),
  );

  app.openapi(sendMessageRoute, async (c) => {
    const found = c.get("workspace");
    const identified = await identify(c);
    if (identified === null) return c.json(UNAUTHORIZED, 401);
    const ipHash = hashIp(ipSecret, found.id, c.get("clientIp"));
    const result = await catchClosed(
      withWorkspace(db, found.id, async (tx) => {
        if (await isBlocked(tx, found.id, identified, ipHash)) return null;
        await noteVisitorAddress(tx, found.id, identified.visitorId, ipHash);
        const { page, ...input } = c.req.valid("json");
        return appendMessage(
          tx,
          found.id,
          { kind: "visitor", visitorId: identified.visitorId },
          { ...input, page: identified.link ? null : startedPage(page, c.req.header("origin")) },
        );
      }),
    );
    // Closed since the check at the door: the same answer as an unknown key.
    if (result instanceof WorkspaceClosedError) return c.json(ORIGIN_NOT_ALLOWED, 403);
    if (result === null) return c.json(BLOCKED, 403);
    // After the commit. A lost signal only delays delivery, because a stream reads from Postgres.
    if (result.created) {
      wakeConversation(live, found.id, identified.visitorId);
    }
    return c.json(view(found.id, result.message), result.created ? 201 : 200);
  });

  app.openapi(streamRoute, async (c) => {
    const found = c.get("workspace");
    const { key } = c.req.valid("param");
    const authorization = c.req.header("authorization");
    const origin = c.req.header("origin") ?? "";
    const identified = await identify(c);
    if (identified === null) return c.json(UNAUTHORIZED, 401);
    const { after } = c.req.valid("query");
    const { visitorId, expiresAt } = identified;
    const lease = streamLeaseMs(stream);
    // One visitor or one address must not fill the workspace's places, or this instance's memory.
    const held: { release(): void }[] = [];
    const release = () => {
      for (const slot of held) slot.release();
    };
    const refuse = (refusal: typeof STREAM_LIMIT) => {
      release();
      c.header("retry-after", String(STREAM_RETRY_SECONDS));
      return c.json(refusal, 429);
    };
    const forVisitor = await slots.take(
      `dinghy:streams:widget-visitor:${visitorId}`,
      STREAMS_PER_VISITOR,
      lease,
    );
    if (forVisitor === null) return refuse(CLIENT_STREAM_LIMIT);
    held.push(forVisitor);
    const address = hashIp(ipSecret, found.id, c.get("clientIp"));
    const forAddress = await slots.take(
      `dinghy:streams:widget-address:${address}`,
      STREAMS_PER_ADDRESS,
      lease,
    );
    if (forAddress === null) return refuse(CLIENT_STREAM_LIMIT);
    held.push(forAddress);
    const inWorkspace = await limits.openStream(found.id, "widget", lease);
    if (inWorkspace === null) return refuse(STREAM_LIMIT);
    held.push(inWorkspace);
    held.push(visitorPresence.open(found.id, visitorId));
    // When the stream ends, so "last seen" reads the end of the visit, not its first page.
    held.push({
      release() {
        withWorkspace(db, found.id, (tx) =>
          tx
            .update(visitor)
            .set({ lastSeenAt: sql`now()` })
            .where(and(eq(visitor.workspaceId, found.id), eq(visitor.id, visitorId))),
        ).catch((err: unknown) => logger.warn({ err }, "could not note when a visitor left"));
      },
    });
    return openLiveStream(c, {
      live,
      release,
      logger,
      options: stream,
      workspaceId: found.id,
      subscriber: visitorId,
      expiresAt,
      after: after === undefined ? undefined : parseCursor(after),
      authorized: async () => {
        // Current data, so a changed origin list or signing secret ends the stream.
        const current = await widgetWorkspace(db, key);
        if (current === null) return false;
        if (!identified.link && !current.allowedOrigins.includes(origin)) return false;
        return stillValid(db, current, key, authorization);
      },
      read: async (position) => {
        const page = await withWorkspace(db, found.id, (tx) =>
          listVisitorMessages(tx, found.id, visitorId, position, 100),
        );
        return {
          ...page,
          items: page.messages.map((message) => ({
            event: "message",
            seq: message.seq,
            data: view(found.id, message),
          })),
        };
      },
    });
  });

  app.openapi(listMessagesRoute, async (c) => {
    const found = c.get("workspace");
    const identified = await identify(c);
    if (identified === null) return c.json(UNAUTHORIZED, 401);
    const { after, limit } = c.req.valid("query");
    const page = await withWorkspace(db, found.id, (tx) =>
      listVisitorMessages(
        tx,
        found.id,
        identified.visitorId,
        after === undefined ? undefined : parseCursor(after),
        limit,
      ),
    );
    return c.json(
      {
        messages: page.messages.map((message) => view(found.id, message)),
        cursor: formatCursor(page.cursor),
        hasMore: page.hasMore,
        resync: page.resync,
      },
      200,
    );
  });

  if (images !== undefined) {
    app.openapi(sendImageRoute, async (c) => {
      const found = c.get("workspace");
      const identified = await identify(c);
      if (identified === null) return c.json(UNAUTHORIZED, 401);
      const { clientId, page } = c.req.valid("query");
      const ipHash = hashIp(ipSecret, found.id, c.get("clientIp"));
      const blocked = await withWorkspace(db, found.id, async (tx) => {
        const refused = await isBlocked(tx, found.id, identified, ipHash);
        if (!refused) await noteVisitorAddress(tx, found.id, identified.visitorId, ipHash);
        return refused;
      });
      if (blocked) return c.json(BLOCKED, 403);
      const outcome = await catchClosed(
        images.receive(
          c.req.raw,
          found.id,
          (image) =>
            withWorkspace(db, found.id, (tx) =>
              appendMessage(
                tx,
                found.id,
                { kind: "visitor", visitorId: identified.visitorId },
                {
                  clientId,
                  image,
                  page: identified.link ? null : startedPage(page, c.req.header("origin")),
                },
                limits,
              ),
            ),
          c.get("clientIp"),
        ),
      );
      // Closed while the image arrived: the same answer as an unknown key.
      if (outcome instanceof WorkspaceClosedError) return c.json(ORIGIN_NOT_ALLOWED, 403);
      if ("refused" in outcome) return refuseImage(c, outcome.refused);
      if (outcome.result.created) {
        wakeConversation(live, found.id, identified.visitorId);
      }
      return c.json(view(found.id, outcome.result.message), outcome.result.created ? 201 : 200);
    });
  }

  app.openapi(markReadRoute, async (c) => {
    const found = c.get("workspace");
    const identified = await identify(c);
    if (identified === null) return c.json(UNAUTHORIZED, 401);
    const { seq } = c.req.valid("json");
    await withWorkspace(db, found.id, (tx) =>
      markRead(tx, found.id, identified.visitorId, BigInt(seq)),
    );
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(saveEmailRoute, async (c) => {
    const found = c.get("workspace");
    const identified = await identify(c);
    if (identified === null) return c.json(UNAUTHORIZED, 401);
    // A signed-in visitor's email comes from the host's signed token, not from the browser.
    if (identified.signedIn || identified.link) {
      return c.json(failure("signed_in", "The host site sets this visitor's email."), 403);
    }
    const { email } = c.req.valid("json");
    await withWorkspace(db, found.id, (tx) =>
      tx
        .update(visitor)
        .set({ email })
        .where(and(eq(visitor.workspaceId, found.id), eq(visitor.id, identified.visitorId))),
    );
    return c.json(await visitorView(db, found.id, identified), 200);
  });

  app.openapi(pageRoute, async (c) => {
    const found = c.get("workspace");
    const authorization = c.req.header("authorization");
    // A chat link's page is this server's, and its address holds the link's token.
    if (isChatLinkToken(bearerToken(authorization))) return c.json({ ok: true as const }, 200);
    const visitorId = await knownVisitor(db, found, c.req.param("key"), authorization);
    if (visitorId === undefined) return c.json(UNAUTHORIZED, 401);
    if (visitorId === null) return c.json({ ok: true as const }, 200);
    const { page, title } = c.req.valid("json");
    await withWorkspace(db, found.id, (tx) =>
      recordPage(tx, found.id, visitorId, {
        path: startedPage(page, c.req.header("origin")),
        title: pageTitle(title),
        device: deviceLine(c.req.header("user-agent")),
      }),
    );
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(meRoute, async (c) => {
    const found = c.get("workspace");
    const identified = await identify(c);
    if (identified === null) return c.json(UNAUTHORIZED, 401);
    return c.json(await visitorView(db, found.id, identified), 200);
  });
}
