import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gt, inArray, isNotNull, isNull, lte, type SQL, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  TWO_FACTOR_REMOVAL_BLOCK_DAYS,
  TWO_FACTOR_REMOVAL_FRESH_MINUTES,
  TWO_FACTOR_REMOVAL_WAIT_HOURS,
} from "../../../packages/widget/src/shared.ts";
import { sendToOperator } from "./alerts.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { confirmUrl } from "./auth.ts";
import { operator, operatorTwoFactor, session, twoFactorRemoval } from "./db/schema.ts";
import {
  type Database,
  lockAccount,
  operatorWorkspaces,
  type Transaction,
  withWorkspace,
} from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  jsonAnswer,
  jsonBody,
  LINK_INVALID,
  OPERATOR_POST_ERRORS,
  okContent,
  RATE_LIMITED,
  safeErrorFields,
  UNAUTHORIZED,
  WRONG_ORIGIN,
  WRONG_ORIGIN_TEXT,
} from "./errors.ts";
import { sha256Hex } from "./identity.ts";
import {
  removalCancelledMail,
  removalReminderMail,
  removalRequestedMail,
  removalUnconfirmedMail,
  teamRemovalDoneMail,
  teamRemovalMail,
  twoFactorOffMail,
} from "./letter.ts";
import { OPERATORS, type Signals } from "./live.ts";
import { type Mail, type Mailer, sendQuietly } from "./mailer.ts";
import { recordTeamChange } from "./messages.ts";
import type { Push } from "./push.ts";
import { retryDelayMs } from "./retry.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./time.ts";

// The policy of a removal request. The operator app names the shared ones, and the emails get
// the numbers from here.
const WAIT_HOURS = TWO_FACTOR_REMOVAL_WAIT_HOURS;
const REMINDER_HOURS = 24;
const BLOCK_DAYS = TWO_FACTOR_REMOVAL_BLOCK_DAYS;
const FRESH_MINUTES = TWO_FACTOR_REMOVAL_FRESH_MINUTES;
const WAIT_MS = WAIT_HOURS * HOUR_MS;
const REMINDER_MS = REMINDER_HOURS * HOUR_MS;
const BLOCK_MS = BLOCK_DAYS * DAY_MS;
/**
 * Only a session that an email link made this recently starts a request: every session starts from
 * a link, and an old one left open at the code screen is not proof of the mailbox now.
 */
const FRESH_SESSION_MS = FRESH_MINUTES * MINUTE_MS;

/** Requests one worker pass warns or completes. Each completion is its own transaction. */
const WORKER_BATCH = 10;
/** How long a claimed warning stays with one worker before another may send it. */
const WARNING_CLAIM_MS = 2 * MINUTE_MS;

const text = {
  pushTitle: "Dinghy",
  pushBody:
    "Someone asked to remove two-step sign-in from your account. Wasn't you? Open Dinghy to cancel the request.",
};

const NOT_NEEDED = failure(
  "removal_not_needed",
  "This session passed the check, or two-step sign-in is off.",
);
const SIGN_IN_AGAIN = failure(
  "sign_in_again",
  `Sign in again with a new email link, then ask within ${FRESH_MINUTES} minutes.`,
);
const BLOCKED = failure(
  "removal_blocked",
  `A request was cancelled in the last ${BLOCK_DAYS} days, so a new one cannot start yet.`,
);
const MANUAL_REVIEW = failure(
  "manual_review",
  "This server can't confirm the request on its own. Ask the person who runs it to turn off two-step sign-in for you.",
);
const NO_REMOVAL = failure("no_removal", "No removal request waits for this account.");

/** A removal request waits until it is cancelled or completed. */
const REMOVAL_WAITS = and(
  isNull(twoFactorRemoval.cancelledAt),
  isNull(twoFactorRemoval.completedAt),
);

/** The account's waiting removal request, if any. A query may name the account by its column. */
export const waitingRemoval = (operatorId: string | SQL) =>
  and(eq(twoFactorRemoval.operatorId, operatorId), REMOVAL_WAITS);

/** A request completes only after its first warning went out, and once its wait ended. */
const REMOVAL_DUE = and(
  REMOVAL_WAITS,
  isNotNull(twoFactorRemoval.warnedAt),
  lte(twoFactorRemoval.completesAt, sql`now()`),
);

