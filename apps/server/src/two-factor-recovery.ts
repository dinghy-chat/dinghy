import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { sendToOperator } from "./alerts.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { confirmUrl } from "./auth.ts";
import { operator, pushSubscription, session, twoFactorRecovery } from "./db/schema.ts";
import type { Database, Transaction } from "./db/tenant.ts";
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
  WRONG_ORIGIN,
} from "./errors.ts";
import { sha256Hex } from "./identity.ts";
import {
  RECOVERY_BLOCK_DAYS,
  RECOVERY_REMINDER_HOURS,
  RECOVERY_WAIT_HOURS,
  recoveryReminderMail,
  recoveryRequestedMail,
  teamRecoveryDoneMail,
  teamRecoveryMail,
  twoFactorOffMail,
} from "./letter.ts";
import type { Live } from "./live.ts";
import type { Mailer } from "./mailer.ts";
import type { Push } from "./push.ts";
import { limitByIp, type RateLimit } from "./rate-limit.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./time.ts";
import {
  afterRecoveryCancel,
  cancelRecovery,
  lockAccount,
  RECOVERY_WAITS,
  type RecoveryNotices,
  removeTwoFactor,
  signalTeams,
  waitingRecovery,
} from "./two-factor.ts";

/**
 * Only a session that an email link made this recently starts a request: every session starts from
 * a link, and an old one left open at the code screen is not proof of the mailbox now.
 */
const FRESH_SESSION_MS = 15 * MINUTE_MS;
const RECOVERY_WAIT_MS = RECOVERY_WAIT_HOURS * HOUR_MS;
const REMINDER_MS = RECOVERY_REMINDER_HOURS * HOUR_MS;
const BLOCK_MS = RECOVERY_BLOCK_DAYS * DAY_MS;
/** Recoveries one worker pass completes. Each is its own transaction. */
const COMPLETE_BATCH = 10;
/** Cancel attempts by link that one address may make in a minute. */
const CANCELS_PER_MINUTE = 20;
const TOKEN_BODY_MAX_BYTES = 8 * 1024;

const text = {
  pushTitle: "Dinghy",
  pushBody:
    "Someone asked to remove two-step sign-in from your account. Wasn't you? Open Dinghy to cancel it.",
};

const NOT_NEEDED = failure(
  "recovery_not_needed",
  "This session passed the check, or two-step sign-in is off.",
);
const SIGN_IN_AGAIN = failure(
  "sign_in_again",
  "Sign in again with a new email link, then ask within 15 minutes.",
);
const BLOCKED = failure(
  "recovery_blocked",
  `A recovery was cancelled in the last ${RECOVERY_BLOCK_DAYS} days, so a new one cannot start yet.`,
);
const MANUAL_REVIEW = failure(
  "manual_review",
  "Nobody else can be warned, so this recovery needs a manual review.",
);
const NO_RECOVERY = failure("no_recovery", "No recovery waits for this account.");

/** A key for the cancel tokens alone, so a token cannot stand in for any other secret. */
const cancelKey = (authSecret: string) =>
  Buffer.from(hkdfSync("sha256", authSecret, "", "dinghy two-factor recovery cancel", 32));

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

/** A device of the account that passed the check: a push subscription, or a session that passed. */
async function hasCheckedDevice(tx: Transaction, operatorId: string): Promise<boolean> {
  const result = await tx.execute<{ found: boolean }>(sql`select
    exists (select 1 from ${pushSubscription} where ${pushSubscription.operatorId} = ${operatorId})
    or exists (select 1 from ${session} where ${session.userId} = ${operatorId}
               and ${session.twoFactorAt} is not null and ${session.expiresAt} > now()) as found`);
  return result.rows[0]?.found === true;
}

async function isFreshSession(db: Database, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ createdAt: session.createdAt })
    .from(session)
    .where(eq(session.id, sessionId));
  return row !== undefined && Date.now() - row.createdAt.getTime() < FRESH_SESSION_MS;
}

type RecoveryAsk =
  | { kind: "waiting"; completesAt: Date }
  | { kind: "started"; id: string; completesAt: Date; managers: { email: string; name: string }[] }
  | { kind: "blocked" }
  | { kind: "manual_review" };

