// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type App, createApp } from "../../apps/server/src/app.ts";
import { type Auth, createAuth } from "../../apps/server/src/auth.ts";
import {
  conversation,
  event,
  lifecycleEmail,
  operator,
  subscription,
  visitor,
  workspace,
  workspaceMember,
} from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { createImages } from "../../apps/server/src/images.ts";
import { createSignals } from "../../apps/server/src/live.ts";
import type { Mailer } from "../../apps/server/src/mailer.ts";
import { appendMessage } from "../../apps/server/src/messages.ts";
import { localStore, type ObjectStore } from "../../apps/server/src/storage.ts";
import { startWorker } from "../../apps/server/src/worker.ts";
import { purgeDeletedWorkspaces } from "../../apps/server/src/workspace-delete.ts";
import { widgetWorkspace, workspaceKeys } from "../../apps/server/src/workspaces.ts";
import { createTestDatabase, type TestDatabase } from "../../apps/server/test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../../apps/server/test/env.ts";
import { signIn } from "../../apps/server/test/operators.ts";
import { type BillingOptions, createBilling } from "./billing.ts";
import {
  BILLING_CLEAR_DELAY_MS,
  billingEmails,
  DELETION_WARNING_DAYS,
  ENDING_SOON_DAYS,
  FIRST_DELETION_WARNING_DAYS,
  GRACE_DAYS,
  type LifecycleRow,
  nextStep,
  ONBOARDING_DAYS,
  PAYMENT_REMINDER_DAYS,
  READ_ONLY_DAYS,
  runLifecycle,
} from "./lifecycle.ts";
import { lifecycleHtml } from "./lifecycle-emails.ts";
import {
  type FakeStripe,
  STRIPE_PRICE_ID,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  startFakeStripe,
} from "./test/fake-stripe.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const DAY_MS = 86_400_000;
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let workerDb: Database;
let owner: Database;
let valkey: Redis;
let stripe: FakeStripe;
let app: App;
let auth: Auth;
let store: ObjectStore;
let directory: string;
/** The clock that every lifecycle time reads. Tests move it. */
let clock: Date;
const later = (days: number) => {
  clock = new Date(clock.getTime() + days * DAY_MS);
};

const keys = (): BillingOptions => ({
  secretKey: STRIPE_SECRET_KEY,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  priceId: STRIPE_PRICE_ID,
  apiBase: "",
  now: () => clock,
});

const mails: {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  html?: string;
}[] = [];
const mailer: Mailer = {
  async send(to, subject, text, headers, html) {
    mails.push({ to, subject, text, ...(headers && { headers }), ...(html && { html }) });
  },
};
const mailsAbout = (name: string) => mails.filter((mail) => mail.subject.includes(name));
const subjectsTo = (email: string) =>
  mails.filter((mail) => mail.to === email).map((mail) => mail.subject);
const textsTo = (email: string) =>
  mails.filter((mail) => mail.to === email).map((mail) => mail.text);
const day = (date: Date) =>
  date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** The worker's own login and billing client, as main.ts builds them. */
const workerBilling = () =>
  createBilling(
    { ...keys(), apiBase: stripe.apiBase },
    workerDb,
    logger,
    createSignals(valkey, logger),
  );

/** `mailer: null` runs it as a server with no SMTP. */
const lifecycle = ({
  mailer: sender = mailer,
  batch,
}: {
  mailer?: Mailer | null;
  batch?: number;
} = {}) =>
  runLifecycle({
    db: workerDb,
    billing: workerBilling(),
    logger,
    mailer: sender ?? undefined,
    publicUrl: PUBLIC_URL,
    secret: AUTH_SECRET,
    ...(batch === undefined ? {} : { batch }),
  });

const IP = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;

const request = (
  server: App,
  method: string,
  path: string,
  { cookie, body }: { cookie?: string; body?: unknown } = {},
) =>
  server.request(path, {
    method,
    headers: {
      origin: ORIGIN,
      "x-forwarded-for": IP,
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const deliver = (event: { payload: string; signature: string }) =>
  app.request("/v1/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": event.signature },
    body: event.payload,
  });

/** Sets the fake's subscription and sends Stripe's event about it. */
async function stripeSays(
  workspaceId: string,
  subscriptionId: string,
  status: string,
  extra: {
    cancel_at_period_end?: boolean;
    cancel_at?: number | null;
    current_period_end?: number;
  } = {},
) {
  const found = stripe.subscriptions.get(subscriptionId);
  if (found === undefined) throw new Error(`No subscription ${subscriptionId}`);
  Object.assign(found, { status, ...extra });
  const response = await deliver(
    stripe.event("customer.subscription.updated", {
      id: subscriptionId,
      object: "subscription",
      status,
      metadata: { workspace_id: workspaceId },
    }),
  );
  expect(response.status).toBe(200);
}

/** Opens Checkout as the owner, pays it and sends the webhook. */
async function payCheckout(workspaceId: string, cookie: string) {
  const response = await request(app, "POST", `/v1/operator/workspaces/${workspaceId}/checkout`, {
    cookie,
  });
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  const paid = stripe.pay(url.split("/").at(-1) ?? "");
  const done = await deliver(
    stripe.event("checkout.session.completed", {
      object: "checkout.session",
      client_reference_id: workspaceId,
      subscription: paid.id,
    }),
  );
  expect(done.status).toBe(200);
  return paid.id;
}

const ONBOARDING_KINDS = ["ready", "install", "team", "check_in", "review"] as const;

/**
 * A paid cloud workspace, its owner's session, and one conversation with an image. Its onboarding
 * emails are dropped unless a test asks for them, so the others read only billing emails.
 */
async function paidWorkspace({ onboarding = false } = {}) {
  const email = `owner-${randomUUID()}@example.com`;
  const name = `Shop ${randomUUID().slice(0, 8)}`;
  const cookie = await signIn(app, auth, email);
  const created = await request(app, "POST", "/v1/operator/workspaces", {
    cookie,
    body: { name: "Owner", workspaceName: name },
  });
  const { workspaceId } = (await created.json()) as { workspaceId: string };
  const subscriptionId = await payCheckout(workspaceId, cookie);
  const storageKey = `${workspaceId}/${randomUUID()}.png`;
  await store.put(storageKey, new Uint8Array([1, 2, 3]), "image/png");
  await withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .insert(visitor)
      .values({ workspaceId, externalId: "visitor-1" })
      .returning({ id: visitor.id });
    const author = { kind: "visitor" as const, visitorId: row?.id ?? "" };
    await appendMessage(tx, workspaceId, author, { clientId: "c1", body: "Hello there" });
    await appendMessage(tx, workspaceId, author, {
      clientId: "c2",
      image: {
        attachmentId: randomUUID(),
        storageKey,
        byteSize: 3,
        contentType: "image/png",
        width: 1,
        height: 1,
      },
    });
  });
  if (!onboarding) {
    await owner
      .delete(lifecycleEmail)
      .where(
        and(
          eq(lifecycleEmail.workspaceId, workspaceId),
          inArray(lifecycleEmail.kind, [...ONBOARDING_KINDS]),
        ),
      );
  }
  const [publicKey] = await owner
    .select({ key: workspace.publicKey })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  return {
    workspaceId,
    name,
    email,
    cookie,
    subscriptionId,
    storageKey,
    key: publicKey?.key ?? "",
  };
}

type Paid = Awaited<ReturnType<typeof paidWorkspace>>;

