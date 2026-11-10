import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createRoute, z } from "@hono/zod-openapi";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import {
  event,
  type MessageCreatedPayload,
  WEBHOOK_EVENTS,
  type WebhookEvent,
  webhook,
  webhookDelivery,
} from "./db/schema.ts";
import { type Database, enterWorkspace, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  MEMBER_ERRORS,
  NOT_FOUND,
  okContent,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import type { Images } from "./images.ts";
import { conversationView, messageView } from "./inbox.ts";
import { OPEN_WHILE_CLOSED } from "./member.ts";
import { authorNames, findConversation, findMessage } from "./messages.ts";
import { retryDelayMs } from "./retry.ts";
import { allowed } from "./team.ts";

/** At most this many webhooks per workspace. */
const WEBHOOK_LIMIT = 5;
/** One request may take this long, from the connection to the answer's status. */
const REQUEST_TIMEOUT_MS = 10_000;
/** The first retry waits 30 seconds, doubling to an hour: 30 attempts last about a day. */
export const WEBHOOK_MAX_ATTEMPTS = 30;
const DAY_MS = 24 * 60 * 60_000;
const DELIVERIES_SHOWN = 20;
const ERROR_MAX = 200;
/** The type of the event that "Send test" sends. It is never stored. */
const TEST_TYPE = "webhook.test";

/** Whether webhooks may go over http or to private addresses. Off unless the server's admin says. */
export interface WebhookPolicy {
  allowPrivate: boolean;
}
export const PUBLIC_ONLY: WebhookPolicy = { allowPrivate: false };

// Addresses a webhook must never reach on a server that does not allow private ones: this host,
// private networks, link-local ones such as cloud metadata at 169.254.169.254, and other special
// ranges. Every address a name resolves to is checked, at the moment of connecting. BlockList checks
// an IPv4-mapped IPv6 address, such as ::ffff:10.0.0.1, against the IPv4 rules.
const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv6");
}

/** True for an address a public webhook must not reach, and for anything that is not an address. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return PRIVATE_RANGES.check(address, family === 4 ? "ipv4" : "ipv6");
}

const REFUSED_ADDRESS = "The address is private, so this server does not send to it.";
const WRONG_SCHEME = "Use an https address.";

/** Why this address cannot take webhooks, from the address alone, or null. */
function endpointProblem(url: URL, policy: WebhookPolicy): string | null {
  if (url.protocol !== "https:" && !(policy.allowPrivate && url.protocol === "http:")) {
    return WRONG_SCHEME;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // A literal address connects without a lookup, so it is checked here.
  if (!policy.allowPrivate && isIP(host) !== 0 && isPrivateAddress(host)) return REFUSED_ADDRESS;
  return null;
}

/** Resolves a name the way a request would, and refuses it if any address it gives is private. */
function guardedLookup(policy: WebhookPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error !== null) return callback(error, []);
      const first = addresses[0];
      if (
        first === undefined ||
        (!policy.allowPrivate && addresses.some((one) => isPrivateAddress(one.address)))
      ) {
        return callback(Object.assign(new Error(REFUSED_ADDRESS), { code: "EPRIVATE" }), []);
      }
      if (options.all === true) return callback(null, addresses);
      callback(null, first.address, first.family);
    });
  };
}

/**
 * Why a new address cannot take webhooks, or null. It also resolves the name now, so a typo shows
 * at once. Each send checks again, because a name can point elsewhere later.
 */
async function checkEndpoint(url: string, policy: WebhookPolicy): Promise<string | null> {
  if (!URL.canParse(url)) return WRONG_SCHEME;
  const parsed = new URL(url);
  const problem = endpointProblem(parsed, policy);
  if (problem !== null || policy.allowPrivate) return problem;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return null;
  const resolved = await new Promise<LookupAddress[] | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    dnsLookup(host, { all: true }, (error, addresses) => {
      clearTimeout(timer);
      resolve(error === null ? addresses : null);
    });
  });
  // A name that does not resolve now may later. The send refuses it then if it is private.
  if (resolved === null) return null;
  return resolved.some((one) => isPrivateAddress(one.address)) ? REFUSED_ADDRESS : null;
}