/** A key for the cancel tokens alone, so a token cannot stand in for any other secret. */
const cancelKey = (authSecret: string) =>
  Buffer.from(hkdfSync("sha256", authSecret, "", "dinghy two-factor removal cancel", 32));

/**
 * The cancel link's token, made from the request's ID. The reminder makes the same link again, so
 * the database holds only its hash, and the token needs AUTH_SECRET.
 */
const cancelToken = (key: Buffer, requestId: string) =>
  createHmac("sha256", key).update(requestId).digest("base64url");

/** The owners and admins of the account's workspaces, but the account itself. */
async function managersOf(db: Database | Transaction, operatorId: string) {
  const result = await db.execute<{ email: string; name: string }>(
    sql`select email, name from operator_managers(${operatorId})`,
  );
  return result.rows;
}

/**
 * Whether someone besides the mailbox can stop a request: an owner or admin of one of the account's
 * workspaces, or a session of the account that passed the check and has not expired. A push
 * subscription alone does not count, because nothing proves that it still reaches a device.
 */
/** Whether a current session of the account passed the check: a device that can stop a request. */
async function hasCheckedSession(db: Database | Transaction, operatorId: string): Promise<boolean> {
  const [found] = await db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.userId, operatorId),
        isNotNull(session.twoFactorAt),
        gt(session.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return found !== undefined;
}

async function canBeStopped(tx: Transaction, operatorId: string): Promise<boolean> {
  const result = await tx.execute<{ found: boolean }>(
    sql`select exists (select 1 from operator_managers(${operatorId})) as found`,
  );
  return result.rows[0]?.found === true || (await hasCheckedSession(tx, operatorId));
}

/**
 * Removes two-step sign-in for an account that lost its app and its recovery codes: the secret and
 * every recovery code go, not only the flag, so nothing of the old setup can pass again. Every
 * session ends, so one that waited at the second step does not pass without it, a waiting removal
 * request ends, and the next sign-in asks to turn it on again. A completed request, a teammate's
 * reset and the server's admin all remove it this way. Lock the account first, with lockAccount.
 * Returns false, changing nothing, when it was off.
 */
export async function removeTwoFactor(tx: Transaction, operatorId: string): Promise<boolean> {
  const removed = await tx
    .delete(operatorTwoFactor)
    .where(
      and(eq(operatorTwoFactor.operatorId, operatorId), isNotNull(operatorTwoFactor.enabledAt)),
    )
    .returning({ operatorId: operatorTwoFactor.operatorId });
  if (removed.length === 0) return false;
  await tx
    .update(operator)
    .set({ twoFactorOn: false, asksTwoFactorAgain: true })
    .where(eq(operator.id, operatorId));
  await tx.delete(session).where(eq(session.userId, operatorId));
  await tx
    .update(twoFactorRemoval)
    .set({ completedAt: new Date() })
    .where(waitingRemoval(operatorId));
  return true;
}

/**
 * Cancels the account's waiting removal request. Whoever cancels holds a code, a session that
 * passed or the link, so the request likely came from someone who reads the mailbox: the sessions
 * that never passed the check end with it. Returns false when none waited.
 */
export async function cancelRemoval(tx: Transaction, operatorId: string): Promise<boolean> {
  // The account first, in the order that a code's check and a removal lock them.
  await lockAccount(tx, operatorId);
  const cancelled = await tx
    .update(twoFactorRemoval)
    .set({ cancelledAt: new Date() })
    .where(waitingRemoval(operatorId))
    .returning({ id: twoFactorRemoval.id });
  if (cancelled.length === 0) return false;
  await tx.delete(session).where(and(eq(session.userId, operatorId), isNull(session.twoFactorAt)));
  return true;
}

/**
 * Records `team.changed` in each of the account's workspaces and wakes their streams: the Team
 * pages mark the request, and the account's own open apps read `me` again for the banner. A lost
 * signal loses nothing: both read again when they open.
 */
async function signalAccount(db: Database, signals: Signals, operatorId: string): Promise<void> {
  for (const { workspaceId } of await operatorWorkspaces(db, operatorId)) {
    await withWorkspace(db, workspaceId, (tx) => recordTeamChange(tx, workspaceId));
    signals.wake(workspaceId, OPERATORS);
  }
}

/** Signals after the answer: what committed stays, whatever Valkey does. */
function signalQuietly(db: Database, signals: Signals, logger: Logger, operatorId: string) {
  signalAccount(db, signals, operatorId).catch((err: unknown) => {
    logger.warn(safeErrorFields(err), "could not signal a two-step sign-in change");
  });
}

