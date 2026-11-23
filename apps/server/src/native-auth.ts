import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { TWO_FACTOR_CODE_MAX } from "../../../packages/widget/src/shared.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { signedSessionCookie } from "./auth.ts";
import { operator, session, verification, workspace } from "./db/schema.ts";
import {
  type Database,
  lockAccount,
  lockWrites,
  operatorWorkspaces,
  withWorkspace,
} from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  jsonAnswer,
  jsonBody,
  OPERATOR_WRITE_ERRORS,
  RATE_LIMITED,
  safeErrorFields,
  TWO_FACTOR_REQUIRED,
  UNAUTHORIZED,
  WRONG_ORIGIN_TEXT,
} from "./errors.ts";
import { emailAddressHash, sha256Hex } from "./identity.ts";
import { nativeSignInCodeMail } from "./letter.ts";
import {
  NATIVE_EMAIL_CODE_MAX_FAILURES,
  type NativeEmailCodeLimit,
  tooManyAttempts,
} from "./login-limit.ts";
import type { Mailer } from "./mailer.ts";
import type { RateLimit } from "./rate-limit.ts";
import { tooManyRequests } from "./rate-limit.ts";
import { MINUTE_MS } from "./time.ts";
import { type TwoFactorCodeChecker, twoFactorStateOf } from "./two-factor.ts";

const NATIVE_REDIRECT_URI = "dinghy://auth/callback";
const NATIVE_CODE_MINUTES = 5;
const NATIVE_EXCHANGES_PER_MINUTE = 20;
const CODE_PREFIX = "native-sign-in:";
const EMAIL_CODE_PREFIX = "native-email-code:";
const TOTP_CHALLENGE_PREFIX = "native-totp:";
const EMAIL_CODE_DIGITS = 6;
const EMAIL_CODE_MINUTES = 10;
const EMAIL_CODE_SECONDS = EMAIL_CODE_MINUTES * 60;
const EMAIL_RESEND_SECONDS = 60;
const EMAIL_REQUESTS_PER_ADDRESS = 10;
const EMAIL_REQUESTS_PER_ACCOUNT_HOUR = 10;
const EMAIL_VERIFICATIONS_PER_MINUTE = 30;
const TOTP_CHALLENGE_MINUTES = 5;
const TOTP_CHALLENGE_SECONDS = TOTP_CHALLENGE_MINUTES * 60;
const Base64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Email = z.email().max(254);
const EmailCode = z.string().regex(new RegExp(`^\\d{${EMAIL_CODE_DIGITS}}$`));
const TwoFactorCode = z
  .string()
  .transform((typed) => typed.replaceAll(/\s/g, ""))
  .pipe(z.string().min(1).max(TWO_FACTOR_CODE_MAX));

const AuthorizeRequest = z.strictObject({
  codeChallenge: Base64Url32,
  codeChallengeMethod: z.literal("S256"),
  redirectUri: z.literal(NATIVE_REDIRECT_URI),
  state: Base64Url32,
});

const ExchangeRequest = z.strictObject({
  code: Base64Url32,
  codeVerifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/),
});

const StoredCode = z.strictObject({
  challenge: Base64Url32,
  operatorId: z.uuid(),
  sessionId: z.uuid(),
});

const StoredEmailCode = z.strictObject({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  operatorId: z.uuid(),
});

const StoredTotpChallenge = z.strictObject({
  operatorId: z.uuid(),
  sessionId: z.uuid(),
});

const EmailRequest = z.strictObject({ email: Email });
const EmailVerifyRequest = z.strictObject({ email: Email, code: EmailCode });
const TotpVerifyRequest = z.strictObject({ challenge: Base64Url32, code: TwoFactorCode });

const NativeSession = z.object({
  origin: z.string(),
  session: z.string(),
  operator: z.object({ id: z.uuid(), name: z.string() }),
  workspace: z.object({ id: z.uuid(), name: z.string() }),
});
const SignedIn = z.object({ status: z.literal("signed_in"), session: NativeSession });
const TotpRequired = z.object({
  status: z.literal("totp_required"),
  challenge: Base64Url32,
  expiresInSeconds: z.number().int(),
});

