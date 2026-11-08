// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { type App, createApp } from "../../apps/server/src/app.ts";
import { createAuth } from "../../apps/server/src/auth.ts";
import { loadConfig } from "../../apps/server/src/config.ts";
import { stripeEvent, subscription, workspace } from "../../apps/server/src/db/schema.ts";
import type { Database } from "../../apps/server/src/db/tenant.ts";
import { createWorkspace, widgetWorkspace } from "../../apps/server/src/workspaces.ts";
import { createTestDatabase, type TestDatabase } from "../../apps/server/test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../../apps/server/test/env.ts";
import {
  addOperator,
  cookieOf,
  TEST_PASSWORD as PASSWORD,
} from "../../apps/server/test/operators.ts";
import { billingFromConfig, verifyStripeSignature } from "./billing.ts";
import {
  type FakeStripe,
  STRIPE_PRICE_ID,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  signStripePayload,
  startFakeStripe,
} from "./test/fake-stripe.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let valkey: Redis;
let stripe: FakeStripe;
let app: App;
let auth: ReturnType<typeof createAuth>;
let directory: string;
/** Runs after a webhook's Stripe fetch and before its commit. */
let beforeCommit: (() => Promise<void>) | undefined;
/** How far billing's clock runs ahead of the real one. Tests move it. */
let ahead = 0;

// A fresh address for each run, so the per-address limits never carry over between runs.
const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const IP = ip();

const request = (
  server: App,
  method: string,
  path: string,
  { cookie, body, from = IP }: { cookie?: string; body?: unknown; from?: string } = {},
) =>
  server.request(path, {
    method,
    headers: {
      origin: ORIGIN,
      "x-forwarded-for": from,
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Cloud signup's two steps. With a wrong password, the second step does not run. */
async function signup(email = `owner-${randomUUID()}@example.com`, password = PASSWORD) {
  const account = await request(app, "POST", "/v1/signup", { body: { email, password } });
  const cookie = cookieOf(account);
  if (account.status !== 200) return { response: account, email, workspaceId: "", cookie };
  const response = await request(app, "POST", "/v1/operator/workspaces", {
    cookie,
    body: { name: "Owner", workspaceName: "Acme" },
  });
  const body = (await response.json()) as { workspaceId: string };
  return { response, email, workspaceId: body.workspaceId, cookie };
}

/** Signs in a new agent of this workspace, who is a member but not its owner. */
async function agentCookie(workspaceId: string) {
  const { email } = await addOperator({
    auth,
    owner,
    email: `agent-${randomUUID()}@example.com`,
    workspaceId,
    role: "agent",
  });
  const signedIn = await request(app, "POST", "/v1/auth/sign-in/email", {
    body: { email, password: PASSWORD },
  });
  return cookieOf(signedIn);
}

const sessionIdOf = (body: unknown) => (body as { url: string }).url.split("/").at(-1) ?? "";

const checkout = (workspaceId: string, cookie: string) =>
  request(app, "POST", `/v1/operator/workspaces/${workspaceId}/checkout`, { cookie });

/** Signs up, opens Checkout and pays, which leaves the webhook still to come. */
async function paidSignup(status = "active") {
  const created = await signup();
  const response = await checkout(created.workspaceId, created.cookie);
  const { url } = (await response.json()) as { url: string };
  const sessionId = url.split("/").at(-1) ?? "";
  return { ...created, sessionId, paid: stripe.pay(sessionId, status) };
}

const deliver = (event: { payload: string; signature: string }) =>
  app.request("/v1/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": event.signature },
    body: event.payload,
  });

const completed = (workspaceId: string, subscriptionId: string, id?: string) =>
  stripe.event(
    "checkout.session.completed",
    { object: "checkout.session", client_reference_id: workspaceId, subscription: subscriptionId },
    id,
  );

const updated = (workspaceId: string, subscriptionId: string, status: string) =>
  stripe.event("customer.subscription.updated", {
    id: subscriptionId,
    object: "subscription",
    status,
    metadata: { workspace_id: workspaceId },
  });

async function isActive(workspaceId: string) {
  const [row] = await owner
    .select({ active: workspace.active })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  return row?.active;
}

async function billingRow(workspaceId: string) {
  const [row] = await owner
    .select()
    .from(subscription)
    .where(eq(subscription.workspaceId, workspaceId));
  return row;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 20).db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  stripe = await startFakeStripe();
  directory = await mkdtemp(join(tmpdir(), "dinghy-billing-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Dinghy</title>");
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger });
  app = createApp({
    auth,
    cloud: {
      billing: {
        secretKey: STRIPE_SECRET_KEY,
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        priceId: STRIPE_PRICE_ID,
        apiBase: stripe.apiBase,
        beforeCommit: () => beforeCommit?.() ?? Promise.resolve(),
        now: () => new Date(Date.now() + ahead),
      },
    },
    db,
    logger,
    valkey,
    trustedProxyHops: 1,
    limitScale: 100,
    operatorDirectory: directory,
    checks: { postgres: ok, valkey: ok },
  });
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await stripe.stop();
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