/** `Dinghy-Signature`: the time, and the HMAC-SHA256 of "time.body" with the webhook's secret. */
export function signature(secret: string, timestamp: number, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

interface SendResult {
  /** The answer's HTTP status, or null when none came. */
  status: number | null;
  /** Why it did not reach a 2xx answer, or null when it did. */
  error: string | null;
}

/**
 * Sends one signed event. It follows no redirect, and it gives up after 10 seconds. Only the answer's
 * status is read.
 */
function sendWebhook(
  url: string,
  secret: string,
  eventId: string,
  body: string,
  policy: WebhookPolicy,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<SendResult> {
  const target = URL.canParse(url) ? new URL(url) : null;
  const problem = target === null ? WRONG_SCHEME : endpointProblem(target, policy);
  if (target === null || problem !== null) return Promise.resolve({ status: null, error: problem });
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const request = send(
      target,
      {
        method: "POST",
        lookup: guardedLookup(policy),
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          "user-agent": "Dinghy-Webhooks",
          "dinghy-event-id": eventId,
          "dinghy-signature": signature(secret, Math.floor(Date.now() / 1000), body),
        },
      },
      (response) => {
        const status = response.statusCode ?? null;
        response.destroy();
        const ok = status !== null && status >= 200 && status < 300;
        resolve({ status, error: ok ? null : `The answer was HTTP ${status}.` });
      },
    );
    request.on("error", (error: Error & { code?: unknown }) => {
      const reason =
        error.message === REFUSED_ADDRESS
          ? REFUSED_ADDRESS
          : error.name === "AbortError" || error.name === "TimeoutError"
            ? "No answer within 10 seconds."
            : `${typeof error.code === "string" ? `${error.code}: ` : ""}${error.message}`;
      resolve({ status: null, error: reason.slice(0, ERROR_MAX) });
    });
    request.end(body);
  });
}

/** The JSON body of one event, in the same shapes as the operator API. */
function webhookBody(
  eventId: string,
  type: string,
  createdAt: Date,
  workspaceId: string,
  data: Record<string, unknown>,
): string {
  return JSON.stringify({
    id: eventId,
    type,
    createdAt: createdAt.toISOString(),
    workspaceId,
    data,
  });
}

// Routes ------------------------------------------------------------------------------------------

const PREFIX = "/v1/operator/workspaces/{workspaceId}/webhooks";
const workspaceParams = z.object({ workspaceId: z.uuid() });
const webhookParams = workspaceParams.extend({ webhookId: z.uuid() });
const EventList = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);
const Url = z.string().trim().max(2000);

