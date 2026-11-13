import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App, AppEnv } from "./app.ts";
import { audit } from "./audit.ts";
import { operator, operatorTwoFactor, session } from "./db/schema.ts";
import { type Database, operatorWorkspaces, type Transaction } from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  jsonAnswer,
  jsonBody,
  OPERATOR_WRITE_ERRORS,
  okContent,
  safeErrorFields,
} from "./errors.ts";
import { lockoutMail, recoveryUsedMail, twoFactorOffMail, twoFactorOnMail } from "./letter.ts";
import { type Live, OPERATORS } from "./live.ts";
import {
  createTwoFactorLimit,
  TWO_FACTOR_MAX_FAILURES,
  TWO_FACTOR_WINDOW_SECONDS,
  tooManyAttempts,
} from "./login-limit.ts";
import type { Mailer } from "./mailer.ts";

/** RFC 6238's defaults, which every authenticator app reads. */
const PERIOD_SECONDS = 30;
const DIGITS = 6;
/** A code of the step before or after also passes, for a phone whose clock is a little off. */
const STEP_WINDOW = 1;
/** RFC 4226 asks for 160 bits. */
const SECRET_BYTES = 20;
const ISSUER = "Dinghy";
const TOTP_CODE = new RegExp(`^\\d{${DIGITS}}$`);

const RECOVERY_CODE_COUNT = 10;
/** Each character is one of 32, so a code holds 50 random bits. */
const RECOVERY_CODE_LENGTH = 10;
/** The longest code the routes accept once spaces are gone, well above a recovery code's 11. */
const CODE_MAX_LENGTH = 40;
const RECOVERY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * `off`: no two-step sign-in. `on`: it is on and this session passed it. `required`: it is on and
 * this session has not passed it, so only the check, `me` and sign-out work.
 */
export type TwoFactorState = "off" | "on" | "required";

/**
 * A session's second step, from the account's flag and the session's pass. The session check
 * reads both with the session, and each stream drain and an upload's last check read the same two
 * columns in `twoFactorState`, so they cannot disagree.
 */
export const twoFactorStateOf = (
  twoFactorOn: boolean | null | undefined,
  twoFactorAt: Date | null | undefined,
): TwoFactorState => (twoFactorOn !== true ? "off" : twoFactorAt == null ? "required" : "on");

/** A session's second step, as SQL, by the rule of `twoFactorStateOf`. Null when the session is gone. */
export const twoFactorState = (sessionId: string) => sql<TwoFactorState | null>`(
  select case
           when not o.two_factor_on then 'off'
           when s.two_factor_at is null then 'required'
           else 'on'
         end
  from ${session} s
  join ${operator} o on o.id = s.user_id
  where s.id = ${sessionId})`;

/**
 * Locks the account's row, first, as an account's delete and a setup's start do, so the
 * transactions that change two-step sign-in and the delete take turns without a deadlock.
 */
const lockAccount = (tx: Transaction, operatorId: string) =>
  tx.select({ id: operator.id }).from(operator).where(eq(operator.id, operatorId)).for("update");

const setTwoFactorOn = (tx: Transaction, operatorId: string, twoFactorOn: boolean) =>
  tx.update(operator).set({ twoFactorOn }).where(eq(operator.id, operatorId));

/** Two keys from AUTH_SECRET, each with its own purpose, so neither can stand in for the other. */
function deriveKeys(authSecret: string) {
  const derive = (purpose: string) =>
    Buffer.from(hkdfSync("sha256", authSecret, "", `dinghy ${purpose}`, 32));
  return { secret: derive("two-factor secret"), recovery: derive("two-factor recovery codes") };
}
type Keys = ReturnType<typeof deriveKeys>;

/**
 * AES-256-GCM, with the operator's ID as associated data, so a secret copied into another
 * account's row does not open.
 */
