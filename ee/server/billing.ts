// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import type { App } from "../../apps/server/src/app.ts";
import type { Auth } from "../../apps/server/src/auth.ts";
import type { Config } from "../../apps/server/src/config.ts";
import { stripeEvent, subscription, workspace } from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { errorAnswer, failure } from "../../apps/server/src/errors.ts";
import { noLive, OPERATORS, type Signals } from "../../apps/server/src/live.ts";
import { OPEN_WHILE_CLOSED, OPEN_WHILE_UNPAID } from "../../apps/server/src/member.ts";
import { recordBillingChange } from "../../apps/server/src/messages.ts";
import { type RateLimit, tooManyRequests } from "../../apps/server/src/rate-limit.ts";
import { billingEmails, billingState, ENDED, FAILING, PAID, queueEmails } from "./lifecycle.ts";

interface BillingKeys {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  apiBase: string;
}

export interface BillingOptions extends BillingKeys {
  /** Tests hold or fail a webhook here, after its Stripe fetch and before its commit. */
  beforeCommit?: () => Promise<void>;
  /** The clock for lifecycle times, which tests control. */
  now?: () => Date;
}

/** The cloud plan's Stripe keys, or none on a self-hosted install. */
export function billingFromConfig(config: Config): BillingKeys | undefined {
  const {
    STRIPE_SECRET_KEY: secretKey,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_PRICE_ID: priceId,
  } = config;
  if (secretKey === undefined && webhookSecret === undefined && priceId === undefined) {
    return undefined;
  }
  if (secretKey === undefined || webhookSecret === undefined || priceId === undefined) {
    throw new Error("Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID together.");
  }
  return { secretKey, webhookSecret, priceId, apiBase: config.STRIPE_API_BASE };
}

/** How old a signed webhook may be, so a captured one cannot be replayed later. */
const TOLERANCE_SECONDS = 5 * 60;
const STRIPE_TIMEOUT_MS = 10_000;
const MAX_APPLY_ATTEMPTS = 5;

const FORBIDDEN = failure("forbidden", "Only the owner can pay for this workspace.");
const ALREADY_ACTIVE = failure("already_active", "This workspace is already paid for.");
const PAYMENT_PENDING = failure(
  "payment_pending",
  "A payment for this workspace is in progress. It opens once Stripe confirms it.",
);
const NO_CUSTOMER = failure("no_customer", "This workspace has no billing account yet.");
const RETRY_LATER = failure(
  "checkout_retry_later",
  "Stripe did not answer the last try. Try again in a few minutes.",
);
const WORKSPACE_DELETED = failure("workspace_deleted", "This workspace was deleted.");
/** How long after a failed create the attempt moves on, if no session tagged with it turned up. */
const CHECKOUT_FAILURE_WAIT_MS = 10 * 60_000;

const checkoutRoute = createRoute({
  method: "post",
  ...OPEN_WHILE_UNPAID,
  path: "/v1/operator/workspaces/{workspaceId}/checkout",
  summary: "Start Stripe Checkout for a workspace that waits for payment",
  request: { params: z.object({ workspaceId: z.uuid() }) },
  responses: {
    200: {
      description: "The Checkout page",
      content: { "application/json": { schema: z.object({ url: z.string() }) } },
    },
    403: errorAnswer("Not the owner"),
    409: errorAnswer("Already paid for, or a payment is in progress"),
    410: errorAnswer("The workspace was deleted"),
    429: errorAnswer("Too many attempts"),
    503: errorAnswer("Stripe failed a moment ago. Try again later."),
  },
});

const portalRoute = createRoute({
  method: "post",
  ...OPEN_WHILE_CLOSED,
  path: "/v1/operator/workspaces/{workspaceId}/billing-portal",
  summary: "Open Stripe's billing portal for a workspace",
  request: { params: z.object({ workspaceId: z.uuid() }) },
  responses: {
    200: {
      description: "The portal page",
      content: { "application/json": { schema: z.object({ url: z.string() }) } },
    },
    403: errorAnswer("Not the owner"),
    409: errorAnswer("The workspace has no billing account yet"),
    429: errorAnswer("Too many attempts"),
  },
});