const Webhook = z
  .object({
    id: z.string(),
    url: z.string(),
    events: z.array(z.enum(WEBHOOK_EVENTS)),
    enabled: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("Webhook");
const WithSecret = Webhook.extend({ secret: z.string() });

const Delivery = z
  .object({
    id: z.string(),
    // The ID the receiver sees in `Dinghy-Event-Id`.
    eventId: z.string(),
    type: z.enum(WEBHOOK_EVENTS),
    status: z.enum(["pending", "sent", "failed"]),
    attempts: z.number().int(),
    lastStatus: z.number().int().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("WebhookDelivery");

const json = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
const answer = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});
const denied = { ...MEMBER_ERRORS, 403: errorAnswer("forbidden: this role may not do this") };
const BAD_ENDPOINT_ANSWER = {
  400: errorAnswer(
    "invalid_request: the request is not valid. bad_endpoint: the URL is not https, or it is a private address on a server that does not allow them",
  ),
};

const listRoute = createRoute({
  method: "get",
  path: PREFIX,
  security: SESSION,
  summary: "List the workspace's webhooks. Owners and admins only",
  request: { params: workspaceParams },
  responses: {
    200: answer("The webhooks", z.object({ webhooks: z.array(Webhook) })),
    ...denied,
  },
});

const createWebhookRoute = createRoute({
  method: "post",
  path: PREFIX,
  security: SESSION,
  summary: "Add a webhook. Its signing secret is shown only in this response",
  request: {
    params: workspaceParams,
    body: json(z.object({ url: Url, events: EventList, enabled: z.boolean().default(true) })),
  },
  responses: {
    201: answer("The webhook, with its signing secret", WithSecret),
    ...ROLE_WRITE_ERRORS,
    ...BAD_ENDPOINT_ANSWER,
    409: errorAnswer(`webhook_limit: the workspace has ${WEBHOOK_LIMIT} webhooks already`),
  },
});

const changeRoute = createRoute({
  method: "patch",
  path: `${PREFIX}/{webhookId}`,
  security: SESSION,
  summary: "Change a webhook's URL, events, or whether it is on",
  request: {
    params: webhookParams,
    body: json(
      z.object({
        url: Url.optional(),
        events: EventList.optional(),
        enabled: z.boolean().optional(),
      }),
    ),
  },
  responses: {
    200: answer("The webhook", Webhook),
    ...ROLE_WRITE_ERRORS,
    ...BAD_ENDPOINT_ANSWER,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  ...OPEN_WHILE_CLOSED,
  path: `${PREFIX}/{webhookId}`,
  security: SESSION,
  summary: "Delete a webhook and its deliveries",
  request: { params: webhookParams },
  responses: { 200: { description: "Deleted", content: okContent }, ...ROLE_WRITE_ERRORS },
});

const rotateRoute = createRoute({
  method: "post",
  path: `${PREFIX}/{webhookId}/rotate-secret`,
  security: SESSION,
  summary: "Replace a webhook's signing secret. The new one is shown only in this response",
  request: { params: webhookParams },
  responses: { 200: answer("The webhook, with its new secret", WithSecret), ...ROLE_WRITE_ERRORS },
});

const testRoute = createRoute({
  method: "post",
  path: `${PREFIX}/{webhookId}/test`,
  security: SESSION,
  summary: "Send a signed `webhook.test` event to the webhook now, and wait for its answer",
  request: { params: webhookParams },
  responses: {
    200: answer(
      "What the webhook answered",
      z.object({
        delivered: z.boolean(),
        status: z.number().int().nullable(),
        error: z.string().nullable(),
      }),
    ),
    ...ROLE_WRITE_ERRORS,
  },
});

const deliveriesRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{webhookId}/deliveries`,
  security: SESSION,
  summary: `A webhook's newest ${DELIVERIES_SHOWN} deliveries`,
  request: { params: webhookParams },
  responses: {
    200: answer("The deliveries, newest first", z.object({ deliveries: z.array(Delivery) })),
    ...denied,
  },
});

const BAD_ENDPOINT = (reason: string) => failure("bad_endpoint", reason);
const LIMIT = failure("webhook_limit", `A workspace can have ${WEBHOOK_LIMIT} webhooks.`);
const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

const webhookColumns = {
  id: webhook.id,
  url: webhook.url,
  events: webhook.events,
  enabled: webhook.enabled,
  createdAt: webhook.createdAt,
};
type WebhookRow = Pick<typeof webhook.$inferSelect, keyof typeof webhookColumns>;
const view = (row: WebhookRow) => ({ ...row, createdAt: row.createdAt.toISOString() });

export function registerWebhookRoutes(
  app: App,
  { db, logger, policy }: { db: Database; logger: Logger; policy: WebhookPolicy },
): void {
  const ofWebhook = (workspaceId: string, webhookId: string) =>
    and(eq(webhook.workspaceId, workspaceId), eq(webhook.id, webhookId));

  app.openapi(listRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const rows = await withWorkspace(db, id, (tx) =>
      tx
        .select(webhookColumns)
        .from(webhook)
        .where(eq(webhook.workspaceId, id))
        .orderBy(webhook.createdAt),
    );
    return c.json({ webhooks: rows.map(view) }, 200);
  });

  app.openapi(createWebhookRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { url, events, enabled } = c.req.valid("json");
    const problem = await checkEndpoint(url, policy);
    if (problem !== null) return c.json(BAD_ENDPOINT(problem), 400);
    const secret = newSecret();
    const created = await withWorkspace(db, id, async (tx) => {
      // Two adds at once take turns, so neither can pass the limit.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`webhooks:${id}`}))`);
      const [existing] = await tx
        .select({ n: count() })
        .from(webhook)
        .where(eq(webhook.workspaceId, id));
      if ((existing?.n ?? 0) >= WEBHOOK_LIMIT) return null;
      const [row] = await tx
        .insert(webhook)
        .values({ workspaceId: id, url, secret, events: [...new Set(events)], enabled })
        .returning(webhookColumns);
      return row ?? null;
    });
    if (created === null) return c.json(LIMIT, 409);
    audit(logger, "webhook.created", {
      workspaceId: id,
      operatorId: c.get("operatorId"),
      webhookId: created.id,
    });
    return c.json({ ...view(created), secret }, 201);
  });

  app.openapi(changeRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { webhookId } = c.req.valid("param");
    const { url, events, enabled } = c.req.valid("json");
    if (url !== undefined) {
      const problem = await checkEndpoint(url, policy);
      if (problem !== null) return c.json(BAD_ENDPOINT(problem), 400);
    }
    const change = {
      ...(url === undefined ? {} : { url }),
      ...(events === undefined ? {} : { events: [...new Set(events)] }),
      ...(enabled === undefined ? {} : { enabled }),
    };
    const [row] = await withWorkspace(db, id, (tx) =>
      Object.keys(change).length === 0
        ? tx.select(webhookColumns).from(webhook).where(ofWebhook(id, webhookId))
        : tx.update(webhook).set(change).where(ofWebhook(id, webhookId)).returning(webhookColumns),
    );
    if (row === undefined) return c.json(NOT_FOUND, 404);
    audit(logger, "webhook.changed", {
      workspaceId: id,
      operatorId: c.get("operatorId"),
      webhookId,
    });
    return c.json(view(row), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { webhookId } = c.req.valid("param");
    await withWorkspace(db, id, (tx) => tx.delete(webhook).where(ofWebhook(id, webhookId)));
    audit(logger, "webhook.deleted", {
      workspaceId: id,
      operatorId: c.get("operatorId"),
      webhookId,
    });
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(rotateRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { webhookId } = c.req.valid("param");
    const secret = newSecret();
    const [row] = await withWorkspace(db, id, (tx) =>
      tx.update(webhook).set({ secret }).where(ofWebhook(id, webhookId)).returning(webhookColumns),
    );
    if (row === undefined) return c.json(NOT_FOUND, 404);
    audit(logger, "webhook.secret_rotated", {
      workspaceId: id,
      operatorId: c.get("operatorId"),
      webhookId,
    });
    return c.json({ ...view(row), secret }, 200);
  });

  app.openapi(testRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { webhookId } = c.req.valid("param");
    const [row] = await withWorkspace(db, id, (tx) =>
      tx
        .select({ url: webhook.url, secret: webhook.secret })
        .from(webhook)
        .where(ofWebhook(id, webhookId)),
    );
    if (row === undefined) return c.json(NOT_FOUND, 404);
    const eventId = randomUUID();
    const body = webhookBody(eventId, TEST_TYPE, new Date(), id, {});
    const result = await sendWebhook(row.url, row.secret, eventId, body, policy);
    return c.json({ delivered: result.error === null, ...result }, 200);
  });

  app.openapi(deliveriesRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { webhookId } = c.req.valid("param");
    const rows = await withWorkspace(db, id, (tx) =>
      tx
        .select()
        .from(webhookDelivery)
        .where(and(eq(webhookDelivery.workspaceId, id), eq(webhookDelivery.webhookId, webhookId)))
        .orderBy(desc(webhookDelivery.createdAt))
        .limit(DELIVERIES_SHOWN),
    );
    return c.json(
      {
        deliveries: rows.map((row) => ({
          id: row.id,
          eventId: row.eventId,
          type: row.type,
          status: row.finishedAt === null ? ("pending" as const) : (row.outcome ?? "failed"),
          attempts: row.attempts,
          lastStatus: row.lastStatus,
          lastError: row.lastError,
          createdAt: row.createdAt.toISOString(),
          finishedAt: row.finishedAt?.toISOString() ?? null,
        })),
      },
      200,
    );
  });
}