function seal(keys: Keys, operatorId: string, secret: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.secret, nonce).setAAD(Buffer.from(operatorId));
  return Buffer.concat([nonce, cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
}

/** The secret, or null when it does not open: AUTH_SECRET changed since it was sealed. */
function unseal(keys: Keys, operatorId: string, sealed: Uint8Array): Buffer | null {
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keys.secret, nonce)
    .setAAD(Buffer.from(operatorId))
    .setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

/** The time step whose code this is, within the window, or null. */
async function matchingStep(secret: Uint8Array, code: string): Promise<number | null> {
  // timingSafeEqual throws when the lengths differ, and a code of another shape never matches.
  if (!TOTP_CODE.test(code)) return null;
  const otp = createOTP(secret, { digits: DIGITS, period: PERIOD_SECONDS });
  const current = Math.floor(Date.now() / 1000 / PERIOD_SECONDS);
  let matched: number | null = null;
  // It compares every step, so the time taken does not show which one matched.
  for (let step = current - STEP_WINDOW; step <= current + STEP_WINDOW; step += 1) {
    if (timingSafeEqual(Buffer.from(await otp.hotp(step)), Buffer.from(code))) matched = step;
  }
  return matched;
}

function newRecoveryCode(): string {
  // 256 is a multiple of 32, so the modulo picks each letter equally often.
  const letters = [...randomBytes(RECOVERY_CODE_LENGTH)].map(
    (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length],
  );
  const half = RECOVERY_CODE_LENGTH / 2;
  return `${letters.slice(0, half).join("")}-${letters.slice(half).join("")}`;
}

/** Keyed, so a copy of the database alone cannot test guesses. Case and dashes do not matter. */
const recoveryHash = (keys: Keys, code: string) =>
  createHmac("sha256", keys.recovery)
    .update(code.toLowerCase().replaceAll(/[^a-z0-9]/g, ""))
    .digest("hex");

/** A new set of recovery codes, to show once, and their hashes, to store. */
function newRecoveryCodes(keys: Keys) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  return { codes, hashes: codes.map((one) => recoveryHash(keys, one)) };
}

/**
 * Starts a setup with a new secret, which replaces one that was never confirmed. Returns null when
 * two-step sign-in is already on, or the account is gone. The operator's row is locked first, as an
 * account's delete locks it, so a secret never outlives its account.
 */
async function startSetup(db: Database, keys: Keys, operatorId: string) {
  const secret = randomBytes(SECRET_BYTES);
  const sealed = seal(keys, operatorId, secret);
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ email: operator.email })
      .from(operator)
      .where(and(eq(operator.id, operatorId), isNull(operator.deletedAt)))
      .for("update");
    if (account === undefined) return null;
    const [started] = await tx
      .insert(operatorTwoFactor)
      .values({ operatorId, secret: sealed })
      .onConflictDoUpdate({
        target: operatorTwoFactor.operatorId,
        set: { secret: sealed },
        setWhere: isNull(operatorTwoFactor.enabledAt),
      })
      .returning({ operatorId: operatorTwoFactor.operatorId });
    if (started === undefined) return null;
    const otp = createOTP(secret, { digits: DIGITS, period: PERIOD_SECONDS });
    return {
      secret: base32.encode(secret, { padding: false }),
      uri: otp.url(ISSUER, account.email),
    };
  });
}

/**
 * Confirms a setup with its first code: turns two-step sign-in on, counts this session as passed,
 * and returns the recovery codes, which are never readable again. Every other session of the
 * account must pass the new secret, also one that passed before it was last turned off.
 */
