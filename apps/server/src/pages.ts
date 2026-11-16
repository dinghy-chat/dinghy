import { z } from "@hono/zod-openapi";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";

// The cursor of a list sorted by a time, newest first: the time and the row's ID.

/** An ISO time in UTC to the microsecond, as the cursor carries it. */
const CURSOR_TIME_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

const CURSOR =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z,[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** The pattern lets through a day that does not exist, such as February 30, which Postgres refuses. */
function isRealTime(cursor: string): boolean {
  const second = cursor.slice(0, "YYYY-MM-DDTHH:MM:SS".length);
  const time = new Date(`${second}Z`);
  return !Number.isNaN(time.getTime()) && time.toISOString().startsWith(second);
}

/** A page's position, as the page before answered it in `next`. */
export const TimeCursor = z.string().regex(CURSOR).refine(isRealTime);

/**
 * A time as a page cursor carries it. As text, because Postgres keeps microseconds and a JavaScript
 * date only milliseconds, so a cursor from a date would skip the rows that share its millisecond.
 */
export const cursorTime = (time: SQL | AnyColumn) =>
  sql<string>`to_char(${time} at time zone 'UTC', ${CURSOR_TIME_FORMAT})`;

/** The rows after the cursor, in the order of `(time, id)` descending. */
export function beforeCursor(cursor: string | undefined, time: SQL | AnyColumn, id: AnyColumn) {
  if (cursor === undefined) return undefined;
  const [at, rowId] = cursor.split(",");
  return sql`(${time}, ${id}) < (${at}::timestamptz, ${rowId}::uuid)`;
}