/** Opens Checkout as the owner and leaves it unpaid. Returns the session's ID. */
async function openCheckout(paid: Paid) {
  const response = await request(
    app,
    "POST",
    `/v1/operator/workspaces/${paid.workspaceId}/checkout`,
    {
      cookie: paid.cookie,
    },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { url: string }).url.split("/").at(-1) ?? "";
}

const row = async (workspaceId: string) =>
  (await owner.select().from(subscription).where(eq(subscription.workspaceId, workspaceId)))[0];

/** The kinds of lifecycle email that went to this workspace's owners. */
const sentKinds = async (workspaceId: string) =>
  (
    await owner
      .select({ kind: lifecycleEmail.kind })
      .from(lifecycleEmail)
      .where(and(eq(lifecycleEmail.workspaceId, workspaceId), isNotNull(lifecycleEmail.sentAt)))
      // Emails sent in one pass share the test clock's time, so the time each was due breaks ties.
      .orderBy(lifecycleEmail.sentAt, lifecycleEmail.dueAt)
  ).map((one) => one.kind);

const workspaceRow = async (workspaceId: string) =>
  (await owner.select().from(workspace).where(eq(workspace.id, workspaceId)))[0];

const conversationsOf = async (workspaceId: string) =>
  owner.select().from(conversation).where(eq(conversation.workspaceId, workspaceId));

const billingOf = async (paid: Paid) =>
  (await (
    await request(app, "GET", `/v1/operator/workspaces/${paid.workspaceId}/billing`, {
      cookie: paid.cookie,
    })
  ).json()) as { state: string; date: string | null; payWith: string };

/** What an operator of a read-only workspace can and cannot do. */
async function expectReadOnly(paid: Paid, readOnly: boolean) {
  expect(await widgetWorkspace(db, paid.key)).toEqual(readOnly ? null : expect.anything());
  const base = `/v1/operator/workspaces/${paid.workspaceId}`;
  const list = await request(app, "GET", `${base}/conversations?status=open`, {
    cookie: paid.cookie,
  });
  expect(list.status).toBe(200);
  const [first] = await conversationsOf(paid.workspaceId);
  const reply = await request(app, "POST", `${base}/conversations/${first?.id}/messages`, {
    cookie: paid.cookie,
    body: { clientId: randomUUID(), body: "a reply" },
  });
  expect(reply.status).toBe(readOnly ? 402 : 201);
  const exported = await request(app, "GET", `${base}/export`, { cookie: paid.cookie });
  expect(exported.status).toBe(200);
  await exported.arrayBuffer();
}