async function finishSetup(
  db: Database,
  keys: Keys,
  operatorId: string,
  sessionId: string,
  code: string,
) {
  return db.transaction(async (tx) => {
    await lockAccount(tx, operatorId);
    const [pending] = await tx
      .select({ secret: operatorTwoFactor.secret })
      .from(operatorTwoFactor)
      .where(and(eq(operatorTwoFactor.operatorId, operatorId), isNull(operatorTwoFactor.enabledAt)))
      .for("update");
    // A secret sealed under another AUTH_SECRET: a new setup replaces it.
    const secret = pending === undefined ? null : unseal(keys, operatorId, pending.secret);
    if (secret === null) return "no_setup" as const;
    const step = await matchingStep(secret, code);
    if (step === null) return "wrong_code" as const;
    const { codes, hashes } = newRecoveryCodes(keys);
    await tx
      .update(operatorTwoFactor)
      .set({ enabledAt: new Date(), lastStep: step, recoveryCodes: hashes })
      .where(eq(operatorTwoFactor.operatorId, operatorId));
    await setTwoFactorOn(tx, operatorId, true);
    await tx
      .update(session)
      .set({ twoFactorAt: sql`case when ${session.id} = ${sessionId} then now() end` })
      .where(eq(session.userId, operatorId));
    return codes;
  });
}

/**
 * Uses a code from the authenticator app or a recovery code. It locks the account's row, so run it
 * in the transaction that also applies the code's effect: two requests with the same code cannot
 * both pass, and a code spent while the setup was turned off or replaced has no effect.
 */
async function spendCode(tx: Transaction, keys: Keys, operatorId: string, code: string) {
  const ours = eq(operatorTwoFactor.operatorId, operatorId);
  await lockAccount(tx, operatorId);
  const [row] = await tx
    .select({ secret: operatorTwoFactor.secret, lastStep: operatorTwoFactor.lastStep })
    .from(operatorTwoFactor)
    .where(and(ours, isNotNull(operatorTwoFactor.enabledAt)))
    .for("update");
  if (row === undefined) return "wrong";
  const secret = unseal(keys, operatorId, row.secret);
  // The recovery codes' hashes are keyed by AUTH_SECRET too, so no code can pass.
  if (secret === null) return "unreadable";
  const step = await matchingStep(secret, code);
  if (step !== null) {
    // A step at or before the last one used is a code seen before.
    if (row.lastStep !== null && step <= row.lastStep) return "wrong";
    await tx.update(operatorTwoFactor).set({ lastStep: step }).where(ours);
    return "totp" as const;
  }
  const hash = recoveryHash(keys, code);
  const [used] = await tx
    .update(operatorTwoFactor)
    .set({ recoveryCodes: sql`array_remove(${operatorTwoFactor.recoveryCodes}, ${hash})` })
    .where(and(ours, sql`${hash} = any(${operatorTwoFactor.recoveryCodes})`))
    .returning({ operatorId: operatorTwoFactor.operatorId });
  return used === undefined ? ("wrong" as const) : ("recovery" as const);
}

/**
 * Turns two-step sign-in off for an account. The sessions that never passed it end too, so turning
 * it off never lets in someone who stopped at the second step.
 */
async function turnOff(tx: Transaction, operatorId: string) {
  await tx.delete(operatorTwoFactor).where(eq(operatorTwoFactor.operatorId, operatorId));
  await setTwoFactorOn(tx, operatorId, false);
  await tx.delete(session).where(and(eq(session.userId, operatorId), isNull(session.twoFactorAt)));
}

/**
 * For the server's admin, when an operator lost their app and their recovery codes. Every session
 * of the account ends, so a session that waited at the second step does not pass without it.
 * Returns false, changing nothing, when it was off.
 */
export async function resetTwoFactor(db: Database, operatorId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockAccount(tx, operatorId);
    const removed = await tx
      .delete(operatorTwoFactor)
      .where(
        and(eq(operatorTwoFactor.operatorId, operatorId), isNotNull(operatorTwoFactor.enabledAt)),
      )
      .returning({ operatorId: operatorTwoFactor.operatorId });
    if (removed.length === 0) return false;
    await setTwoFactorOn(tx, operatorId, false);
    await tx.delete(session).where(eq(session.userId, operatorId));
    return true;
  });
}