/**
 * Starts a request, unless one waits, which this leaves as it is, or a cancel blocks new ones. It
 * starts only when someone besides the mailbox can stop it: another owner or admin, or a device
 * that passed the check. The account's row is locked first, so two asks at once start one request.
 */
function startRecovery(db: Database, key: Buffer, operatorId: string): Promise<RecoveryAsk> {
  return db.transaction(async (tx): Promise<RecoveryAsk> => {
    await lockAccount(tx, operatorId);
    const [waiting] = await tx
      .select({ completesAt: twoFactorRecovery.completesAt })
      .from(twoFactorRecovery)
      .where(waitingRecovery(operatorId));
    if (waiting !== undefined) return { kind: "waiting", completesAt: waiting.completesAt };
    const [cancelled] = await tx
      .select({ id: twoFactorRecovery.id })
      .from(twoFactorRecovery)
      .where(
        and(
          eq(twoFactorRecovery.operatorId, operatorId),
          gt(twoFactorRecovery.cancelledAt, new Date(Date.now() - BLOCK_MS)),
        ),
      )
      .limit(1);
    if (cancelled !== undefined) return { kind: "blocked" };
    const managers = await managersOf(tx, operatorId);
    if (managers.length === 0 && !(await hasCheckedDevice(tx, operatorId))) {
      return { kind: "manual_review" };
    }
    const id = randomUUID();
    const completesAt = new Date(Date.now() + RECOVERY_WAIT_MS);
    await tx.insert(twoFactorRecovery).values({
      id,
      operatorId,
      completesAt,
      cancelTokenHash: sha256Hex(cancelToken(key, id)),
    });
    return { kind: "started", id, completesAt, managers };
  });
}

/** Sends one email after the answer: a mail server that fails changes nothing that committed. */
function sendLater(
  mailer: Mailer,
  logger: Logger,
  to: string,
  mail: { subject: string; body: string },
) {
  mailer.send(to, mail.subject, mail.body).catch((err: unknown) => {
    logger.error(safeErrorFields(err), "could not send a two-step sign-in recovery email");
  });
}

const RecoveryAnswer = z.object({
  completesAt: z
    .string()
    .openapi({ description: "When two-step sign-in is removed, unless someone cancels" }),
});

const requestRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/recovery",
  security: SESSION,
  summary: `Ask to remove two-step sign-in after ${RECOVERY_WAIT_HOURS} hours, for an operator who lost their authenticator app and their recovery codes. Only a session that has not passed the check, and that an email link made in the last 15 minutes. The account, its devices and the owners and admins of its workspaces are warned, and any of them can stop it. While a request waits, a new one changes nothing`,
  responses: {
    200: jsonAnswer("The request that waits", RecoveryAnswer),
    ...OPERATOR_POST_ERRORS,
    409: errorAnswer(
      `recovery_not_needed: this session passed the check, or two-step sign-in is off. sign_in_again: the session is older than 15 minutes. recovery_blocked: a recovery was cancelled in the last ${RECOVERY_BLOCK_DAYS} days. manual_review: nobody else can be warned, or the server sends no email, so the server's admin must remove it`,
    ),
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/recovery/cancel",
  security: SESSION,
  summary:
    "Cancel the account's waiting recovery, from a session that passed the check. Sessions that never passed it end, and no new request can start for 7 days",
  responses: {
    200: { description: "The recovery is cancelled", content: okContent },
    ...OPERATOR_POST_ERRORS,
    409: errorAnswer("no_recovery: no recovery waits"),
  },
});

const cancelByLinkRoute = createRoute({
  method: "post",
  path: "/v1/two-factor-recovery/cancel",
  summary:
    "Cancel a waiting recovery with the token from its email's link, from the button on the page the link opens. Sessions that never passed the check end, and no new request can start for 7 days",
  request: { body: jsonBody(z.strictObject({ token: z.string().min(1).max(200) })) },
  responses: {
    200: { description: "The recovery is cancelled", content: okContent },
    400: errorAnswer(
      "invalid_request: the request is not valid. link_invalid: the recovery already ended, or the link is wrong",
    ),
    403: errorAnswer("origin_not_allowed: another site sent this"),
    ...RATE_LIMITED,
  },
});

const skipPromptRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/skip-prompt",
  security: SESSION,
  summary: "Stop asking to turn two-step sign-in on again, after a recovery or a reset removed it",
  responses: {
    200: { description: "The prompt is gone", content: okContent },
    ...OPERATOR_POST_ERRORS,
  },
});

interface RecoveryOptions {
  db: Database;
  live: Live;
  logger: Logger;
  /** Without one, nobody can be warned by email, so every recovery goes to manual review. */
  mailer: Mailer | undefined;
  push: Push | undefined;
  rateLimit: RateLimit;
  publicUrl: string;
  /** AUTH_SECRET, which the cancel tokens derive from. */
  authSecret: string;
}

/** The recovery routes. Register them after the operator routes' session check. */
export function registerRecoveryRoutes(
  app: App,
  { db, live, logger, mailer, push, rateLimit, publicUrl, authSecret }: RecoveryOptions,
) {
  const key = cancelKey(authSecret);
  const notices: RecoveryNotices = { db, live, logger, mailer };
  const publicOrigin = new URL(publicUrl).origin;

  /** Every warning that a new request sends at once. The banner and the Team mark read the row. */
  const warn = (
    account: { id: string; name: string; email: string },
    started: Extract<RecoveryAsk, { kind: "started" }>,
  ) => {
    if (mailer !== undefined) {
      const url = confirmUrl(publicUrl, "cancel-recovery", cancelToken(key, started.id));
      sendLater(mailer, logger, account.email, recoveryRequestedMail(url));
      for (const manager of started.managers) {
        sendLater(mailer, logger, manager.email, teamRecoveryMail(account));
      }
    }
    if (push !== undefined) {
      const payload = {
        title: text.pushTitle,
        body: text.pushBody,
        tag: "two-factor-recovery",
        url: "/",
      };
      sendToOperator(db, push, account.id, payload).catch((err: unknown) => {
        logger.error(safeErrorFields(err), "could not push a two-step sign-in recovery");
      });
    }
    signalTeams(db, live, account.id).catch((err: unknown) => {
      logger.warn(safeErrorFields(err), "could not signal a Team change");
    });
  };

  app.openapi(requestRoute, async (c) => {
    if (c.get("twoFactor") !== "required") return c.json(NOT_NEEDED, 409);
    if (!(await isFreshSession(db, c.get("sessionId")))) return c.json(SIGN_IN_AGAIN, 409);
    const operatorId = c.get("operatorId");
    const request: RecoveryAsk =
      mailer === undefined ? { kind: "manual_review" } : await startRecovery(db, key, operatorId);
    if (request.kind === "blocked") return c.json(BLOCKED, 409);
    if (request.kind === "manual_review") return c.json(MANUAL_REVIEW, 409);
    if (request.kind === "started") {
      audit(logger, "two_factor.recovery_requested", { operatorId, ip: c.get("clientIp") });
      warn({ id: operatorId, name: c.get("operatorName"), email: c.get("operatorEmail") }, request);
    }
    return c.json({ completesAt: request.completesAt.toISOString() }, 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const operatorId = c.get("operatorId");
    if (!(await db.transaction((tx) => cancelRecovery(tx, operatorId)))) {
      return c.json(NO_RECOVERY, 409);
    }
    afterRecoveryCancel(
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

  const cancelPath = cancelByLinkRoute.getRoutingPath();
  app.use(cancelPath, limitByIp(rateLimit, "recovery-cancel", CANCELS_PER_MINUTE, 60));
  app.use(cancelPath, bodyLimit({ maxSize: TOKEN_BODY_MAX_BYTES }));
  // Only this POST cancels, never a GET of the link, because mail scanners open links.
  app.openapi(cancelByLinkRoute, async (c) => {
    if (c.req.header("origin") !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const [found] = await db
      .select({ operatorId: twoFactorRecovery.operatorId, email: operator.email })
      .from(twoFactorRecovery)
      .innerJoin(operator, eq(operator.id, twoFactorRecovery.operatorId))
      .where(
        and(
          eq(twoFactorRecovery.cancelTokenHash, sha256Hex(c.req.valid("json").token)),
          RECOVERY_WAITS,
        ),
      );
    // The token ends with its request: one that completed or was cancelled finds nothing here.
    if (found === undefined) return c.json(LINK_INVALID, 400);
    if (!(await db.transaction((tx) => cancelRecovery(tx, found.operatorId)))) {
      return c.json(LINK_INVALID, 400);
    }
    afterRecoveryCancel(
      notices,
      { id: found.operatorId, email: found.email },
      "link",
      c.get("clientIp"),
    );
    return c.json({ ok: true as const }, 200);
  });
}

interface RecoveryStepOptions {
  db: Database;
  logger: Logger;
  mailer: Mailer | undefined;
  publicUrl: string;
  /** AUTH_SECRET, which the cancel tokens derive from. */
  secret: string;
}

/**
 * The worker's part: the reminder a day before the end, and the end itself. Each email goes after
 * its row is marked, so two workers never send it twice, and a crash between the two loses it: the
 * first warning and the banner have told the account already.
 */
export function recoveryWorkerStep({ db, logger, mailer, publicUrl, secret }: RecoveryStepOptions) {
  const key = cancelKey(secret);
  const sendAll = async (mails: { to: string; mail: { subject: string; body: string } }[]) => {
    if (mailer === undefined) return;
    const sent = await Promise.allSettled(
      mails.map(({ to, mail }) => mailer.send(to, mail.subject, mail.body)),
    );
    for (const result of sent) {
      if (result.status === "rejected") {
        logger.error(
          safeErrorFields(result.reason),
          "could not send a two-step sign-in recovery email",
        );
      }
    }
  };

  const remind = async () => {
    const due = await db
      .update(twoFactorRecovery)
      .set({ remindedAt: new Date() })
      .where(
        and(
          RECOVERY_WAITS,
          isNull(twoFactorRecovery.remindedAt),
          lte(twoFactorRecovery.completesAt, new Date(Date.now() + REMINDER_MS)),
        ),
      )
      .returning({ id: twoFactorRecovery.id, operatorId: twoFactorRecovery.operatorId });
    if (due.length === 0) return;
    const accounts = await db
      .select({ id: operator.id, email: operator.email })
      .from(operator)
      .where(
        inArray(
          operator.id,
          due.map((request) => request.operatorId),
        ),
      );
    await sendAll(
      due.flatMap((request) => {
        const account = accounts.find((one) => one.id === request.operatorId);
        const url = confirmUrl(publicUrl, "cancel-recovery", cancelToken(key, request.id));
        return account === undefined
          ? []
          : [{ to: account.email, mail: recoveryReminderMail(url) }];
      }),
    );
  };

  /** Removes it, unless a cancel or another worker came first. The account's row decides. */
  const complete = (request: { id: string; operatorId: string }) =>
    db.transaction(async (tx) => {
      await lockAccount(tx, request.operatorId);
      const [claimed] = await tx
        .update(twoFactorRecovery)
        .set({ completedAt: new Date() })
        .where(and(eq(twoFactorRecovery.id, request.id), RECOVERY_WAITS))
        .returning({ id: twoFactorRecovery.id });
      return claimed !== undefined && (await removeTwoFactor(tx, request.operatorId));
    });

  const completeDue = async () => {
    const due = await db
      .select({ id: twoFactorRecovery.id, operatorId: twoFactorRecovery.operatorId })
      .from(twoFactorRecovery)
      .where(and(RECOVERY_WAITS, lte(twoFactorRecovery.completesAt, new Date())))
      .limit(COMPLETE_BATCH);
    for (const request of due) {
      if (!(await complete(request))) continue;
      audit(logger, "two_factor.recovery_completed", { operatorId: request.operatorId });
      const [account] = await db
        .select({ name: operator.name, email: operator.email })
        .from(operator)
        .where(eq(operator.id, request.operatorId));
      if (account === undefined) continue;
      const managers = await managersOf(db, request.operatorId);
      await sendAll([
        { to: account.email, mail: twoFactorOffMail("recovery") },
        ...managers.map((manager) => ({ to: manager.email, mail: teamRecoveryDoneMail(account) })),
      ]);
    }
    return due.length > 0;
  };

  return async () => {
    await remind();
    return completeDue();
  };
}
