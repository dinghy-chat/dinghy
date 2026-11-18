import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import type { ChainableCommander, Redis } from "iovalkey";
import { conversation, siteHour, workspace } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { countedConversation } from "./messages.ts";
import { periodBounds } from "./periods.ts";
import { DAY_MS, HOUR_MINUTES, HOUR_MS, HOUR_SECONDS, MINUTE_MS } from "./time.ts";

// The site's traffic by the hour. The beats count each hour in a Valkey hash, which names itself in
// HOURS_KEY, and the worker copies it to Postgres at most a minute later.

/** The Valkey set of the hour hashes that the worker still has to copy. */
export const HOURS_KEY = "dinghy:live:hours";
/**
 * An hour's hash stays this long in Valkey. The worker copies it to Postgres within a minute, and
 * the live chart reads only the last two hours' minutes.
 */
const HISTORY_HOURS = 3;
/** Distinct pages and referrers an hour keeps, so a flood of addresses stays bounded. */
export const HOUR_FIELD_CAP = 200;
/** The hour of a time, as hours since the epoch. */
export const hourOf = (ms: number) => Math.floor(ms / HOUR_MS);
/** The minute of a time within its hour, from 0 to 59. */
const minuteOfHour = (ms: number) => Math.floor(ms / MINUTE_MS) % HOUR_MINUTES;
/** The Valkey hash of a workspace's hour, which HOUR_HASH reads back. */
export const hourKey = (workspaceId: string, hour: number) =>
  `dinghy:live:${workspaceId}:h:${hour}`;
const HOUR_HASH = /^dinghy:live:([0-9a-f-]{36}):h:(\d+)$/;

/**
 * Adds a beat to its hour's history: the minute's most tabs at once, and for a visit or a page view
 * its counts. Past the cap, a new page or referrer is not added, so `np` and `nr` count the distinct
 * ones. The hour goes in the set of hours for the worker to copy. KEYS: the hour, the set. ARGV:
 * expiry in seconds, cap, minute, live tabs, is a visit, is a page view, page, title, referrer (""
 * for none).
 */
const RECORD_BEAT = `
local hour, cap = KEYS[1], tonumber(ARGV[2])
local function add(field, distinct)
  if redis.call('HEXISTS', hour, field) == 1 then
    redis.call('HINCRBY', hour, field, 1)
    return true
  end
  if tonumber(redis.call('HGET', hour, distinct) or '0') >= cap then return false end
  redis.call('HINCRBY', hour, distinct, 1)
  redis.call('HSET', hour, field, 1)
  return true
end
local minute = 'm:' .. ARGV[3]
if tonumber(redis.call('HGET', hour, minute) or '0') < tonumber(ARGV[4]) then
  redis.call('HSET', hour, minute, ARGV[4])
end
if ARGV[5] == '1' then
  redis.call('HINCRBY', hour, 'v', 1)
  add('r:' .. ARGV[9], 'nr')
end
if ARGV[6] == '1' then
  redis.call('HINCRBY', hour, 'pv', 1)
  if add('p:' .. ARGV[7], 'np') and ARGV[8] ~= '' then redis.call('HSET', hour, 't:' .. ARGV[7], ARGV[8]) end
end
redis.call('EXPIRE', hour, ARGV[1])
redis.call('SADD', KEYS[2], hour)`;

/** What a beat adds to its hour. */
interface HourBeat {
  /** The tabs live now, this one included. */
  liveCount: number;
  isVisit: boolean;
  isPageView: boolean;
  page: string;
  title: string | null;
  referrer: string | null;
}

/** Adds RECORD_BEAT to `multi`, so the beat's hour is written with the tab it comes from. */
export function recordBeat(
  multi: ChainableCommander,
  workspaceId: string,
  now: number,
  beat: HourBeat,
): ChainableCommander {
  return multi.eval(
    RECORD_BEAT,
    2,
    hourKey(workspaceId, hourOf(now)),
    HOURS_KEY,
    HISTORY_HOURS * HOUR_SECONDS,
    HOUR_FIELD_CAP,
    minuteOfHour(now),
    beat.liveCount,
    beat.isVisit ? 1 : 0,
    beat.isPageView ? 1 : 0,
    beat.page,
    beat.title ?? "",
    beat.referrer ?? "",
  );
}

