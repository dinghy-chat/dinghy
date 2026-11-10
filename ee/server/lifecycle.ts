// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import {
  and,
  type Column,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Logger } from "pino";
import {
  lifecycleEmail,
  type lifecycleEmailKind,
  operator,
  subscription,
  visitor,
  workspace,
  workspaceMember,
} from "../../apps/server/src/db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { letter } from "../../apps/server/src/letter.ts";
import type { Mailer } from "../../apps/server/src/mailer.ts";
import { recordBillingChange } from "../../apps/server/src/messages.ts";
import type { Billing } from "./billing.ts";
import { lifecycleMail, onboardingStopUrl } from "./lifecycle-emails.ts";

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
export const GRACE_DAYS = 7;
/** Read-only time after the subscription ended or the grace ran out, before deletion. */
export const READ_ONLY_DAYS = 90;
/** How long before deletion the owners get the first warning, and the last one. */
export const FIRST_DELETION_WARNING_DAYS = 30;
export const DELETION_WARNING_DAYS = 7;
/** How many days after a failed payment the owners get a reminder. The last day gets one too. */
export const PAYMENT_REMINDER_DAYS = 3;
/** How long before a canceled plan ends the owners hear about it again. */
export const ENDING_SOON_DAYS = 3;
/** The onboarding emails, by days after the first payment. */
export const ONBOARDING_DAYS = { install: 1, team: 3, check_in: 7, review: 30 } as const;

const DAY_MS = 86_400_000;
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