/** Tenant tables that still hold a row of this workspace. */
async function leftovers(workspaceId: string): Promise<string[]> {
  const tables = await owner.execute<{ table_name: string }>(
    sql`select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'workspace_id'`,
  );
  const left: string[] = [];
  for (const { table_name } of tables.rows) {
    const found = await owner.execute<{ count: string }>(
      sql`select count(*) as count from ${sql.identifier(table_name)} where workspace_id = ${workspaceId}`,
    );
    if (Number(found.rows[0]?.count) > 0) left.push(table_name);
  }
  return left;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 20).db;
  workerDb = database.connect("worker", 10).db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  stripe = await startFakeStripe();
  // Stripe tells Dinghy about a cancel, the worker's own included, through the real webhook.
  stripe.hooks.afterCancel = async (ended) => {
    const response = await deliver(
      stripe.event("customer.subscription.deleted", {
        id: ended.id,
        object: "subscription",
        status: ended.status,
        metadata: ended.metadata,
      }),
    );
    expect(response.status).toBe(200);
  };
  directory = await mkdtemp(join(tmpdir(), "dinghy-lifecycle-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Dinghy</title>");
  store = localStore(join(directory, "images"));
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const images = createImages({ store, secret: AUTH_SECRET, publicUrl: PUBLIC_URL });
  app = createApp({
    auth,
    db,
    logger,
    valkey,
    images,
    trustedProxyHops: 1,
    limitScale: 100,
    operatorDirectory: directory,
    checks: { postgres: ok, valkey: ok },
    cloud: { billing: { ...keys(), apiBase: stripe.apiBase } },
  });
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await stripe.stop();
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

beforeEach(() => {
  clock = new Date("2027-03-01T12:00:00Z");
  mails.length = 0;
});

describe("the rules", () => {
  const base: LifecycleRow = {
    status: "active",
    paidAt: new Date(0),
    paymentFailedAt: null,
    readOnlyAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };
  const now = new Date("2027-03-01T00:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);

  test("keep the named numbers of days", () => {
    expect([
      GRACE_DAYS,
      READ_ONLY_DAYS,
      FIRST_DELETION_WARNING_DAYS,
      DELETION_WARNING_DAYS,
    ]).toEqual([7, 90, 30, 7]);
    expect([PAYMENT_REMINDER_DAYS, ENDING_SOON_DAYS]).toEqual([3, 3]);
    expect(ONBOARDING_DAYS).toEqual({ install: 1, team: 3, check_in: 7, review: 30 });
  });

  test("a paid or canceling subscription has nothing to do", () => {
    expect(nextStep(base, now)).toBeNull();
    expect(nextStep({ ...base, cancelAtPeriodEnd: true }, now)).toBeNull();
  });

  test("a signup that never paid never goes read-only", () => {
    expect(nextStep({ ...base, paidAt: null, status: "incomplete_expired" }, now)).toBeNull();
  });

  test("each step comes at its time", () => {
    const failing = { ...base, status: "past_due" };
    expect(nextStep({ ...failing, paymentFailedAt: ago(6.9) }, now)).toBeNull();
    expect(nextStep({ ...failing, paymentFailedAt: ago(7) }, now)).toBe("read_only");
    expect(nextStep({ ...base, status: "canceled" }, now)).toBe("read_only");
    const ended = { ...base, status: "canceled", readOnlyAt: ago(1) };
    expect(nextStep(ended, now)).toBeNull();
    expect(nextStep({ ...ended, readOnlyAt: ago(89.9) }, now)).toBeNull();
    expect(nextStep({ ...ended, readOnlyAt: ago(90) }, now)).toBe("delete");
  });

  test("a Stripe change queues the emails of what changed, and nothing for a repeat", () => {
    const before = {
      paidAt: ago(40),
      paymentFailedAt: null,
      readOnlyAt: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    };
    const paid = { status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: null };
    const kinds = (emails: { kind: string }[]) => emails.map((email) => email.kind);
    expect(kinds(billingEmails(undefined, paid, now))).toEqual([
      "ready",
      "install",
      "team",
      "check_in",
      "review",
    ]);
    expect(billingEmails(before, paid, now)).toEqual([]);
    expect(kinds(billingEmails(before, { ...paid, status: "past_due" }, now))).toEqual([
      "payment_failed",
      "payment_reminder",
      "payment_last_day",
    ]);
    const failed = { ...before, paymentFailedAt: ago(2) };
    expect(billingEmails(failed, { ...paid, status: "unpaid" }, now)).toEqual([]);
    expect(billingEmails(failed, paid, now)).toEqual([
      { kind: "payment_recovered", occurrenceAt: ago(2), dueAt: now },
    ]);
    const readOnly = { ...failed, readOnlyAt: ago(1) };
    expect(kinds(billingEmails(readOnly, paid, now))).toEqual(["welcome_back"]);
    const end = new Date(now.getTime() + 20 * DAY_MS);
    expect(
      billingEmails(before, { ...paid, cancelAtPeriodEnd: true, currentPeriodEnd: end }, now),
    ).toEqual([
      { kind: "cancellation", occurrenceAt: now, dueAt: now },
      { kind: "ending_soon", occurrenceAt: end, dueAt: new Date(end.getTime() - 3 * DAY_MS) },
    ]);
    // Inside the last 3 days, the cancellation email is the only one.
    const soon = new Date(now.getTime() + 2 * DAY_MS);
    expect(
      kinds(
        billingEmails(before, { ...paid, cancelAtPeriodEnd: true, currentPeriodEnd: soon }, now),
      ),
    ).toEqual(["cancellation"]);
    // Stripe moves the end of a cancelled plan: no second cancellation, a reminder for the new end.
    const cancelled = { ...before, cancelAtPeriodEnd: true, currentPeriodEnd: end };
    const later = new Date(end.getTime() + 9 * DAY_MS);
    expect(
      billingEmails(cancelled, { ...paid, cancelAtPeriodEnd: true, currentPeriodEnd: later }, now),
    ).toEqual([
      { kind: "ending_soon", occurrenceAt: later, dueAt: new Date(later.getTime() - 3 * DAY_MS) },
    ]);
    expect(
      billingEmails(cancelled, { ...paid, cancelAtPeriodEnd: true, currentPeriodEnd: end }, now),
    ).toEqual([]);
    // Moved to inside the last 3 days: the reminder of the new date goes at once.
    const close = new Date(now.getTime() + 2 * DAY_MS);
    expect(
      billingEmails(cancelled, { ...paid, cancelAtPeriodEnd: true, currentPeriodEnd: close }, now),
    ).toEqual([{ kind: "ending_soon", occurrenceAt: close, dueAt: now }]);
  });
});

describe("the HTML version of a lifecycle email", () => {
  test("escapes every word, opens links, and ends with an Unsubscribe link", () => {
    const html = lifecycleHtml(
      'Hi <b>Bob</b>,\n\nOpen "Settings": https://app.dinghy.chat/?workspace=1&x=2\n\nCheers,\nJulien',
      "https://app.dinghy.chat/v1/onboarding-stop/a/b?signature=s",
    );
    expect(html).toContain("Hi &lt;b&gt;Bob&lt;/b&gt;,");
    expect(html).toContain("Open &quot;Settings&quot;:");
    expect(html).toContain(
      '<a href="https://app.dinghy.chat/?workspace=1&amp;x=2" style="color:#1d4ed8">',
    );
    expect(html).toContain("Cheers,<br>Julien");
    expect(html).toContain(">Unsubscribe</a></p></body></html>");
    expect(lifecycleHtml("Hi,\n\nCheers", undefined)).not.toContain("Unsubscribe");
  });
});

describe("the subscription lifecycle", () => {
  test("a portal cancellation under flexible billing, which sets cancel_at, also ends the plan", async () => {
    const paid = await paidWorkspace();
    const found = stripe.subscriptions.get(paid.subscriptionId);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "active", {
      cancel_at: found?.current_period_end ?? null,
    });
    expect(await billingOf(paid)).toMatchObject({ state: "ending" });
    // Resubscribing in the portal clears the date.
    await stripeSays(paid.workspaceId, paid.subscriptionId, "active", { cancel_at: null });
    expect(await billingOf(paid)).toMatchObject({ state: "active" });
  });

  test("a cancellation keeps full service until the paid period ends, then turns read-only", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "active", {
      cancel_at_period_end: true,
    });
    expect(await billingOf(paid)).toMatchObject({ state: "ending" });
    later(20);
    await lifecycle();
    await expectReadOnly(paid, false);
    const ends = day((await row(paid.workspaceId))?.currentPeriodEnd ?? new Date(0));
    const cancellation = `${paid.name} stays on until ${ends}`;
    expect(mailsAbout(paid.name).map((mail) => mail.subject)).toEqual([cancellation]);

    // Stripe ends it at the period's end.
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    await lifecycle();
    expect((await row(paid.workspaceId))?.readOnlyAt).toEqual(clock);
    await expectReadOnly(paid, true);
    const me = await (await request(app, "GET", "/v1/operator/me", { cookie: paid.cookie })).json();
    expect(me).toMatchObject({ workspaces: [{ workspaceId: paid.workspaceId, readOnly: true }] });
    expect(await billingOf(paid)).toEqual({
      state: "read_only",
      date: new Date(clock.getTime() + READ_ONLY_DAYS * DAY_MS).toISOString(),
      payWith: "checkout",
    });
    expect(mailsAbout(paid.name).map((mail) => [mail.to, mail.subject])).toEqual([
      [paid.email, cancellation],
      [paid.email, `${paid.name} is now read-only`],
    ]);
    // To the owner, who proved this address, by name, in the voice every email shares.
    const text = mailsAbout(paid.name)[1]?.text ?? "";
    expect(text.startsWith("Hi Owner,\n\n")).toBe(true);
    expect(text.endsWith("\n\nCheers,\nJulien from Dinghy")).toBe(true);
    expect(text).toContain(`${PUBLIC_URL}/?workspace=${paid.workspaceId}`);
    expect(text).toContain(day(new Date(clock.getTime() + READ_ONLY_DAYS * DAY_MS)));
    // A later pass sends nothing again.
    await lifecycle();
    expect(mailsAbout(paid.name)).toHaveLength(2);
  });

  test("a failed payment gives 7 days from the first failure, with a reminder on day 3 and on the last day", async () => {
    const paid = await paidWorkspace();
    const first = new Date(clock);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due");
    expect((await row(paid.workspaceId))?.paymentFailedAt).toEqual(first);
    await lifecycle();
    const failed = `The payment for ${paid.name} didn't go through`;
    expect(subjectsTo(paid.email)).toEqual([failed]);
    expect(await billingOf(paid)).toEqual({
      state: "payment_failed",
      date: new Date(first.getTime() + GRACE_DAYS * DAY_MS).toISOString(),
      payWith: "portal",
    });
    expect(textsTo(paid.email)[0]).toContain(day(new Date(first.getTime() + GRACE_DAYS * DAY_MS)));

    // A second failure does not restart the days.
    later(PAYMENT_REMINDER_DAYS - 0.1);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "unpaid");
    expect((await row(paid.workspaceId))?.paymentFailedAt).toEqual(first);
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([failed]);
    later(0.1);
    await lifecycle();
    const payUntil = day(new Date(first.getTime() + GRACE_DAYS * DAY_MS));
    const reminder = `${paid.name} keeps working until ${payUntil}`;
    expect(subjectsTo(paid.email)).toEqual([failed, reminder]);
    await expectReadOnly(paid, false);

    later(GRACE_DAYS - 1 - PAYMENT_REMINDER_DAYS);
    await lifecycle();
    const lastDay = `${paid.name} turns read-only on ${payUntil}`;
    expect(subjectsTo(paid.email)).toEqual([failed, reminder, lastDay]);
    later(0.9);
    await lifecycle();
    await expectReadOnly(paid, false);
    later(0.1);
    await lifecycle();
    await expectReadOnly(paid, true);
    expect(subjectsTo(paid.email)).toEqual([
      failed,
      reminder,
      lastDay,
      `${paid.name} is now read-only`,
    ]);
    // Dinghy ended the subscription, so no late retry can charge, and paying again is Checkout.
    expect(stripe.subscriptions.get(paid.subscriptionId)?.status).toBe("canceled");
    expect((await billingOf(paid)).payWith).toBe("checkout");
  });

  test("the worker's own cancel, and its webhook, still give one read-only email at once", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due");
    await lifecycle();
    later(GRACE_DAYS);
    await lifecycle();
    expect(stripe.subscriptions.get(paid.subscriptionId)?.status).toBe("canceled");
    expect((await row(paid.workspaceId))?.readOnlyAt).toEqual(clock);
    await expectReadOnly(paid, true);
    // Later passes, after any claim has run out, send nothing more.
    later(0.01);
    await lifecycle();
    later(0.01);
    await lifecycle();
    expect(mailsAbout(paid.name).map((mail) => mail.subject)).toEqual([
      `The payment for ${paid.name} didn't go through`,
      `${paid.name} is now read-only`,
    ]);
  });

  test("a recovered payment clears the failure and its reminders, and the next failure starts a new 7 days", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due");
    await lifecycle();
    later(1);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "active");
    expect(await row(paid.workspaceId)).toMatchObject({ paymentFailedAt: null });
    await lifecycle();
    const failed = `The payment for ${paid.name} didn't go through`;
    const recovered = `All good with ${paid.name}`;
    expect(subjectsTo(paid.email)).toEqual([failed, recovered]);
    // The reminders of the failure that was paid never go.
    later(10);
    await lifecycle();
    await expectReadOnly(paid, false);
    expect(subjectsTo(paid.email)).toEqual([failed, recovered]);

    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due");
    expect((await row(paid.workspaceId))?.paymentFailedAt).toEqual(clock);
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([failed, recovered, failed]);
  });

  test("resubscribing during the read-only time brings everything back, with all data", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    await lifecycle();
    await expectReadOnly(paid, true);
    const before = await leftoversCount(paid.workspaceId);

    later(12);
    const again = await payCheckout(paid.workspaceId, paid.cookie);
    expect(again).not.toBe(paid.subscriptionId);
    expect(await row(paid.workspaceId)).toMatchObject({
      readOnlyAt: null,
      status: "active",
      stripeSubscriptionId: again,
    });
    await expectReadOnly(paid, false);
    expect(await leftoversCount(paid.workspaceId)).toBeGreaterThanOrEqual(before);
    expect(await store.get(paid.storageKey)).not.toBeNull();

    // A late event about the old, canceled subscription does not end the new one.
    await deliver(
      stripe.event("customer.subscription.deleted", {
        id: paid.subscriptionId,
        object: "subscription",
        metadata: { workspace_id: paid.workspaceId },
      }),
    );
    expect((await row(paid.workspaceId))?.status).toBe("active");
    later(60);
    await lifecycle();
    await expectReadOnly(paid, false);
  });

  test("Checkout opens once the subscription ended, before the worker makes it read-only", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    expect((await row(paid.workspaceId))?.readOnlyAt).toBeNull();
    const sessionId = await openCheckout(paid);
    expect(stripe.sessions.get(sessionId)?.expired).toBeUndefined();
  });

  test("going read-only and back is on the workspace's feed, and the worker wakes open inboxes", async () => {
    const paid = await paidWorkspace();
    const billingEvents = async () =>
      (
        await owner
          .select({ seq: event.seq })
          .from(event)
          .where(and(eq(event.workspaceId, paid.workspaceId), eq(event.kind, "billing.changed")))
      ).length;
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    const before = await billingEvents();

    const listener = new Redis(VALKEY_URL);
    const signals: string[] = [];
    listener.on("message", (_channel: string, payload: string) => signals.push(payload));
    await listener.subscribe(`dinghy:signals:${paid.workspaceId}`);
    try {
      await lifecycle();
      expect((await row(paid.workspaceId))?.readOnlyAt).toEqual(clock);
      expect(await billingEvents()).toBe(before + 1);
      // A signal is best effort and travels apart from the commit, so a loaded machine can be slow.
      await expect.poll(() => signals, { timeout: 5000 }).toContain("wake:operators");
    } finally {
      listener.disconnect();
    }

    await payCheckout(paid.workspaceId, paid.cookie);
    expect((await row(paid.workspaceId))?.readOnlyAt).toBeNull();
    expect(await billingEvents()).toBe(before + 2);
  });

  test("a paid workspace's Checkout still answers 409", async () => {
    const paid = await paidWorkspace();
    const response = await request(
      app,
      "POST",
      `/v1/operator/workspaces/${paid.workspaceId}/checkout`,
      { cookie: paid.cookie },
    );
    expect(response.status).toBe(409);
  });

  test("after the 90 days, the workspace and all its data are deleted, including images", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    await lifecycle();
    const deleteOn = day(new Date(clock.getTime() + READ_ONLY_DAYS * DAY_MS));
    const readOnly = `${paid.name} is now read-only`;
    later(READ_ONLY_DAYS - FIRST_DELETION_WARNING_DAYS - 0.01);
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([readOnly]);
    later(0.01);
    await lifecycle();
    const first = `${paid.name} will be deleted on ${deleteOn}`;
    expect(subjectsTo(paid.email)).toEqual([readOnly, first]);
    expect(textsTo(paid.email).at(-1)).toContain(deleteOn);
    later(FIRST_DELETION_WARNING_DAYS - DELETION_WARNING_DAYS);
    await lifecycle();
    const last = `Last reminder: ${paid.name} will be deleted on ${deleteOn}`;
    expect(subjectsTo(paid.email)).toEqual([readOnly, first, last]);
    later(DELETION_WARNING_DAYS - 0.01);
    await lifecycle();
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toBeNull();
    later(0.01);
    await lifecycle();
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toEqual(clock);
    // To the owners, after the deletion, once.
    later(0.01);
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([
      readOnly,
      first,
      last,
      `${paid.name} has been deleted`,
    ]);
    // Gone for its operators and its widget at once.
    const me = await (await request(app, "GET", "/v1/operator/me", { cookie: paid.cookie })).json();
    expect(me).toMatchObject({ workspaces: [] });
    expect(await widgetWorkspace(db, paid.key)).toBeNull();

    await purgeUntilGone(paid.workspaceId);
    expect(await leftovers(paid.workspaceId)).toEqual([]);
    expect(await store.get(paid.storageKey)).toBeNull();
    // The owner's account stays, because it is global and may belong to other workspaces.
    expect(await owner.select().from(operator).where(eq(operator.email, paid.email))).toHaveLength(
      1,
    );
  });

  test("the deletion asks Stripe again and skips a subscription that is paid", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due");
    later(GRACE_DAYS);
    await lifecycle();
    await expectReadOnly(paid, true);
    later(READ_ONLY_DAYS);
    // The payment cleared at Stripe, and its webhook never came.
    const found = stripe.subscriptions.get(paid.subscriptionId);
    if (found !== undefined) found.status = "active";
    await lifecycle();
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toBeNull();
    expect(await row(paid.workspaceId)).toMatchObject({ status: "active", readOnlyAt: null });
    await expectReadOnly(paid, false);
  });

  test("a payment whose webhook never came stops the read-only step", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due");
    later(GRACE_DAYS);
    // The card worked on Stripe, but Dinghy never heard.
    const sub = stripe.subscriptions.get(paid.subscriptionId);
    if (sub !== undefined) sub.status = "active";
    await lifecycle();
    await expectReadOnly(paid, false);
    expect(sub?.status).toBe("active");
  });

  test("a new payment after a cancellation keeps the workspace, though its webhook is late", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    // The owner paid again through a new Checkout, and its webhook has not come yet.
    const customer = (await row(paid.workspaceId))?.stripeCustomerId ?? "";
    stripe.subscriptions.set("sub_again", {
      id: "sub_again",
      customer,
      status: "active",
      current_period_end: Math.floor(clock.getTime() / 1000) + 30 * 86_400,
      metadata: { workspace_id: paid.workspaceId },
    });
    await lifecycle();
    await expectReadOnly(paid, false);
  });

  test("a subscription that still retries is ended at read-only time, and the deletion follows", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "unpaid");
    later(GRACE_DAYS);
    await lifecycle();
    expect(stripe.subscriptions.get(paid.subscriptionId)?.status).toBe("canceled");
    later(READ_ONLY_DAYS);
    await lifecycle();
    expect(stripe.subscriptions.get(paid.subscriptionId)?.status).toBe("canceled");
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toEqual(clock);
  });

  test("the deletion after the read-only time expires an open Checkout", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    await lifecycle();
    const sessionId = await openCheckout(paid);
    later(READ_ONLY_DAYS);
    await lifecycle();
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toEqual(clock);
    expect(stripe.sessions.get(sessionId)?.expired).toBe(true);
  });

  test("two workers that run the check at once act once", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    const counts = await Promise.all([lifecycle(), lifecycle(), lifecycle()]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(mailsAbout(paid.name)).toHaveLength(1);

    later(READ_ONLY_DAYS);
    const cancels = stripe.counts.cancels;
    await Promise.all([lifecycle(), lifecycle(), lifecycle()]);
    expect(stripe.counts.cancels).toBe(cancels);
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toEqual(clock);
    // The billing is cleared first, within the deletion's claim.
    clock = new Date(clock.getTime() + BILLING_CLEAR_DELAY_MS);
    await lifecycle();
    expect(stripe.counts.cancels).toBe(cancels);
    const purged = await Promise.all([
      purgeDeletedWorkspaces(workerDb),
      purgeDeletedWorkspaces(workerDb),
    ]);
    // The images are queued once, and none is removed twice.
    expect(purged).toEqual([0, 0]);
    const queued = await owner.execute<{ count: string }>(
      sql`select count(*) as count from storage_deletion where workspace_id = ${paid.workspaceId}`,
    );
    expect(Number(queued.rows[0]?.count)).toBe(1);
  });

  test("a second worker does not repeat a step that the first worker's slow email still holds", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    let reached = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Holds only this workspace's email, as a slow SMTP server would.
    const slow: Mailer = {
      async send(to, subject, text) {
        if (to === paid.email) {
          reached = true;
          await held;
        }
        mails.push({ to, subject, text });
      },
    };
    const worker = startWorker({
      db: workerDb,
      logger,
      mailer: slow,
      cloud: { billing: { ...keys(), apiBase: stripe.apiBase } },
      signals: createSignals(valkey, logger),
      publicUrl: PUBLIC_URL,
      secret: AUTH_SECRET,
      pollMs: 20,
      mailTimeoutMs: 60_000,
    });
    try {
      await expect.poll(() => reached, { timeout: 8000 }).toBe(true);
      // Past the alert worker's 60-second claim, well inside the lifecycle's own.
      clock = new Date(clock.getTime() + 2 * 60_000);
      await lifecycle();
      expect(mailsAbout(paid.name)).toEqual([]);
      release();
      await expect.poll(() => mailsAbout(paid.name).length, { timeout: 8000 }).toBeGreaterThan(0);
    } finally {
      release();
      await worker.stop();
    }
    expect(mailsAbout(paid.name)).toHaveLength(1);
  });

  test("rows with nothing due never fill the batch ahead of a row that is due", async () => {
    // IDs that sort before every random one, so the rows with nothing due come first.
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const insert = async (n: number, row: Partial<typeof subscription.$inferInsert>) => {
      const keys = { ...workspaceKeys(), id: id(n) };
      await owner.insert(workspace).values({ ...keys, name: `Row ${n}` });
      // The worker asks Stripe about the customer before it acts, so Stripe must know it.
      stripe.customers.push(`cus_row_${n}`);
      await owner.insert(subscription).values({
        workspaceId: keys.id,
        stripeCustomerId: `cus_row_${n}`,
        paidAt: new Date(clock.getTime() - 60 * DAY_MS),
        ...row,
      });
    };
    // Read-only, warned, and far from deletion: more than one batch of them.
    for (const n of [1, 2, 3]) {
      await insert(n, {
        status: "canceled",
        readOnlyAt: new Date(clock.getTime() - DAY_MS),
      });
    }
    await insert(4, { status: "canceled" });
    await lifecycle({ batch: 2 });
    expect((await row(id(4)))?.readOnlyAt).toEqual(clock);
  });

  test("an email that reaches one owner is sent, and a bad address never repeats it", async () => {
    const paid = await paidWorkspace();
    // A second owner whose address the mail server rejects.
    const bad = `gone-${randomUUID()}@example.com`;
    await signIn(app, auth, bad);
    const [second] = await owner
      .select({ id: operator.id })
      .from(operator)
      .where(eq(operator.email, bad));
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: paid.workspaceId, operatorId: second?.id ?? "", role: "owner" });
    const tries: string[] = [];
    const picky: Mailer = {
      async send(to, subject, text, headers) {
        tries.push(to);
        if (to === bad) throw new Error("550 no such mailbox");
        await mailer.send(to, subject, text, headers);
      },
    };
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    await lifecycle({ mailer: picky });
    expect(await sentKinds(paid.workspaceId)).toEqual(["read_only"]);
    later(0.01);
    await lifecycle({ mailer: picky });
    expect(subjectsTo(paid.email)).toEqual([`${paid.name} is now read-only`]);
    expect(tries.filter((to) => to === paid.email)).toHaveLength(1);
  });

  test("an email that reaches nobody retries, then stops after 3 days", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    let tries = 0;
    const down: Mailer = {
      send: () => {
        tries += 1;
        return Promise.reject(new Error("the mail server is down"));
      },
    };
    await lifecycle({ mailer: down });
    later(1);
    await lifecycle({ mailer: down });
    expect(await sentKinds(paid.workspaceId)).toEqual([]);
    later(2.01);
    await lifecycle({ mailer: down });
    expect(tries).toBe(3);
    expect(await sentKinds(paid.workspaceId)).toEqual(["read_only"]);
    later(0.01);
    await lifecycle({ mailer: down });
    expect(tries).toBe(3);
  });

  test("the purge waits for the deletion email while the mail server is down", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    await lifecycle();
    const down: Mailer = { send: () => Promise.reject(new Error("the mail server is down")) };
    later(READ_ONLY_DAYS);
    await lifecycle({ mailer: down });
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).not.toBeNull();
    clock = new Date(clock.getTime() + BILLING_CLEAR_DELAY_MS);
    await lifecycle({ mailer: down });
    expect((await row(paid.workspaceId))?.billingClearedAt).not.toBeNull();
    await purgeDeletedWorkspaces(workerDb);
    // The owners are still members, so the email can still reach them.
    expect(await leftovers(paid.workspaceId)).toContain("workspace_member");
    later(0.01);
    await lifecycle();
    expect(subjectsTo(paid.email).at(-1)).toBe(`${paid.name} has been deleted`);
    await purgeUntilGone(paid.workspaceId);
    expect(await leftovers(paid.workspaceId)).toEqual([]);
  });

  test("a cancellation while a payment fails sends its email, with the date service stops", async () => {
    const paid = await paidWorkspace();
    const failedAt = new Date(clock);
    // A renewal failed, so the unpaid period runs a month from now.
    const periodEnd = Math.floor((failedAt.getTime() + 30 * DAY_MS) / 1000);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due", {
      current_period_end: periodEnd,
    });
    await lifecycle();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due", {
      cancel_at_period_end: true,
      current_period_end: periodEnd,
    });
    await lifecycle();
    // Service stops when the grace ends, which is before the period's end.
    const graceEnd = new Date(failedAt.getTime() + GRACE_DAYS * DAY_MS);
    expect(graceEnd < ((await row(paid.workspaceId))?.currentPeriodEnd ?? new Date(0))).toBe(true);
    expect(subjectsTo(paid.email)).toEqual([
      `The payment for ${paid.name} didn't go through`,
      `${paid.name} stays on until ${day(graceEnd)}`,
    ]);
  });

  test("a failed email is sent again by a later pass, and a server with no SMTP carries on", async () => {
    const first = await paidWorkspace();
    await stripeSays(first.workspaceId, first.subscriptionId, "canceled");
    const failing: Mailer = {
      send: () => Promise.reject(new Error("the mail server is down")),
    };
    await lifecycle({ mailer: failing });
    expect(await sentKinds(first.workspaceId)).toEqual([]);
    // The claim lasts 10 minutes.
    later(0.01);
    await lifecycle();
    expect(mailsAbout(first.name)).toHaveLength(1);
    expect(await sentKinds(first.workspaceId)).toEqual(["read_only"]);

    const second = await paidWorkspace();
    await stripeSays(second.workspaceId, second.subscriptionId, "canceled");
    await lifecycle({ mailer: null });
    expect(await sentKinds(second.workspaceId)).toEqual(["read_only"]);
    expect((await row(second.workspaceId))?.readOnlyAt).not.toBeNull();
  });
});