const authorizeRoute = createRoute({
  method: "post",
  path: "/v1/auth/native/authorize",
  security: SESSION,
  summary: "Confirm a signed-in browser may sign in the Dinghy native operator app",
  request: { body: jsonBody(AuthorizeRequest) },
  responses: {
    200: jsonAnswer(
      "The fixed Dinghy app callback with a five-minute one-time code and the request state",
      z.object({ redirectTo: z.string() }),
    ),
    ...OPERATOR_WRITE_ERRORS,
  },
});

const exchangeRoute = createRoute({
  method: "post",
  path: "/v1/auth/native/exchange",
  summary: "Exchange a native app sign-in code and proof verifier for an operator session",
  request: { body: jsonBody(ExchangeRequest) },
  responses: {
    200: jsonAnswer(
      "A normal operator session Cookie pair for this server, with its initial workspace",
      z.object({
        origin: z.string(),
        session: z.string(),
        operator: z.object({ id: z.uuid(), name: z.string() }),
        workspace: z.object({ id: z.uuid(), name: z.string() }),
      }),
    ),
    400: errorAnswer(
      "invalid_request: the code or verifier has the wrong shape. link_invalid: the code expired, was used, or does not match the verifier",
    ),
    402: errorAnswer(
      "payment_required: every workspace waits for its first payment, so none can open",
    ),
    403: errorAnswer(WRONG_ORIGIN_TEXT),
    409: errorAnswer("not_a_member: the operator is not in a workspace on this server"),
    ...RATE_LIMITED,
    413: errorAnswer("too_large: the body is over 8 KB"),
  },
});

const emailRequestRoute = createRoute({
  method: "post",
  path: "/v1/auth/native/email-code/request",
  summary: "Email a short sign-in code for the native operator app",
  request: { body: jsonBody(EmailRequest) },
  responses: {
    200: jsonAnswer(
      "The code lifetime and the time before this address may ask again. The answer does not reveal whether the account exists",
      z.object({
        ok: z.literal(true),
        expiresInSeconds: z.literal(EMAIL_CODE_SECONDS),
        resendAfterSeconds: z.literal(EMAIL_RESEND_SECONDS),
      }),
    ),
    400: errorAnswer(
      "invalid_request: the email has the wrong shape. email_unavailable: this server cannot send email",
    ),
    403: errorAnswer(WRONG_ORIGIN_TEXT),
    429: errorAnswer("too_many_attempts: this email or address asked too often"),
    413: errorAnswer("too_large: the body is over 8 KB"),
  },
});

const emailVerifyRoute = createRoute({
  method: "post",
  path: "/v1/auth/native/email-code/verify",
  summary: "Use an emailed code to start or finish native operator sign-in",
  request: { body: jsonBody(EmailVerifyRequest) },
  responses: {
    200: jsonAnswer(
      "A signed-in native session, or a short-lived challenge when two-step sign-in is on",
      z.union([SignedIn, TotpRequired]),
    ),
    400: errorAnswer(
      "invalid_request: the email or code has the wrong shape. invalid_code: the code is wrong, expired or already used",
    ),
    402: errorAnswer(
      "payment_required: every workspace waits for its first payment, so none can open",
    ),
    403: errorAnswer(WRONG_ORIGIN_TEXT),
    409: errorAnswer("not_a_member: the operator is not in a workspace on this server"),
    429: errorAnswer("too_many_attempts: the account reached its email-code attempt limit"),
    503: errorAnswer(
      "check_unavailable: the server cannot enforce the email-code attempt limit right now",
    ),
    413: errorAnswer("too_large: the body is over 8 KB"),
  },
});