/**
 * After a cancel commits: the audit line, an email that the mailbox is likely stolen, and the
 * signals.
 */
export function afterRemovalCancel(
  {
    db,
    signals,
    logger,
    mailer,
  }: { db: Database; signals: Signals; logger: Logger; mailer: Mailer | undefined },
  account: { id: string; email: string },
  by: "code" | "link" | "session",
  ip: string,
): void {
  audit(logger, "two_factor.removal_cancelled", { operatorId: account.id, by, ip });
  sendQuietly(mailer, logger, account.email, removalCancelledMail(BLOCK_DAYS));
  signalQuietly(db, signals, logger, account.id);
}

type RemovalAsk =
  | { kind: "waiting"; completesAt: Date }
  | { kind: "started"; completesAt: Date }
  | { kind: "signed_out" }
  | { kind: "not_needed" }
  | { kind: "sign_in_again" }
  | { kind: "blocked" }
  | { kind: "manual_review" };

/**
 * Starts a request, unless one waits, which this leaves as it is, or a cancel blocks new ones. It
 * starts only when someone besides the mailbox can stop it. Everything is read again under the
 * account's lock, so a teammate's reset or a code that passed meanwhile wins, and two asks at once
 * start one request. The worker sends the warnings.
 */
function startRemoval(
  db: Database,
  key: Buffer,
  operatorId: string,
  sessionId: string,
): Promise<RemovalAsk> {
  return db.transaction(async (tx): Promise<RemovalAsk> => {
    await lockAccount(tx, operatorId);
    const [asking] = await tx
      .select({
        createdAt: session.createdAt,
        hasPassed: sql<boolean>`${session.twoFactorAt} is not null`,
        twoFactorOn: operator.twoFactorOn,
      })
      .from(session)
      .innerJoin(operator, eq(operator.id, session.userId))
      .where(and(eq(session.id, sessionId), gt(session.expiresAt, sql`now()`)));
    if (asking === undefined) return { kind: "signed_out" };
    if (asking.hasPassed || !asking.twoFactorOn) return { kind: "not_needed" };
    if (Date.now() - asking.createdAt.getTime() >= FRESH_SESSION_MS) {
      return { kind: "sign_in_again" };
    }
    const [waiting] = await tx
      .select({ completesAt: twoFactorRemoval.completesAt })
      .from(twoFactorRemoval)
      .where(waitingRemoval(operatorId));
    if (waiting !== undefined) return { kind: "waiting", completesAt: waiting.completesAt };
    const [cancelled] = await tx
      .select({ id: twoFactorRemoval.id })
      .from(twoFactorRemoval)
      .where(
        and(
          eq(twoFactorRemoval.operatorId, operatorId),
          gt(twoFactorRemoval.cancelledAt, new Date(Date.now() - BLOCK_MS)),
        ),
      )
      .limit(1);
    if (cancelled !== undefined) return { kind: "blocked" };
    if (!(await canBeStopped(tx, operatorId))) return { kind: "manual_review" };
    const id = randomUUID();
    const completesAt = new Date(Date.now() + WAIT_MS);
    await tx.insert(twoFactorRemoval).values({
      id,
      operatorId,
      completesAt,
      cancelTokenHash: sha256Hex(cancelToken(key, id)),
    });
    return { kind: "started", completesAt };
  });
}

const RemovalAnswer = z.object({
  completesAt: z.string().openapi({
    description:
      "When two-step sign-in is removed, unless someone cancels. The wait counts from the first warning, so it can move by the time that warning takes",
  }),
});

const requestRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/removal",
  security: SESSION,
  summary: `Ask to remove two-step sign-in after ${WAIT_HOURS} hours, for an operator who lost their authenticator app and their recovery codes. Only a session that has not passed the check, and that an email link made in the last ${FRESH_MINUTES} minutes. The worker warns the account, its devices and the owners and admins of its workspaces, and any of them can stop it. While a request waits, a new one changes nothing`,
  responses: {
    200: jsonAnswer("The request that waits", RemovalAnswer),
    ...OPERATOR_POST_ERRORS,
    409: errorAnswer(
      `removal_not_needed: this session passed the check, or two-step sign-in is off. sign_in_again: the session is older than ${FRESH_MINUTES} minutes. removal_blocked: a request was cancelled in the last ${BLOCK_DAYS} days. manual_review: no other owner or admin, and no session of theirs that passed the check, can stop it, or the server sends no email, so the server's admin must remove it`,
    ),
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/removal/cancel",
  security: SESSION,
  summary: `Cancel the account's waiting removal request, from a session that passed the check. Sessions that never passed it end, and no new request can start for ${BLOCK_DAYS} days`,
  responses: {
    200: { description: "The request is cancelled", content: okContent },
    ...OPERATOR_POST_ERRORS,
    409: errorAnswer("no_removal: no removal request waits"),
  },
});