/** The stored fields that decide a workspace's billing state. */
export interface LifecycleRow {
  status: string | null;
  paidAt: Date | null;
  paymentFailedAt: Date | null;
  readOnlyAt: Date | null;
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

type Step = "read_only" | "delete";

/**
 * The next thing the worker does for a subscription, from stored times and Stripe's status alone.
 * A signup that never paid has none: it stays a pending workspace.
 */
export function nextStep(row: LifecycleRow, now: Date): Step | null {
  if (row.paidAt === null) return null;
  if (row.readOnlyAt === null) {
    if (row.status !== null && ENDED.has(row.status)) return "read_only";
    if (row.paymentFailedAt !== null && now >= addDays(row.paymentFailedAt, GRACE_DAYS)) {
      return "read_only";
    }
    return null;
  }
  return now >= addDays(row.readOnlyAt, READ_ONLY_DAYS) ? "delete" : null;
}

type LifecycleEmailKind = (typeof lifecycleEmailKind.enumValues)[number];

/** An email to queue: once per kind and occurrence, sent by the worker from `dueAt` on. */
export interface QueuedEmail {
  kind: LifecycleEmailKind;
  occurrenceAt: Date;
  dueAt: Date;
}

const on = (kind: LifecycleEmailKind, occurrenceAt: Date, days = 0): QueuedEmail => ({
  kind,
  occurrenceAt,
  dueAt: addDays(occurrenceAt, days),
});

/** The fields that a Stripe change compares with, read under the row's lock before it writes. */
export type BillingBefore = Pick<
  LifecycleRow,
  "paidAt" | "paymentFailedAt" | "readOnlyAt" | "cancelAtPeriodEnd"
>;

/** The emails that a change of Stripe's state starts, from the state before it and after it. */
export function billingEmails(
  before: BillingBefore | undefined,
  after: { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null },
  at: Date,
): QueuedEmail[] {
  if (FAILING.has(after.status)) {
    // A repeated failure keeps the first time, and so its emails.
    const failed =
      before?.paymentFailedAt != null || before?.readOnlyAt != null
        ? []
        : [
            on("payment_failed", at),
            on("payment_reminder", at, PAYMENT_REMINDER_DAYS),
            on("payment_last_day", at, GRACE_DAYS - 1),
          ];
    // An owner can still cancel while a payment fails, and the workspace still works then.
    return [...failed, ...cancellationEmails(before, after, at)];
  }
  if (!PAID.has(after.status)) return [];
  const emails: QueuedEmail[] = [];
  if (before?.paidAt == null) {
    emails.push(on("ready", at));
    for (const [kind, days] of Object.entries(ONBOARDING_DAYS) as [LifecycleEmailKind, number][]) {
      emails.push(on(kind, at, days));
    }
  } else if (before.readOnlyAt !== null) {
    emails.push({ kind: "welcome_back", occurrenceAt: before.readOnlyAt, dueAt: at });
  } else if (before.paymentFailedAt !== null) {
    emails.push({ kind: "payment_recovered", occurrenceAt: before.paymentFailedAt, dueAt: at });
  }
  return [...emails, ...cancellationEmails(before, after, at)];
}

/** A new cancellation's emails: now, and a reminder before the end unless the end is close. */
function cancellationEmails(
  before: BillingBefore | undefined,
  after: { cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null },
  at: Date,
): QueuedEmail[] {
  if (!after.cancelAtPeriodEnd || before?.cancelAtPeriodEnd === true) return [];
  const emails = [on("cancellation", at)];
  const end = after.currentPeriodEnd;
  // A cancellation in the last days already says when the plan ends.
  if (end !== null && addDays(end, -ENDING_SOON_DAYS) > at) {
    emails.push(on("ending_soon", end, -ENDING_SOON_DAYS));
  }
  return emails;
}

/** The emails that going read-only starts: now, then the two warnings before deletion. */
const readOnlyEmails = (readOnlyAt: Date): QueuedEmail[] => [
  on("read_only", readOnlyAt),
  on("deletion_30", readOnlyAt, READ_ONLY_DAYS - FIRST_DELETION_WARNING_DAYS),
  on("deletion_7", readOnlyAt, READ_ONLY_DAYS - DELETION_WARNING_DAYS),
];

/** Queues emails in the caller's transaction, so they commit with the change that caused them. */
export async function queueEmails(
  tx: Transaction,
  workspaceId: string,
  emails: QueuedEmail[],
): Promise<void> {
  if (emails.length === 0) return;
  await tx
    .insert(lifecycleEmail)
    .values(emails.map((email) => ({ workspaceId, ...email })))
    .onConflictDoNothing();
}

/**
 * The rules of `nextStep` as a filter, so the batch limit applies only to rows with work due.
 * Rows with nothing due would otherwise fill every batch and hold back the ones after them.
 */
function dueBy(now: Date) {
  const ago = (days: number) => addDays(now, -days).toISOString();
  const ended = inArray(subscription.status, [...ENDED]);
  return sql`${subscription.paidAt} is not null and (
    (${subscription.readOnlyAt} is null and (
      ${ended} or ${subscription.paymentFailedAt} <= ${ago(GRACE_DAYS)}::timestamptz
    ))
    or ${subscription.readOnlyAt} <= ${ago(READ_ONLY_DAYS)}::timestamptz
  )`;
}

interface LifecycleOptions {
  db: Database;
  billing: Billing;
  logger: Logger;
  mailer?: Mailer | undefined;
  publicUrl: string;
  /** Signs the stop link in onboarding emails. */
  secret: string;
  /** Where the 30-day email asks for a review. Without it, the email asks for a reply instead. */
  reviewUrl?: string | undefined;
  batch?: number;
}

/** How long a worker holds a row it acts on, so a crashed worker's rows come back. */
const CLAIM_MS = 10 * 60_000;
/** An email that reached no owner stops retrying after this. The purge waits as long for one. */
const GIVE_UP_MS = 3 * DAY_MS;

const columns = {
  workspaceId: subscription.workspaceId,
  customerId: subscription.stripeCustomerId,
  status: subscription.status,
  paidAt: subscription.paidAt,
  paymentFailedAt: subscription.paymentFailedAt,
  readOnlyAt: subscription.readOnlyAt,
  currentPeriodEnd: subscription.currentPeriodEnd,
  cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
};

type Claimed = LifecycleRow & { workspaceId: string; customerId: string };

/**
 * The column holds this time. A Date keeps milliseconds, and node-postgres truncates the
 * microseconds that Postgres keeps, so both sides are truncated alike.
 */
const sameTime = (column: Column, value: Date | null) =>
  value === null
    ? isNull(column)
    : sql`date_trunc('milliseconds', ${column}) = ${value.toISOString()}::timestamptz`;

/**
 * One pass over the subscriptions that have lifecycle work. It claims rows with SKIP LOCKED and a
 * claim time, so two workers never act on the same one, and acts with no transaction open. Then it
 * sends the emails that are due. Returns how many subscriptions it acted on.
 */
export async function runLifecycle(options: LifecycleOptions): Promise<number> {
  const { db, billing, logger, batch = 20 } = options;
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
        .set({ claimedUntil: new Date(now.getTime() + CLAIM_MS) })
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
  await sendLifecycleEmails({ ...options, now });
  await clearDeletedBilling(db, billing, logger);
  return claimed.length;

  async function act(row: Claimed) {
    const step = nextStep(row, now);
    if (step === "read_only") await makeReadOnly(row);
    if (step === "delete") await deleteAfterCheck(row);
  }

  async function makeReadOnly(row: Claimed) {
    // A payment whose webhook never came keeps the workspace, even after a cancellation: the
    // owner may have paid again through a new Checkout. After 7 days of failed payments, Dinghy
    // ends the subscription itself, so a late retry never charges for a read-only workspace and
    // paying again is always a new Checkout.
    if (await keptByPayment(row)) return;
    if (row.status !== null && !ENDED.has(row.status)) await billing.cancelAll(row.customerId);
    const written = await withWorkspace(db, row.workspaceId, async (tx) => {
      // The guards name the fields that decide the step, not the revision, because the webhook of
      // the worker's own cancel moves it. A payment since the claim clears the failure or makes the
      // status paid, and stops this.
      const rows = await tx
        .update(subscription)
        .set({ readOnlyAt: now, claimedUntil: null })
        .where(
          and(
            eq(subscription.workspaceId, row.workspaceId),
            isNull(subscription.readOnlyAt),
            sameTime(subscription.paidAt, row.paidAt),
            sameTime(subscription.paymentFailedAt, row.paymentFailedAt),
            or(isNull(subscription.status), notInArray(subscription.status, [...PAID])),
          ),
        )
        .returning({ id: subscription.workspaceId });
      if (rows.length === 0) return false;
      // In the same commit, so an inbox that misses the signal still finds it from its cursor.
      await recordBillingChange(tx, row.workspaceId);
      await queueEmails(tx, row.workspaceId, readOnlyEmails(now));
      return true;
    });
    if (!written) return;
    billing.changed(row.workspaceId);
    logger.info({ workspaceId: row.workspaceId }, "a workspace became read-only");
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
            sameTime(subscription.readOnlyAt, row.readOnlyAt),
          ),
        )
        .for("update");
      if (unchanged === undefined || row.readOnlyAt === null) return false;
      const marked = await tx
        .update(workspace)
        .set({ deletedAt: now })
        .where(and(eq(workspace.id, row.workspaceId), isNull(workspace.deletedAt)))
        .returning({ id: workspace.id });
      if (marked.length === 0) return false;
      // The owners stay members until the purge, so the email still reaches them after this.
      await queueEmails(tx, row.workspaceId, [
        { kind: "deleted", occurrenceAt: row.readOnlyAt, dueAt: now },
      ]);
      return true;
    });
    if (deleted) {
      logger.info(
        { workspaceId: row.workspaceId },
        "a workspace was deleted after its read-only time",
      );
    }
  }
}