const totpVerifyRoute = createRoute({
  method: "post",
  path: "/v1/auth/native/totp/verify",
  summary: "Finish native sign-in with an authenticator or recovery code",
  request: { body: jsonBody(TotpVerifyRequest) },
  responses: {
    200: jsonAnswer("A signed-in native session", SignedIn),
    400: errorAnswer(
      "invalid_request: the challenge or code has the wrong shape. invalid_code: the challenge or code is wrong, expired or already used",
    ),
    402: errorAnswer(
      "payment_required: every workspace waits for its first payment, so none can open",
    ),
    403: errorAnswer(WRONG_ORIGIN_TEXT),
    409: errorAnswer("not_a_member: the operator is not in a workspace on this server"),
    429: errorAnswer("too_many_attempts: the account reached its two-step attempt limit"),
    500: errorAnswer(
      "two_factor_unreadable: AUTH_SECRET changed, so the stored two-step secret cannot open",
    ),
    503: errorAnswer(
      "check_unavailable: the server cannot enforce the two-step attempt limit right now",
    ),
    413: errorAnswer("too_large: the body is over 8 KB"),
  },
});

/** The one account that an app store's reviewer signs in to the app with, by a fixed code. */
export interface AppReview {
  email: string;
  code: string;
}

interface NativeAuthOptions {
  appReview: AppReview | undefined;
  auth: Auth;
  db: Database;
  logger: Logger;
  mailer: Mailer | undefined;
  nativeEmailCodes: NativeEmailCodeLimit;
  rateLimit: RateLimit;
  twoFactorCodes: TwoFactorCodeChecker;
}

const invalidCode = () =>
  failure(
    "link_invalid",
    "This app sign-in request expired or was already used. Start again from the app.",
  );

const jsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const matchesChallenge = (verifier: string, expected: string) => {
  const actual = Buffer.from(challengeOf(verifier));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

const INVALID_NATIVE_CODE = failure(
  "invalid_code",
  "That code is wrong, expired or already used. Ask for a new code.",
);
const NOT_A_MEMBER = failure("not_a_member", "This account is not in a workspace on this server.");
const PAYMENT_REQUIRED = failure(
  "payment_required",
  "No workspace is available in the mobile app until its first payment is complete.",
);
const TWO_FACTOR_UNREADABLE = failure(
  "two_factor_unreadable",
  "This server cannot read your two-step sign-in. Ask its admin to reset it.",
);
const CHECK_UNAVAILABLE = failure(
  "check_unavailable",
  "Codes cannot be checked right now. Try again in a minute.",
);

type NativeWorkspace =
  | { kind: "available"; id: string; name: string }
  | { kind: "not_a_member" }
  | { kind: "payment_required" }
  | { kind: "invalid" };

async function nativeWorkspace(db: Database, operatorId: string): Promise<NativeWorkspace> {
  const memberships = await operatorWorkspaces(db, operatorId);
  if (memberships.length === 0) return { kind: "not_a_member" };
  // Match the web app. Read-only, suspended and early-cloud workspaces still open for their notice.
  const membership = memberships.find(({ access }) => access !== "waiting_payment");
  if (membership === undefined) return { kind: "payment_required" };
  const name = await withWorkspace(db, membership.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, membership.workspaceId));
    return found?.name;
  });
  return name === undefined
    ? { kind: "invalid" }
    : { kind: "available", id: membership.workspaceId, name };
}

const emailCodeIdentifier = (email: string) => `${EMAIL_CODE_PREFIX}${emailAddressHash(email)}`;
const totpChallengeIdentifier = (challenge: string) =>
  `${TOTP_CHALLENGE_PREFIX}${sha256Hex(challenge)}`;
const emailCodeDigest = (secret: string, email: string, code: string) =>
  createHmac("sha256", secret).update(`${email}\n${code}`).digest("hex");