// The worker's part -------------------------------------------------------------------------------

/** The webhook events one feed event makes: a first message also starts its conversation. */
function webhookTypes(kind: string, payload: unknown): WebhookEvent[] {
  if (kind === "message.created") {
    const created = (payload as MessageCreatedPayload).conversationCreated === true;
    return created ? ["conversation.created", "message.created"] : ["message.created"];
  }
  return WEBHOOK_EVENTS.some((one) => one === kind) ? [kind as WebhookEvent] : [];
}

/**
 * Creates the deliveries for one event, in one transaction with clearing its flag, so a crash here
 * repeats the whole step. Each event type gets one new ID, shared by every webhook and every retry.
 * Returns false with no work.
 */
export function fanOutWebhooksOne(db: Database): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({
        workspaceId: event.workspaceId,
        seq: event.seq,
        kind: event.kind,
        payload: event.payload,
        createdAt: event.createdAt,
      })
      .from(event)
      .where(eq(event.needsWebhook, true))
      .orderBy(event.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (found === undefined) return false;
    const { workspaceId, seq } = found;
    await enterWorkspace(tx, workspaceId);
    const payload = found.payload as { conversationId?: string; messageId?: string };
    const types = webhookTypes(found.kind, found.payload);
    const hooks = await tx
      .select({ id: webhook.id, events: webhook.events })
      .from(webhook)
      .where(and(eq(webhook.workspaceId, workspaceId), eq(webhook.enabled, true)));
    const rows: (typeof webhookDelivery.$inferInsert)[] = [];
    if (payload.conversationId !== undefined) {
      for (const type of types) {
        const eventId = randomUUID();
        for (const hook of hooks.filter((one) => one.events.includes(type))) {
          rows.push({
            workspaceId,
            webhookId: hook.id,
            eventId,
            type,
            conversationId: payload.conversationId,
            messageId: type === "message.created" ? (payload.messageId ?? null) : null,
            createdAt: found.createdAt,
          });
        }
      }
    }
    // A conversation or message deleted before this step has nothing to send.
    const live =
      rows.length === 0
        ? []
        : await liveRows(tx, workspaceId, payload.conversationId ?? "", payload.messageId, rows);
    if (live.length > 0) await tx.insert(webhookDelivery).values(live);
    await tx
      .update(event)
      .set({ needsWebhook: false })
      .where(and(eq(event.workspaceId, workspaceId), eq(event.seq, seq)));
    return true;
  });
}

