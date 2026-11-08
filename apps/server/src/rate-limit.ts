import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { failure } from "./errors.ts";
import { sha256Hex } from "./identity.ts";

export interface RateLimit {
  /** Counts a hit. Returns the seconds to wait, or null if this hit is allowed. */
  hit(name: string, subject: string, max: number, windowSeconds: number): Promise<number | null>;
}

/**
 * A fixed window per subject, shared by every instance through Valkey. During a Valkey outage it
 * allows everything, because a send must succeed with Valkey down, and an outage must not lock out
 * every visitor and operator. The limit returns with Valkey.
 */
export function createRateLimit(valkey: Redis | null, logger: Logger, scale = 1): RateLimit {
  return {
    async hit(name, subject, max, windowSeconds) {
      if (valkey === null) return null;
      const digest = sha256Hex(subject);
      const key = `dinghy:limit:${name}:${digest}`;
      try {
        // One transaction, because a counter with no expiry would refuse this subject forever.
        const results = await valkey
          .multi()
          .incr(key)
          .expire(key, windowSeconds, "NX")
          .ttl(key)
          .exec();
        const count = results?.[0]?.[1];
        const ttl = results?.[2]?.[1];
        if (typeof count !== "number" || count <= Math.max(1, max * scale)) return null;
        return typeof ttl === "number" && ttl > 0 ? ttl : windowSeconds;
      } catch (err) {
        logger.warn({ err }, "rate limit unavailable");
        return null;
      }
    },
  };
}

export interface Slots {
  /**
   * Takes one of `max` places in `key`, until `release` or until `leaseMs` passes. Null means all
   * are taken. During a Valkey outage it admits everything, as the rate limits do.
   */
  take(key: string, max: number, leaseMs: number): Promise<{ release(): void } | null>;
}

// Members of a sorted set score by when they lapse. Old ones go first, so a place whose instance
// died stops counting once its lease ends.
const ADMIT = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

/**
 * Counts things held open, such as streams, across every instance through Valkey. `scale` is the
 * rate limits' scale, for a load test from one address.
 */
export function createSlots(valkey: Redis | null, logger: Logger, scale = 1): Slots {
  return {
    async take(key, max, leaseMs) {
      if (valkey === null) return { release() {} };
      const id = randomUUID();
      const most = Math.max(1, Math.floor(max * scale));
      try {
        const admitted = await valkey.eval(ADMIT, 1, key, Date.now(), Math.ceil(leaseMs), most, id);
        if (admitted === 0) return null;
      } catch (err) {
        logger.warn({ err }, "slot count unavailable");
        return { release() {} };
      }
      return {
        release() {
          valkey.zrem(key, id).catch((err: unknown) => {
            logger.warn({ err }, "could not release a slot");
          });
        },
      };
    },
  };
}

export const tooManyRequests = (c: Context, retryAfter: number) => {
  c.header("retry-after", String(retryAfter));
  return c.json(failure("too_many_requests", "Too many requests. Try again later."), 429);
};

/** A route limit per client address. */
export function limitByIp(limit: RateLimit, name: string, max: number, windowSeconds: number) {
  return async (c: Context, next: Next) => {
    const wait = await limit.hit(name, c.get("clientIp"), max, windowSeconds);
    if (wait !== null) return tooManyRequests(c, wait);
    await next();
  };
}