const sameText = (actual: string, expected: string) => {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

async function storeEmailCode(
  db: Database,
  secret: string,
  email: string,
  operatorId: string,
  code: string,
): Promise<void> {
  const identifier = emailCodeIdentifier(email);
  await db.transaction(async (tx) => {
    await lockWrites(tx, "native-email-code", emailAddressHash(email));
    await tx.delete(verification).where(eq(verification.identifier, identifier));
    await tx.insert(verification).values({
      identifier,
      value: JSON.stringify({
        digest: emailCodeDigest(secret, email, code),
        operatorId,
      }),
      expiresAt: new Date(Date.now() + EMAIL_CODE_SECONDS * 1000),
    });
  });
}

async function sendEmailCode(
  auth: Auth,
  db: Database,
  mailer: Mailer,
  logger: Logger,
  appReview: AppReview | undefined,
  email: string,
  ip: string,
): Promise<void> {
  const [account] = await db
    .select({ id: operator.id })
    .from(operator)
    .where(and(eq(operator.email, email), isNull(operator.deletedAt)));
  if (account === undefined) return;
  // The reviewer cannot read this account's mail, so its code is the fixed one, with the same
  // expiry, single use and guess limit as an emailed code.
  if (email === appReview?.email) {
    await storeEmailCode(db, auth.options.secret, email, account.id, appReview.code);
    audit(logger, "native_email_code.review", { operatorId: account.id, ip });
    return;
  }
  const code = randomInt(10 ** (EMAIL_CODE_DIGITS - 1), 10 ** EMAIL_CODE_DIGITS).toString();
  await storeEmailCode(db, auth.options.secret, email, account.id, code);
  const mail = nativeSignInCodeMail(code, EMAIL_CODE_MINUTES);
  await mailer.send(email, mail.subject, mail.body, { html: mail.html });
  audit(logger, "native_email_code.sent", { operatorId: account.id, ip });
}

type EmailCodeResult =
  | { kind: "passed"; operatorId: string }
  | { kind: "invalid" }
  | { kind: "locked" };

async function consumeEmailCode(
  auth: Auth,
  db: Database,
  email: string,
  code: string,
  attempt: number,
): Promise<EmailCodeResult> {
  const identifier = emailCodeIdentifier(email);
  return db.transaction(async (tx) => {
    await lockWrites(tx, "native-email-code", emailAddressHash(email));
    const [record] = await tx
      .select({
        id: verification.id,
        value: verification.value,
        expiresAt: verification.expiresAt,
      })
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .orderBy(desc(verification.createdAt))
      .limit(1)
      .for("update");
    if (record === undefined) return { kind: "invalid" };
    const stored = StoredEmailCode.safeParse(jsonValue(record.value));
    if (!stored.success || record.expiresAt.getTime() <= Date.now()) {
      await tx.delete(verification).where(eq(verification.id, record.id));
      return { kind: "invalid" };
    }
    const actual = emailCodeDigest(auth.options.secret, email, code);
    if (!sameText(actual, stored.data.digest)) {
      if (attempt >= NATIVE_EMAIL_CODE_MAX_FAILURES) {
        await tx.delete(verification).where(eq(verification.id, record.id));
        return { kind: "locked" };
      }
      return { kind: "invalid" };
    }
    await tx.delete(verification).where(eq(verification.id, record.id));
    return { kind: "passed", operatorId: stored.data.operatorId };
  });
}

interface MadeEmailSession {
  token: string;
  operator: { id: string; name: string };
  challenge: string | null;
}

async function createEmailSession(
  auth: Auth,
  db: Database,
  operatorId: string,
  ip: string,
  userAgent: string,
): Promise<MadeEmailSession | null> {
  const context = await auth.$context;
  const token = randomBytes(32).toString("base64url");
  const challenge = randomBytes(32).toString("base64url");
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, operatorId);
    const [state] = await tx
      .select({
        deletedAt: operator.deletedAt,
        emailProven: operator.emailProven,
        twoFactorOn: operator.twoFactorOn,
      })
      .from(operator)
      .where(eq(operator.id, operatorId));
    if (account === undefined || state === undefined || state.deletedAt !== null) return null;
    if (!state.emailProven) {
      await tx.update(operator).set({ emailProven: true }).where(eq(operator.id, operatorId));
      await tx.delete(session).where(eq(session.userId, operatorId));
    }
    const needsTotp = state.twoFactorOn;
    const expiresInSeconds = needsTotp ? TOTP_CHALLENGE_SECONDS : context.sessionConfig.expiresIn;
    const [made] = await tx
      .insert(session)
      .values({
        userId: operatorId,
        token,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
        ipAddress: ip,
        userAgent,
      })
      .returning({ id: session.id });
    if (made === undefined) return null;
    if (needsTotp) {
      await tx.insert(verification).values({
        identifier: totpChallengeIdentifier(challenge),
        value: JSON.stringify({ operatorId, sessionId: made.id }),
        expiresAt: new Date(Date.now() + TOTP_CHALLENGE_SECONDS * 1000),
      });
    }
    return {
      token,
      operator: { id: operatorId, name: account.name },
      challenge: needsTotp ? challenge : null,
    };
  });
}

