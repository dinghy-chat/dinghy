import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { isUnknownZone, UNKNOWN_ZONE } from "./analytics.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { conversation, message, visitor } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { INVALID, MEMBER_ERRORS } from "./errors.ts";
import { WORKSPACE_PREFIX as PREFIX, workspaceParams } from "./member.ts";
import { isChat, snoozedNow } from "./messages.ts";
import { HOURS_KEY, PERIOD_DAYS, readSiteStats } from "./site-hours.ts";
import { HOUR_MS, HOUR_SECONDS, MINUTE_MS, TimeZone } from "./time.ts";

/** A tab that stops beating, closed or asleep, leaves the live view after this long. */
const LIVE_TTL_MS = 90_000;
/** Tabs a workspace shows at once. A beat above it is dropped, so a flood stays bounded. */
export const LIVE_TAB_CAP = 2000;

/**
 * An hour's hash stays this long in Valkey. The worker copies it to Postgres within a minute, and
 * the live chart reads only the last two hours' minutes.
 */
const HISTORY_HOURS = 3;
/** Distinct pages and referrers an hour keeps, so a flood of addresses stays bounded. */
export const HOUR_FIELD_CAP = 200;

/**
 * Drops the expired tabs, then adds this one unless the workspace is full, in one step, so beats at
 * once cannot pass the cap. Returns the tab's details from before ("" for none), the tabs live now,
 * and 1 when this beat added the tab, which only one of two beats at once can do; or nil when full.
 */
const ADMIT_TAB = `
local order, tabs, tab = KEYS[1], KEYS[2], ARGV[1]
local expired = redis.call('ZRANGEBYSCORE', order, '-inf', ARGV[2])
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', order, '-inf', ARGV[2])
  redis.call('HDEL', tabs, unpack(expired))
end
local added = redis.call('ZSCORE', order, tab) and 0 or 1
if added == 1 and redis.call('ZCARD', order) >= tonumber(ARGV[4]) then
  return nil
end
redis.call('ZADD', order, ARGV[3], tab)
return {redis.call('HGET', tabs, tab) or '', redis.call('ZCARD', order), added}`;

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

const orderKey = (workspaceId: string) => `dinghy:live:${workspaceId}`;
const tabsKey = (workspaceId: string) => `dinghy:live:${workspaceId}:tabs`;
/** One hour's history, by the hours since the epoch. */
export const hourKey = (workspaceId: string, hour: number) =>
  `dinghy:live:${workspaceId}:h:${hour}`;

/** One open tab of the host site, as its latest beat described it. */
interface LiveTab {
  tab: string;
  page: string;
  title: string | null;
  /** The site the visitor came from, as an origin, from the tab's first beat. */
  referrer: string | null;
  country: string | null;
  timeZone: string | null;
  device: string | null;
  /** Set only for a visitor who has used the chat. */
  visitorId: string | null;
  conversationId: string | null;
  startedAt: number;
  seenAt: number;
}

/**
 * A beat, whether it is its tab's first (only that one carries the referrer), and whether the tab
 * arrived from another site or from nowhere, not from the site's own page.
 */
type Beat = Omit<LiveTab, "startedAt" | "seenAt"> & { first: boolean; entrance: boolean };

export interface LiveVisitors {
  /** False when the workspace already shows as many tabs as it may. */
  beat(workspaceId: string, beat: Beat): Promise<boolean>;
  leave(workspaceId: string, tab: string): Promise<void>;
  /** Null when Valkey cannot answer. */
  list(workspaceId: string): Promise<LiveTab[] | null>;
  count(workspaceId: string): Promise<number | null>;
  /** Tabs live at once in each of the last 60 minutes, oldest first. Null when Valkey cannot answer. */
  lastHour(workspaceId: string): Promise<number[] | null>;
}

const parse = (text: string | null): LiveTab | null => {
  if (text === null) return null;
  try {
    return JSON.parse(text) as LiveTab;
  } catch {
    return null;
  }
};