const CodeBody = z.strictObject({
  // Spaces go here, once, so every check below sees the code as the app shows it.
  code: z
    .string()
    .transform((typed) => typed.replaceAll(/\s/g, ""))
    .pipe(z.string().min(1).max(CODE_MAX_LENGTH))
    .openapi({
      description: `${DIGITS} digits from the authenticator app, or a recovery code. Spaces do not count, and without them it has 1 to ${CODE_MAX_LENGTH} characters.`,
    }),
});

const WRONG_CODE = failure("wrong_code", "That code is not right, or it was already used.");
const TWO_FACTOR_ON = failure("two_factor_on", "Two-step sign-in is already on.");
const TWO_FACTOR_OFF = failure("two_factor_off", "Two-step sign-in is off for this account.");
const NO_SETUP = failure("no_setup", "Start the setup first.");
const TWO_FACTOR_UNREADABLE = failure(
  "two_factor_unreadable",
  "This server cannot read your two-step sign-in. Ask its admin to reset it.",
);
const CHECK_UNAVAILABLE = failure(
  "check_unavailable",
  "Codes cannot be checked right now. Try again in a minute.",
);

const WINDOW_MINUTES = TWO_FACTOR_WINDOW_SECONDS / 60;
const LOCKED_TEXT = `too_many_attempts: ${TWO_FACTOR_MAX_FAILURES} wrong codes in ${WINDOW_MINUTES} minutes. The session ended. Retry after \`retry-after\``;
const UNREADABLE_TEXT =
  "two_factor_unreadable: the stored secret does not open, because AUTH_SECRET changed. The server's admin runs `chat two-factor-reset`";
const UNAVAILABLE_TEXT =
  "check_unavailable: the server cannot count attempts right now, so it checks no code. Retry later";

/** The answers of every route that checks a code under the limit. */
const CODE_ERRORS = {
  400: errorAnswer(
    "invalid_request: the request is not valid. wrong_code: the code is not right, or it was already used",
  ),
  429: errorAnswer(LOCKED_TEXT),
  500: errorAnswer(UNREADABLE_TEXT),
  503: errorAnswer(UNAVAILABLE_TEXT),
};

const setupRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/setup",
  security: SESSION,
  summary:
    "Start turning on two-step sign-in. Returns a new TOTP secret for an authenticator app, which works once a code confirms it. A new call replaces a secret that was not confirmed",
  responses: {
    200: jsonAnswer(
      "The secret in base32, to type in, and the otpauth URI, for a QR code",
      z.object({ secret: z.string(), uri: z.string() }),
    ),
    ...OPERATOR_WRITE_ERRORS,
    409: errorAnswer("two_factor_on: two-step sign-in is already on"),
  },
});

const enableRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/enable",
  security: SESSION,
  summary:
    "Confirm the setup with a code from the authenticator app. Two-step sign-in is then on, this session counts as passed, and every other session must pass the check",
  request: { body: jsonBody(CodeBody) },
  responses: {
    200: jsonAnswer(
      `${RECOVERY_CODE_COUNT} recovery codes. Each works once in place of a code, and this is the only time they show`,
      z.object({ recoveryCodes: z.array(z.string()) }),
    ),
    ...OPERATOR_WRITE_ERRORS,
    400: errorAnswer(
      "invalid_request: the request is not valid. wrong_code: the code is not right",
    ),
    409: errorAnswer("no_setup: no setup waits for a code"),
  },
});

const checkRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/check",
  security: SESSION,
  summary:
    "Pass the second step of sign-in with a code from the authenticator app or a recovery code. A session must do this before any other operator route but `me` and sign-out",
  request: { body: jsonBody(CodeBody) },
  responses: {
    200: { description: "This session passed", content: okContent },
    ...OPERATOR_WRITE_ERRORS,
    ...CODE_ERRORS,
    409: errorAnswer("two_factor_off: two-step sign-in is off"),
  },
});

const recoveryCodesRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/recovery-codes",
  security: SESSION,
  summary: `Make a new set of ${RECOVERY_CODE_COUNT} recovery codes, with a current code from the authenticator app. The old ones stop working`,
  request: { body: jsonBody(CodeBody) },
  responses: {
    200: jsonAnswer(
      `${RECOVERY_CODE_COUNT} recovery codes, which replace the old ones. This is the only time they show`,
      z.object({ recoveryCodes: z.array(z.string()) }),
    ),
    ...OPERATOR_WRITE_ERRORS,
    ...CODE_ERRORS,
    400: errorAnswer(
      `invalid_request: the request is not valid. wrong_code: not a current ${DIGITS}-digit code from the app, or one already used. A recovery code does not work here`,
    ),
    409: errorAnswer("two_factor_off: two-step sign-in is off"),
  },
});

const disableRoute = createRoute({
  method: "post",
  path: "/v1/operator/two-factor/disable",
  security: SESSION,
  summary:
    "Turn two-step sign-in off, with a current code or a recovery code. Sessions that never passed the check end",
  request: { body: jsonBody(CodeBody) },
  responses: {
    200: { description: "Two-step sign-in is off", content: okContent },
    ...OPERATOR_WRITE_ERRORS,
    ...CODE_ERRORS,
    409: errorAnswer("two_factor_off: two-step sign-in is already off"),
  },
});

/** How a code fared under the limit. */
type CodeCheck = "passed" | "wrong" | "locked" | "unreadable" | "unavailable";

interface TwoFactorOptions {
  db: Database;
  live: Live;
  logger: Logger;
  /** AUTH_SECRET, which the keys derive from. */
  authSecret: string;
  valkey: Redis | null;
  /** Tells the account about each change. Without one, nothing is sent. */
  mailer: Mailer | undefined;
}

