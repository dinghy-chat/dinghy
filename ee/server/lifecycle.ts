// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import {
  and,
  type Column,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Logger } from "pino";
import {
  operator,
  subscription,
  workspace,
  workspaceMember,
} from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { letter } from "../../apps/server/src/letter.ts";
import type { Mailer } from "../../apps/server/src/mailer.ts";
import { recordBillingChange } from "../../apps/server/src/messages.ts";
import type { Billing } from "./billing.ts";

/**
 * Stripe's subscription statuses that pay for service. This set and the two below live in this
 * module, which billing.ts imports, so the two modules do not import each other at run time.
 */
export const PAID = new Set(["active", "trialing"]);
/** A payment failed and Stripe retries it. Service goes on for the grace period. */
export const FAILING = new Set(["past_due", "unpaid"]);
/** Stripe's list of subscriptions leaves out canceled ones, and these two never charge again. */
export const ENDED = new Set(["canceled", "incomplete_expired"]);

/** Full service after the first failed payment, while Stripe retries it. */
export const GRACE_DAYS = 14;
/** Read-only time after the subscription ended or the grace ran out, before deletion. */
export const READ_ONLY_DAYS = 30;
/** How long before deletion the owners get a last warning. */
export const DELETION_WARNING_DAYS = 7;

const DAY_MS = 86_400_000;
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

type Notice = "payment_failed" | "read_only" | "deletion_soon";