const billingStateRoute = createRoute({
  method: "get",
  path: "/v1/operator/workspaces/{workspaceId}/billing",
  summary: "Get a workspace's billing state",
  request: { params: z.object({ workspaceId: z.uuid() }) },
  responses: {
    200: {
      description: "The state, and the date that goes with it",
      content: {
        "application/json": {
          schema: z
            .object({
              state: z.enum(["pending", "active", "ending", "payment_failed", "read_only"]),
              // Renews, ends, becomes read-only or is deleted on this date, by state.
              date: z.string().nullable(),
              // How the owner pays again: a new Checkout, or Stripe's portal for a live subscription.
              payWith: z.enum(["checkout", "portal"]),
            })
            .openapi("BillingState"),
        },
      },
    },
    403: errorAnswer("Not the owner"),
  },
});

const STRIPE_ID = /^[A-Za-z0-9_]{1,255}$/;

const webhookEvent = z.object({
  id: z.string().regex(STRIPE_ID),
  type: z.string(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
const checkoutObject = z.object({
  client_reference_id: z.uuid(),
  subscription: z.string().regex(STRIPE_ID),
});
const subscriptionObject = z.object({
  id: z.string().regex(STRIPE_ID),
  metadata: z.object({ workspace_id: z.uuid() }),
});
/** A Stripe list, of which only the IDs and URLs matter here. */
const stripeList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      status: z.string().optional(),
      url: z.string().nullish(),
      metadata: z.record(z.string(), z.string()).nullish(),
    }),
  ),
});

const stripeSubscription = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  // Newer API versions keep the period on each item.
  current_period_end: z.number().optional(),
  cancel_at_period_end: z.boolean().optional(),
  // With flexible billing, which Managed Payments uses, the portal cancels by setting this date.
  cancel_at: z.number().nullish(),
  items: z
    .object({ data: z.array(z.object({ current_period_end: z.number().optional() })) })
    .optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
type StripeSubscription = z.infer<typeof stripeSubscription>;

/** Checks Stripe's signature over the exact bytes it sent. */
export function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (header === undefined) return false;
  const parts = header.split(",").map((part) => part.split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();
  return parts
    .filter(([key, value]) => key === "v1" && value !== undefined && /^[0-9a-f]{64}$/.test(value))
    .some(([, value]) => timingSafeEqual(Buffer.from(value ?? "", "hex"), expected));
}

/** Stripe answered with an error status. A timeout or a lost connection is a plain Error. */
class StripeError extends Error {
  readonly status: number;
  constructor(status: number, method: string, path: string) {
    super(`Stripe answered ${status} to ${method} ${path.split("?")[0]}`);
    this.status = status;
  }
}