/**
 * Who is on the site now, only in Valkey: a sorted set of tabs by expiry, and a hash of each tab's
 * details. Losing Valkey loses only this view, and every read and write can fail.
 */
export function createLiveVisitors(valkey: Redis | null, logger: Logger): LiveVisitors {
  const attempt = async <T>(fallback: T, work: (client: Redis) => Promise<T>): Promise<T> => {
    if (valkey === null) return fallback;
    try {
      return await work(valkey);
    } catch (err) {
      logger.warn({ err }, "the live visitors are unavailable");
      return fallback;
    }
  };

  return {
    beat(workspaceId, beat) {
      return attempt(false, async (client) => {
        const tabs = tabsKey(workspaceId);
        const now = Date.now();
        const admitted = (await client.eval(
          ADMIT_TAB,
          2,
          orderKey(workspaceId),
          tabs,
          beat.tab,
          now,
          now + LIVE_TTL_MS,
          LIVE_TAB_CAP,
        )) as [string, number, number] | null;
        if (admitted === null) return false;
        const [previous, liveCount, added] = admitted;
        const before = parse(previous === "" ? null : previous);
        const { first, entrance, ...details } = beat;
        // A tab that comes back after its presence expired is added again, but only its first beat
        // is a visit or a page view. A later page change in the same tab is a page view too.
        const isNew = added === 1 && first;
        const isPageView = isNew || (before !== null && before.page !== beat.page);
        const entry: LiveTab = {
          ...details,
          // The referrer comes with the first beat only, so later beats keep it.
          referrer: before?.referrer ?? beat.referrer,
          startedAt: before?.startedAt ?? now,
          seenAt: now,
        };
        await client
          .multi()
          .hset(tabs, beat.tab, JSON.stringify(entry))
          .pexpire(orderKey(workspaceId), LIVE_TTL_MS * 2)
          .pexpire(tabs, LIVE_TTL_MS * 2)
          .eval(
            RECORD_BEAT,
            2,
            hourKey(workspaceId, Math.floor(now / HOUR_MS)),
            HOURS_KEY,
            HISTORY_HOURS * HOUR_SECONDS,
            HOUR_FIELD_CAP,
            Math.floor(now / MINUTE_MS) % 60,
            liveCount,
            isNew && entrance ? 1 : 0,
            isPageView ? 1 : 0,
            beat.page,
            beat.title ?? "",
            beat.referrer ?? "",
          )
          .exec();
        return true;
      });
    },
    leave(workspaceId, tab) {
      return attempt(undefined, async (client) => {
        await client
          .multi()
          .zrem(orderKey(workspaceId), tab)
          .hdel(tabsKey(workspaceId), tab)
          .exec();
      });
    },
    list(workspaceId) {
      return attempt(null, async (client) => {
        const live = await client.zrangebyscore(orderKey(workspaceId), Date.now(), "+inf");
        if (live.length === 0) return [];
        const rows = await client.hmget(tabsKey(workspaceId), ...live);
        return rows.map(parse).filter((row) => row !== null);
      });
    },
    count(workspaceId) {
      return attempt(null, (client) => client.zcount(orderKey(workspaceId), Date.now(), "+inf"));
    },
    lastHour(workspaceId) {
      return attempt(null, async (client) => {
        const nowMinute = Math.floor(Date.now() / MINUTE_MS);
        const current = Math.floor(nowMinute / 60);
        const [before, latest] = await Promise.all([
          client.hgetall(hourKey(workspaceId, current - 1)),
          client.hgetall(hourKey(workspaceId, current)),
        ]);
        return Array.from({ length: 60 }, (_, index) => {
          const minute = nowMinute - 59 + index;
          const fields = Math.floor(minute / 60) === current ? latest : before;
          return Number(fields[`m:${minute % 60}`] ?? 0);
        });
      });
    },
  };
}

