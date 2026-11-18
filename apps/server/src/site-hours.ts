import { and, eq, gte, not, type SQL, sql } from "drizzle-orm";
import type { Redis } from "iovalkey";
import { periodBounds } from "./analytics.ts";
import { conversation, siteHour, workspace } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { conversationHasTestVisitor } from "./messages.ts";
import { HOUR_MS, HOUR_SECONDS, MINUTE_MS } from "./time.ts";

// The site's traffic by the hour, in Postgres. The beats count each hour in a Valkey hash, which
// names itself in HOURS_KEY, and the worker copies it here at most a minute later.

/** The Valkey set of the hour hashes that the worker still has to copy. */
export const HOURS_KEY = "dinghy:live:hours";
const HOUR_HASH = /^dinghy:live:([0-9a-f-]{36}):h:(\d+)$/;
/** How long an hour stays: the longest period, 90 days, and a day either side for time zones. */
const KEPT_DAYS = 92;
/** How many pages and referrers the stats list. */
const TOP_COUNT = 8;
const DAY_HOURS = 24;
export const PERIOD_DAYS = [1, 7, 30, 90] as const;

type HourRow = typeof siteHour.$inferInsert;

/** The row of an hour from its hash's fields, as RECORD_BEAT writes them. */
function hourRow(workspaceId: string, hour: number, fields: Record<string, string>): HourRow {
  const row: HourRow = {
    workspaceId,
    hour: new Date(hour * HOUR_MS),
    visits: Number(fields.v ?? 0),
    pageViews: Number(fields.pv ?? 0),
    peak: 0,
    peakAt: null,
    pages: {},
    referrers: {},
    titles: {},
  };
  for (const [field, value] of Object.entries(fields)) {
    const colon = field.indexOf(":");
    if (colon === -1) continue;
    const [kind, key] = [field.slice(0, colon), field.slice(colon + 1)];
    if (kind === "p") row.pages[key] = Number(value);
    else if (kind === "r") row.referrers[key] = Number(value);
    else if (kind === "t") row.titles[key] = value;
    else if (kind === "m" && Number(value) > row.peak) {
      row.peak = Number(value);
      row.peakAt = new Date(hour * HOUR_MS + Number(key) * MINUTE_MS);
    }
  }
  return row;
}

/**
 * Writes a workspace's hours over the stored ones. A hash only grows, so a row never goes back to
 * fewer counts, which an older copy from a slower worker would otherwise do. A workspace that is
 * gone gets none.
 */
async function saveHours(db: Database, workspaceId: string, rows: HourRow[]): Promise<void> {
  await withWorkspace(db, workspaceId, async (tx) => {
    const [found] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    if (found === undefined) return;
    const fresher = (column: string) =>
      sql`${sql.identifier("site_hour")}.${sql.identifier(column)} <= excluded.${sql.identifier(column)}`;
    await tx
      .insert(siteHour)
      .values(rows)
      .onConflictDoUpdate({
        target: [siteHour.workspaceId, siteHour.hour],
        set: {
          visits: sql`excluded.visits`,
          pageViews: sql`excluded.page_views`,
          peak: sql`excluded.peak`,
          peakAt: sql`excluded.peak_at`,
          pages: sql`excluded.pages`,
          referrers: sql`excluded.referrers`,
          titles: sql`excluded.titles`,
        },
        setWhere: sql`${fresher("visits")} AND ${fresher("page_views")} AND ${fresher("peak")}`,
      });
  });
}

/**
 * Copies every hour hash named in HOURS_KEY into `site_hour`, and forgets the ones whose hour was
 * over before they were read, as nothing adds to them any more. A rerun writes the same rows.
 */