/** Keeps the rows whose conversation and message still exist, so their foreign keys hold. */
async function liveRows(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  messageId: string | undefined,
  rows: (typeof webhookDelivery.$inferInsert)[],
) {
  if ((await findConversation(tx, workspaceId, conversationId)) === null) return [];
  if (messageId === undefined) return rows;
  const kept = await findMessage(tx, workspaceId, messageId);
  return kept === null ? rows.filter((row) => row.messageId === null) : rows;
}

interface ClaimedWebhook {
  workspaceId: string;
  id: string;
  attempts: number;
}

/** Claims due rows and commits, as alerts do, so no transaction stays open during a send. */
export async function claimWebhookDeliveries(
  db: Database,
  limit: number,
  claimMs: number,
): Promise<ClaimedWebhook[]> {
  const result = await db.execute<{ workspace_id: string; id: string; attempts: number }>(sql`
    WITH due AS MATERIALIZED (
      SELECT workspace_id, id FROM webhook_delivery
      WHERE finished_at IS NULL
        AND next_attempt_at <= now()
        AND (claimed_until IS NULL OR claimed_until < now())
      ORDER BY next_attempt_at, created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE webhook_delivery AS row
    SET attempts = row.attempts + 1,
        claimed_until = now() + ${claimMs}::float8 * interval '1 millisecond'
    FROM due
    WHERE row.workspace_id = due.workspace_id AND row.id = due.id
    RETURNING row.workspace_id, row.id, row.attempts`);
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    id: row.id,
    attempts: row.attempts,
  }));
}

// The attempts check means a worker that outlived its claim cannot change the next worker's row.
const held = (row: ClaimedWebhook) =>
  and(
    eq(webhookDelivery.workspaceId, row.workspaceId),
    eq(webhookDelivery.id, row.id),
    eq(webhookDelivery.attempts, row.attempts),
    isNull(webhookDelivery.finishedAt),
  );