/** The stored fields that decide a workspace's billing state. */
export interface LifecycleRow {
  status: string | null;
  paidAt: Date | null;
  paymentFailedAt: Date | null;
  readOnlyAt: Date | null;
  notice: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

type BillingStateName = "pending" | "active" | "ending" | "payment_failed" | "read_only";

/** What the owner sees in Settings, and how they would pay again. */
export function billingState(
  active: boolean,
  row: LifecycleRow | null,
  now: Date,
): { state: BillingStateName; date: string | null; payWith: "checkout" | "portal" } {
  const day = (date: Date | null) => date?.toISOString() ?? null;
  // A new subscription comes from Checkout. A live one that failed is paid in Stripe's portal.
  const payWith =
    row === null || row.status === null || ENDED.has(row.status) ? "checkout" : "portal";
  if (row?.readOnlyAt != null) {
    // The worker ended the subscription when the workspace became read-only.
    return {
      state: "read_only",
      date: day(addDays(row.readOnlyAt, READ_ONLY_DAYS)),
      payWith: "checkout",
    };
  }
  if (!active || row === null) return { state: "pending", date: null, payWith };
  if (row.paymentFailedAt !== null) {
    return {
      state: "payment_failed",
      date: day(addDays(row.paymentFailedAt, GRACE_DAYS)),
      payWith,
    };
  }
  // Ended, and the worker has not made it read-only yet.
  if (row.status !== null && ENDED.has(row.status)) {
    return { state: "ending", date: day(now), payWith };
  }
  return {
    state: row.cancelAtPeriodEnd ? "ending" : "active",
    date: day(row.currentPeriodEnd),
    payWith,
  };
}

const NOTICE_ORDER: (string | null)[] = [null, "payment_failed", "read_only", "deletion_soon"];
const sent = (row: LifecycleRow, notice: Notice) =>
  NOTICE_ORDER.indexOf(row.notice) >= NOTICE_ORDER.indexOf(notice);

type Step = { kind: "read_only" } | { kind: "delete" } | { kind: "notice"; notice: Notice };

/**
 * The next thing the worker does for a subscription, from stored times and Stripe's status alone.
 * A signup that never paid has none: it stays a pending workspace.
 */
export function nextStep(row: LifecycleRow, now: Date): Step | null {
  if (row.paidAt === null) return null;
  if (row.readOnlyAt === null) {
    if (row.status !== null && ENDED.has(row.status)) return { kind: "read_only" };
    if (row.paymentFailedAt === null) return null;
    if (now >= addDays(row.paymentFailedAt, GRACE_DAYS)) return { kind: "read_only" };
    if (row.status !== null && FAILING.has(row.status) && !sent(row, "payment_failed")) {
      return { kind: "notice", notice: "payment_failed" };
    }
    return null;
  }
  const deleteAt = addDays(row.readOnlyAt, READ_ONLY_DAYS);
  if (now >= deleteAt) return { kind: "delete" };
  if (now >= addDays(deleteAt, -DELETION_WARNING_DAYS)) {
    return sent(row, "deletion_soon") ? null : { kind: "notice", notice: "deletion_soon" };
  }
  return sent(row, "read_only") ? null : { kind: "notice", notice: "read_only" };
}

const date = (value: Date) => value.toISOString().slice(0, 10);

// Plain text. Every string has a key here, so a locale can be added later.
const text = {
  paymentFailedSubject: (name: string) => `The payment for ${name} didn't go through`,
  paymentFailedBody: (name: string, until: Date, url: string) => [
    `The payment for your Dinghy workspace ${name} didn't go through. Stripe will try again on ` +
      "its own.",
    `Everything keeps working until ${date(until)}. If no payment clears by then, the workspace ` +
      "turns read-only: the chat widget goes off and nobody can reply.",
    `You can update the card in Settings, under Billing: ${url}`,
  ],
  readOnlySubject: (name: string) => `${name} is now read-only`,
  readOnlyBody: (name: string, deleteOn: Date, url: string) => [
    `Your Dinghy workspace ${name} no longer has a paid subscription, so it's read-only now. The ` +
      "chat widget is off. Your team can still sign in, read conversations and download an " +
      "export, but nobody can reply.",
    `Pay again and you get everything back, with all its data: ${url}`,
    `If nobody pays, the workspace and all its data are deleted on ${date(deleteOn)}.`,
  ],
  deletionSubject: (name: string, deleteOn: Date) => `${name} will be deleted on ${date(deleteOn)}`,
  deletionBody: (name: string, deleteOn: Date, url: string) => [
    `Your Dinghy workspace ${name} has been read-only since its subscription ended. On ` +
      `${date(deleteOn)}, the workspace and all its data, images included, are deleted for good.`,
    `To keep it, pay again: ${url}`,
    "If you'd rather keep a copy, download an export in Settings before then.",
  ],
};

function noticeMail(notice: Notice, name: string, row: LifecycleRow, url: string) {
  if (notice === "payment_failed") {
    const until = addDays(row.paymentFailedAt ?? new Date(), GRACE_DAYS);
    return {
      subject: text.paymentFailedSubject(name),
      body: text.paymentFailedBody(name, until, url),
    };
  }
  const deleteOn = addDays(row.readOnlyAt ?? new Date(), READ_ONLY_DAYS);
  if (notice === "read_only") {
    return { subject: text.readOnlySubject(name), body: text.readOnlyBody(name, deleteOn, url) };
  }
  return {
    subject: text.deletionSubject(name, deleteOn),
    body: text.deletionBody(name, deleteOn, url),
  };
}

/** Where the notice stands in NOTICE_ORDER, in SQL. An unknown one counts as none sent. */
const noticeRank = sql`case ${subscription.notice}
  when 'payment_failed' then 1 when 'read_only' then 2 when 'deletion_soon' then 3 else 0 end`;

/**
 * The rules of `nextStep` as a filter, so the batch limit applies only to rows with work due.
 * Rows with nothing due would otherwise fill every batch and hold back the ones after them.
 */
function dueBy(now: Date) {
  const ago = (days: number) => addDays(now, -days).toISOString();
  const ended = inArray(subscription.status, [...ENDED]);
  const failing = inArray(subscription.status, [...FAILING]);
  return sql`${subscription.paidAt} is not null and (
    (${subscription.readOnlyAt} is null and (
      ${ended}
      or ${subscription.paymentFailedAt} <= ${ago(GRACE_DAYS)}::timestamptz
      or (${subscription.paymentFailedAt} is not null and ${failing} and ${noticeRank} < 1)
    ))
    or (${subscription.readOnlyAt} is not null and (
      (${subscription.readOnlyAt} <= ${ago(READ_ONLY_DAYS - DELETION_WARNING_DAYS)}::timestamptz
        and ${noticeRank} < 3)
      or ${subscription.readOnlyAt} <= ${ago(READ_ONLY_DAYS)}::timestamptz
      or ${noticeRank} < 2
    ))
  )`;
}

interface LifecycleOptions {
  db: Database;
  billing: Billing;
  logger: Logger;
  mailer?: Mailer | undefined;
  publicUrl: string;
  /** How long a claim lasts, so a crashed worker's rows come back. */
  claimMs?: number;
  batch?: number;
}

const columns = {
  workspaceId: subscription.workspaceId,
  customerId: subscription.stripeCustomerId,
  status: subscription.status,
  paidAt: subscription.paidAt,
  paymentFailedAt: subscription.paymentFailedAt,
  readOnlyAt: subscription.readOnlyAt,
  notice: subscription.notice,
  currentPeriodEnd: subscription.currentPeriodEnd,
  cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
};

type Claimed = LifecycleRow & { workspaceId: string; customerId: string };

/**
 * The column still holds the time the worker read. A Date keeps milliseconds, and node-postgres
 * truncates the microseconds that Postgres keeps, so both sides are truncated alike.
 */
const still = (column: Column, value: Date | null) =>
  value === null
    ? isNull(column)
    : sql`date_trunc('milliseconds', ${column}) = ${value.toISOString()}::timestamptz`;

/**
 * One pass over the subscriptions that have lifecycle work. It claims rows with SKIP LOCKED and a
 * claim time, so two workers never act on the same one, and acts with no transaction open.
 * Returns how many it acted on.
 */
export async function runLifecycle({
  db,
  billing,
  logger,
  mailer,
  publicUrl,
  claimMs = 10 * 60_000,
  batch = 20,
}: LifecycleOptions): Promise<number> {
  const now = billing.now();
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select(columns)
      .from(subscription)
      .where(
        and(or(isNull(subscription.claimedUntil), lt(subscription.claimedUntil, now)), dueBy(now)),
      )
      .orderBy(subscription.workspaceId)
      .limit(batch)
      .for("update", { skipLocked: true });
    const due = rows.filter((row) => nextStep(row, now) !== null);
    for (const row of due) {
      await tx
        .update(subscription)
        .set({ claimedUntil: new Date(now.getTime() + claimMs) })
        .where(eq(subscription.workspaceId, row.workspaceId));
    }
    return due;
  });

  for (const row of claimed) {
    try {
      await act(row);
    } catch (err) {
      // The claim runs out, and a later pass tries again.
      logger.warn({ err, workspaceId: row.workspaceId }, "a lifecycle step failed and will retry");
    }
  }
  await clearDeletedBilling(db, billing, logger);
  return claimed.length;

  /**
   * Writes only while `unchanged` holds, and can let the row go. The guards name the fields that
   * decide the step, not the revision, because the webhook of the worker's own cancel moves it.
   */
  async function finish(
    row: Claimed,
    change: Partial<typeof subscription.$inferInsert>,
    unchanged: SQL | undefined,
    { release = true, billingChanged = false } = {},
  ) {
    const written = await withWorkspace(db, row.workspaceId, async (tx) => {
      const rows = await tx
        .update(subscription)
        .set({ ...change, ...(release && { claimedUntil: null }) })
        .where(and(eq(subscription.workspaceId, row.workspaceId), unchanged))
        .returning({ id: subscription.workspaceId });
      // In the same commit, so an inbox that misses the signal still finds it from its cursor.
      if (rows.length > 0 && billingChanged) await recordBillingChange(tx, row.workspaceId);
      return rows.length > 0;
    });
    if (written && billingChanged) billing.changed(row.workspaceId);
    return written;
  }

  async function act(row: Claimed) {
    const step = nextStep(row, now);
    if (step === null) return;
    if (step.kind === "read_only") {
      // A payment whose webhook never came keeps the workspace, even after a cancellation: the
      // owner may have paid again through a new Checkout. After 14 days of failed payments,
      // Dinghy ends the subscription itself, so a late retry never charges for a read-only
      // workspace and paying again is always a new Checkout.
      if (await keptByPayment(row)) return;
      if (row.status !== null && !ENDED.has(row.status)) await billing.cancelAll(row.customerId);
      // The claim stays for the email that follows, so no other worker sends it too.
      // A payment since the claim clears the failure or makes the status paid, and stops this.
      const stillDue = and(
        isNull(subscription.readOnlyAt),
        still(subscription.paidAt, row.paidAt),
        still(subscription.paymentFailedAt, row.paymentFailedAt),
        or(isNull(subscription.status), notInArray(subscription.status, [...PAID])),
      );
      if (
        await finish(row, { readOnlyAt: now }, stillDue, { release: false, billingChanged: true })
      ) {
        logger.info({ workspaceId: row.workspaceId }, "a workspace became read-only");
        await act({ ...row, readOnlyAt: now });
      }
      return;
    }
    if (step.kind === "delete") {
      await deleteAfterCheck(row);
      return;
    }
    await sendNotice(row, step.notice);
  }

  /** Stripe is the record: a payment whose webhook never came, or a new subscription, keeps it. */
  async function keptByPayment(row: Claimed): Promise<boolean> {
    if (await billing.customerGone(row.customerId)) return false;
    const live = (await billing.listSubscriptions(row.customerId)).find((one) =>
      PAID.has(one.status ?? ""),
    );
    if (live === undefined) return false;
    logger.warn({ workspaceId: row.workspaceId }, "a paid subscription stopped a lifecycle step");
    await billing.apply(null, row.workspaceId, live.id);
    await withWorkspace(db, row.workspaceId, (tx) =>
      tx
        .update(subscription)
        .set({ claimedUntil: null })
        .where(eq(subscription.workspaceId, row.workspaceId)),
    );
    return true;
  }

  async function deleteAfterCheck(row: Claimed) {
    if (await keptByPayment(row)) return;
    // A subscription that still retries a payment would charge for a deleted workspace.
    await billing.cancelAll(row.customerId);
    const deleted = await withWorkspace(db, row.workspaceId, async (tx) => {
      const [unchanged] = await tx
        .select({ id: subscription.workspaceId })
        .from(subscription)
        .where(
          and(
            eq(subscription.workspaceId, row.workspaceId),
            // A payment clears the read-only time. The cancel above moves only the revision.
            still(subscription.readOnlyAt, row.readOnlyAt),
          ),
        )
        .for("update");
      if (unchanged === undefined) return false;
      await tx
        .update(workspace)
        .set({ deletedAt: now })
        .where(and(eq(workspace.id, row.workspaceId), isNull(workspace.deletedAt)));
      return true;
    });
    if (deleted) {
      logger.info(
        { workspaceId: row.workspaceId },
        "a workspace was deleted after its read-only time",
      );
    }
  }

  async function sendNotice(row: Claimed, notice: Notice) {
    const found = await withWorkspace(db, row.workspaceId, async (tx) => {
      const [named] = await tx
        .select({ name: workspace.name })
        .from(workspace)
        .where(eq(workspace.id, row.workspaceId));
      const owners = await tx
        .select({ email: operator.email, name: operator.name })
        .from(workspaceMember)
        .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
        .where(
          and(
            eq(workspaceMember.workspaceId, row.workspaceId),
            eq(workspaceMember.role, "owner"),
            isNull(workspaceMember.removedAt),
          ),
        );
      return { name: named?.name ?? "", owners };
    });
    if (mailer === undefined) {
      logger.info(
        { workspaceId: row.workspaceId, notice },
        "this server has no SMTP, so a billing email was not sent",
      );
    } else {
      const url = `${publicUrl.replace(/\/$/, "")}/?workspace=${row.workspaceId}`;
      const mail = noticeMail(notice, found.name, row, url);
      // A failure leaves the notice unsent, and the claim's end retries it: at least once.
      for (const to of found.owners) {
        // Each owner signed in with a link to this address, so their own name is safe here.
        await mailer.send(to.email, mail.subject, letter(mail.body, to.name));
      }
    }
    await finish(
      row,
      { notice },
      and(
        still(subscription.readOnlyAt, row.readOnlyAt),
        still(subscription.paymentFailedAt, row.paymentFailedAt),
      ),
    );
  }
}

