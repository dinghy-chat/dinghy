import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { AnalyticsQuery } from "./analytics.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { visitor } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { INVALID, MEMBER_ERRORS } from "./errors.ts";
import { WORKSPACE_PREFIX as PREFIX, workspaceParams } from "./member.ts";
import { waitingSince } from "./messages.ts";
import { readInZone, UNKNOWN_ZONE } from "./periods.ts";
import { minutePeaks, readSiteStats, recordBeat } from "./site-hours.ts";
import { HOUR_MINUTES } from "./time.ts";

/** A tab that stops beating, closed or asleep, leaves the live view after this long. */
const LIVE_TTL_MS = 90_000;
/** Tabs a workspace shows at once. A beat above it is dropped, so a flood stays bounded. */
export const LIVE_TAB_CAP = 2000;

/**
 * Drops the expired tabs, then adds this one unless the workspace is full, in one step, so beats at
 * once cannot pass the cap. Returns the tab's details from before ("" for none), the tabs live now,
 * and 1 when this is the tab's first beat and the first to arrive with it, so a sent-again first beat
 * counts once; or nil when full. The `+tab` field marks a tab whose first beat was counted.
 */
const ADMIT_TAB = `
local order, tabs, tab = KEYS[1], KEYS[2], ARGV[1]
local expired = redis.call('ZRANGEBYSCORE', order, '-inf', ARGV[2])
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', order, '-inf', ARGV[2])
  local fields = {}
  for _, id in ipairs(expired) do
    fields[#fields + 1] = id
    fields[#fields + 1] = '+' .. id
  end
  redis.call('HDEL', tabs, unpack(fields))
end
if not redis.call('ZSCORE', order, tab) and redis.call('ZCARD', order) >= tonumber(ARGV[4]) then
  return nil
end
redis.call('ZADD', order, ARGV[3], tab)
local counted = ARGV[5] == '1' and redis.call('HSETNX', tabs, '+' .. tab, 1) or 0
return {redis.call('HGET', tabs, tab) or '', redis.call('ZCARD', order), counted}`;

const orderKey = (workspaceId: string) => `dinghy:live:${workspaceId}`;
/** Exported for the dev seed, which stores a tab before its first beat. */
export const tabsKey = (workspaceId: string) => `dinghy:live:${workspaceId}:tabs`;

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
 * A beat, and for its tab's first beat, the only one that carries the referrer, how the tab arrived:
 * from another site or from nowhere (`entrance`), or from the site's own page (`inside`). Null for a
 * later beat.
 */
type Beat = Omit<LiveTab, "startedAt" | "seenAt"> & { arrival: "entrance" | "inside" | null };

export interface LiveVisitors {
  /** False when the workspace already shows as many tabs as it may. */
  beat(workspaceId: string, beat: Beat): Promise<boolean>;
  leave(workspaceId: string, tab: string): Promise<void>;
  /** Null when Valkey cannot answer. */
  list(workspaceId: string): Promise<LiveTab[] | null>;
  count(workspaceId: string): Promise<number | null>;
  /** The most tabs live at once in each of the last 60 minutes, oldest first. Null as for `list`. */
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
          beat.arrival === null ? 0 : 1,
        )) as [string, number, number] | null;
        if (admitted === null) return false;
        const [previous, liveCount, counted] = admitted;
        const before = parse(previous === "" ? null : previous);
        const { arrival, ...details } = beat;
        // Only a tab's first beat, the one that carries the referrer, is a visit and a page view,
        // once, even when a later beat reaches the server first or the tab comes back after it
        // expired. A later page change in the same tab is a page view too.
        const isNew = counted === 1;
        const isPageView = isNew || (before !== null && before.page !== beat.page);
        const entry: LiveTab = {
          ...details,
          // The referrer comes with the first beat only, so later beats keep it.
          referrer: before?.referrer ?? beat.referrer,
          startedAt: before?.startedAt ?? now,
          seenAt: now,
        };
        const write = client
          .multi()
          .hset(tabs, beat.tab, JSON.stringify(entry))
          .pexpire(orderKey(workspaceId), LIVE_TTL_MS * 2)
          .pexpire(tabs, LIVE_TTL_MS * 2);
        await recordBeat(write, workspaceId, now, {
          liveCount,
          isVisit: isNew && arrival === "entrance",
          isPageView,
          page: beat.page,
          title: beat.title,
          referrer: beat.referrer,
        }).exec();
        return true;
      });
    },
    leave(workspaceId, tab) {
      return attempt(undefined, async (client) => {
        await client
          .multi()
          .zrem(orderKey(workspaceId), tab)
          .hdel(tabsKey(workspaceId), tab, `+${tab}`)
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
      return attempt(null, (client) => minutePeaks(client, workspaceId, Date.now()));
    },
  };
}

