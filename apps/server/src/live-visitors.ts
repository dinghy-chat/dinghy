import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { visitor } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { MEMBER_ERRORS } from "./errors.ts";
import { WORKSPACE_PREFIX as PREFIX } from "./member.ts";

/** A tab that stops beating, closed or asleep, leaves the live view after this long. */
const LIVE_TTL_MS = 90_000;
/** Tabs a workspace shows at once. A beat above it is dropped, so a flood stays bounded. */
export const LIVE_TAB_CAP = 2000;

const orderKey = (workspaceId: string) => `dinghy:live:${workspaceId}`;
const tabsKey = (workspaceId: string) => `dinghy:live:${workspaceId}:tabs`;

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

type Beat = Omit<LiveTab, "startedAt" | "seenAt">;

export interface LiveVisitors {
  /** False when the workspace already shows as many tabs as it may. */
  beat(workspaceId: string, beat: Beat): Promise<boolean>;
  leave(workspaceId: string, tab: string): Promise<void>;
  /** Null when Valkey cannot answer. */
  list(workspaceId: string): Promise<LiveTab[] | null>;
  count(workspaceId: string): Promise<number | null>;
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
        const order = orderKey(workspaceId);
        const tabs = tabsKey(workspaceId);
        const now = Date.now();
        const read = await client
          .multi()
          .zrangebyscore(order, "-inf", now)
          .zremrangebyscore(order, "-inf", now)
          .zscore(order, beat.tab)
          .zcard(order)
          .hget(tabs, beat.tab)
          .exec();
        const value = (index: number) => read?.[index]?.[1];
        const expired = (value(0) as string[] | undefined) ?? [];
        const known = value(2) !== null && value(2) !== undefined;
        const write = client.multi();
        if (expired.length > 0) write.hdel(tabs, ...expired);
        const full = !known && Number(value(3) ?? 0) >= LIVE_TAB_CAP;
        if (!full) {
          const before = parse((value(4) as string | null | undefined) ?? null);
          const entry: LiveTab = {
            ...beat,
            // The referrer comes with the first beat only, so later beats keep it.
            referrer: before?.referrer ?? beat.referrer,
            startedAt: before?.startedAt ?? now,
            seenAt: now,
          };
          write
            .zadd(order, now + LIVE_TTL_MS, beat.tab)
            .hset(tabs, beat.tab, JSON.stringify(entry))
            .pexpire(order, LIVE_TTL_MS * 2)
            .pexpire(tabs, LIVE_TTL_MS * 2);
        }
        await write.exec();
        return !full;
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
  };
}

const workspaceParams = z.object({ workspaceId: z.uuid() });

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
        externalId: z.string().nullable(),
        // Their newest conversation, open first.
        conversationId: z.string().nullable(),
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

export function registerLiveVisitorRoutes(app: App, db: Database, visitors: LiveVisitors): void {
  app.openapi(countRoute, async (c) => {
    return c.json({ count: await visitors.count(c.get("memberWorkspaceId")) }, 200);
  });

  app.openapi(listRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const tabs = await visitors.list(id);
    if (tabs === null) return c.json({ visitors: null }, 200);
    // Who the chatting visitors are, in one query, from this workspace only.
    const ids = [
      ...new Set(tabs.flatMap((tab) => (tab.visitorId === null ? [] : [tab.visitorId]))),
    ];
    const people =
      ids.length === 0
        ? []
        : await withWorkspace(db, id, (tx) =>
            tx
              .select({
                id: visitor.id,
                name: visitor.name,
                email: visitor.email,
                externalId: visitor.externalId,
              })
              .from(visitor)
              .where(and(eq(visitor.workspaceId, id), inArray(visitor.id, ids))),
          );
    const byId = new Map(people.map((person) => [person.id, person]));
    const shown = tabs
      .sort((one, other) => other.startedAt - one.startedAt)
      .map(({ visitorId, conversationId, startedAt, seenAt: _seen, ...tab }) => {
        const person = visitorId === null ? undefined : byId.get(visitorId);
        return {
          ...tab,
          startedAt: new Date(startedAt).toISOString(),
          visitor: person === undefined ? null : { ...person, conversationId },
        };
      });
    return c.json({ visitors: shown }, 200);
  });
}