/** The most tabs at once in each of the last 60 minutes up to `now`, oldest first. */
export async function minutePeaks(
  valkey: Redis,
  workspaceId: string,
  now: number,
): Promise<number[]> {
  const current = hourOf(now);
  const [before, latest] = await Promise.all([
    valkey.hgetall(hourKey(workspaceId, current - 1)),
    valkey.hgetall(hourKey(workspaceId, current)),
  ]);
  return Array.from({ length: HOUR_MINUTES }, (_, index) => {
    const minute = now - (HOUR_MINUTES - 1 - index) * MINUTE_MS;
    const fields = hourOf(minute) === current ? latest : before;
    return Number(fields[`m:${minuteOfHour(minute)}`] ?? 0);
  });
}
/** How long an hour stays: twice the longest period, so 90 days compare with the 90 before them. */
const KEPT_DAYS = 182;
/** How many pages and referrers the stats list. */
const TOP_COUNT = 8;
const DAY_HOURS = 24;
export const PERIOD_DAYS = [1, 7, 30, 90] as const;

type HourRow = typeof siteHour.$inferInsert;

/** The workspace and hour that a key from HOURS_KEY names, or null for a key of another shape. */
function parseHourKey(key: string): { workspaceId: string; hour: number } | null {
  const match = HOUR_HASH.exec(key);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { workspaceId: match[1], hour: Number(match[2]) };
}

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
 * Copies every hour hash named in HOURS_KEY into `site_hour`, and forgets the ones whose hour ended
 * over an hour ago, as no beat adds to them any more, even one that read its clock just before the
 * hour turned. A rerun writes the same rows. A workspace whose rows fail keeps its hours for the next
 * run, and the others are still saved; the first error is thrown after them.
 */
export async function rollUpHours(db: Database, valkey: Redis, now = Date.now()): Promise<void> {
  const keys = await valkey.smembers(HOURS_KEY);
  if (keys.length === 0) return;
  const batch = valkey.pipeline();
  for (const key of keys) batch.hgetall(key);
  const results = (await batch.exec()) ?? [];
  const current = hourOf(now);
  const byWorkspace = new Map<string, HourRow[]>();
  const finished = new Map<string, string[]>();
  // A key that names no hour is never copied, so it is forgotten at once.
  const forget: string[] = [];
  const add = <T>(groups: Map<string, T[]>, workspaceId: string, item: T) => {
    const group = groups.get(workspaceId) ?? [];
    group.push(item);
    groups.set(workspaceId, group);
  };
  keys.forEach((key, index) => {
    const [err, result] = results[index] ?? [null, {}];
    if (err !== null) throw err;
    const fields = result as Record<string, string>;
    const parsed = parseHourKey(key);
    if (parsed === null) {
      forget.push(key);
      return;
    }
    const { workspaceId, hour } = parsed;
    if (Object.keys(fields).length > 0)
      add(byWorkspace, workspaceId, hourRow(workspaceId, hour, fields));
    if (hour < current - 1) add(finished, workspaceId, key);
  });
  let failure: unknown = null;
  for (const [workspaceId, rows] of byWorkspace) {
    try {
      await saveHours(db, workspaceId, rows);
    } catch (err) {
      failure ??= err;
      finished.delete(workspaceId);
    }
  }
  forget.push(...[...finished.values()].flat());
  if (forget.length > 0) await valkey.srem(HOURS_KEY, ...forget);
  if (failure !== null) throw failure;
}

