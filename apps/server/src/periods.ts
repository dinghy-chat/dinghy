import { z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { failure } from "./errors.ts";
import { TimeZone } from "./time.ts";

// The periods of the Analytics page, for its conversations and its site's numbers: which ones a
// query may ask for, where they start and end, and a read of them in a time zone that Postgres may
// not know.

/** Postgres's code for a time zone it does not know. */
const PG_INVALID_PARAMETER = "22023";

/** A period of one of `periods` days, `fallback` by default, and the time zone its days start in. */
export const periodQuery = (periods: readonly number[], fallback: number) =>
  z.object({
    days: z.coerce
      .number()
      .int()
      .refine(
        (days) => periods.includes(days),
        `${periods.slice(0, -1).join(", ")} or ${periods.at(-1)}`,
      )
      .default(fallback),
    tz: TimeZone.default("UTC"),
  });

/**
 * The CTEs `clock`, `local_today` and `bounds` of a period of `days` that ends at `now`: it starts at
 * the start of the day `days - 1` days ago in `timeZone`. `bounds` has `first_day`, `since`, and the
 * previous period's `previous_since` and `previous_until`.
 */
export const periodBounds = (days: number, timeZone: string, now: Date) => sql`
    clock AS (
      SELECT ${now.toISOString()}::timestamptz AS now
    ), local_today AS (
      SELECT (clock.now AT TIME ZONE ${timeZone})::date AS day FROM clock
    ), local_bounds AS (
      SELECT day - ${days - 1}::int AS first_day,
             ((day - ${days - 1}::int)::timestamp AT TIME ZONE ${timeZone}) AS since,
             ((day - ${2 * days - 1}::int)::timestamp AT TIME ZONE ${timeZone}) AS previous_since
      FROM local_today
    ), bounds AS (
      -- The previous period lasts as many real seconds as the current one, which ends now, so a
      -- change of clocks in either period does not make one longer. LEAST keeps them apart.
      SELECT b.*,
             LEAST(b.since, b.previous_since + make_interval(
               secs => extract(epoch FROM clock.now - b.since)::double precision)) AS previous_until
      FROM local_bounds AS b, clock
    )`;

/** A time zone Postgres does not know, as its own tz database can lag Node's. */
function isUnknownZone(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === PG_INVALID_PARAMETER) return true;
  }
  return false;
}

export const UNKNOWN_ZONE = failure("invalid_request", "This server does not know that time zone.");

/**
 * One read of a period's numbers in a time zone, in one snapshot, or null when Postgres does not
 * know the zone.
 */
export async function readInZone<T>(
  db: Database,
  workspaceId: string,
  read: (tx: Transaction) => Promise<T>,
): Promise<T | null> {
  try {
    return await withWorkspace(db, workspaceId, read, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  } catch (error) {
    if (!isUnknownZone(error)) throw error;
    return null;
  }
}