const Count = z.number().int();

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
        // When that conversation is open, not snoozed, and its newest message is theirs: the time of
        // their first message since the team's latest one.
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
    "Each tab of a page with the widget beats once a minute while it is visible, and leaves the list 90 seconds after its last beat. It holds no cookie and no stored ID. `lastHour` holds the most tabs open at once in each of the last 60 minutes, oldest first. Null `visitors` or `lastHour` means the server cannot tell now.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The live tabs",
      content: {
        "application/json": {
          schema: z.object({
            visitors: z.array(LiveVisitorSchema).nullable(),
            lastHour: z.array(Count).length(HOUR_MINUTES).nullable(),
          }),
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

const VisitorStatsSchema = z
  .object({
    visits: Count,
    pageViews: Count,
    chats: Count,
    // The period of the same length just before, or null when the stored hours do not reach back to
    // its start, as on a site that Dinghy has not counted for that long.
    previous: z.object({ visits: Count, pageViews: Count, chats: Count }).nullable(),
    peak: z.object({ count: Count, at: z.string() }).nullable(),
    // Visits per day in `tz`, oldest first.
    series: z.array(Count),
    pages: z.array(z.object({ page: z.string(), title: z.string().nullable(), count: Count })),
    referrers: z.array(z.object({ referrer: z.string().nullable(), count: Count })),
  })
  .openapi("VisitorStats");

const statsRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/visitors/stats`,
  security: SESSION,
  summary: "Count the site's visits, page views, chats and busiest minute over 7, 30 or 90 days",
  description:
    "Counted by the hour with no cookie and no stored ID, and kept 182 days; the stored hours are at most about a minute behind. A period runs from the start of the day, `days - 1` days ago, in `tz`, to now, as for analytics. `previous` holds the numbers of a period of the same length just before, or null when the stored hours do not reach back to its start. A visit is a tab that opened from another site or from nowhere; a page view is a tab that opened, or one whose page changed. `series` holds the visits per day in `tz`, oldest first. `peak` is the busiest minute, by the most tabs open at once. `pages` and `referrers` list the top 8, with a null `referrer` for none; an hour keeps at most 200 distinct pages and 200 referrers. `chats` counts the conversations that visitors started in the period, leaving out the welcome chat and test visitors.",
  request: { params: workspaceParams, query: AnalyticsQuery },
  responses: {
    200: {
      description: "The stats",
      content: { "application/json": { schema: VisitorStatsSchema } },
    },
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

/** Each value once, without the nulls. */
const distinct = (values: (string | null)[]) =>
  [...new Set(values)].filter((value) => value !== null);

/** The live tabs, newest first, with who the chatting visitors are. Null when Valkey cannot tell. */
export async function liveVisitorList(
  db: Database,
  visitors: LiveVisitors,
  id: string,
): Promise<z.infer<typeof LiveVisitorSchema>[] | null> {
  const tabs = await visitors.list(id);
  if (tabs === null) return null;
  // Who the chatting visitors are, in one query, from this workspace only.
  const ids = distinct(tabs.map((tab) => tab.visitorId));
  const conversationIds = distinct(tabs.map((tab) => tab.conversationId));
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
    const stats = await readInZone(db, id, (tx) =>
      readSiteStats(tx, id, { days, timeZone: tz, now: new Date() }),
    );
    if (stats === null) return c.json(UNKNOWN_ZONE, 400);
    return c.json(stats, 200);
  });

  app.openapi(listRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const [list, lastHour] = await Promise.all([
      liveVisitorList(db, visitors, id),
      visitors.lastHour(id),
    ]);
    return c.json({ visitors: list, lastHour }, 200);
  });
}
