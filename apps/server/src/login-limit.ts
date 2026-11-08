import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "hono";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { failure } from "./errors.ts";
import { emailAddressHash, sha256Hex } from "./identity.ts";

const CLEAR_WAIT_MS = 1000;

interface AccountLimit {
  /** How long a count lasts, and so the longest wait after the last attempt. */
  windowSeconds: number;
  /** Counts an attempt and returns false if this account and address have used up their attempts. */
  attempt(email: string, ip: string): Promise<boolean>;
  /** With an address, clears only that one. Without one, clears every address for this account. */
  clear(email: string, ip?: string): Promise<void>;
}

/**
 * Limits attempts across instances. The count is per account and address, so someone else's address
 * cannot lock an operator out. A second count per address stops one machine from trying many
 * accounts. A third count per account, high and short, slows guesses from many addresses. It
 * counts before the attempt, so parallel requests cannot pass the limit. During a Valkey outage it
 * allows everything, because locking every operator out is worse.
 */
function createAccountLimit(
  valkey: Redis | null,
  logger: Logger,
  {
    prefix,
    maxPerAccountAddress,
    maxPerAddress,
    maxPerAccount,
    windowSeconds,
  }: {
    prefix: string;
    maxPerAccountAddress: number;
    maxPerAddress: number;
    maxPerAccount: number;
    windowSeconds: number;
  },
): AccountLimit {
  const keyFor = (email: string) => `dinghy:${prefix}:${emailAddressHash(email)}`;
  const addressKeyFor = (ip: string) => `dinghy:${prefix}-address:${sha256Hex(ip)}`;
  return {
    windowSeconds,
    async attempt(email, ip) {
      if (valkey === null) return true;
      try {
        const key = keyFor(email);
        const totalKey = `${key}:total`;
        const addressKey = addressKeyFor(ip);
        // One transaction, because a counter with no expiry would lock the account forever.
        const results = await valkey
          .multi()
          .hincrby(key, ip, 1)
          .expire(key, windowSeconds, "NX")
          .incr(addressKey)
          .expire(addressKey, windowSeconds, "NX")
          .exec();
        const count = results?.[0]?.[1];
        const fromAddress = results?.[2]?.[1];
        if (typeof count === "number" && count > maxPerAccountAddress) return false;
        // With no known address, everyone would share one count, so this check does not apply.
        if (ip !== "unknown" && typeof fromAddress === "number" && fromAddress > maxPerAddress) {
          return false;
        }
        // Only attempts that passed the checks above count here, so one address that keeps trying
        // cannot use up the account's total and lock its owner out.
        const totals = await valkey
          .multi()
          .incr(totalKey)
          .expire(totalKey, windowSeconds, "NX")
          .exec();
        const total = totals?.[0]?.[1];
        return !(typeof total === "number" && total > maxPerAccount);
      } catch (err) {
        logger.warn({ err }, "account limit unavailable");
        return true;
      }
    },
    async clear(email, ip) {
      if (valkey === null) return;
      // Bounded, because the reset that calls this has already committed. A stalled Valkey must
      // not hold back the answer, and the count expires on its own.
      const key = keyFor(email);
      const work = ip === undefined ? valkey.del(key, `${key}:total`) : valkey.hdel(key, ip);
      await Promise.race([
        work.catch((err: unknown) => {
          logger.warn({ err }, "account limit unavailable");
        }),
        delay(CLEAR_WAIT_MS, undefined, { ref: false }),
      ]);
    },
  };
}

// The account total slows guessing spread over many addresses. It takes 40 addresses to reach, and
// lasts 15 minutes at most: a password reset, by email or `chat reset-password`, clears it.
export const createLoginLimit = (valkey: Redis | null, logger: Logger) =>
  createAccountLimit(valkey, logger, {
    prefix: "login",
    maxPerAccountAddress: 5,
    maxPerAddress: 30,
    maxPerAccount: 200,
    windowSeconds: 15 * 60,
  });

// Each reset request sends one email through the owner's mail server, so an account also has a total.
export const createResetLimit = (valkey: Redis | null, logger: Logger) =>
  createAccountLimit(valkey, logger, {
    prefix: "reset",
    maxPerAccountAddress: 3,
    maxPerAddress: 30,
    maxPerAccount: 10,
    windowSeconds: 60 * 60,
  });

/** The answer once attempts are used up. Retry-After is the whole window, the longest wait. */
export const tooManyAttempts = (c: Context, limit: AccountLimit) => {
  c.header("retry-after", String(limit.windowSeconds));
  return c.json(failure("too_many_attempts", "Too many attempts. Try again later."), 429);
};