describe("the lifecycle emails", () => {
  const ready = (paid: Paid) => `${paid.name} is ready`;
  const stopLink = (text: string) => text.match(/\/v1\/onboarding-stop\/[^\s]+/)?.[0] ?? "";

  test("a paid signup gets the ready email once, then the onboarding emails on days 1, 3, 7 and 30", async () => {
    const paid = await paidWorkspace({ onboarding: true });
    await lifecycle();
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([ready(paid)]);
    const [readyMail] = mails;
    expect(readyMail?.text).toContain(`${PUBLIC_URL}/?workspace=${paid.workspaceId}`);
    expect(readyMail?.text).toContain("https://dinghy.chat/docs/add-to-your-site");
    // Billing emails have no stop link.
    expect(readyMail?.headers).toEqual({ "reply-to": "support@dinghy.chat" });

    later(ONBOARDING_DAYS.install - 0.01);
    await lifecycle();
    expect(subjectsTo(paid.email)).toHaveLength(1);
    later(0.01);
    await lifecycle();
    later(ONBOARDING_DAYS.team - ONBOARDING_DAYS.install);
    await lifecycle();
    later(ONBOARDING_DAYS.check_in - ONBOARDING_DAYS.team);
    await lifecycle();
    later(ONBOARDING_DAYS.review - ONBOARDING_DAYS.check_in);
    await lifecycle();
    later(1);
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([
      ready(paid),
      "Need a hand adding the chat?",
      "Working with someone?",
      "How's it going?",
      "What would you change?",
    ]);
    const sent = mails.filter((mail) => mail.to === paid.email).slice(1);
    for (const mail of sent) {
      expect(mail.text).toContain(`${PUBLIC_URL}/v1/onboarding-stop/${paid.workspaceId}/`);
      // One short line under the signature, and the last line of the email.
      expect(mail.text).toMatch(/Julien from Dinghy\n\nUnsubscribe: \S+$/);
      // In HTML, the word is the link, and the address is not shown.
      const stop = `${PUBLIC_URL}${stopLink(mail.text)}`.replaceAll("&", "&amp;");
      expect(mail.html).toContain(`<a href="${stop}" style="color:#8a8f98">Unsubscribe</a>`);
      expect(mail.html).not.toContain("Unsubscribe:");
      expect(mail.headers?.["list-unsubscribe"]).toBe(`<${PUBLIC_URL}${stopLink(mail.text)}>`);
      expect(mail.headers?.["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    }
    // Every lifecycle email takes replies, so an answer always reaches a person.
    for (const mail of sent) expect(mail.headers?.["reply-to"]).toBe("support@dinghy.chat");
    expect(sent[1]?.text).toContain(`${PUBLIC_URL}/?workspace=${paid.workspaceId}`);
    expect(sent[3]?.text).toContain("Just reply");
  });

  test("the install email is skipped once the widget has run on a site", async () => {
    const paid = await paidWorkspace({ onboarding: true });
    // A visitor from the widget: a browser token, as its first message gives one.
    await withWorkspace(db, paid.workspaceId, (tx) =>
      tx.insert(visitor).values({ workspaceId: paid.workspaceId, tokenHash: randomUUID() }),
    );
    later(ONBOARDING_DAYS.install);
    await lifecycle();
    later(ONBOARDING_DAYS.team - ONBOARDING_DAYS.install);
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([ready(paid), "Working with someone?"]);
    expect(await sentKinds(paid.workspaceId)).toEqual(["ready", "team"]);
  });

  test("the stop link stops the onboarding emails of its owner, and billing emails still go", async () => {
    const paid = await paidWorkspace({ onboarding: true });
    later(ONBOARDING_DAYS.install);
    await lifecycle();
    const link = stopLink(textsTo(paid.email)[1] ?? "");
    expect(link).not.toBe("");
    // A mail scanner that opens the link changes nothing.
    const asked = await app.request(link);
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("Billing emails still come.");
    const forged = await app.request(link.replace(/signature=.+$/, "signature=forged"), {
      method: "POST",
      headers: { "x-forwarded-for": IP },
    });
    expect(forged.status).toBe(404);
    const stopped = await app.request(link, {
      method: "POST",
      headers: { "x-forwarded-for": IP },
    });
    expect(stopped.status).toBe(200);
    const [member] = await owner
      .select({ stoppedAt: workspaceMember.onboardingStoppedAt })
      .from(workspaceMember)
      .where(eq(workspaceMember.workspaceId, paid.workspaceId));
    expect(member?.stoppedAt).not.toBeNull();

    later(ONBOARDING_DAYS.check_in - ONBOARDING_DAYS.install);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due");
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([
      ready(paid),
      "Need a hand adding the chat?",
      `The payment for ${paid.name} didn't go through`,
    ]);
  });

  test("onboarding goes only while the workspace pays and is not failing or ending", async () => {
    const paid = await paidWorkspace({ onboarding: true });
    await lifecycle();
    later(0.5);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due");
    later(ONBOARDING_DAYS.team - 0.5);
    await lifecycle();
    // The install and team emails were due while the payment failed, so they never go.
    await stripeSays(paid.workspaceId, paid.subscriptionId, "active");
    later(ONBOARDING_DAYS.check_in - ONBOARDING_DAYS.team);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "active", {
      cancel_at_period_end: true,
    });
    await lifecycle();
    expect(await sentKinds(paid.workspaceId)).toEqual([
      "ready",
      "payment_failed",
      "payment_recovered",
      "cancellation",
    ]);
  });

  test("a cancellation sends one email, the plan's end sends another 3 days before, and a cancellation after renewing sends again", async () => {
    const paid = await paidWorkspace();
    const end = new Date(clock.getTime() + 20 * DAY_MS);
    const periodEnd = Math.floor(end.getTime() / 1000);
    const cancel = () =>
      stripeSays(paid.workspaceId, paid.subscriptionId, "active", {
        cancel_at_period_end: true,
        current_period_end: periodEnd,
      });
    await cancel();
    await lifecycle();
    await cancel();
    await lifecycle();
    const cancellation = `${paid.name} stays on until ${day(end)}`;
    expect(subjectsTo(paid.email)).toEqual([cancellation]);
    expect(textsTo(paid.email)[0]).toContain("read-only for 90 days");

    // Renewing in the portal, then canceling again, is a new cancellation.
    later(1);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "active", {
      cancel_at_period_end: false,
    });
    await lifecycle();
    later(1);
    await cancel();
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([cancellation, cancellation]);

    later(20 - 2 - ENDING_SOON_DAYS - 0.01);
    await lifecycle();
    expect(subjectsTo(paid.email)).toHaveLength(2);
    later(0.01);
    await lifecycle();
    later(1);
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([
      cancellation,
      cancellation,
      `${paid.name} ends on ${day(end)}`,
    ]);
  });

  test("renewing before the plan ends stops the 3-day email", async () => {
    const paid = await paidWorkspace();
    const end = new Date(clock.getTime() + 20 * DAY_MS);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "active", {
      cancel_at_period_end: true,
      current_period_end: Math.floor(end.getTime() / 1000),
    });
    await lifecycle();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "active", {
      cancel_at_period_end: false,
    });
    later(20 - ENDING_SOON_DAYS);
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([`${paid.name} stays on until ${day(end)}`]);
  });

  test("paying again after read-only sends one welcome back", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    await lifecycle();
    later(10);
    await payCheckout(paid.workspaceId, paid.cookie);
    await lifecycle();
    await lifecycle();
    expect(subjectsTo(paid.email)).toEqual([
      `${paid.name} is now read-only`,
      `Welcome back to ${paid.name}`,
    ]);
    // The warnings of the read-only time that ended never go.
    later(READ_ONLY_DAYS);
    await lifecycle();
    expect(subjectsTo(paid.email)).toHaveLength(2);
    expect(textsTo(paid.email)[0]).toContain("Settings under Export");
  });

  test("two workers that send at once send each email once", async () => {
    const paid = await paidWorkspace({ onboarding: true });
    await Promise.all([lifecycle(), lifecycle(), lifecycle()]);
    later(ONBOARDING_DAYS.install);
    await Promise.all([lifecycle(), lifecycle(), lifecycle()]);
    const failedAt = new Date(clock);
    await stripeSays(paid.workspaceId, paid.subscriptionId, "past_due");
    await Promise.all([lifecycle(), lifecycle(), lifecycle()]);
    later(PAYMENT_REMINDER_DAYS);
    await Promise.all([lifecycle(), lifecycle(), lifecycle()]);
    const payUntil = day(new Date(failedAt.getTime() + GRACE_DAYS * DAY_MS));
    expect(subjectsTo(paid.email)).toEqual([
      ready(paid),
      "Need a hand adding the chat?",
      `The payment for ${paid.name} didn't go through`,
      `${paid.name} keeps working until ${payUntil}`,
    ]);
  });
});