export async function rollUpHours(db: Database, valkey: Redis, now = Date.now()): Promise<void> {
  const keys = await valkey.smembers(HOURS_KEY);
  if (keys.length === 0) return;
  const batch = valkey.pipeline();
  for (const key of keys) batch.hgetall(key);
  const results = (await batch.exec()) ?? [];
  const current = Math.floor(now / HOUR_MS);
  const byWorkspace = new Map<string, HourRow[]>();
  const finished: string[] = [];
  keys.forEach((key, index) => {
    const [err, fields] = results[index] ?? [null, {}];
    if (err !== null) throw err;
    const match = HOUR_HASH.exec(key);
    const hour = Number(match?.[2]);
    if (match?.[1] !== undefined && Object.keys(fields as object).length > 0) {
      const rows = byWorkspace.get(match[1]) ?? [];
      rows.push(hourRow(match[1], hour, fields as Record<string, string>));
      byWorkspace.set(match[1], rows);
    }
    if (match === null || hour < current) finished.push(key);
  });
  for (const [workspaceId, rows] of byWorkspace) await saveHours(db, workspaceId, rows);
  if (finished.length > 0) await valkey.srem(HOURS_KEY, ...finished);
}

/** Deletes up to `limit` hours older than 92 days, across workspaces. For the worker. */
export async function pruneSiteHours(db: Database, limit: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM site_hour WHERE (workspace_id, hour) IN (
      SELECT workspace_id, hour FROM site_hour
      WHERE hour < now() - make_interval(days => ${KEPT_DAYS}) LIMIT ${limit})`);
  return result.rowCount ?? 0;
}

/** A period and the one of the same length before it, which ends at `previousUntil`. */
interface Window {
  since: Date;
  previousSince: Date;
  previousUntil: Date;
}

/**
 * One day is the last 24 whole hours: the current hour and the 23 before it. Longer periods start
 * at the start of a day in `timeZone`, as on the Analytics page.
 */
async function periodWindow(
  tx: Transaction,
  days: number,
  timeZone: string,
  now: Date,
): Promise<Window> {
  if (days === 1) {
    const since = (Math.floor(now.getTime() / HOUR_MS) - DAY_HOURS + 1) * HOUR_MS;
    return {
      since: new Date(since),
      previousSince: new Date(since - DAY_HOURS * HOUR_MS),
      previousUntil: new Date(since),
    };
  }
  const result = await tx.execute<{
    since: string;
    previous_since: string;
    previous_until: string;
  }>(sql`WITH ${periodBounds(days, timeZone, now)}
    SELECT since, previous_since, previous_until FROM bounds`);
  const row = result.rows[0];
  if (row === undefined) throw new Error("The period query returned no row");
  return {
    since: new Date(row.since),
    previousSince: new Date(row.previous_since),
    previousUntil: new Date(row.previous_until),
  };
}

/** Conversations that visitors started in the period and the one before, as Analytics counts them. */
async function countChats(tx: Transaction, workspaceId: string, window: Window) {
  const [row] = await tx
    .select({
      chats: sql<number>`count(*) filter (where ${gte(conversation.createdAt, window.since)})::int`,
      chatsBefore: sql<number>`count(*) filter (where ${conversation.createdAt} < ${window.previousUntil.toISOString()})::int`,
    })
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        gte(conversation.createdAt, window.previousSince),
        eq(conversation.startedBy, "visitor"),
        not(conversation.welcome),
        not(conversationHasTestVisitor(sql`${conversation}`)),
      ),
    );
  return { chats: row?.chats ?? 0, chatsBefore: row?.chatsBefore ?? 0 };
}

/** The most counted keys of a jsonb map column over the period's hours. */
const topKeys = (column: string) => sql`
  SELECT e.key, sum(e.value::int)::int AS count
  FROM period, jsonb_each_text(period.${sql.identifier(column)}) AS e
  GROUP BY e.key ORDER BY count DESC, e.key LIMIT ${TOP_COUNT}`;

interface StatsRow extends Record<string, unknown> {
  visits: number;
  visits_before: number;
  page_views: number;
  page_views_before: number;
  peak: { count: number; at: string } | null;
  series: { slot: number; visits: number }[];
  pages: { page: string; title: string | null; count: number }[];
  referrers: { referrer: string; count: number }[];
}

/** The period's numbers from the stored hours, in one statement so they read the same rows. */
async function readHours(
  tx: Transaction,
  workspaceId: string,
  window: Window,
  slot: SQL,
): Promise<StatsRow> {
  const since = sql`${window.since.toISOString()}::timestamptz`;
  const result = await tx.execute<StatsRow>(sql`
    WITH hours AS MATERIALIZED (
      SELECT * FROM site_hour
      WHERE workspace_id = ${workspaceId} AND hour >= ${window.previousSince.toISOString()}::timestamptz
    ), period AS (
      SELECT * FROM hours WHERE hour >= ${since}
    ), previous AS (
      SELECT * FROM hours WHERE hour < ${window.previousUntil.toISOString()}::timestamptz
    )
    SELECT
      (SELECT coalesce(sum(visits), 0) FROM period)::int AS visits,
      (SELECT coalesce(sum(visits), 0) FROM previous)::int AS visits_before,
      (SELECT coalesce(sum(page_views), 0) FROM period)::int AS page_views,
      (SELECT coalesce(sum(page_views), 0) FROM previous)::int AS page_views_before,
      (SELECT json_build_object('count', peak, 'at', peak_at) FROM period
         WHERE peak > 0 ORDER BY peak DESC, peak_at DESC LIMIT 1) AS peak,
      (SELECT coalesce(json_agg(json_build_object('slot', s.slot, 'visits', s.visits)), '[]')
         FROM (SELECT ${slot} AS slot, sum(visits)::int AS visits FROM period GROUP BY 1) AS s)
        AS series,
      (SELECT coalesce(json_agg(json_build_object(
                'page', p.key, 'count', p.count,
                'title', (SELECT t.titles ->> p.key FROM period AS t
                          WHERE t.titles ? p.key ORDER BY t.hour DESC LIMIT 1))
              ORDER BY p.count DESC, p.key), '[]')
         FROM (${topKeys("pages")}) AS p) AS pages,
      (SELECT coalesce(json_agg(json_build_object('referrer', r.key, 'count', r.count)
                                ORDER BY r.count DESC, r.key), '[]')
         FROM (${topKeys("referrers")}) AS r) AS referrers`);
  const row = result.rows[0];
  if (row === undefined) throw new Error("The visitor stats query returned no row");
  return row;
}

/** The stored side of the Visitors page's numbers for the last `days`, ending now. */
export async function readSiteStats(
  tx: Transaction,
  workspaceId: string,
  { days, timeZone, now }: { days: number; timeZone: string; now: Date },
) {
  const window = await periodWindow(tx, days, timeZone, now);
  const since = sql`${window.since.toISOString()}::timestamptz`;
  // Each hour goes in the slot of its start: its hour of the day, or its day in the time zone.
  const slot =
    days === 1
      ? sql`(extract(epoch FROM hour - ${since}) / ${HOUR_SECONDS})::int`
      : sql`(hour AT TIME ZONE ${timeZone})::date - (${since} AT TIME ZONE ${timeZone})::date`;
  const row = await readHours(tx, workspaceId, window, slot);
  const series = Array.from({ length: days === 1 ? DAY_HOURS : days }, () => 0);
  for (const { slot: index, visits } of row.series) {
    if (index >= 0 && index < series.length) series[index] = visits;
  }
  return {
    visits: row.visits,
    visitsBefore: row.visits_before,
    pageViews: row.page_views,
    pageViewsBefore: row.page_views_before,
    ...(await countChats(tx, workspaceId, window)),
    peak: row.peak === null ? null : { ...row.peak, at: new Date(row.peak.at).toISOString() },
    series,
    pages: row.pages,
    referrers: row.referrers.map(({ referrer, count }) => ({
      referrer: referrer === "" ? null : referrer,
      count,
    })),
  };
}