/**
 * How long after a deletion its billing is cleared: longer than any Checkout request that was
 * already running then takes with its Stripe calls.
 */
export const BILLING_CLEAR_DELAY_MS = 2 * 60_000;
const CLEAR_BATCH = 100;

/**
 * Expires the Checkouts and cancels the subscriptions of each deleted workspace that still has a
 * Stripe customer, once the deletion is old enough that no Checkout started before it is still being
 * made. The purge keeps the workspace until this has worked, and a failure is tried again on the
 * next pass. Two workers may both clear one workspace: each step is safe to repeat.
 */
async function clearDeletedBilling(db: Database, billing: Billing, logger: Logger): Promise<void> {
  const cutoff = new Date(billing.now().getTime() - BILLING_CLEAR_DELAY_MS);
  const due = await db.execute<{ workspace_id: string; stripe_customer_id: string }>(
    sql`select workspace_id, stripe_customer_id
        from deleted_billing_to_clear(${cutoff.toISOString()}::timestamptz, ${CLEAR_BATCH})`,
  );
  for (const { workspace_id: workspaceId, stripe_customer_id: customerId } of due.rows) {
    try {
      await billing.cancelAll(customerId);
      await withWorkspace(db, workspaceId, (tx) =>
        tx
          .update(subscription)
          .set({ billingClearedAt: billing.now() })
          .where(eq(subscription.workspaceId, workspaceId)),
      );
    } catch (err) {
      logger.warn(
        { err, workspaceId },
        "a deleted workspace's billing was not cleared, will retry",
      );
    }
  }
}
