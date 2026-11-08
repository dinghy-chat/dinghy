// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { createHmac } from "node:crypto";
import http from "node:http";

export const STRIPE_SECRET_KEY = "sk_test_fake_key_for_tests";
export const STRIPE_WEBHOOK_SECRET = "whsec_fake_secret_for_tests";
export const STRIPE_PRICE_ID = "price_fake_monthly";

interface FakeSession {
  id: string;
  url: string;
  params: URLSearchParams;
  /** Set once the session is paid, when it is no longer open. */
  paid?: boolean;
  /** Set once the session expires without a payment. */
  expired?: boolean;
}

interface FakeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_end: number;
  cancel_at_period_end?: boolean;
  metadata: Record<string, string>;
}

/** Signs a payload the way Stripe does, for the Stripe-Signature header. */
export function signStripePayload(
  payload: string,
  secret = STRIPE_WEBHOOK_SECRET,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

/**
 * The few Stripe API calls that billing makes, with idempotency keys, plus a page that stands in
 * for Checkout. It is a fake of Stripe, never of Postgres or Valkey.
 */
export async function startFakeStripe() {
  let next = 0;
  const customers: string[] = [];
  const sessions = new Map<string, FakeSession>();
  const subscriptions = new Map<string, FakeSubscription>();
  const replies = new Map<string, unknown>();
  const counts = { subscriptionFetches: 0, cancels: 0 };
  /** Billing portal sessions, by ID, with the customer and return URL they were made for. */
  const portals = new Map<string, URLSearchParams>();
  /** How many coming Checkout creates fail, with which status, as Stripe does at times. */
  /** `checkoutMade` creates fail after Stripe made the session, as when its answer is lost. */
  const failures = { checkout: 0, checkoutStatus: 500, checkoutMade: 0, cancel: 0, expire: 0 };
  /** Runs once, right after the next list of Checkout sessions, to land a payment between reads. */
  const hooks: {
    afterSessionList: (() => void) | null;
    /** Runs once, before the next Checkout create is handled, and holds it until it settles. */
    beforeCheckoutCreate: (() => Promise<void>) | null;
    /** Runs after each cancel and before its answer, as Stripe sends its webhook meanwhile. */
    afterCancel: ((subscription: FakeSubscription) => Promise<void>) | null;
  } = { afterSessionList: null, beforeCheckoutCreate: null, afterCancel: null };
  /** Customers deleted in the dashboard, which Stripe still answers for, as deleted. */
  const deletedCustomers = new Set<string>();
  let origin = "";

  const handle = (method: string, path: string, params: URLSearchParams): [number, unknown] => {
    const customerPath = /^\/v1\/customers\/([A-Za-z0-9_]+)$/.exec(path);
    if (method === "GET" && customerPath !== null) {
      const id = customerPath[1] ?? "";
      if (!customers.includes(id)) return [404, { error: { type: "invalid_request_error" } }];
      return [200, { id, ...(deletedCustomers.has(id) && { deleted: true }) }];
    }
    if (method === "POST" && path === "/v1/customers") {
      const id = `cus_${++next}`;
      customers.push(id);
      return [200, { id }];
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (failures.checkout > 0) {
        failures.checkout--;
        return [failures.checkoutStatus, { error: { type: "api_error" } }];
      }
      const id = `cs_${++next}`;
      const session = { id, url: `${origin}/pay/${id}`, params };
      sessions.set(id, session);
      if (failures.checkoutMade > 0) {
        failures.checkoutMade--;
        return [500, { error: { type: "api_error" } }];
      }
      return [200, { id, url: session.url }];
    }
    // Assume the worst for a deleted customer: Stripe refuses lists filtered by it.
    if (method === "GET" && deletedCustomers.has(params.get("customer") ?? "")) {
      return [404, { error: { type: "invalid_request_error" } }];
    }
    if (method === "GET" && path === "/v1/subscriptions") {
      const customer = params.get("customer");
      const data = [...subscriptions.values()].filter(
        (one) => one.customer === customer && one.status !== "canceled",
      );
      return [200, { data }];
    }
    if (method === "GET" && path === "/v1/checkout/sessions") {
      const customer = params.get("customer");
      // Newest first, as Stripe lists them.
      const data = [...sessions.values()]
        .reverse()
        .filter((one) => one.params.get("customer") === customer)
        .map((one) => ({
          id: one.id,
          url: one.url,
          metadata: Object.fromEntries(
            [...one.params]
              .filter(([key]) => key.startsWith("metadata["))
              .map(([key, value]) => [key.slice(9, -1), value]),
          ),
          status: one.paid ? "complete" : one.expired ? "expired" : "open",
        }))
        .filter((one) => !params.has("status") || one.status === params.get("status"))
        .slice(0, Number(params.get("limit") ?? 10));
      const after = hooks.afterSessionList;
      hooks.afterSessionList = null;
      after?.();
      return [200, { data }];
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      if (!customers.includes(params.get("customer") ?? "")) {
        return [400, { error: { type: "invalid_request_error" } }];
      }
      const id = `bps_${++next}`;
      portals.set(id, params);
      return [200, { id, url: `${origin}/portal/${id}` }];
    }
    const expiring = /^\/v1\/checkout\/sessions\/([A-Za-z0-9_]+)\/expire$/.exec(path);
    if (method === "POST" && expiring !== null) {
      if (failures.expire > 0) {
        failures.expire--;
        return [500, { error: { type: "api_error" } }];
      }
      const session = sessions.get(expiring[1] ?? "");
      // Stripe expires only an open session.
      if (session === undefined || session.paid || session.expired) {
        return [400, { error: { type: "invalid_request_error" } }];
      }
      session.expired = true;
      return [200, { id: session.id, status: "expired" }];
    }
    const found = /^\/v1\/subscriptions\/([A-Za-z0-9_]+)$/.exec(path);
    if (method === "DELETE" && found !== null) {
      if (failures.cancel > 0) {
        failures.cancel--;
        return [500, { error: { type: "api_error" } }];
      }
      const subscription = subscriptions.get(found[1] ?? "");
      if (subscription === undefined || subscription.status === "canceled") {
        return [404, { error: { type: "invalid_request_error" } }];
      }
      counts.cancels++;
      subscription.status = "canceled";
      return [200, subscription];
    }
    if (method === "GET" && found !== null) {
      counts.subscriptionFetches++;
      const subscription = subscriptions.get(found[1] ?? "");
      return subscription === undefined
        ? [404, { error: { type: "invalid_request_error" } }]
        : [200, subscription];
    }
    return [404, { error: { type: "invalid_request_error" } }];
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname.startsWith("/pay/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Fake Checkout</title><h1>Fake Checkout</h1>");
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/portal/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Fake portal</title><h1>Fake billing portal</h1>");
      return;
    }
    if (req.headers.authorization !== `Bearer ${STRIPE_SECRET_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" }).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    // A GET carries its parameters in the query, and a POST in its form body.
    const params =
      req.method === "GET"
        ? url.searchParams
        : new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const before = hooks.beforeCheckoutCreate;
      hooks.beforeCheckoutCreate = null;
      await before?.();
    }
    const key = req.headers["idempotency-key"];
    const cacheKey = typeof key === "string" ? `${req.method} ${url.pathname} ${key}` : null;
    let reply = cacheKey === null ? undefined : replies.get(cacheKey);
    if (reply === undefined) {
      reply = handle(req.method ?? "GET", url.pathname, params);
      // Stripe saves a 5xx under its key, but not a 4xx it rejected before running the request.
      const saved = (reply as [number, unknown])[0];
      if (cacheKey !== null && (saved < 400 || saved >= 500)) replies.set(cacheKey, reply);
      const [status, body] = reply as [number, unknown];
      if (req.method === "DELETE" && status === 200) {
        await hooks.afterCancel?.(body as FakeSubscription);
      }
    }
    const [status, body] = reply as [number, unknown];
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  return {
    apiBase: origin,
    customers,
    sessions,
    subscriptions,
    counts,
    portals,
    failures,
    hooks,
    /** Pays a session: Stripe makes a subscription with the session's metadata. */
    pay(sessionId: string, status = "active"): FakeSubscription {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new Error(`No session ${sessionId}`);
      session.paid = true;
      const id = `sub_${++next}`;
      const subscription = {
        id,
        customer: session.params.get("customer") ?? "",
        status,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
        metadata: { workspace_id: session.params.get("client_reference_id") ?? "" },
      };
      subscriptions.set(id, subscription);
      return subscription;
    },
    /** Deletes a customer, as someone can in Stripe's dashboard. */
    deleteCustomer(customerId: string) {
      deletedCustomers.add(customerId);
    },
    /** Expires an unpaid session, as Stripe does after 24 hours. */
    expire(sessionId: string) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new Error(`No session ${sessionId}`);
      session.expired = true;
    },
    /** A signed webhook body and header. */
    event(type: string, object: Record<string, unknown>, id = `evt_${++next}`) {
      const payload = JSON.stringify({ id, object: "event", type, data: { object } });
      return { id, payload, signature: signStripePayload(payload) };
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export type FakeStripe = Awaited<ReturnType<typeof startFakeStripe>>;