const sessionPayload = async (
  auth: Auth,
  source: { token: string; operator: { id: string; name: string } },
  selected: Extract<NativeWorkspace, { kind: "available" }>,
) => ({
  origin: new URL(String(auth.options.baseURL)).origin,
  session: await signedSessionCookie(auth, source.token),
  operator: source.operator,
  workspace: { id: selected.id, name: selected.name },
});

interface PendingTotp {
  id: string;
  operatorId: string;
  operatorEmail: string;
  sessionId: string;
}

async function pendingTotp(db: Database, challenge: string): Promise<PendingTotp | null> {
  const identifier = totpChallengeIdentifier(challenge);
  const [record] = await db
    .select({ id: verification.id, value: verification.value })
    .from(verification)
    .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, new Date())))
    .orderBy(desc(verification.createdAt))
    .limit(1);
  if (record === undefined) return null;
  const stored = StoredTotpChallenge.safeParse(jsonValue(record.value));
  if (!stored.success) return null;
  const [account] = await db
    .select({ email: operator.email })
    .from(operator)
    .where(and(eq(operator.id, stored.data.operatorId), isNull(operator.deletedAt)));
  if (account === undefined) return null;
  return {
    id: record.id,
    operatorId: stored.data.operatorId,
    operatorEmail: account.email,
    sessionId: stored.data.sessionId,
  };
}

const endPendingTotp = (db: Database, pending: PendingTotp) =>
  db.transaction(async (tx) => {
    await tx.delete(verification).where(eq(verification.id, pending.id));
    // A concurrent verification may have upgraded this session after `pendingTotp` read it.
    // Never revoke a full session while cleaning up a stale or exhausted challenge.
    await tx
      .delete(session)
      .where(and(eq(session.id, pending.sessionId), isNull(session.twoFactorAt)));
  });

async function finishTotp(
  auth: Auth,
  db: Database,
  checker: TwoFactorCodeChecker,
  pending: PendingTotp,
  code: string,
  ip: string,
): Promise<
  | { checked: "passed"; source: { token: string; operator: { id: string; name: string } } }
  | { checked: Exclude<Awaited<ReturnType<TwoFactorCodeChecker["check"]>>, "passed"> }
> {
  const context = await auth.$context;
  const checked = await checker.check({
    operatorId: pending.operatorId,
    operatorEmail: pending.operatorEmail,
    ip,
    code,
    beforeSpend: async (tx) => {
      const [record] = await tx
        .select({ value: verification.value, expiresAt: verification.expiresAt })
        .from(verification)
        .where(eq(verification.id, pending.id))
        .for("update");
      const stored = StoredTotpChallenge.safeParse(
        record === undefined ? null : jsonValue(record.value),
      );
      if (
        !stored.success ||
        record === undefined ||
        record.expiresAt.getTime() <= Date.now() ||
        stored.data.operatorId !== pending.operatorId ||
        stored.data.sessionId !== pending.sessionId
      ) {
        return false;
      }
      const [waiting] = await tx
        .select({ id: session.id })
        .from(session)
        .where(
          and(
            eq(session.id, pending.sessionId),
            eq(session.userId, pending.operatorId),
            gt(session.expiresAt, new Date()),
          ),
        )
        .for("update");
      return waiting !== undefined;
    },
    effect: async (tx) => {
      await tx
        .update(session)
        .set({
          twoFactorAt: new Date(),
          expiresAt: new Date(Date.now() + context.sessionConfig.expiresIn * 1000),
        })
        .where(eq(session.id, pending.sessionId));
      await tx.delete(verification).where(eq(verification.id, pending.id));
    },
    onLocked: () => endPendingTotp(db, pending),
  });
  if (checked !== "passed") return { checked };
  const [source] = await db
    .select({ token: session.token, operatorId: operator.id, operatorName: operator.name })
    .from(session)
    .innerJoin(operator, eq(operator.id, session.userId))
    .where(
      and(
        eq(session.id, pending.sessionId),
        eq(session.userId, pending.operatorId),
        gt(session.expiresAt, new Date()),
        isNull(operator.deletedAt),
      ),
    );
  if (source === undefined) return { checked: "invalid" };
  return {
    checked: "passed",
    source: {
      token: source.token,
      operator: { id: source.operatorId, name: source.operatorName },
    },
  };
}