/** Deletes up to `limit` hours older than 182 days, across workspaces. For the worker. */
export async function pruneSiteHours(db: Database, limit: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM site_hour WHERE (workspace_id, hour) IN (
      SELECT workspace_id, hour FROM site_hour
      WHERE hour < now() - make_interval(days => ${KEPT_DAYS}) LIMIT ${limit})`);
  return result.rowCount ?? 0;
}

/** A time for a query, as Postgres's timestamptz. */
const at = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/**
 * A period and the one of the same length before it, which ends at `previousUntil`, on a whole hour
 * so its visits and its chats cover the same stored hours. Each stored hour goes in the slot of its
 * start, from 0 to `slotCount - 1`.
 */
interface StatsPeriod {
  since: Date;
  previousSince: Date;
  previousUntil: Date;
  slot: SQL;
  slotCount: number;
}

/**
 * One day is the last 24 whole hours: the current hour and the 23 before it, a slot each. Longer
 * periods start at the start of a day in `timeZone`, as on the Analytics page, with a slot per day.
 */
async function statsPeriod(
  tx: Transaction,
  days: number,
  timeZone: string,
  now: Date,
): Promise<StatsPeriod> {
  if (days === 1) {
    const since = new Date((hourOf(now.getTime()) - DAY_HOURS + 1) * HOUR_MS);
    return {
      since,
      previousSince: new Date(since.getTime() - DAY_MS),
      previousUntil: since,
      slot: sql`(extract(epoch FROM hour - ${at(since)}) / ${HOUR_SECONDS})::int`,
      slotCount: DAY_HOURS,
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
  const since = new Date(row.since);
  return {
    since,
    previousSince: new Date(row.previous_since),
    previousUntil: new Date(hourOf(Date.parse(row.previous_until)) * HOUR_MS),
    slot: sql`(hour AT TIME ZONE ${timeZone})::date - (${at(since)} AT TIME ZONE ${timeZone})::date`,
    slotCount: days,
  };
}

/** Conversations that visitors started in the period and the one before, as Analytics counts them. */
async function countChats(tx: Transaction, workspaceId: string, period: StatsPeriod) {
  const [row] = await tx
    .select({
      chats: sql<number>`count(*) filter (where ${gte(conversation.createdAt, period.since)})::int`,
      chatsBefore: sql<number>`count(*) filter (where ${lt(conversation.createdAt, period.previousUntil)})::int`,
    })
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        gte(conversation.createdAt, period.previousSince),
        eq(conversation.startedBy, "visitor"),
        countedConversation(sql`${conversation}`),
      ),
    );
  return { chats: row?.chats ?? 0, chatsBefore: row?.chatsBefore ?? 0 };
}

/** The most counted keys of a jsonb map column over the period's hours. */
const topKeys = (column: "pages" | "referrers") => sql`
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
  period: StatsPeriod,
): Promise<StatsRow> {
  const result = await tx.execute<StatsRow>(sql`
    WITH hours AS MATERIALIZED (
      SELECT * FROM site_hour
      WHERE workspace_id = ${workspaceId} AND hour >= ${at(period.previousSince)}
    ), period AS (
      SELECT * FROM hours WHERE hour >= ${at(period.since)}
    ), previous AS (
      SELECT * FROM hours WHERE hour < ${at(period.previousUntil)}
    )
    SELECT
      (SELECT coalesce(sum(visits), 0) FROM period)::int AS visits,
      (SELECT coalesce(sum(visits), 0) FROM previous)::int AS visits_before,
      (SELECT coalesce(sum(page_views), 0) FROM period)::int AS page_views,
      (SELECT coalesce(sum(page_views), 0) FROM previous)::int AS page_views_before,
      (SELECT json_build_object('count', peak, 'at', peak_at) FROM period
         WHERE peak > 0 ORDER BY peak DESC, peak_at DESC LIMIT 1) AS peak,
      (SELECT coalesce(json_agg(json_build_object('slot', s.slot, 'visits', s.visits)), '[]')
         FROM (SELECT ${period.slot} AS slot, sum(visits)::int AS visits FROM period GROUP BY 1) AS s)
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
  const period = await statsPeriod(tx, days, timeZone, now);
  const row = await readHours(tx, workspaceId, period);
  const series = Array.from({ length: period.slotCount }, () => 0);
  for (const { slot: index, visits } of row.series) {
    if (index >= 0 && index < series.length) series[index] = visits;
  }
  return {
    visits: row.visits,
    visitsBefore: row.visits_before,
    pageViews: row.page_views,
    pageViewsBefore: row.page_views_before,
    ...(await countChats(tx, workspaceId, period)),
    peak: row.peak === null ? null : { ...row.peak, at: new Date(row.peak.at).toISOString() },
    series,
    pages: row.pages,
    referrers: row.referrers.map(({ referrer, count }) => ({
      referrer: referrer === "" ? null : referrer,
      count,
    })),
  };
}