type ClaimedEmail = typeof lifecycleEmail.$inferSelect;

const isEmail = (email: ClaimedEmail) =>
  and(
    eq(lifecycleEmail.workspaceId, email.workspaceId),
    eq(lifecycleEmail.kind, email.kind),
    sameTime(lifecycleEmail.occurrenceAt, email.occurrenceAt),
  );

/** What decides whether a queued email still holds, read when it is due. */
interface EmailState extends LifecycleRow {
  isDeleted: boolean;
  hasWidgetVisitor: boolean;
}

const same = (a: Date | null, b: Date) => a?.getTime() === b.getTime();

/** Whether the reason for the email still holds. A payment, for one, stops a reminder. */
function stillHolds(email: ClaimedEmail, state: EmailState): boolean {
  const paid = state.status !== null && PAID.has(state.status);
  const live = !state.isDeleted && state.readOnlyAt === null;
  // Onboarding goes only to a workspace that pays and is neither failing nor ending.
  const settled = paid && live && state.paymentFailedAt === null && !state.cancelAtPeriodEnd;
  const failing = state.status !== null && FAILING.has(state.status);
  switch (email.kind) {
    case "ready":
    case "welcome_back":
      return paid && live;
    case "install":
      return settled && !state.hasWidgetVisitor;
    case "team":
    case "check_in":
    case "review":
      return settled;
    case "cancellation":
      return (paid || failing) && live && state.cancelAtPeriodEnd;
    case "ending_soon":
      return (
        (paid || failing) &&
        live &&
        state.cancelAtPeriodEnd &&
        same(state.currentPeriodEnd, email.occurrenceAt)
      );
    case "payment_failed":
    case "payment_reminder":
    case "payment_last_day":
      return failing && live && same(state.paymentFailedAt, email.occurrenceAt);
    case "payment_recovered":
      return paid && live && state.paymentFailedAt === null;
    case "read_only":
    case "deletion_30":
    case "deletion_7":
      return !state.isDeleted && same(state.readOnlyAt, email.occurrenceAt);
    case "deleted":
      return state.isDeleted && same(state.readOnlyAt, email.occurrenceAt);
  }
}