/** The two-step sign-in routes. Register them after the operator routes' session check. */
export function registerTwoFactorRoutes(
  app: App,
  { db, live, logger, authSecret, valkey, mailer }: TwoFactorOptions,
) {
  const keys = deriveKeys(authSecret);
  const limit = createTwoFactorLimit(valkey, logger);

  /** Emails the account, after the answer: a mail server that fails changes nothing here. */
  const tell = (c: Context<AppEnv>, mail: { subject: string; body: string }) => {
    mailer?.send(c.get("operatorEmail"), mail.subject, mail.body).catch((err: unknown) => {
      logger.error(safeErrorFields(err), "could not send a two-step sign-in email");
    });
  };

  /**
   * Uses a code under the limit, with `effect` in the same transaction. The wrong code that reaches
   * the limit ends the session, and so does any code after it, unchecked: its operator signs in
   * again, and the count outlives the session. With no count, no code is checked.
   */
  const checkCode = async (
    c: Context<AppEnv>,
    code: string,
    effect: (tx: Transaction) => Promise<unknown>,
  ): Promise<CodeCheck> => {
    const operatorId = c.get("operatorId");
    const ip = c.get("clientIp");
    const endSession = () => db.delete(session).where(eq(session.id, c.get("sessionId")));
    const tries = await limit.attempt(operatorId);
    if (tries === null) return "unavailable";
    if (tries > TWO_FACTOR_MAX_FAILURES) {
      await endSession();
      return "locked";
    }
    const used = await db.transaction(async (tx) => {
      const spent = await spendCode(tx, keys, operatorId, code);
      if (spent === "totp" || spent === "recovery") await effect(tx);
      return spent;
    });
    if (used === "unreadable") {
      logger.error({ operatorId }, "a two-step sign-in secret does not open: AUTH_SECRET changed");
      return "unreadable";
    }
    if (used !== "wrong") {
      await limit.clear(operatorId);
      if (used === "recovery") {
        audit(logger, "two_factor.recovery_used", { operatorId, ip });
        tell(c, recoveryUsedMail());
      }
      return "passed";
    }
    audit(logger, "two_factor.failed", { operatorId, ip }, "warn");
    if (tries < TWO_FACTOR_MAX_FAILURES) return "wrong";
    await endSession();
    // Once, as the limit is reached. The refused codes after it send nothing.
    tell(c, lockoutMail(TWO_FACTOR_MAX_FAILURES, WINDOW_MINUTES));
    return "locked";
  };

  /** The answer for a code that did not pass, or null when it passed. */
  const refuseCode = (c: Context<AppEnv>, checked: CodeCheck) => {
    if (checked === "wrong") return c.json(WRONG_CODE, 400);
    if (checked === "locked") return tooManyAttempts(c, limit);
    if (checked === "unreadable") return c.json(TWO_FACTOR_UNREADABLE, 500);
    if (checked === "unavailable") return c.json(CHECK_UNAVAILABLE, 503);
    return null;
  };

  app.openapi(setupRoute, async (c) => {
    const started = await startSetup(db, keys, c.get("operatorId"));
    if (started === null) return c.json(TWO_FACTOR_ON, 409);
    return c.json(started, 200);
  });

  app.openapi(enableRoute, async (c) => {
    const operatorId = c.get("operatorId");
    const { code } = c.req.valid("json");
    const finished = await finishSetup(db, keys, operatorId, c.get("sessionId"), code);
    if (finished === "no_setup") return c.json(NO_SETUP, 409);
    if (finished === "wrong_code") return c.json(WRONG_CODE, 400);
    audit(logger, "two_factor.enabled", { operatorId, ip: c.get("clientIp") });
    tell(c, twoFactorOnMail());
    // The drains check the session again and end the streams of the operator's other sessions,
    // which also stops the typing previews they get. If a signal is lost, the next drain does it.
    for (const { workspaceId } of await operatorWorkspaces(db, operatorId)) {
      live.wake(workspaceId, OPERATORS);
    }
    return c.json({ recoveryCodes: finished }, 200);
  });

  app.openapi(checkRoute, async (c) => {
    if (c.get("twoFactor") === "off") return c.json(TWO_FACTOR_OFF, 409);
    const sessionId = c.get("sessionId");
    const checked = await checkCode(c, c.req.valid("json").code, (tx) =>
      tx.update(session).set({ twoFactorAt: new Date() }).where(eq(session.id, sessionId)),
    );
    const refused = refuseCode(c, checked);
    if (refused !== null) return refused;
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(recoveryCodesRoute, async (c) => {
    if (c.get("twoFactor") === "off") return c.json(TWO_FACTOR_OFF, 409);
    const { code } = c.req.valid("json");
    // Only the app proves the phone, so a recovery code cannot make more of itself.
    if (!TOTP_CODE.test(code)) return c.json(WRONG_CODE, 400);
    const operatorId = c.get("operatorId");
    const { codes, hashes } = newRecoveryCodes(keys);
    const checked = await checkCode(c, code, (tx) =>
      tx
        .update(operatorTwoFactor)
        .set({ recoveryCodes: hashes })
        .where(eq(operatorTwoFactor.operatorId, operatorId)),
    );
    const refused = refuseCode(c, checked);
    if (refused !== null) return refused;
    audit(logger, "two_factor.recovery_regenerated", { operatorId, ip: c.get("clientIp") });
    return c.json({ recoveryCodes: codes }, 200);
  });

  app.openapi(disableRoute, async (c) => {
    if (c.get("twoFactor") === "off") return c.json(TWO_FACTOR_OFF, 409);
    const operatorId = c.get("operatorId");
    const checked = await checkCode(c, c.req.valid("json").code, (tx) => turnOff(tx, operatorId));
    const refused = refuseCode(c, checked);
    if (refused !== null) return refused;
    audit(logger, "two_factor.disabled", { operatorId, ip: c.get("clientIp") });
    tell(c, twoFactorOffMail("operator"));
    return c.json({ ok: true as const }, 200);
  });
}