/** What one claimed row sends: its URL, secret, ID and body, or a reason it sends nothing. */
async function planWebhook(
  db: Database,
  images: Images | undefined,
  row: ClaimedWebhook,
): Promise<
  { url: string; secret: string; eventId: string; body: string; createdAt: Date } | string
> {
  return withWorkspace(db, row.workspaceId, async (tx) => {
    const [delivery] = await tx
      .select({
        eventId: webhookDelivery.eventId,
        type: webhookDelivery.type,
        conversationId: webhookDelivery.conversationId,
        messageId: webhookDelivery.messageId,
        createdAt: webhookDelivery.createdAt,
        url: webhook.url,
        secret: webhook.secret,
        enabled: webhook.enabled,
      })
      .from(webhookDelivery)
      .innerJoin(
        webhook,
        and(
          eq(webhook.workspaceId, webhookDelivery.workspaceId),
          eq(webhook.id, webhookDelivery.webhookId),
        ),
      )
      .where(and(eq(webhookDelivery.workspaceId, row.workspaceId), eq(webhookDelivery.id, row.id)));
    if (delivery === undefined) return "The webhook was deleted.";
    if (!delivery.enabled) return "The webhook was turned off.";
    const found = await findConversation(tx, row.workspaceId, delivery.conversationId);
    if (found === null) return "The conversation was deleted.";
    const data: Record<string, unknown> = { conversation: conversationView(found, null) };
    if (delivery.messageId !== null) {
      const stored = await findMessage(tx, row.workspaceId, delivery.messageId);
      if (stored === null) return "The message was deleted.";
      const names = await authorNames(tx, row.workspaceId, [stored]);
      data.message = messageView(images, row.workspaceId, names, stored);
    }
    return {
      url: delivery.url,
      secret: delivery.secret,
      eventId: delivery.eventId,
      createdAt: delivery.createdAt,
      body: webhookBody(delivery.eventId, delivery.type, delivery.createdAt, row.workspaceId, data),
    };
  });
}

async function finishWebhook(
  db: Database,
  row: ClaimedWebhook,
  outcome: "sent" | "failed",
  result: SendResult,
): Promise<void> {
  await db
    .update(webhookDelivery)
    .set({
      outcome,
      finishedAt: new Date(),
      claimedUntil: null,
      lastStatus: result.status,
      lastError: result.error,
    })
    .where(held(row));
}

/**
 * Sends one claimed row. A 2xx answer finishes it. Anything else waits and tries again, doubling the
 * wait, for about a day. `stopping` gives the claim back, so the next worker sends at once.
 */
export async function deliverWebhook(
  db: Database,
  row: ClaimedWebhook,
  {
    images,
    policy,
    retryMs,
    stopping,
  }: { images: Images | undefined; policy: WebhookPolicy; retryMs: number; stopping: AbortSignal },
): Promise<void> {
  const plan = await planWebhook(db, images, row);
  if (typeof plan === "string") {
    await finishWebhook(db, row, "failed", { status: null, error: plan });
    return;
  }
  const result = await sendWebhook(plan.url, plan.secret, plan.eventId, plan.body, policy);
  if (result.error === null) {
    await finishWebhook(db, row, "sent", result);
    return;
  }
  if (stopping.aborted) {
    await db
      .update(webhookDelivery)
      .set({ claimedUntil: null, attempts: row.attempts - 1 })
      .where(held(row));
    return;
  }
  const wait = retryDelayMs(retryMs, row.attempts);
  const expired = Date.now() + wait - plan.createdAt.getTime() > DAY_MS;
  if (row.attempts >= WEBHOOK_MAX_ATTEMPTS || expired) {
    await finishWebhook(db, row, "failed", result);
    return;
  }
  await db
    .update(webhookDelivery)
    .set({
      claimedUntil: null,
      nextAttemptAt: new Date(Date.now() + wait),
      lastStatus: result.status,
      lastError: result.error,
    })
    .where(held(row));
}

/** Gives up on a row whose earlier claims ended in crashes. */
export async function abandonWebhook(db: Database, row: ClaimedWebhook): Promise<void> {
  await finishWebhook(db, row, "failed", {
    status: null,
    error: "The worker stopped while sending.",
  });
}