const cancelByLinkRoute = createRoute({
  method: "post",
  path: "/v1/account/two-factor-removal/cancel",
  summary: `Cancel a waiting removal request with the token from its email's link, from the button on the page the link opens. Sessions that never passed the check end, and no new request can start for ${BLOCK_DAYS} days`,
  request: { body: jsonBody(z.strictObject({ token: z.string().min(1).max(200) })) },
  responses: {
    200: { description: "The request is cancelled", content: okContent },
    400: errorAnswer(
      "invalid_request: the request is not valid. link_invalid: the request already ended, or the link is wrong",
    ),
    403: errorAnswer(WRONG_ORIGIN_TEXT),
    ...RATE_LIMITED,
  },
});

const skipPromptRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/skip-prompt",
  security: SESSION,
  summary:
    "Stop asking to turn two-step sign-in on again, after a removal request or a reset removed it",
  responses: {
    200: { description: "The prompt is gone", content: okContent },
    ...OPERATOR_POST_ERRORS,
  },
});

interface RemovalOptions {
  db: Database;
  live: Signals;
  logger: Logger;
  /** Without one, nobody can be warned by email, so every request goes to manual review. */
  mailer: Mailer | undefined;
  publicUrl: string;
  /** AUTH_SECRET, which the cancel tokens derive from. */
  authSecret: string;
}

/**
 * The removal routes. Register them after the operator routes' session check, and after the
 * rate limit and body limit of /v1/account/, which the cancel link's route uses.
 */