/** The workspace's name, state and owners, for one due email. */
async function loadEmailState(tx: Transaction, email: ClaimedEmail) {
  const { workspaceId } = email;
  const [found] = await tx
    .select({
      name: workspace.name,
      deletedAt: workspace.deletedAt,
      status: subscription.status,
      paidAt: subscription.paidAt,
      paymentFailedAt: subscription.paymentFailedAt,
      readOnlyAt: subscription.readOnlyAt,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    })
    .from(workspace)
    .innerJoin(subscription, eq(subscription.workspaceId, workspace.id))
    .where(eq(workspace.id, workspaceId));
  if (found === undefined) return undefined;
  const owners = await tx
    .select({
      operatorId: operator.id,
      email: operator.email,
      name: operator.name,
      onboardingStoppedAt: workspaceMember.onboardingStoppedAt,
    })
    .from(workspaceMember)
    .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.role, "owner"),
        isNull(workspaceMember.removedAt),
      ),
    );
  // Nothing records a widget load itself. A visitor gets a browser token on their first message,
  // and a last-seen time when a widget stream ends, so either one means the widget ran on a site.
  // An early signup's sample visitor has neither.
  const widgetVisitors =
    email.kind === "install"
      ? await tx
          .select({ id: visitor.id })
          .from(visitor)
          .where(
            and(
              eq(visitor.workspaceId, workspaceId),
              or(isNotNull(visitor.tokenHash), isNotNull(visitor.lastSeenAt)),
            ),
          )
          .limit(1)
      : [];
  const state: EmailState = {
    ...found,
    isDeleted: found.deletedAt !== null,
    hasWidgetVisitor: widgetVisitors.length > 0,
  };
  return { name: found.name, state, owners };
}

/**
 * Sends the queued emails that are due. It claims them with SKIP LOCKED and a claim time, as the
 * lifecycle claims its rows, so two workers never send the same one. A failed send keeps it
 * queued, and the claim's end retries it: delivery is at least once.
 */