const LiveVisitorSchema = z
  .object({
    // The tab's random ID, which lives only in the page's memory.
    tab: z.string(),
    // Origin and path, never a query or hash.
    page: z.string(),
    title: z.string().nullable(),
    // The origin the visitor came from.
    referrer: z.string().nullable(),
    // ISO 3166-1 alpha-2, from the address, which is not kept.
    country: z.string().nullable(),
    timeZone: z.string().nullable(),
    device: z.string().nullable(),
    startedAt: z.string(),
    // Only for a visitor who has used the chat.
    visitor: z
      .object({
        id: z.string(),
        name: z.string().nullable(),
        email: z.string().nullable(),
        userId: z.string().nullable(),
        // Their newest conversation, open first.
        conversationId: z.string().nullable(),
        // When that conversation is open, not snoozed, and its newest message is theirs: that message's time.
        waitingSince: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("LiveVisitor");

const listRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/visitors/live`,
  security: SESSION,
  summary: "List the tabs of the site open now, newest first",
  description:
    "Each tab of a page with the widget beats once a minute while it is visible, and leaves the list 90 seconds after its last beat. It holds no cookie and no stored ID. Null `visitors` means the server cannot tell now.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The live tabs",
      content: {
        "application/json": {
          schema: z.object({ visitors: z.array(LiveVisitorSchema).nullable() }),
        },
      },
    },
    ...MEMBER_ERRORS,
  },
});

const countRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/visitors/live/count`,
  security: SESSION,
  summary: "Count the tabs of the site open now",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The count, or null when the server cannot tell now",
      content: { "application/json": { schema: z.object({ count: z.number().int().nullable() }) } },
    },
    ...MEMBER_ERRORS,
  },
});

const counted = z.number().int();

const VisitorStatsSchema = z
  .object({
    // The most tabs open at once in each of the last 60 minutes, oldest first. Null when the server
    // cannot tell now.
    lastHour: z.array(counted).length(60).nullable(),
    visits: counted,
    visitsBefore: counted,
    pageViews: counted,
    pageViewsBefore: counted,
    chats: counted,
    chatsBefore: counted,
    peak: z.object({ count: counted, at: z.string() }).nullable(),
    // Visits per hour for one day, per day in `tz` otherwise, oldest first.
    series: z.array(counted),
    pages: z.array(z.object({ page: z.string(), title: z.string().nullable(), count: counted })),
    referrers: z.array(z.object({ referrer: z.string().nullable(), count: counted })),
  })
  .openapi("VisitorStats");

const StatsQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((days) => (PERIOD_DAYS as readonly number[]).includes(days), "1, 7, 30 or 90")
    .default(1),
  tz: TimeZone.default("UTC"),
});

const statsRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/visitors/stats`,
  security: SESSION,
  summary: "Count the site's visits, page views, chats and busiest minute over 1, 7, 30 or 90 days",
  description:
    "Counted by the hour with no cookie and no stored ID, and kept 182 days; the stored hours are at most about a minute behind. One day is the last 24 whole hours: the current hour and the 23 before it. A longer period runs from the start of the day, `days - 1` days ago, in `tz`, to now, as for analytics. The `Before` numbers are for a period of the same length just before. A visit is a tab that opened from another site or from nowhere; a page view is a tab that opened, or one whose page changed. `series` holds the visits per hour for one day, and per day in `tz` otherwise, oldest first. `peak` is the busiest minute, by the most tabs open at once. `pages` and `referrers` list the top 8, with a null `referrer` for none; an hour keeps at most 200 distinct pages and 200 referrers. `chats` counts the conversations that visitors started in the period, leaving out the welcome chat and test visitors. `lastHour` holds the most tabs open at once in each of the last 60 minutes, oldest first, and is null when the server cannot tell now.",
  request: { params: workspaceParams, query: StatsQuery },
  responses: {
    200: {
      description: "The stats",
      content: { "application/json": { schema: VisitorStatsSchema } },
    },
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

/**
 * When each of these conversations started to wait for a reply: the visitor's first message since the
 * team's latest one. Waiting follows `countWaiting`: open, not snoozed, and its newest chat message is
 * the visitor's. Leaves out the ones that do not wait.
 */
async function waitingSince(
  tx: Transaction,
  workspaceId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  // A chat message of this conversation, as `alias`.
  const chat = (alias: string) =>
    sql`${sql.raw(alias)}.workspace_id = c.workspace_id and ${sql.raw(alias)}.conversation_id = c.id
      and ${isChat(sql.raw(`${alias}.kind`))} and ${sql.raw(alias)}.deleted_at is null`;
  // The wait starts at the visitor's first message after the team's latest reply.
  const result = await tx.execute<{ id: string; since: string }>(sql`
    select c.id, (
      select min(v.created_at) from ${message} as v
      where ${chat("v")} and v.author_visitor_id is not null
        and v.seq > coalesce(
          (select max(r.seq) from ${message} as r where ${chat("r")} and r.author_visitor_id is null),
          -1)
    ) as since
    from ${conversation} as c
    cross join lateral (
      select m.author_visitor_id from ${message} as m
      where ${chat("m")}
      order by m.seq desc
      limit 1
    ) as newest
    where c.workspace_id = ${workspaceId} and ${inArray(sql`c.id`, ids)} and c.status = 'open'
      and newest.author_visitor_id is not null and not ${snoozedNow(sql`c`)}`);
  return new Map(result.rows.map(({ id, since }) => [id, new Date(since).toISOString()]));
}

/** The live tabs, newest first, with who the chatting visitors are. Null when Valkey cannot tell. */
export async function liveVisitorList(
  db: Database,
  visitors: LiveVisitors,
  id: string,
): Promise<z.infer<typeof LiveVisitorSchema>[] | null> {
  const tabs = await visitors.list(id);
  if (tabs === null) return null;
  // Who the chatting visitors are, in one query, from this workspace only.
  const ids = [...new Set(tabs.flatMap((tab) => (tab.visitorId === null ? [] : [tab.visitorId])))];
  const conversationIds = [
    ...new Set(tabs.flatMap((tab) => (tab.conversationId === null ? [] : [tab.conversationId]))),
  ];
  const { people, waiting } =
    ids.length === 0
      ? { people: [], waiting: new Map<string, string>() }
      : await withWorkspace(db, id, async (tx) => ({
          people: await tx
            .select({
              id: visitor.id,
              name: visitor.name,
              email: visitor.email,
              userId: visitor.userId,
            })
            .from(visitor)
            .where(and(eq(visitor.workspaceId, id), inArray(visitor.id, ids))),
          waiting: await waitingSince(tx, id, conversationIds),
        }));
  const byId = new Map(people.map((person) => [person.id, person]));
  return tabs
    .sort((one, other) => other.startedAt - one.startedAt)
    .map(({ visitorId, conversationId, startedAt, seenAt: _seen, ...tab }) => {
      const person = visitorId === null ? undefined : byId.get(visitorId);
      return {
        ...tab,
        startedAt: new Date(startedAt).toISOString(),
        visitor:
          person === undefined
            ? null
            : {
                ...person,
                conversationId,
                waitingSince:
                  conversationId === null ? null : (waiting.get(conversationId) ?? null),
              },
      };
    });
}

export function registerLiveVisitorRoutes(app: App, db: Database, visitors: LiveVisitors): void {
  app.openapi(countRoute, async (c) => {
    return c.json({ count: await visitors.count(c.get("memberWorkspaceId")) }, 200);
  });

  app.openapi(statsRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { days, tz } = c.req.valid("query");
    const read = withWorkspace(
      db,
      id,
      (tx) => readSiteStats(tx, id, { days, timeZone: tz, now: new Date() }),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ).catch((error: unknown) => {
      if (isUnknownZone(error)) return null;
      throw error;
    });
    const [lastHour, stats] = await Promise.all([visitors.lastHour(id), read]);
    if (stats === null) return c.json(UNKNOWN_ZONE, 400);
    return c.json({ lastHour, ...stats }, 200);
  });

  app.openapi(listRoute, async (c) =>
    c.json({ visitors: await liveVisitorList(db, visitors, c.get("memberWorkspaceId")) }, 200),
  );
}