export function registerRemovalRoutes(
  app: App,
  { db, live, logger, mailer, publicUrl, authSecret }: RemovalOptions,
) {
  const key = cancelKey(authSecret);
  const notices = { db, signals: live, logger, mailer };
  const publicOrigin = new URL(publicUrl).origin;

  app.openapi(requestRoute, async (c) => {
    if (c.get("twoFactor") !== "required") return c.json(NOT_NEEDED, 409);
    if (mailer === undefined) return c.json(MANUAL_REVIEW, 409);
    const operatorId = c.get("operatorId");
    const request = await startRemoval(db, key, operatorId, c.get("sessionId"));
    if (request.kind === "signed_out") return c.json(UNAUTHORIZED, 401);
    if (request.kind === "not_needed") return c.json(NOT_NEEDED, 409);
    if (request.kind === "sign_in_again") return c.json(SIGN_IN_AGAIN, 409);
    if (request.kind === "blocked") return c.json(BLOCKED, 409);
    if (request.kind === "manual_review") return c.json(MANUAL_REVIEW, 409);
    if (request.kind === "started") {
      audit(logger, "two_factor.removal_requested", { operatorId, ip: c.get("clientIp") });
      signalQuietly(db, live, logger, operatorId);
    }
    return c.json({ completesAt: request.completesAt.toISOString() }, 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const operatorId = c.get("operatorId");
    if (!(await db.transaction((tx) => cancelRemoval(tx, operatorId)))) {
      return c.json(NO_REMOVAL, 409);
    }
    afterRemovalCancel(
      notices,
      { id: operatorId, email: c.get("operatorEmail") },
      "session",
      c.get("clientIp"),
    );
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(skipPromptRoute, async (c) => {
    await db
      .update(operator)
      .set({ asksTwoFactorAgain: false })
      .where(eq(operator.id, c.get("operatorId")));
    return c.json({ ok: true as const }, 200);
  });

  // Only this POST cancels, never a GET of the link, because mail scanners open links.
  app.openapi(cancelByLinkRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const [found] = await db
      .select({ operatorId: twoFactorRemoval.operatorId, email: operator.email })
      .from(twoFactorRemoval)
      .innerJoin(operator, eq(operator.id, twoFactorRemoval.operatorId))
      .where(
        and(
          eq(twoFactorRemoval.cancelTokenHash, sha256Hex(c.req.valid("json").token)),
          REMOVAL_WAITS,
        ),
      );
    // The token ends with its request: one that completed or was cancelled finds nothing here.
    if (found === undefined) return c.json(LINK_INVALID, 400);
    if (!(await db.transaction((tx) => cancelRemoval(tx, found.operatorId)))) {
      return c.json(LINK_INVALID, 400);
    }
    afterRemovalCancel(
      notices,
      { id: found.operatorId, email: found.email },
      "link",
      c.get("clientIp"),
    );
    return c.json({ ok: true as const }, 200);
  });
}

interface RemovalStepOptions {
  db: Database;
  logger: Logger;
  mailer: Mailer | undefined;
  push: Push | undefined;
  signals: Signals;
  publicUrl: string;
  /** AUTH_SECRET, which the cancel tokens derive from. */
  secret: string;
  /** The first wait before a failed warning is sent again. It doubles with each failure. */
  retryMs: number;
}

interface ClaimedWarning {
  id: string;
  operatorId: string;
  isWarned: boolean;
  attempts: number;
}

/**
 * The worker's part. The warnings go out at least once: a claim holds a request for a while, and
 * the request is marked warned only after its sends succeed, so a crash or a failed send sends
 * again later. The first warning goes to the account, its devices and the owners and admins of its
 * workspaces, and the wait counts from it. The reminder goes to the account a day before the end.
 * A request completes only once its first warning went out.
 */
export function removalWorkerStep({
  db,
  logger,
  mailer,
  push,
  signals,
  publicUrl,
  secret,
  retryMs,
}: RemovalStepOptions) {
  const key = cancelKey(secret);

  /** Claims due warnings and commits, so no transaction stays open during a send. */
  const claimWarnings = (): Promise<ClaimedWarning[]> => {
    const due = db
      .select({ id: twoFactorRemoval.id })
      .from(twoFactorRemoval)
      .where(and(REMOVAL_WAITS, lte(twoFactorRemoval.nextWarningAt, sql`now()`)))
      .orderBy(twoFactorRemoval.nextWarningAt)
      .limit(WORKER_BATCH)
      .for("update", { skipLocked: true });
    return db
      .update(twoFactorRemoval)
      .set({
        warningAttempts: sql`${twoFactorRemoval.warningAttempts} + 1`,
        nextWarningAt: new Date(Date.now() + WARNING_CLAIM_MS),
      })
      .where(inArray(twoFactorRemoval.id, due))
      .returning({
        id: twoFactorRemoval.id,
        operatorId: twoFactorRemoval.operatorId,
        isWarned: sql<boolean>`${twoFactorRemoval.warnedAt} is not null`,
        attempts: twoFactorRemoval.warningAttempts,
      });
  };

  // The attempts check means a worker that outlived its claim cannot change the next one's row.
  const held = (row: ClaimedWarning) =>
    and(
      eq(twoFactorRemoval.id, row.id),
      eq(twoFactorRemoval.warningAttempts, row.attempts),
      REMOVAL_WAITS,
    );

  const send = async (to: string, mail: Mail) => {
    if (mailer === undefined) throw new Error("This worker has no mail server");
    await mailer.send(to, mail.subject, mail.body);
  };

  /**
   * Throws when the account's email fails, or when every owner and admin's email fails. False,
   * sending nothing, when nobody but the mailbox can be warned any more: the last other owner or
   * admin left, and no session of the account passed the check since the request.
   */
  const sendFirstWarning = async (
    row: ClaimedWarning,
    account: { name: string; email: string },
  ): Promise<boolean> => {
    const managers = await managersOf(db, row.operatorId);
    if (managers.length === 0 && !(await hasCheckedSession(db, row.operatorId))) return false;
    if (push !== undefined) {
      const payload = { title: text.pushTitle, body: text.pushBody, tag: "two-factor-removal" };
      // An extra channel: its failure does not hold the warning back.
      await sendToOperator(db, push, row.operatorId, { ...payload, url: "/" }).catch(
        (err: unknown) => logger.warn(safeErrorFields(err), "could not push a removal warning"),
      );
    }
    const url = confirmUrl(publicUrl, "cancel-removal", cancelToken(key, row.id));
    const [own, ...team] = await Promise.allSettled([
      send(account.email, removalRequestedMail(url, WAIT_HOURS)),
      ...managers.map((manager) => send(manager.email, teamRemovalMail(account, WAIT_HOURS))),
    ]);
    if (own?.status === "rejected") throw own.reason;
    const failed = team.filter((result) => result.status === "rejected");
    if (failed.length > 0 && failed.length === team.length) throw failed[0]?.reason;
    for (const result of failed) {
      logger.warn(safeErrorFields(result.reason), "a removal warning did not reach one manager");
    }
    return true;
  };

  const warnOne = async (row: ClaimedWarning) => {
    const [account] = await db
      .select({ name: operator.name, email: operator.email })
      .from(operator)
      .where(eq(operator.id, row.operatorId));
    // The account's delete removes its requests too.
    if (account === undefined) return;
    if (row.isWarned) {
      const url = confirmUrl(publicUrl, "cancel-removal", cancelToken(key, row.id));
      await send(account.email, removalReminderMail(url, REMINDER_HOURS));
      await db
        .update(twoFactorRemoval)
        .set({ remindedAt: new Date(), nextWarningAt: null, warningAttempts: 0 })
        .where(held(row));
      return;
    }
    if (!(await sendFirstWarning(row, account))) {
      // Only the mailbox would know, and the mailbox is what the request doubts: manual review.
      const [ended] = await db
        .delete(twoFactorRemoval)
        .where(held(row))
        .returning({ id: twoFactorRemoval.id });
      if (ended === undefined) return;
      audit(logger, "two_factor.removal_unconfirmed", { operatorId: row.operatorId });
      await send(account.email, removalUnconfirmedMail());
      await signalAccount(db, signals, row.operatorId);
      return;
    }
    const warnedAt = Date.now();
    const [marked] = await db
      .update(twoFactorRemoval)
      .set({
        warnedAt: new Date(warnedAt),
        completesAt: new Date(warnedAt + WAIT_MS),
        nextWarningAt: new Date(warnedAt + WAIT_MS - REMINDER_MS),
        warningAttempts: 0,
      })
      .where(held(row))
      .returning({ id: twoFactorRemoval.id });
    // The banner shows the end, which moved.
    if (marked !== undefined) await signalAccount(db, signals, row.operatorId);
  };

  const warn = async () => {
    const claimed = await claimWarnings();
    for (const row of claimed) {
      try {
        await warnOne(row);
      } catch (err) {
        logger.warn(safeErrorFields(err), "a removal warning failed and will retry");
        await db
          .update(twoFactorRemoval)
          .set({ nextWarningAt: new Date(Date.now() + retryDelayMs(retryMs, row.attempts)) })
          .where(held(row));
      }
    }
    return claimed.length > 0;
  };

  /**
   * Removes it, unless a cancel, a code or another worker came first, and returns the account's
   * name and email. The account's row decides.
   */
  const complete = (request: { id: string; operatorId: string }) =>
    db.transaction(async (tx) => {
      const account = await lockAccount(tx, request.operatorId);
      const [claimed] = await tx
        .update(twoFactorRemoval)
        .set({ completedAt: new Date() })
        .where(and(eq(twoFactorRemoval.id, request.id), REMOVAL_DUE))
        .returning({ id: twoFactorRemoval.id });
      if (account === undefined || claimed === undefined) return null;
      return (await removeTwoFactor(tx, request.operatorId)) ? account : null;
    });

  const completeDue = async () => {
    const due = await db
      .select({ id: twoFactorRemoval.id, operatorId: twoFactorRemoval.operatorId })
      .from(twoFactorRemoval)
      .where(REMOVAL_DUE)
      .limit(WORKER_BATCH);
    for (const request of due) {
      const account = await complete(request);
      if (account === null) continue;
      audit(logger, "two_factor.removal_completed", { operatorId: request.operatorId });
      // Each email after the commit: a mail server that fails changes nothing here.
      sendQuietly(mailer, logger, account.email, twoFactorOffMail("removal"));
      for (const manager of await managersOf(db, request.operatorId)) {
        sendQuietly(mailer, logger, manager.email, teamRemovalDoneMail(account));
      }
      // The Team pages drop the mark, and the account's streams end with its sessions.
      await signalAccount(db, signals, request.operatorId);
    }
    return due.length > 0;
  };

  return async () => {
    const warned = await warn();
    return (await completeDue()) || warned;
  };
}