/** Stripe's API, through fetch and form encoding. Errors name the status, never the key. */
function stripeApi({ secretKey, apiBase }: BillingKeys) {
  return async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<unknown> => {
    const response = await fetch(new URL(path, apiBase), {
      method,
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(params === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      ...(params === undefined ? {} : { body: new URLSearchParams(params).toString() }),
    });
    if (!response.ok) throw new StripeError(response.status, method, path);
    return response.json();
  };
}

/**
 * Billing's calls to Stripe and its writes, shared by the routes and the worker. `signals` wakes
 * the open operator apps after a change to a workspace's billing state, in the web process and in
 * the worker alike.
 */
export function createBilling(
  billing: BillingOptions,
  db: Database,
  logger: Logger,
  signals: Signals = noLive,
) {
  const stripe = stripeApi(billing);
  const now = billing.now ?? (() => new Date());
  /** Wakes the workspace's open operator apps, after a billing change and its event commit. */
  function changed(workspaceId: string): void {
    signals.wake(workspaceId, OPERATORS);
  }

  async function fetchSubscription(subscriptionId: string): Promise<StripeSubscription> {
    return stripeSubscription.parse(
      await stripe("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`),
    );
  }

  /** Cancels at once, with no refund. The key makes a retried cancel the same request. */
  function cancelSubscription(id: string): Promise<unknown> {
    return stripe(
      "DELETE",
      `/v1/subscriptions/${encodeURIComponent(id)}`,
      undefined,
      `dinghy-cancel-${id}`,
    );
  }

  /** A customer's subscriptions, without the canceled ones, as Stripe lists them. */
  async function listSubscriptions(customerId: string) {
    return stripeList.parse(
      await stripe("GET", `/v1/subscriptions?customer=${encodeURIComponent(customerId)}&limit=10`),
    ).data;
  }

  /**
   * Expires every open Checkout of the customer, so nobody can pay for a workspace that is gone,
   * then cancels every subscription that could still charge, at once and with no refund. The
   * expiry comes first, so a session paid in between leaves a subscription that the list finds.
   */
  async function cancelAll(customerId: string): Promise<void> {
    if (await customerGone(customerId)) return;
    await expireOpen(customerId);
    for (const one of await listSubscriptions(customerId)) {
      if (ENDED.has(one.status ?? "")) continue;
      await cancelSubscription(one.id);
    }
  }

  /**
   * Whether Stripe says the customer was deleted. Deleting a customer cancels its subscriptions, so
   * nothing can charge it again. A 404 is not enough: other keys cannot see a customer that still
   * exists, and its open Checkout could still be paid.
   */
  async function customerGone(customerId: string): Promise<boolean> {
    const found = z
      .object({ deleted: z.boolean().optional() })
      .parse(await stripe("GET", `/v1/customers/${encodeURIComponent(customerId)}`));
    return found.deleted === true;
  }

  /** Expires every open Checkout of the customer. */
  async function expireOpen(customerId: string): Promise<void> {
    const open = stripeList.parse(
      await stripe(
        "GET",
        `/v1/checkout/sessions?customer=${encodeURIComponent(customerId)}&status=open&limit=100`,
      ),
    ).data;
    for (const session of open) {
      await stripe("POST", `/v1/checkout/sessions/${encodeURIComponent(session.id)}/expire`, {});
    }
  }

  /**
   * Treats the event as a hint. It reads the revision, fetches the current state from Stripe, then
   * commits the event ID and the state together only if the revision has not moved. A slow handler
   * then cannot overwrite newer state, and no network call holds a transaction open. With no event
   * ID, it only copies Stripe's state, as the worker does before a deletion.
   */
  async function apply(eventId: string | null, workspaceId: string, subscriptionId: string) {
    for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt++) {
      const seen = await withWorkspace(db, workspaceId, async (tx) => {
        const [done] =
          eventId === null
            ? []
            : await tx
                .select({ id: stripeEvent.eventId })
                .from(stripeEvent)
                .where(
                  and(eq(stripeEvent.workspaceId, workspaceId), eq(stripeEvent.eventId, eventId)),
                );
        const [found] = await tx
          .select({ deletedAt: workspace.deletedAt })
          .from(workspace)
          .where(eq(workspace.id, workspaceId));
        const [row] = await tx
          .select({
            revision: subscription.revision,
            subscriptionId: subscription.stripeSubscriptionId,
          })
          .from(subscription)
          .where(eq(subscription.workspaceId, workspaceId));
        return {
          done: done !== undefined || found === undefined,
          deleted: found?.deletedAt != null,
          revision: row?.revision ?? null,
          subscriptionId: row?.subscriptionId ?? null,
        };
      });
      // Applied already, or no such workspace here.
      if (seen.done) return;
      const current = await fetchSubscription(subscriptionId);
      // A signed event names the workspace, and Stripe's own record must agree.
      if (current.metadata?.workspace_id !== workspaceId) {
        logger.warn({ workspaceId }, "a Stripe subscription names another workspace");
        return;
      }
      if (seen.deleted) {
        // A Checkout paid as the workspace was deleted. Nothing may charge for it.
        if (!ENDED.has(current.status)) {
          logger.warn({ workspaceId }, "a deleted workspace's new subscription was canceled");
          await cancelSubscription(current.id);
        }
        return;
      }
      // A late event about an old subscription must not end the one that replaced it.
      const stale =
        seen.subscriptionId !== null &&
        seen.subscriptionId !== current.id &&
        ENDED.has(current.status);
      await billing.beforeCommit?.();
      const periodEnd = current.current_period_end ?? current.items?.data[0]?.current_period_end;
      const at = now();
      const state = {
        stripeCustomerId: current.customer,
        stripeSubscriptionId: current.id,
        status: current.status,
        currentPeriodEnd: periodEnd === undefined ? null : new Date(periodEnd * 1000),
        cancelAtPeriodEnd: (current.cancel_at_period_end ?? false) || current.cancel_at != null,
        // A payment ends a failure and a read-only time. A repeated failure keeps the first time.
        ...(PAID.has(current.status)
          ? {
              paidAt: sql`coalesce(${subscription.paidAt}, ${at.toISOString()}::timestamptz)`,
              paymentFailedAt: null,
              readOnlyAt: null,
            }
          : FAILING.has(current.status)
            ? {
                paymentFailedAt: sql`coalesce(${subscription.paymentFailedAt}, ${at.toISOString()}::timestamptz)`,
              }
            : {}),
      };
      const committed = await withWorkspace(db, workspaceId, async (tx) => {
        if (eventId !== null) {
          const [fresh] = await tx
            .insert(stripeEvent)
            .values({ workspaceId, eventId })
            .onConflictDoNothing()
            .returning({ id: stripeEvent.eventId });
          // Another delivery of this event committed first.
          if (fresh === undefined) return "skipped";
        }
        if (stale) return "skipped";
        // Under the row's lock, so the emails below compare with the state this write replaces,
        // including a read-only time the worker set without moving the revision.
        const [before] = await tx
          .select({
            paidAt: subscription.paidAt,
            paymentFailedAt: subscription.paymentFailedAt,
            readOnlyAt: subscription.readOnlyAt,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            currentPeriodEnd: subscription.currentPeriodEnd,
          })
          .from(subscription)
          .where(eq(subscription.workspaceId, workspaceId))
          .for("update");
        const written =
          seen.revision === null
            ? await tx
                .insert(subscription)
                .values({
                  workspaceId,
                  ...state,
                  paidAt: PAID.has(current.status) ? at : null,
                  paymentFailedAt: FAILING.has(current.status) ? at : null,
                  readOnlyAt: null,
                  revision: 1,
                })
                .onConflictDoNothing()
                .returning({ revision: subscription.revision })
            : await tx
                .update(subscription)
                .set({ ...state, revision: sql`${subscription.revision} + 1` })
                .where(
                  and(
                    eq(subscription.workspaceId, workspaceId),
                    eq(subscription.revision, seen.revision),
                  ),
                )
                .returning({ revision: subscription.revision });
        if (written.length === 0) tx.rollback();
        await queueEmails(
          tx,
          workspaceId,
          billingEmails(before, { ...state, status: current.status }, at),
        );
        if (PAID.has(current.status)) {
          await tx
            .update(workspace)
            .set({ active: true, waitingSince: null })
            .where(and(eq(workspace.id, workspaceId), eq(workspace.active, false)));
        }
        // In the same commit, so an inbox that misses the signal still finds it from its cursor.
        await recordBillingChange(tx, workspaceId);
        return "written";
      }).catch((error: unknown) => {
        if (error instanceof TransactionRollbackError) return false;
        throw error;
      });
      if (committed === "written") changed(workspaceId);
      if (committed !== false) return;
    }
    // Stripe retries a failed delivery, and the state will have settled by then.
    throw new Error("The subscription kept changing while a webhook applied it");
  }

  return { stripe, now, listSubscriptions, cancelAll, customerGone, apply, changed };
}

export type Billing = ReturnType<typeof createBilling>;

interface BillingRouteOptions {
  auth: Auth;
  billing: BillingOptions;
  client: Billing;
  db: Database;
  rateLimit: RateLimit;
}

/** Checkout, the billing state and the webhook. Call this only with billing on. */
export function registerBillingRoutes(
  app: App,
  { auth, billing, client, db, rateLimit }: BillingRouteOptions,
) {
  const publicUrl = String(auth.options.baseURL);
  const { stripe, apply } = client;

  app.openapi(checkoutRoute, async (c) => {
    if (c.get("memberRole") !== "owner") return c.json(FORBIDDEN, 403);
    const wait = await rateLimit.hit("checkout", c.get("operatorId"), 10, 60);
    if (wait !== null) return tooManyRequests(c, wait);
    const id = c.get("memberWorkspaceId");
    const readWorkspace = async () => {
      const [row] = await withWorkspace(db, id, (tx) =>
        tx
          .select({
            name: workspace.name,
            active: workspace.active,
            deletedAt: workspace.deletedAt,
            customerId: subscription.stripeCustomerId,
            readOnlyAt: subscription.readOnlyAt,
            status: subscription.status,
          })
          .from(workspace)
          .leftJoin(subscription, eq(subscription.workspaceId, workspace.id))
          .where(eq(workspace.id, id)),
      );
      return row?.deletedAt === null ? row : undefined;
    };
    const current = await readWorkspace();
    if (current === undefined) return c.json(WORKSPACE_DELETED, 410);
    // A read-only workspace can pay again, and so can one whose subscription ended before the
    // worker made it read-only. The checks below still stop a second live subscription.
    const ended =
      current.readOnlyAt !== null || (current.status !== null && ENDED.has(current.status));
    if (current.active && !ended) return c.json(ALREADY_ACTIVE, 409);

    // One customer per workspace, so every Checkout for it reuses the same one.
    if (current.customerId === null) {
      const customer = z.object({ id: z.string().regex(STRIPE_ID) }).parse(
        await stripe(
          "POST",
          "/v1/customers",
          {
            name: current.name,
            email: c.get("operatorEmail"),
            "metadata[workspace_id]": id,
          },
          `dinghy-customer-${id}`,
        ),
      );
      await withWorkspace(db, id, (tx) =>
        tx
          .insert(subscription)
          .values({ workspaceId: id, stripeCustomerId: customer.id })
          .onConflictDoNothing(),
      );
    }
    const [stored] = await withWorkspace(db, id, (tx) =>
      tx
        .select({
          customerId: subscription.stripeCustomerId,
          attempt: subscription.checkoutAttempt,
          failedAt: subscription.checkoutFailedAt,
        })
        .from(subscription)
        .where(eq(subscription.workspaceId, id)),
    );
    if (stored === undefined) throw new Error("A workspace's billing row is missing");

    let attempt = stored.attempt;
    let lastSession = "first";
    if (current.customerId !== null) {
      // A Checkout from another tab, or a paid one whose webhook is late, must not lead to a
      // second subscription. Stripe is the record here, because the webhook may not have come.
      // Sessions are read before subscriptions: Stripe makes the subscription before it marks the
      // session complete, so a payment that lands between the two reads is still caught.
      const customer = encodeURIComponent(current.customerId);
      const newest = stripeList.parse(
        await stripe("GET", `/v1/checkout/sessions?customer=${customer}&limit=1`),
      ).data[0];
      const subscriptions = stripeList.parse(
        await stripe("GET", `/v1/subscriptions?customer=${customer}&limit=10`),
      );
      if (subscriptions.data.some((one) => !ENDED.has(one.status ?? ""))) {
        return c.json(PAYMENT_PENDING, 409);
      }
      if (stored.failedAt !== null) {
        // A create under this attempt got a 5xx, and Stripe may have made its session anyway. A
        // new key now could make a second one, so the attempt moves on only once that session
        // turns up, or once the failure is old enough that no create under it is still running.
        // Every create under one attempt carries its tag, and a create runs only when the newest
        // session is not open. So only an open newest session with this tag is the failed one.
        const madeAnyway =
          newest?.status === "open" && newest.metadata?.dinghy_attempt === String(attempt);
        const waited = client.now().getTime() - stored.failedAt.getTime();
        if (!madeAnyway && waited < CHECKOUT_FAILURE_WAIT_MS) {
          c.header("retry-after", String(Math.ceil((CHECKOUT_FAILURE_WAIT_MS - waited) / 1000)));
          return c.json(RETRY_LATER, 503);
        }
        // Requests at the same moment all move to the same next attempt, so they still share a key.
        await withWorkspace(db, id, (tx) =>
          tx
            .update(subscription)
            .set({ checkoutAttempt: attempt + 1, checkoutFailedAt: null })
            .where(
              and(eq(subscription.workspaceId, id), eq(subscription.checkoutAttempt, attempt)),
            ),
        );
        attempt += 1;
      }
      if (newest?.status === "open" && newest.url) return c.json({ url: newest.url }, 200);
      lastSession = newest?.id ?? "first";
    }

    const back = publicUrl.replace(/\/$/, "");
    // Requests at the same moment see the same newest session and attempt, so they share a key and
    // Stripe makes one session. An expired session changes the key. Stripe keeps a 5xx under its
    // key, so after a 5xx the attempt moves on, as above. A timeout, a 409 for a create still
    // running, or a 4xx that Stripe did not save keeps the key, because the first create may still
    // finish under it.
    const created = await stripe(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "subscription",
        customer: stored.customerId,
        client_reference_id: id,
        "line_items[0][price]": billing.priceId,
        "line_items[0][quantity]": "1",
        // Stripe sells as the merchant of record, and so collects and files the sales tax and VAT.
        "managed_payments[enabled]": "true",
        "metadata[workspace_id]": id,
        "metadata[dinghy_attempt]": String(attempt),
        "subscription_data[metadata][workspace_id]": id,
        success_url: `${back}/billing/return?workspace=${id}`,
        cancel_url: `${back}/?workspace=${id}`,
      },
      `dinghy-checkout-${id}-${lastSession}-${attempt}`,
    ).catch(async (error: unknown) => {
      if (error instanceof StripeError && error.status >= 500) {
        await withWorkspace(db, id, (tx) =>
          tx
            .update(subscription)
            .set({ checkoutFailedAt: client.now() })
            .where(
              and(eq(subscription.workspaceId, id), eq(subscription.checkoutAttempt, attempt)),
            ),
        );
      }
      throw error;
    });
    const session = z.object({ id: z.string().regex(STRIPE_ID), url: z.url() }).parse(created);
    // The owner may have deleted the workspace while the create ran, after its billing was
    // cleared. Nobody may pay for it then.
    if ((await readWorkspace()) === undefined) {
      await stripe("POST", `/v1/checkout/sessions/${encodeURIComponent(session.id)}/expire`, {});
      return c.json(WORKSPACE_DELETED, 410);
    }
    return c.json({ url: session.url }, 200);
  });

  const billingRow = (id: string) =>
    withWorkspace(db, id, async (tx) => {
      const [row] = await tx
        .select({ active: workspace.active, subscription })
        .from(workspace)
        .leftJoin(subscription, eq(subscription.workspaceId, workspace.id))
        .where(eq(workspace.id, id));
      return row;
    });

  app.openapi(billingStateRoute, async (c) => {
    if (c.get("memberRole") !== "owner") return c.json(FORBIDDEN, 403);
    const row = await billingRow(c.get("memberWorkspaceId"));
    if (row === undefined) throw new Error("A member's workspace is missing");
    return c.json(billingState(row.active, row.subscription, client.now()), 200);
  });

  app.openapi(portalRoute, async (c) => {
    if (c.get("memberRole") !== "owner") return c.json(FORBIDDEN, 403);
    const wait = await rateLimit.hit("billing-portal", c.get("operatorId"), 10, 60);
    if (wait !== null) return tooManyRequests(c, wait);
    const id = c.get("memberWorkspaceId");
    const customerId = (await billingRow(id))?.subscription?.stripeCustomerId;
    if (customerId === undefined) return c.json(NO_CUSTOMER, 409);
    const session = z.object({ url: z.url() }).parse(
      await stripe("POST", "/v1/billing_portal/sessions", {
        customer: customerId,
        return_url: `${publicUrl.replace(/\/$/, "")}/?workspace=${id}`,
      }),
    );
    return c.json({ url: session.url }, 200);
  });

  app.post("/v1/stripe/webhook", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    // The exact bytes, because the signature covers them and a parsed body would not match.
    const payload = await c.req.text();
    if (!verifyStripeSignature(payload, c.req.header("stripe-signature"), billing.webhookSecret)) {
      return c.json(failure("bad_signature", "The signature does not match."), 400);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(payload);
    } catch {
      return c.json(failure("invalid_request", "The request is not valid."), 400);
    }
    const event = webhookEvent.safeParse(parsedJson);
    if (!event.success) return c.json(failure("invalid_request", "The request is not valid."), 400);
    const { id, type, data } = event.data;
    let target: { workspaceId: string; subscriptionId: string } | null = null;
    if (type === "checkout.session.completed") {
      const object = checkoutObject.safeParse(data.object);
      if (object.success) {
        target = {
          workspaceId: object.data.client_reference_id,
          subscriptionId: object.data.subscription,
        };
      }
    } else if (type.startsWith("customer.subscription.")) {
      const object = subscriptionObject.safeParse(data.object);
      if (object.success) {
        target = { workspaceId: object.data.metadata.workspace_id, subscriptionId: object.data.id };
      }
    }
    // Stripe stops retrying an event that gets a 2xx, and these hold nothing for Dinghy.
    if (target !== null) await apply(id, target.workspaceId, target.subscriptionId);
    return c.json({ received: true }, 200);
  });
}