beforeEach(() => {
  beforeCommit = undefined;
  ahead = 0;
});

describe("signup", () => {
  test("creates a signed-in owner of an inactive workspace", async () => {
    const created = await signup();
    expect(created.response.status).toBe(200);
    expect(created.cookie).toContain("better-auth.session_token=");
    const me = await request(app, "GET", "/v1/operator/me", { cookie: created.cookie });
    expect(await me.json()).toMatchObject({
      email: created.email,
      billing: true,
      workspaces: [
        { workspaceId: created.workspaceId, role: "owner", name: "Acme", active: false },
      ],
    });
  });

  test("a known email with the wrong password gets no session and no workspace", async () => {
    const first = await signup();
    const before = await owner.select().from(workspace);
    const again = await signup(first.email, "another-long-password");
    expect(again.response.status).toBe(409);
    expect(again.response.headers.getSetCookie()).toEqual([]);
    expect(await owner.select().from(workspace)).toHaveLength(before.length);
  });

  test("a known email with its own password signs in and adds a workspace", async () => {
    const first = await signup();
    const again = await signup(first.email);
    expect(again.response.status).toBe(200);
    expect(again.workspaceId).not.toBe(first.workspaceId);
    const me = await request(app, "GET", "/v1/operator/me", { cookie: again.cookie });
    const body = (await me.json()) as { workspaces: unknown[] };
    expect(body.workspaces).toHaveLength(2);
  });

  test("another site cannot sign a browser up", async () => {
    const response = await app.request("/v1/signup", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ email: `x-${randomUUID()}@example.com`, password: PASSWORD }),
    });
    expect(response.status).toBe(403);
  });

  test("a short password is refused, as sign-in's rule says", async () => {
    const response = await request(app, "POST", "/v1/signup", {
      body: { email: `x-${randomUUID()}@example.com`, password: "short" },
    });
    expect(response.status).toBe(400);
  });

  test("is limited per address", async () => {
    const strict = createApp({
      auth,
      cloud: {
        billing: {
          secretKey: STRIPE_SECRET_KEY,
          webhookSecret: STRIPE_WEBHOOK_SECRET,
          priceId: STRIPE_PRICE_ID,
          apiBase: stripe.apiBase,
        },
      },
      db,
      logger,
      valkey,
      trustedProxyHops: 1,
      checks: { postgres: ok, valkey: ok },
    });
    const from = ip();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await request(strict, "POST", "/v1/signup", {
        from,
        body: { email: "not-an-email", password: PASSWORD },
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("before payment", () => {
  test("no workspace is active before payment, including after an abandoned Checkout", async () => {
    const created = await signup();
    expect(await isActive(created.workspaceId)).toBe(false);

    const response = await checkout(created.workspaceId, created.cookie);
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const session = stripe.sessions.get(url.split("/").at(-1) ?? "");
    expect(session?.params.get("mode")).toBe("subscription");
    expect(session?.params.get("client_reference_id")).toBe(created.workspaceId);
    expect(session?.params.get("line_items[0][price]")).toBe(STRIPE_PRICE_ID);
    expect(session?.params.get("subscription_data[metadata][workspace_id]")).toBe(
      created.workspaceId,
    );
    expect(session?.params.get("success_url")).toBe(
      `${ORIGIN}/billing/return?workspace=${created.workspaceId}`,
    );

    // The visitor closes Checkout, and Stripe later says the session expired.
    const expired = stripe.event("checkout.session.expired", {
      object: "checkout.session",
      client_reference_id: created.workspaceId,
      subscription: null,
    });
    expect((await deliver(expired)).status).toBe(200);
    expect(await isActive(created.workspaceId)).toBe(false);

    // The widget treats the key as unknown, and the inbox asks for payment.
    const [row] = await owner
      .select({ publicKey: workspace.publicKey })
      .from(workspace)
      .where(eq(workspace.id, created.workspaceId));
    expect(await widgetWorkspace(db, row?.publicKey ?? "")).toBeNull();
    const inbox = await request(
      app,
      "GET",
      `/v1/operator/workspaces/${created.workspaceId}/conversations?status=open`,
      { cookie: created.cookie },
    );
    expect(inbox.status).toBe(402);
    expect(await inbox.json()).toMatchObject({ error: { code: "payment_required" } });
    const settings = await request(
      app,
      "GET",
      `/v1/operator/workspaces/${created.workspaceId}/settings`,
      { cookie: created.cookie },
    );
    expect(settings.status).toBe(402);
  });

  test("the widget's routes answer as for an unknown key", async () => {
    const created = await signup();
    const [row] = await owner
      .select({ publicKey: workspace.publicKey })
      .from(workspace)
      .where(eq(workspace.id, created.workspaceId));
    await owner
      .update(workspace)
      .set({ allowedOrigins: ["https://site.example"] })
      .where(eq(workspace.id, created.workspaceId));
    const unknown = await app.request("/v1/widget/wk_00000000000000000000000000000000/visitors", {
      method: "POST",
      headers: { origin: "https://site.example" },
    });
    const pending = await app.request(`/v1/widget/${row?.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: "https://site.example" },
    });
    expect(pending.status).toBe(unknown.status);
    expect(await pending.json()).toEqual(await unknown.json());
  });

  test("only the owner can open Checkout", async () => {
    const created = await signup();
    expect(
      (await checkout(created.workspaceId, await agentCookie(created.workspaceId))).status,
    ).toBe(403);
  });

  test("another workspace's owner cannot open this one's Checkout", async () => {
    const mine = await signup();
    const theirs = await signup();
    expect((await checkout(theirs.workspaceId, mine.cookie)).status).toBe(404);
  });

  test("a double-clicked Checkout creates one subscription", async () => {
    const created = await signup();
    const customersBefore = stripe.customers.length;
    const sessionsBefore = stripe.sessions.size;
    const [first, second] = await Promise.all([
      checkout(created.workspaceId, created.cookie),
      checkout(created.workspaceId, created.cookie),
    ]);
    const urls = await Promise.all([first.json(), second.json()]);
    expect(urls[0]).toEqual(urls[1]);
    expect(stripe.sessions.size - sessionsBefore).toBe(1);
    expect(stripe.customers.length - customersBefore).toBe(1);
    // A later click reuses the stored customer.
    await checkout(created.workspaceId, created.cookie);
    expect(stripe.customers.length - customersBefore).toBe(1);

    const sessionId = String((urls[0] as { url: string }).url.split("/").at(-1));
    const paid = stripe.pay(sessionId);
    expect((await deliver(completed(created.workspaceId, paid.id))).status).toBe(200);
    const subscriptions = [...stripe.subscriptions.values()].filter(
      (one) => one.metadata.workspace_id === created.workspaceId,
    );
    expect(subscriptions).toHaveLength(1);
    expect((await billingRow(created.workspaceId))?.stripeSubscriptionId).toBe(paid.id);
    // Paid, so a new Checkout is refused.
    expect((await checkout(created.workspaceId, created.cookie)).status).toBe(409);
  });

  test("a second tab or a late webhook cannot lead to a second subscription", async () => {
    const created = await signup();
    const first = (await (await checkout(created.workspaceId, created.cookie)).json()) as {
      url: string;
    };
    // Minutes later, from another tab: the open session comes back, not a new one.
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
    const sessionsBefore = stripe.sessions.size;
    const second = (await (await checkout(created.workspaceId, created.cookie)).json()) as {
      url: string;
    };
    later.mockRestore();
    expect(second.url).toBe(first.url);
    expect(stripe.sessions.size).toBe(sessionsBefore);

    // Paid on Stripe, but the webhook has not come: the workspace still waits, and a new
    // Checkout is refused instead of charging twice.
    stripe.pay(String(first.url.split("/").at(-1)));
    expect(await isActive(created.workspaceId)).toBe(false);
    const again = await checkout(created.workspaceId, created.cookie);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      "payment_pending",
    );
  });

  test("after the first session expires, paying again opens a new session", async () => {
    const created = await signup();
    const first = (await (await checkout(created.workspaceId, created.cookie)).json()) as {
      url: string;
    };
    stripe.expire(String(first.url.split("/").at(-1)));
    const second = (await (await checkout(created.workspaceId, created.cookie)).json()) as {
      url: string;
    };
    expect(second.url).not.toBe(first.url);
    expect(stripe.sessions.get(String(second.url.split("/").at(-1)))?.expired).toBeUndefined();
  });

  test("a payment that lands between Stripe's two reads is refused, not charged twice", async () => {
    const created = await signup();
    const first = (await (await checkout(created.workspaceId, created.cookie)).json()) as {
      url: string;
    };
    // The other tab pays right after this request reads the sessions.
    stripe.hooks.afterSessionList = () => stripe.pay(String(first.url.split("/").at(-1)));
    const sessionsBefore = stripe.sessions.size;
    const second = await checkout(created.workspaceId, created.cookie);
    expect(second.status).toBe(409);
    expect(stripe.sessions.size).toBe(sessionsBefore);
  });

  test("after a 5xx, a retry waits rather than make a session under a new key", async () => {
    const created = await signup();
    const sessionsBefore = stripe.sessions.size;
    stripe.failures.checkout = 1;
    expect((await checkout(created.workspaceId, created.cookie)).status).toBe(500);
    expect(await billingRow(created.workspaceId)).toMatchObject({ checkoutAttempt: 0 });
    expect((await billingRow(created.workspaceId))?.checkoutFailedAt).not.toBeNull();

    // Stripe may still make the failed create's session, so a new key now could make a second.
    const soon = await checkout(created.workspaceId, created.cookie);
    expect(soon.status).toBe(503);
    expect(await soon.json()).toMatchObject({ error: { code: "checkout_retry_later" } });
    expect(Number(soon.headers.get("retry-after"))).toBeGreaterThan(0);
    ahead = 9 * 60_000;
    expect((await checkout(created.workspaceId, created.cookie)).status).toBe(503);
    expect(stripe.sessions.size).toBe(sessionsBefore);

    // Ten minutes on, and no session tagged with the attempt: the next create gets a new key.
    ahead = 10 * 60_000;
    const retry = await checkout(created.workspaceId, created.cookie);
    expect(retry.status).toBe(200);
    expect(stripe.sessions.size - sessionsBefore).toBe(1);
    const made = stripe.sessions.get(sessionIdOf(await retry.json()));
    expect(made?.params.get("metadata[dinghy_attempt]")).toBe("1");
    expect(await billingRow(created.workspaceId)).toMatchObject({
      checkoutAttempt: 1,
      checkoutFailedAt: null,
    });
  });

  test("after a 5xx, an older session with the same attempt does not count as the failed one", async () => {
    const created = await signup();
    const first = sessionIdOf(await (await checkout(created.workspaceId, created.cookie)).json());
    // The owner abandons the first Checkout. It expires, still tagged with attempt 0.
    stripe.expire(first);
    const sessionsBefore = stripe.sessions.size;
    stripe.failures.checkout = 1;
    expect((await checkout(created.workspaceId, created.cookie)).status).toBe(500);
    const soon = await checkout(created.workspaceId, created.cookie);
    expect(soon.status).toBe(503);
    expect(stripe.sessions.size).toBe(sessionsBefore);
    expect(await billingRow(created.workspaceId)).toMatchObject({ checkoutAttempt: 0 });
  });

  test("a 5xx whose create did make a session is found and reused, not made twice", async () => {
    const created = await signup();
    const sessionsBefore = stripe.sessions.size;
    stripe.failures.checkoutMade = 1;
    expect((await checkout(created.workspaceId, created.cookie)).status).toBe(500);
    expect(stripe.sessions.size - sessionsBefore).toBe(1);
    const [made] = [...stripe.sessions.values()].slice(-1);
    expect(made?.params.get("metadata[dinghy_attempt]")).toBe("0");

    const retry = await checkout(created.workspaceId, created.cookie);
    expect(retry.status).toBe(200);
    expect(sessionIdOf(await retry.json())).toBe(made?.id);
    expect(stripe.sessions.size - sessionsBefore).toBe(1);
    expect(await billingRow(created.workspaceId)).toMatchObject({ checkoutFailedAt: null });
  });

  test("a Checkout create with an unknown outcome keeps its key, so it cannot make a second session", async () => {
    const created = await signup();
    // A 409 means the same key's create is still running, so the next try must reuse that key.
    stripe.failures.checkout = 1;
    stripe.failures.checkoutStatus = 409;
    try {
      expect((await checkout(created.workspaceId, created.cookie)).status).toBeGreaterThanOrEqual(
        500,
      );
    } finally {
      stripe.failures.checkoutStatus = 500;
    }
    expect(await billingRow(created.workspaceId)).toMatchObject({
      checkoutAttempt: 0,
      checkoutFailedAt: null,
    });
    const retry = await checkout(created.workspaceId, created.cookie);
    expect(retry.status).toBe(200);
  });

  test("a Checkout made while the workspace is deleted is expired, and the owner gets 410", async () => {
    const created = await signup();
    // The owner's delete commits while this request's create is at Stripe.
    stripe.hooks.beforeCheckoutCreate = async () => {
      await owner
        .update(workspace)
        .set({ deletedAt: new Date() })
        .where(eq(workspace.id, created.workspaceId));
    };
    const sessionsBefore = stripe.sessions.size;
    const response = await checkout(created.workspaceId, created.cookie);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "workspace_deleted" } });
    expect(stripe.sessions.size - sessionsBefore).toBe(1);
    const [made] = [...stripe.sessions.values()].slice(-1);
    expect(made?.expired).toBe(true);
  });

  test("two Checkouts at once share one session, whatever the clock says between them", async () => {
    const created = await signup();
    // One second before a 10-minute boundary, which the old key's clock part used.
    const boundary = Math.ceil(Date.now() / 600_000) * 600_000;
    let now = boundary - 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sessionsBefore = stripe.sessions.size;
    try {
      let second: ReturnType<typeof checkout> | undefined;
      // The first request has sent its create. The clock crosses the boundary, and the second
      // request reads the same Stripe state and sends its own create before the first is handled.
      stripe.hooks.beforeCheckoutCreate = async () => {
        now = boundary + 1000;
        second = checkout(created.workspaceId, created.cookie);
        await new Promise((resolve) => setTimeout(resolve, 200));
      };
      const first = await checkout(created.workspaceId, created.cookie);
      const answers = [await first.json(), await (await second)?.json()];
      expect(answers[0]).toEqual(answers[1]);
      expect(stripe.sessions.size - sessionsBefore).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("the webhook", () => {
  test("a correctly signed event passes through the real raw-body path, and a forged one fails", async () => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/v1/stripe/webhook`;
    const post = (payload: string, signature: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body: payload,
      });
    try {
      const { workspaceId, paid } = await paidSignup();
      // Spacing that a parse and re-encode would change, so only the raw bytes verify.
      const payload = JSON.stringify(
        {
          id: `evt_${randomUUID().replaceAll("-", "")}`,
          type: "checkout.session.completed",
          data: { object: { client_reference_id: workspaceId, subscription: paid.id } },
        },
        null,
        3,
      );
      const forged = await post(payload, signStripePayload(payload, "whsec_someone_else"));
      expect(forged.status).toBe(400);
      const changed = await post(
        payload.replace("completed", "completed "),
        signStripePayload(payload),
      );
      expect(changed.status).toBe(400);
      const stale = await post(
        payload,
        signStripePayload(payload, STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 301),
      );
      expect(stale.status).toBe(400);
      expect((await post(payload, "")).status).toBe(400);
      expect(await isActive(workspaceId)).toBe(false);

      const signed = await post(payload, signStripePayload(payload));
      expect(signed.status).toBe(200);
      expect(await isActive(workspaceId)).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("the signature check accepts any of several v1 signatures and nothing malformed", () => {
    const payload = '{"id":"evt_1"}';
    const good = signStripePayload(payload);
    const time = good.split(",")[0];
    expect(
      verifyStripeSignature(
        payload,
        `${time},v1=${"0".repeat(64)},${good.split(",")[1]}`,
        STRIPE_WEBHOOK_SECRET,
      ),
    ).toBe(true);
    expect(verifyStripeSignature(payload, `${time},v1=abc`, STRIPE_WEBHOOK_SECRET)).toBe(false);
    expect(verifyStripeSignature(payload, "v1=nothing", STRIPE_WEBHOOK_SECRET)).toBe(false);
    expect(verifyStripeSignature(payload, undefined, STRIPE_WEBHOOK_SECRET)).toBe(false);
  });

  test("concurrent duplicate webhooks apply once", async () => {
    const { workspaceId, paid } = await paidSignup();
    const event = completed(workspaceId, paid.id);
    const responses = await Promise.all(Array.from({ length: 6 }, () => deliver(event)));
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200));
    expect(await isActive(workspaceId)).toBe(true);
    const events = await owner
      .select()
      .from(stripeEvent)
      .where(eq(stripeEvent.workspaceId, workspaceId));
    expect(events.map((row) => row.eventId)).toEqual([event.id]);
    expect((await billingRow(workspaceId))?.revision).toBe(1);
    // A later redelivery changes nothing.
    expect((await deliver(event)).status).toBe(200);
    expect((await billingRow(workspaceId))?.revision).toBe(1);
  });

  test("events arriving out of order give the correct state", async () => {
    const { workspaceId, paid } = await paidSignup("incomplete");
    const older = updated(workspaceId, paid.id, "incomplete");
    const first = completed(workspaceId, paid.id);
    // Stripe moved on to active, and the newest event arrives first.
    paid.status = "active";
    const newer = updated(workspaceId, paid.id, "active");
    expect((await deliver(newer)).status).toBe(200);
    expect((await deliver(older)).status).toBe(200);
    expect((await deliver(first)).status).toBe(200);
    expect(await isActive(workspaceId)).toBe(true);
    expect(await billingRow(workspaceId)).toMatchObject({
      status: "active",
      stripeSubscriptionId: paid.id,
      revision: 3,
    });

    // The lifecycle decides what a failed payment does, so this stores the status and suspends nothing.
    paid.status = "past_due";
    expect((await deliver(updated(workspaceId, paid.id, "past_due"))).status).toBe(200);
    expect((await billingRow(workspaceId))?.status).toBe("past_due");
    expect(await isActive(workspaceId)).toBe(true);
  });

  test("a crash between the fetch and the commit still activates the workspace on Stripe's retry", async () => {
    const { workspaceId, paid } = await paidSignup();
    const event = completed(workspaceId, paid.id);
    beforeCommit = async () => {
      throw new Error("the process died here");
    };
    expect((await deliver(event)).status).toBe(500);
    expect(await isActive(workspaceId)).toBe(false);
    expect(
      await owner.select().from(stripeEvent).where(eq(stripeEvent.workspaceId, workspaceId)),
    ).toEqual([]);

    beforeCommit = undefined;
    expect((await deliver(event)).status).toBe(200);
    expect(await isActive(workspaceId)).toBe(true);
  });

  test("a handler held before its commit, while another event commits, does not overwrite the newer state", async () => {
    const { workspaceId, paid } = await paidSignup("incomplete");
    let release = () => {};
    let held = () => {};
    const reachedCommit = new Promise<void>((resolve) => {
      held = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Only the first attempt of the slow handler waits.
    let first = true;
    beforeCommit = async () => {
      if (!first) return;
      first = false;
      held();
      await gate;
    };
    const fetchesBefore = stripe.counts.subscriptionFetches;
    const slow = deliver(completed(workspaceId, paid.id));
    await reachedCommit;
    // The slow handler holds "incomplete". Stripe moves on, and a newer event commits.
    paid.status = "active";
    expect((await deliver(updated(workspaceId, paid.id, "active"))).status).toBe(200);
    expect((await billingRow(workspaceId))?.status).toBe("active");

    release();
    expect((await slow).status).toBe(200);
    expect(await billingRow(workspaceId)).toMatchObject({ status: "active", revision: 2 });
    expect(await isActive(workspaceId)).toBe(true);
    // The slow handler saw the revision move and fetched again.
    expect(stripe.counts.subscriptionFetches - fetchesBefore).toBe(3);
  });

  test("a subscription that names another workspace changes nothing", async () => {
    const mine = await paidSignup();
    const other = await signup();
    const event = completed(other.workspaceId, mine.paid.id);
    expect((await deliver(event)).status).toBe(200);
    expect(await isActive(other.workspaceId)).toBe(false);
    expect(await billingRow(other.workspaceId)).toBeUndefined();
  });
});

describe("a self-hosted install with no keys", () => {
  test("shows no billing", async () => {
    expect(
      billingFromConfig(
        loadConfig({ DATABASE_URL: "postgres://x/y", VALKEY_URL: "redis://x", AUTH_SECRET }),
      ),
    ).toBeUndefined();
    expect(() =>
      billingFromConfig(
        loadConfig({
          DATABASE_URL: "postgres://x/y",
          VALKEY_URL: "redis://x",
          AUTH_SECRET,
          STRIPE_SECRET_KEY,
        }),
      ),
    ).toThrow();

    const selfHosted = createApp({
      auth,
      db,
      logger,
      valkey,
      operatorDirectory: directory,
      checks: { postgres: ok, valkey: ok },
    });
    const existing = await createWorkspace(db, "Self-hosted", []);
    expect(await isActive(existing.id)).toBe(true);
    const { email } = await addOperator({
      auth,
      owner,
      email: `self-${randomUUID()}@example.com`,
      workspaceId: existing.id,
    });
    const cookie = cookieOf(
      await request(selfHosted, "POST", "/v1/auth/sign-in/email", {
        body: { email, password: PASSWORD },
      }),
    );

    const meta = await (await selfHosted.request("/v1/meta")).json();
    expect(meta).toMatchObject({ billing: false });
    const me = await (await request(selfHosted, "GET", "/v1/operator/me", { cookie })).json();
    expect(me).toMatchObject({
      billing: false,
      workspaces: [{ workspaceId: existing.id, active: true }],
    });
    const signupResponse = await request(selfHosted, "POST", "/v1/signup", {
      body: { email: `x-${randomUUID()}@example.com`, password: PASSWORD },
    });
    expect(signupResponse.status).toBe(404);
    const onboarding = await request(selfHosted, "POST", "/v1/operator/workspaces", {
      cookie,
      body: { name: "X", workspaceName: "X" },
    });
    expect(onboarding.status).toBe(404);
    const event = stripe.event("checkout.session.completed", {});
    const webhook = await selfHosted.request("/v1/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": event.signature },
      body: event.payload,
    });
    expect(webhook.status).toBe(404);
    const checkoutResponse = await request(
      selfHosted,
      "POST",
      `/v1/operator/workspaces/${existing.id}/checkout`,
      { cookie },
    );
    expect(checkoutResponse.status).toBe(404);
    expect((await selfHosted.request("/signup")).status).toBe(404);
    expect((await selfHosted.request("/billing/return")).status).toBe(404);
    // The same pages exist with billing on.
    expect((await app.request("/signup")).status).toBe(200);
    // The inbox works as before.
    const inbox = await request(
      selfHosted,
      "GET",
      `/v1/operator/workspaces/${existing.id}/conversations?status=open`,
      { cookie },
    );
    expect(inbox.status).toBe(200);
  });
});

/** The /v1/ routes a server answers, as the isolation suite lists them for the core. */
const routesOf = (server: App) =>
  new Set(
    server.routes
      .filter((route) => route.method !== "ALL" && route.method !== "OPTIONS")
      .filter((route) => route.path.startsWith("/v1/") && !route.path.startsWith("/v1/auth/"))
      .map((route) => `${route.method} ${route.path}`),
  );

/**
 * A workspace route that only its owner may use: another workspace's owner and an agent are refused.
 * Billing and the portal run on a paid workspace, because an unpaid one stops an agent earlier, with 402.
 */
const ownerOnly =
  (method: string, path: string, { paid = true } = {}) =>
  async () => {
    const mine = paid ? await activeSignup() : await signup();
    const theirs = await signup();
    const call = (workspaceId: string, cookie: string) =>
      request(app, method, `/v1/operator/workspaces/${workspaceId}/${path}`, { cookie });
    expect((await call(theirs.workspaceId, mine.cookie)).status).toBe(404);
    expect((await call(mine.workspaceId, await agentCookie(mine.workspaceId))).status).toBe(403);
    // The owner gets in, so the refusals above are about who asks.
    expect((await call(mine.workspaceId, mine.cookie)).status).toBe(200);
  };

/** A signed-up owner whose payment went through. */
async function activeSignup() {
  const created = await paidSignup();
  expect((await deliver(completed(created.workspaceId, created.paid.id))).status).toBe(200);
  expect(await isActive(created.workspaceId)).toBe(true);
  return created;
}

/**
 * The cloud's routes, which the core isolation suite does not build, each with what keeps a stranger
 * out. A new route in ee/ fails the list test until it has an entry here.
 */
const CLOUD_ATTACKS: Record<string, () => Promise<void>> = {
  "GET /v1/operator/workspaces/:workspaceId/billing": ownerOnly("GET", "billing"),
  "POST /v1/operator/workspaces/:workspaceId/billing-portal": ownerOnly("POST", "billing-portal"),
  "POST /v1/operator/workspaces/:workspaceId/checkout": ownerOnly("POST", "checkout", {
    paid: false,
  }),
  "POST /v1/operator/workspaces": async () => {
    const response = await request(app, "POST", "/v1/operator/workspaces", {
      body: { name: "Owner", workspaceName: "Acme" },
    });
    expect(response.status).toBe(401);
  },
  "POST /v1/signup": async () => {
    const response = await app.request("/v1/signup", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ email: `x-${randomUUID()}@example.com`, password: PASSWORD }),
    });
    expect(response.status).toBe(403);
  },
  "POST /v1/stripe/webhook": async () => {
    const event = stripe.event("checkout.session.completed", {});
    const response = await app.request("/v1/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signStripePayload(event.payload, "whsec_someone_else"),
      },
      body: event.payload,
    });
    expect(response.status).toBe(400);
  },
};

describe("the cloud's routes", () => {
  test("every cloud route has an attack, and every attack has a route", () => {
    const core = routesOf(
      createApp({
        auth,
        db,
        logger,
        valkey,
        operatorDirectory: directory,
        checks: { postgres: ok, valkey: ok },
      }),
    );
    const cloudOnly = [...routesOf(app)].filter((route) => !core.has(route));
    expect(cloudOnly.sort()).toEqual(Object.keys(CLOUD_ATTACKS).sort());
  });

  test.each(Object.keys(CLOUD_ATTACKS))("%s", async (route) => {
    await CLOUD_ATTACKS[route]?.();
  });
});