describe("the owner's delete", () => {
  test("cancels the subscription at once, then deletes the workspace and its images", async () => {
    const paid = await paidWorkspace();
    const path = `/v1/operator/workspaces/${paid.workspaceId}`;
    const wrong = await request(app, "DELETE", path, {
      cookie: paid.cookie,
      body: { name: "Not the name" },
    });
    expect(wrong.status).toBe(400);
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toBeNull();

    // Another tab opens a Checkout while the cancel runs, before the deletion commits.
    const webhook = stripe.hooks.afterCancel;
    stripe.hooks.afterCancel = async (ended) => {
      stripe.hooks.afterCancel = webhook;
      await webhook?.(ended);
      const params = new URLSearchParams({ customer: ended.customer });
      stripe.sessions.set("cs_late", { id: "cs_late", url: "http://x/pay/cs_late", params });
    };
    const done = await request(app, "DELETE", path, {
      cookie: paid.cookie,
      body: { name: paid.name },
    });
    expect(done.status).toBe(200);
    expect(stripe.subscriptions.get(paid.subscriptionId)?.status).toBe("canceled");
    expect(await widgetWorkspace(db, paid.key)).toBeNull();
    expect((await request(app, "GET", path, { cookie: paid.cookie })).status).toBe(404);
    // The worker expires it before the purge.
    await purgeUntilGone(paid.workspaceId);
    expect(stripe.sessions.get("cs_late")?.expired).toBe(true);
    expect(await leftovers(paid.workspaceId)).toEqual([]);
    expect(await store.get(paid.storageKey)).toBeNull();
  });

  test("expires an open Checkout, and cancels a subscription that still comes from one", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    await lifecycle();
    const sessionId = await openCheckout(paid);
    const done = await request(app, "DELETE", `/v1/operator/workspaces/${paid.workspaceId}`, {
      cookie: paid.cookie,
      body: { name: paid.name },
    });
    expect(done.status).toBe(200);
    expect(stripe.sessions.get(sessionId)?.expired).toBe(true);

    // A payment that Stripe took just before the expiry, whose webhook comes after the delete.
    const late = stripe.pay(sessionId);
    const response = await deliver(
      stripe.event("checkout.session.completed", {
        object: "checkout.session",
        client_reference_id: paid.workspaceId,
        subscription: late.id,
      }),
    );
    expect(response.status).toBe(200);
    expect(stripe.subscriptions.get(late.id)?.status).toBe("canceled");
    expect((await workspaceRow(paid.workspaceId))?.active).toBe(true);
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).not.toBeNull();
  });

  test("deletes nothing when Stripe cannot cancel", async () => {
    const paid = await paidWorkspace();
    stripe.failures.cancel = 1;
    const response = await request(app, "DELETE", `/v1/operator/workspaces/${paid.workspaceId}`, {
      cookie: paid.cookie,
      body: { name: paid.name },
    });
    expect(response.status).toBe(502);
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toBeNull();
    expect(stripe.subscriptions.get(paid.subscriptionId)?.status).toBe("active");
  });

  // This server has no mail server, so the typed email confirms an account's delete at once.
  const deleteAccount = (paid: { cookie: string; email: string }) =>
    request(app, "POST", "/v1/operator/account/delete", {
      cookie: paid.cookie,
      body: { email: paid.email },
    });

  test("an account delete ends the subscription of a workspace nobody else is in", async () => {
    const paid = await paidWorkspace();
    expect((await deleteAccount(paid)).status).toBe(200);
    expect(stripe.subscriptions.get(paid.subscriptionId)?.status).toBe("canceled");
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).not.toBeNull();
  });

  test("an account delete deletes nothing when Stripe cannot cancel", async () => {
    const paid = await paidWorkspace();
    stripe.failures.cancel = 1;
    const refused = await deleteAccount(paid);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ error: { code: "billing_unavailable" } });
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toBeNull();
    expect(stripe.subscriptions.get(paid.subscriptionId)?.status).toBe("active");
    expect((await request(app, "GET", "/v1/operator/me", { cookie: paid.cookie })).status).toBe(
      200,
    );
  });

  test("an account delete stops when a workspace's last other member left during the cancel", async () => {
    const paid = await paidWorkspace();
    // A second workspace with one member, which would pass to them.
    const created = await request(app, "POST", "/v1/operator/workspaces", {
      cookie: paid.cookie,
      body: { name: "Owner", workspaceName: `Team ${randomUUID().slice(0, 8)}` },
    });
    const { workspaceId: shared } = (await created.json()) as { workspaceId: string };
    const helperCookie = await signIn(app, auth, `helper-${randomUUID()}@example.com`);
    const helperMe = await request(app, "GET", "/v1/operator/me", { cookie: helperCookie });
    const { id: helperId } = (await helperMe.json()) as { id: string };
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: shared, operatorId: helperId, role: "member" });

    // The member leaves while Stripe cancels the paid workspace's subscription.
    const webhook = stripe.hooks.afterCancel;
    stripe.hooks.afterCancel = async (ended) => {
      stripe.hooks.afterCancel = webhook;
      await owner
        .update(workspaceMember)
        .set({ removedAt: new Date() })
        .where(eq(workspaceMember.operatorId, helperId));
      await webhook?.(ended);
    };
    const refused = await deleteAccount(paid);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "team_changed" } });
    expect((await workspaceRow(shared))?.deletedAt).toBeNull();
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toBeNull();

    // Again: both workspaces now go with the account.
    expect((await deleteAccount(paid)).status).toBe(200);
    expect((await workspaceRow(shared))?.deletedAt).not.toBeNull();
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).not.toBeNull();
    // Gone, so the purge counts in the tests below start from nothing.
    await purgeUntilGone(paid.workspaceId);
    await purgeUntilGone(shared);
  });

  test("a Checkout made after the deletion commits is expired before the purge", async () => {
    const paid = await paidWorkspace();
    const customer = (await row(paid.workspaceId))?.stripeCustomerId ?? "";
    const response = await request(app, "DELETE", `/v1/operator/workspaces/${paid.workspaceId}`, {
      cookie: paid.cookie,
      body: { name: paid.name },
    });
    expect(response.status).toBe(200);
    // A Checkout request that was already running makes its session after the commit.
    const params = new URLSearchParams({ customer });
    stripe.sessions.set("cs_after", { id: "cs_after", url: "http://x/pay/cs_after", params });

    // The purge waits for the worker, and the worker waits out any request still running.
    expect(await purgeDeletedWorkspaces(workerDb)).toBe(0);
    await lifecycle();
    expect(stripe.sessions.get("cs_after")?.expired).toBeUndefined();
    expect(await purgeDeletedWorkspaces(workerDb)).toBe(0);
    expect(await leftovers(paid.workspaceId)).toContain("subscription");

    clock = new Date(clock.getTime() + BILLING_CLEAR_DELAY_MS);
    await lifecycle();
    expect(stripe.sessions.get("cs_after")?.expired).toBe(true);
    expect((await row(paid.workspaceId))?.billingClearedAt).toEqual(clock);
    await purgeUntilGone(paid.workspaceId);
    expect(await leftovers(paid.workspaceId)).toEqual([]);
  });

  test("a Stripe failure while clearing a deleted workspace's billing keeps its rows, and retries", async () => {
    const paid = await paidWorkspace();
    const customer = (await row(paid.workspaceId))?.stripeCustomerId ?? "";
    const response = await request(app, "DELETE", `/v1/operator/workspaces/${paid.workspaceId}`, {
      cookie: paid.cookie,
      body: { name: paid.name },
    });
    expect(response.status).toBe(200);
    const params = new URLSearchParams({ customer });
    stripe.sessions.set("cs_retry", { id: "cs_retry", url: "http://x/pay/cs_retry", params });
    clock = new Date(clock.getTime() + BILLING_CLEAR_DELAY_MS);
    stripe.failures.expire = 1;
    await lifecycle();
    expect(stripe.sessions.get("cs_retry")?.expired).toBeUndefined();
    expect((await row(paid.workspaceId))?.billingClearedAt).toBeNull();
    expect(await purgeDeletedWorkspaces(workerDb)).toBe(0);
    expect(await leftovers(paid.workspaceId)).toEqual(
      expect.arrayContaining(["subscription", "conversation", "message"]),
    );

    // The next pass tries again.
    await lifecycle();
    expect(stripe.sessions.get("cs_retry")?.expired).toBe(true);
    expect((await row(paid.workspaceId))?.billingClearedAt).not.toBeNull();
    await purgeUntilGone(paid.workspaceId);
    expect(await leftovers(paid.workspaceId)).toEqual([]);
  });

  test("a customer deleted in Stripe does not block the owner's delete or the purge", async () => {
    const paid = await paidWorkspace();
    stripe.deleteCustomer((await row(paid.workspaceId))?.stripeCustomerId ?? "");
    const response = await request(app, "DELETE", `/v1/operator/workspaces/${paid.workspaceId}`, {
      cookie: paid.cookie,
      body: { name: paid.name },
    });
    expect(response.status).toBe(200);
    clock = new Date(clock.getTime() + BILLING_CLEAR_DELAY_MS);
    await lifecycle();
    expect((await row(paid.workspaceId))?.billingClearedAt).not.toBeNull();
    await purgeUntilGone(paid.workspaceId);
    expect(await leftovers(paid.workspaceId)).toEqual([]);
  });

  test("a customer deleted in Stripe does not block the deletion after the read-only time", async () => {
    const paid = await paidWorkspace();
    await stripeSays(paid.workspaceId, paid.subscriptionId, "canceled");
    await lifecycle();
    stripe.deleteCustomer((await row(paid.workspaceId))?.stripeCustomerId ?? "");
    later(READ_ONLY_DAYS);
    await lifecycle();
    expect((await workspaceRow(paid.workspaceId))?.deletedAt).toEqual(clock);
  });

  test("a customer that other keys cannot see is never counted as cleared", async () => {
    const paid = await paidWorkspace();
    const customer = (await row(paid.workspaceId))?.stripeCustomerId ?? "";
    const response = await request(app, "DELETE", `/v1/operator/workspaces/${paid.workspaceId}`, {
      cookie: paid.cookie,
      body: { name: paid.name },
    });
    expect(response.status).toBe(200);
    // The keys changed: Stripe answers 404 for a customer that still exists elsewhere.
    stripe.customers.splice(stripe.customers.indexOf(customer), 1);
    clock = new Date(clock.getTime() + BILLING_CLEAR_DELAY_MS);
    await lifecycle();
    expect((await row(paid.workspaceId))?.billingClearedAt).toBeNull();
    expect(await purgeDeletedWorkspaces(workerDb)).toBe(0);
  });
});

/**
 * Runs the real worker until the workspace row is gone: billing first, then data, then images,
 * then the row. The clock moves past the wait before billing is cleared. The self-hosted case,
 * with no cloud, is in apps/server/src/workspace-delete.test.ts.
 */
async function purgeUntilGone(workspaceId: string) {
  clock = new Date(clock.getTime() + BILLING_CLEAR_DELAY_MS);
  const worker = startWorker({
    db: workerDb,
    logger,
    publicUrl: PUBLIC_URL,
    secret: AUTH_SECRET,
    store,
    pollMs: 20,
    lifecycleMs: 20,
    cloud: { billing: { ...keys(), apiBase: stripe.apiBase } },
    signals: createSignals(valkey, logger),
  });
  try {
    const deadline = Date.now() + 10_000;
    while ((await workspaceRow(workspaceId)) !== undefined) {
      if (Date.now() > deadline) throw new Error("The workspace was not purged");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await worker.stop();
  }
  expect(await readdir(join(directory, "images", workspaceId)).catch(() => [])).toEqual([]);
}

async function leftoversCount(workspaceId: string) {
  return (await conversationsOf(workspaceId)).length;
}