async function requestWait(
  rateLimit: RateLimit,
  email: string,
  ip: string,
): Promise<number | null> {
  const waits = await Promise.all([
    rateLimit.hit("native-email-code-request", `${email}\n${ip}`, 1, EMAIL_RESEND_SECONDS),
    rateLimit.hit(
      "native-email-code-request-address",
      ip,
      EMAIL_REQUESTS_PER_ADDRESS,
      EMAIL_RESEND_SECONDS,
    ),
    rateLimit.hit(
      "native-email-code-request-account",
      email,
      EMAIL_REQUESTS_PER_ACCOUNT_HOUR,
      60 * 60,
    ),
  ]);
  return waits.reduce<number | null>(
    (longest, wait) => (wait !== null && (longest === null || wait > longest) ? wait : longest),
    null,
  );
}

/**
 * Adds the browser confirmation and proof-key exchange routes for the native operator app. The
 * normal auth middleware still checks the server Origin and JSON content type for both writes.
 */
export function registerNativeAuthRoutes(
  app: App,
  {
    appReview,
    auth,
    db,
    logger,
    mailer,
    nativeEmailCodes,
    rateLimit,
    twoFactorCodes,
  }: NativeAuthOptions,
): void {
  const publicOrigin = new URL(String(auth.options.baseURL)).origin;

  app.openapi(emailRequestRoute, async (c) => {
    if (mailer === undefined) {
      return c.json(failure("email_unavailable", "This server cannot send email."), 400);
    }
    const email = c.req.valid("json").email.toLowerCase();
    const ip = c.get("clientIp");
    const wait = await requestWait(rateLimit, email, ip);
    if (wait !== null) {
      audit(
        logger,
        "native_email_code.limited",
        { account: emailAddressHash(email).slice(0, 16), ip },
        "warn",
      );
      return tooManyAttempts(c, { windowSeconds: wait });
    }
    // The known and unknown paths both continue after the same answer. Only a known account gets mail.
    const sent = sendEmailCode(auth, db, mailer, logger, appReview, email, ip).catch(
      (error: unknown) => {
        logger.error(safeErrorFields(error), "could not send a native sign-in code");
      },
    );
    // A reviewer already knows the code, so it must be stored before the answer.
    if (email === appReview?.email) await sent;
    return c.json(
      {
        ok: true,
        expiresInSeconds: EMAIL_CODE_SECONDS,
        resendAfterSeconds: EMAIL_RESEND_SECONDS,
      } as const,
      200,
    );
  });

  app.openapi(emailVerifyRoute, async (c) => {
    const ip = c.get("clientIp");
    const wait = await rateLimit.hit(
      "native-email-code-verify",
      ip,
      EMAIL_VERIFICATIONS_PER_MINUTE,
      60,
    );
    if (wait !== null) return tooManyAttempts(c, { windowSeconds: wait });
    const request = c.req.valid("json");
    const email = request.email.toLowerCase();
    const attempt = await nativeEmailCodes.attempt(email);
    if (attempt === null) return c.json(CHECK_UNAVAILABLE, 503);
    if (attempt > NATIVE_EMAIL_CODE_MAX_FAILURES) {
      return tooManyAttempts(c, nativeEmailCodes);
    }
    const checked = await consumeEmailCode(auth, db, email, request.code, attempt);
    if (checked.kind !== "passed") {
      audit(
        logger,
        checked.kind === "locked" ? "native_email_code.limited" : "native_email_code.refused",
        { account: emailAddressHash(email).slice(0, 16), ip },
        "warn",
      );
      return checked.kind === "locked"
        ? tooManyAttempts(c, nativeEmailCodes)
        : c.json(INVALID_NATIVE_CODE, 400);
    }
    await nativeEmailCodes.clear(email);

    const selected = await nativeWorkspace(db, checked.operatorId);
    if (selected.kind === "not_a_member") return c.json(NOT_A_MEMBER, 409);
    if (selected.kind === "payment_required") return c.json(PAYMENT_REQUIRED, 402);
    if (selected.kind === "invalid") return c.json(INVALID_NATIVE_CODE, 400);
    const source = await createEmailSession(
      auth,
      db,
      checked.operatorId,
      ip,
      c.req.header("user-agent") ?? "",
    );
    if (source === null) return c.json(INVALID_NATIVE_CODE, 400);
    audit(logger, "native_email_code.used", { operatorId: checked.operatorId, ip });
    if (source.challenge !== null) {
      return c.json(
        {
          status: "totp_required" as const,
          challenge: source.challenge,
          expiresInSeconds: TOTP_CHALLENGE_SECONDS,
        },
        200,
      );
    }
    const payload = await sessionPayload(auth, source, selected);
    audit(logger, "native_sign_in.used", {
      operatorId: checked.operatorId,
      workspaceId: selected.id,
      ip,
    });
    return c.json({ status: "signed_in" as const, session: payload }, 200);
  });

  app.openapi(totpVerifyRoute, async (c) => {
    const ip = c.get("clientIp");
    const wait = await rateLimit.hit("native-totp-verify", ip, EMAIL_VERIFICATIONS_PER_MINUTE, 60);
    if (wait !== null) return tooManyAttempts(c, { windowSeconds: wait });
    const request = c.req.valid("json");
    const pending = await pendingTotp(db, request.challenge);
    if (pending === null) return c.json(INVALID_NATIVE_CODE, 400);
    const selected = await nativeWorkspace(db, pending.operatorId);
    if (selected.kind !== "available") {
      await endPendingTotp(db, pending);
      if (selected.kind === "not_a_member") return c.json(NOT_A_MEMBER, 409);
      if (selected.kind === "payment_required") return c.json(PAYMENT_REQUIRED, 402);
      return c.json(INVALID_NATIVE_CODE, 400);
    }
    const result = await finishTotp(auth, db, twoFactorCodes, pending, request.code, ip);
    if (result.checked === "locked") return tooManyAttempts(c, twoFactorCodes);
    if (result.checked === "unreadable") return c.json(TWO_FACTOR_UNREADABLE, 500);
    if (result.checked === "unavailable") return c.json(CHECK_UNAVAILABLE, 503);
    if (result.checked !== "passed") {
      if (result.checked === "invalid") await endPendingTotp(db, pending);
      return c.json(INVALID_NATIVE_CODE, 400);
    }
    const payload = await sessionPayload(auth, result.source, selected);
    audit(logger, "native_sign_in.used", {
      operatorId: pending.operatorId,
      workspaceId: selected.id,
      ip,
    });
    return c.json({ status: "signed_in" as const, session: payload }, 200);
  });

  app.openapi(authorizeRoute, async (c) => {
    const request = c.req.valid("json");
    const found = await auth.api.getSession({ headers: c.req.raw.headers });
    if (found === null || found.user.deletedAt != null) return c.json(UNAUTHORIZED, 401);
    if (twoFactorStateOf(found.user.twoFactorOn, found.session.twoFactorAt) === "required") {
      return c.json(TWO_FACTOR_REQUIRED, 401);
    }

    const code = randomBytes(32).toString("base64url");
    const { internalAdapter } = await auth.$context;
    await internalAdapter.createVerificationValue({
      identifier: `${CODE_PREFIX}${sha256Hex(code)}`,
      value: JSON.stringify({
        challenge: request.codeChallenge,
        operatorId: found.user.id,
        sessionId: found.session.id,
      }),
      expiresAt: new Date(Date.now() + NATIVE_CODE_MINUTES * MINUTE_MS),
    });
    const redirect = new URL(NATIVE_REDIRECT_URI);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", request.state);
    audit(logger, "native_sign_in.authorized", {
      operatorId: found.user.id,
      ip: c.get("clientIp"),
    });
    return c.json({ redirectTo: redirect.href }, 200);
  });

  app.openapi(exchangeRoute, async (c) => {
    const wait = await rateLimit.hit(
      "native-sign-in-exchange",
      c.get("clientIp"),
      NATIVE_EXCHANGES_PER_MINUTE,
      60,
    );
    if (wait !== null) return tooManyRequests(c, wait);

    const request = c.req.valid("json");
    const { internalAdapter } = await auth.$context;
    const record = await internalAdapter.consumeVerificationValue(
      `${CODE_PREFIX}${sha256Hex(request.code)}`,
    );
    const stored = StoredCode.safeParse(record === null ? null : jsonValue(record.value));
    if (!stored.success || !matchesChallenge(request.codeVerifier, stored.data.challenge)) {
      audit(logger, "native_sign_in.refused", { ip: c.get("clientIp") }, "warn");
      return c.json(invalidCode(), 400);
    }

    const memberships = await operatorWorkspaces(db, stored.data.operatorId);
    if (memberships.length === 0) {
      return c.json(
        failure("not_a_member", "This account is not in a workspace on this server."),
        409,
      );
    }
    // Match the web app: a workspace that waits for its first payment does not open while another
    // workspace can. Read-only, suspended and early-cloud workspaces still open for their notices.
    const membership = memberships.find(({ access }) => access !== "waiting_payment");
    if (membership === undefined) {
      return c.json(
        failure(
          "payment_required",
          "No workspace is available in the mobile app until its first payment is complete.",
        ),
        402,
      );
    }
    const workspaceName = await withWorkspace(db, membership.workspaceId, async (tx) => {
      const [found] = await tx
        .select({ name: workspace.name })
        .from(workspace)
        .where(eq(workspace.id, membership.workspaceId));
      return found?.name;
    });
    if (workspaceName === undefined) return c.json(invalidCode(), 400);

    const context = await auth.$context;
    const token = randomBytes(32).toString("base64url");
    const source = await db.transaction(async (tx) => {
      // Account changes and two-step resets take this lock first. Sign-out takes the session lock
      // below. A revocation that wins either race prevents this transaction from making a session.
      const account = await lockAccount(tx, stored.data.operatorId);
      if (account === undefined) return null;
      const [sourceSession] = await tx
        .select({ twoFactorAt: session.twoFactorAt })
        .from(session)
        .where(
          and(
            eq(session.id, stored.data.sessionId),
            eq(session.userId, stored.data.operatorId),
            gt(session.expiresAt, new Date()),
          ),
        )
        .for("update");
      const [sourceOperator] = await tx
        .select({ twoFactorOn: operator.twoFactorOn })
        .from(operator)
        .where(and(eq(operator.id, stored.data.operatorId), isNull(operator.deletedAt)));
      if (
        sourceSession === undefined ||
        sourceOperator === undefined ||
        twoFactorStateOf(sourceOperator.twoFactorOn, sourceSession.twoFactorAt) === "required"
      ) {
        return null;
      }
      await tx.insert(session).values({
        userId: stored.data.operatorId,
        token,
        expiresAt: new Date(Date.now() + context.sessionConfig.expiresIn * 1000),
        ipAddress: c.get("clientIp"),
        userAgent: c.req.header("user-agent") ?? "",
        twoFactorAt: sourceSession.twoFactorAt,
      });
      return { operatorId: stored.data.operatorId, operatorName: account.name };
    });
    if (source === null) return c.json(invalidCode(), 400);

    const cookie = await signedSessionCookie(auth, token);
    audit(logger, "native_sign_in.used", {
      operatorId: source.operatorId,
      workspaceId: membership.workspaceId,
      ip: c.get("clientIp"),
    });
    return c.json(
      {
        origin: publicOrigin,
        session: cookie,
        operator: { id: source.operatorId, name: source.operatorName },
        workspace: { id: membership.workspaceId, name: workspaceName },
      },
      200,
    );
  });
}
