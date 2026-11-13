import { z } from "@hono/zod-openapi";

// Durations in milliseconds, the unit Date and timers use.

export const MINUTE_MS = 60_000;
/** A minute in seconds, the unit rate limits take. */
export const MINUTE_SECONDS = MINUTE_MS / 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const HOUR_SECONDS = HOUR_MS / 1000;
export const DAY_MS = 24 * HOUR_MS;
// How long a finished alert delivery, and so the record of what an email carried, is kept.
export const RETENTION_MS = 30 * DAY_MS;

/**
 * An IANA zone name that this Node knows. An offset such as "+01:00" is refused, because Postgres
 * reads its sign the other way round.
 */
export function isTimeZone(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The spelling this Node uses for a zone that isTimeZone accepts: Europe/Paris for europe/paris. */
export const canonicalTimeZone = (name: string): string =>
  new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;

/** An IANA time zone, under the spelling this Node uses. */
export const TimeZone = z
  .string()
  .refine(isTimeZone, "an IANA time zone, such as Europe/Paris")
  .transform(canonicalTimeZone);