async function sendLifecycleEmails({
  db,
  logger,
  mailer,
  publicUrl,
  secret,
  reviewUrl,
  batch = 20,
  now,
}: LifecycleOptions & { now: Date }): Promise<void> {
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(lifecycleEmail)
      .where(
        and(
          isNull(lifecycleEmail.sentAt),
          lte(lifecycleEmail.dueAt, now),
          or(isNull(lifecycleEmail.claimedUntil), lt(lifecycleEmail.claimedUntil, now)),
        ),
      )
      .orderBy(lifecycleEmail.dueAt)
      .limit(batch)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      await tx
        .update(lifecycleEmail)
        .set({ claimedUntil: new Date(now.getTime() + CLAIM_MS) })
        .where(isEmail(row));
    }
    return rows;
  });
  for (const email of claimed) {
    try {
      await sendOne(email);
    } catch (err) {
      logger.warn(
        { err, workspaceId: email.workspaceId, kind: email.kind },
        "a billing email failed and will retry",
      );
    }
  }

  async function sendOne(email: ClaimedEmail) {
    const found = await withWorkspace(db, email.workspaceId, (tx) => loadEmailState(tx, email));
    if (found === undefined || !stillHolds(email, found.state)) return drop(email);
    const isOnboarding = email.kind in ONBOARDING_DAYS;
    const recipients = found.owners.filter(
      (owner) => !isOnboarding || owner.onboardingStoppedAt === null,
    );
    if (recipients.length === 0) return drop(email);
    if (mailer === undefined) {
      logger.info(
        { workspaceId: email.workspaceId, kind: email.kind },
        "this server has no SMTP, so a billing email was not sent",
      );
    }
    let delivered = 0;
    let lastError: unknown;
    for (const owner of mailer === undefined ? [] : recipients) {
      const mail = lifecycleMail(email.kind, {
        name: found.name,
        settingsUrl: `${publicUrl.replace(/\/$/, "")}/?workspace=${email.workspaceId}`,
        signInUrl: publicUrl,
        reviewUrl,
        stopUrl: isOnboarding
          ? onboardingStopUrl(publicUrl, secret, email.workspaceId, owner.operatorId)
          : undefined,
        days: MAIL_DAYS,
        ...emailDates(email, found.state),
      });
      // Each owner signed in with a link to this address, so their own name is safe here.
      try {
        await mailer?.send(owner.email, mail.subject, letter(mail.body, owner.name), mail.headers);
        delivered += 1;
      } catch (err) {
        lastError = err;
        logger.warn(
          { err, workspaceId: email.workspaceId, kind: email.kind },
          "a billing email did not reach one owner",
        );
      }
    }
    // One owner who got it is enough, so a bad address never repeats it for the others. When
    // nobody got it, it retries after the claim, but not past a few days of a broken mail server.
    if (mailer !== undefined && delivered === 0) {
      if (now.getTime() - email.dueAt.getTime() < GIVE_UP_MS) throw lastError;
      logger.error(
        { workspaceId: email.workspaceId, kind: email.kind },
        "a billing email reached no owner for days, so it stops retrying",
      );
    }
    await withWorkspace(db, email.workspaceId, (tx) =>
      tx.update(lifecycleEmail).set({ sentAt: now, claimedUntil: null }).where(isEmail(email)),
    );
  }

  /** The reason passed before the email was due, so it never goes. */
  async function drop(email: ClaimedEmail) {
    await withWorkspace(db, email.workspaceId, (tx) =>
      tx.delete(lifecycleEmail).where(isEmail(email)),
    );
  }
}

/** The numbers of days that the emails name. */
const MAIL_DAYS = { readOnly: READ_ONLY_DAYS };

/** The dates an email names, from its occurrence and the workspace's state. */
function emailDates(email: ClaimedEmail, state: EmailState) {
  return {
    payUntil: addDays(email.occurrenceAt, GRACE_DAYS),
    deleteOn: addDays(email.occurrenceAt, READ_ONLY_DAYS),
    endsOn: email.kind === "ending_soon" ? email.occurrenceAt : state.currentPeriodEnd,
  };
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
