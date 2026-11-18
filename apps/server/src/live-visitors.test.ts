import { eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator } from "../test/requests.ts";
import { pruneOnce } from "./alerts.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { conversation, siteHour, visitor } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { createLiveVisitors, LIVE_TAB_CAP } from "./live-visitors.ts";
import {
  HOUR_FIELD_CAP,
  HOURS_KEY,
  hourKey,
  hourOf,
  readSiteStats,
  rollUpHours,
} from "./site-hours.ts";
import { DAY_MS, HOUR_MS } from "./time.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const logger = pino({ level: "silent" });

let database: TestDatabase;
let db: Database;
let owner: Database;
let workerDb: Database;
let valkey: Redis;
let app: App;
let space: NewWorkspace;
let other: NewWorkspace;
let auth: ReturnType<typeof createAuth>;
let cookie: string;
let otherCookie: string;
const addresses: string[] = [];

type Live = {
  visitors:
    | {
        tab: string;
        page: string;
        title: string | null;
        referrer: string | null;
        country: string | null;
        timeZone: string | null;
        device: string | null;
        visitor: {
          id: string;
          conversationId: string | null;
          waitingSince: string | null;
        } | null;
      }[]
    | null;
  lastHour: number[] | null;
};

/** A tab's beat to a workspace's widget, by default this one's, as a visitor when given a token. */
const beat = (
  body: Record<string, unknown>,
  { token, key = space.publicKey }: { token?: string; key?: string } = {},
) =>
  app.request(`/v1/widget/${key}/beat`, {
    method: "POST",
    headers: {
      origin: SITE,
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36",
      "x-forwarded-for": "81.2.69.160",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
const live = async (as = cookie, workspace = space) =>
  (await (
    await app.request(`/v1/operator/workspaces/${workspace.id}/visitors/live`, {
      headers: { cookie: as },
    })
  ).json()) as Live;
const count = async () =>
  (
    (await (
      await app.request(`/v1/operator/workspaces/${space.id}/visitors/live/count`, {
        headers: { cookie },
      })
    ).json()) as { count: number | null }
  ).count;
const tab = () => Math.random().toString(36).slice(2, 14);
/** One tab in this workspace's live list, or undefined when it is not there. */
const liveTab = async (id: string) => (await live()).visitors?.find((one) => one.tab === id);
// The Valkey keys of a workspace's live tabs: their order by expiry, and their details.
const orderKey = (workspaceId: string) => `dinghy:live:${workspaceId}`;
const tabsKey = (workspaceId: string) => `dinghy:live:${workspaceId}:tabs`;

/** A new visitor of a workspace, by default this one, with the token their widget holds. */
const newVisitor = async (key = space.publicKey) => {
  const created = await app.request(`/v1/widget/${key}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  return (await created.json()) as { token: string; visitorId: string };
};
/** Sends a message as a visitor, and answers the conversation it went to. */
const sendAsVisitor = async (token: string, clientId: string, body: string) => {
  const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
    method: "POST",
    headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ clientId, body }),
  });
  return ((await sent.json()) as { conversationId: string }).conversationId;
};
/** A new visitor who has sent a first message. */
const chattingVisitor = async (clientId: string, body: string) => {
  const { token, visitorId } = await newVisitor();
  return { token, visitorId, conversationId: await sendAsVisitor(token, clientId, body) };
};

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  workerDb = database.connect("worker", 2).db;
  valkey = new Redis(VALKEY_URL, { lazyConnect: true });
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const ok = async () => {};
  app = createApp({
    db,
    logger,
    auth,
    valkey,
    trustedProxyHops: 1,
    countryOf: (ip) => {
      addresses.push(ip);
      return ip === "81.2.69.160" ? "GB" : null;
    },
    checks: { postgres: ok, valkey: ok },
  });
  space = await createWorkspace(db, "Live", [SITE]);
  other = await createWorkspace(db, "Other", [SITE]);
  cookie = (await signedInOperator({ app, auth, owner, workspaceId: space.id })).cookie;
  otherCookie = (await signedInOperator({ app, auth, owner, workspaceId: other.id })).cookie;
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await database.drop();
});

describe("the beat", () => {
  test("an anonymous tab shows with its page, country and device, and its address goes nowhere", async () => {
    const id = tab();
    const sent = await beat({
      tab: id,
      page: `${SITE}/pricing?plan=pro#top`,
      title: "Pricing",
      referrer: "https://news.example.org/some/story?id=1",
      timeZone: "Europe/London",
    });
    expect(sent.status).toBe(200);
    const shown = await liveTab(id);
    expect(shown).toMatchObject({
      page: `${SITE}/pricing`,
      title: "Pricing",
      referrer: "https://news.example.org",
      country: "GB",
      timeZone: "Europe/London",
      device: "Chrome on macOS",
      visitor: null,
    });
    expect(addresses).toContain("81.2.69.160");
    const listed = await live();
    expect(JSON.stringify(listed)).not.toContain("81.2.69.160");
    expect(listed.lastHour).toHaveLength(60);
    const stored = await valkey.hgetall(tabsKey(space.id));
    expect(JSON.stringify(stored)).not.toContain("81.2.69.160");
    expect(await count()).toBeGreaterThanOrEqual(1);
  });

  test("the referrer stays from the first beat, and the site's own, a bad time zone or another site's page is dropped", async () => {
    const id = tab();
    await beat({ tab: id, page: `${SITE}/a`, referrer: "https://first.example" });
    await beat({ tab: id, page: `${SITE}/b`, timeZone: "Not/AZone" });
    expect(await liveTab(id)).toMatchObject({
      page: `${SITE}/b`,
      referrer: "https://first.example",
      timeZone: null,
    });
    const inside = tab();
    await beat({ tab: inside, page: `${SITE}/c`, referrer: `${SITE}/a` });
    expect((await liveTab(inside))?.referrer).toBeNull();
    const elsewhere = tab();
    expect((await beat({ tab: elsewhere, page: "https://evil.example/x" })).status).toBe(200);
    expect((await live()).visitors?.some((one) => one.tab === elsewhere)).toBe(false);
  });

  test("a visitor with a token gets their country and time zone saved, and a Chatting link", async () => {
    const { token, visitorId, conversationId } = await chattingVisitor("live-1", "Hi");
    const id = tab();
    // A zone in another case is stored under the one spelling.
    await beat({ tab: id, page: `${SITE}/app`, timeZone: "europe/lisbon" }, { token });
    const [row] = await owner
      .select({ country: visitor.country, timeZone: visitor.timeZone })
      .from(visitor)
      .where(eq(visitor.id, visitorId));
    expect(row).toEqual({ country: "GB", timeZone: "Europe/Lisbon" });
    expect((await liveTab(id))?.visitor).toMatchObject({
      id: visitorId,
      conversationId,
    });
  });

  test("a leave takes the tab away", async () => {
    const id = tab();
    await beat({ tab: id, page: `${SITE}/x` });
    const left = await app.request(`/v1/widget/${space.publicKey}/leave?tab=${id}`, {
      method: "POST",
      headers: { origin: SITE },
    });
    expect(left.status).toBe(200);
    expect((await live()).visitors?.some((one) => one.tab === id)).toBe(false);
  });

  test("a workspace that shows its cap of tabs drops a new one, and keeps beating the known ones", async () => {
    const full = await createWorkspace(db, "Full", [SITE]);
    const order = orderKey(full.id);
    const later = Date.now() + 60_000;
    const batch = valkey.multi();
    for (let index = 0; index < LIVE_TAB_CAP; index += 1)
      batch.zadd(order, later, `filled${index}`);
    await batch.exec();
    const id = tab();
    expect((await beat({ tab: id, page: `${SITE}/x` }, { key: full.publicKey })).status).toBe(200);
    expect(await valkey.zscore(order, id)).toBeNull();
    expect(await valkey.zcard(order)).toBe(LIVE_TAB_CAP);
    await beat({ tab: "filled0", page: `${SITE}/y` }, { key: full.publicKey });
    expect(Number(await valkey.zscore(order, "filled0"))).toBeGreaterThan(later);
  });

  test("beats at once never take a workspace past its cap", async () => {
    const full = await createWorkspace(db, "Nearly full", [SITE]);
    const order = orderKey(full.id);
    const batch = valkey.multi();
    for (let index = 1; index < LIVE_TAB_CAP; index += 1)
      batch.zadd(order, Date.now() + 60_000, `filled${index}`);
    await batch.exec();
    const visitors = createLiveVisitors(valkey, logger);
    const admitted = await Promise.all(
      Array.from({ length: 20 }, () =>
        visitors.beat(full.id, {
          tab: tab(),
          page: `${SITE}/x`,
          title: null,
          referrer: null,
          country: null,
          timeZone: null,
          device: null,
          arrival: "entrance",
          visitorId: null,
          conversationId: null,
        }),
      ),
    );
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(await valkey.zcard(order)).toBe(LIVE_TAB_CAP);
  });

  test("another workspace's operators never see these tabs", async () => {
    const id = tab();
    await beat({ tab: id, page: `${SITE}/private` });
    expect(JSON.stringify(await live(otherCookie, other))).not.toContain(id);
    const refused = await app.request(`/v1/operator/workspaces/${space.id}/visitors/live`, {
      headers: { cookie: otherCookie },
    });
    expect(refused.status).toBe(404);
  });
});

describe("the history", () => {
  const fresh = () => createWorkspace(db, "History", [SITE]);
  /** Copies the hours to Postgres, as the worker does, and reads them back. */
  const stats = async (workspaceId: string) => {
    await rollUpHours(workerDb, valkey);
    return read(workspaceId, { days: 7 });
  };

  test("a tab from outside is a visit, a click inside the site is not, and every new page is a view", async () => {
    const { id, publicKey } = await fresh();
    const outside = tab();
    await beat(
      { tab: outside, page: `${SITE}/`, referrer: "https://news.example.org/a" },
      { key: publicKey },
    );
    await beat({ tab: outside, page: `${SITE}/` }, { key: publicKey });
    // A single-page app moves to another page in the same tab.
    await beat({ tab: outside, page: `${SITE}/pricing` }, { key: publicKey });
    await beat({ tab: tab(), page: `${SITE}/docs`, referrer: `${SITE}/` }, { key: publicKey });
    // The widget sends "" on a tab's first beat when nothing referred it.
    await beat(
      { tab: tab(), page: `${SITE}/docs`, title: "Docs", referrer: "" },
      { key: publicKey },
    );
    expect(await stats(id)).toMatchObject({
      visits: 2,
      pageViews: 4,
      // The counting started this hour, so nothing reaches back to the week before.
      previous: null,
      pages: [
        { page: `${SITE}/docs`, title: "Docs", count: 2 },
        { page: `${SITE}/`, count: 1 },
        { page: `${SITE}/pricing`, count: 1 },
      ],
      // A tie goes by address, where no referrer comes first.
      referrers: [
        { referrer: null, count: 1 },
        { referrer: "https://news.example.org", count: 1 },
      ],
    });
  });

  test("a first beat counts once: not again when the tab comes back or when it is sent twice, and still when overtaken", async () => {
    const { id, publicKey } = await fresh();
    const back = tab();
    await beat({ tab: back, page: `${SITE}/`, referrer: "" }, { key: publicKey });
    // The tab was hidden for longer than the live view keeps it.
    await valkey.zrem(orderKey(id), back);
    await valkey.hdel(tabsKey(id), back);
    await beat({ tab: back, page: `${SITE}/` }, { key: publicKey });
    // A later beat of a new tab reaches the server before its first, which still counts once.
    const overtaken = tab();
    await beat({ tab: overtaken, page: `${SITE}/` }, { key: publicKey });
    await beat({ tab: overtaken, page: `${SITE}/`, referrer: "" }, { key: publicKey });
    // A first beat sent twice, at once or one after the other, counts once.
    const twice = tab();
    const first = { tab: twice, page: `${SITE}/`, referrer: "" };
    const key = { key: publicKey };
    await Promise.all([beat(first, key), beat(first, key)]);
    await beat(first, key);
    expect(await stats(id)).toMatchObject({ visits: 3, pageViews: 3 });
  });

  test("each minute keeps the most tabs open at once, for the last hour and the peak", async () => {
    const { id, publicKey } = await fresh();
    const tabs = [tab(), tab(), tab()];
    for (const one of tabs) await beat({ tab: one, page: `${SITE}/` }, { key: publicKey });
    await beat({ tab: tabs[0], page: `${SITE}/` }, { key: publicKey });
    const lastHour = await createLiveVisitors(valkey, logger).lastHour(id);
    expect(lastHour).toHaveLength(60);
    expect(Math.max(...(lastHour ?? []))).toBe(3);
    const found = await stats(id);
    expect(found.peak?.count).toBe(3);
    expect(Date.now() - Date.parse(found.peak?.at ?? "")).toBeLessThan(2 * 60_000);
    expect(await createLiveVisitors(null, logger).lastHour(id)).toBeNull();
  });

  test("an hour keeps at most its cap of pages and referrers, and still counts the ones it has", async () => {
    const { id, publicKey } = await fresh();
    await valkey.hset(hourKey(id, hourOf(Date.now())), {
      np: HOUR_FIELD_CAP,
      nr: HOUR_FIELD_CAP,
      [`p:${SITE}/kept`]: 1,
      "r:": 1,
    });
    await beat(
      { tab: tab(), page: `${SITE}/new`, referrer: "https://new.example" },
      { key: publicKey },
    );
    await beat({ tab: tab(), page: `${SITE}/kept`, referrer: "" }, { key: publicKey });
    const found = await stats(id);
    expect(found.pages).toEqual([{ page: `${SITE}/kept`, title: null, count: 2 }]);
    expect(found.referrers).toEqual([{ referrer: null, count: 2 }]);
    expect(found.visits).toBe(2);
  });

  test("a page title loses its control characters", async () => {
    const { id, publicKey } = await fresh();
    const hour = hourOf(Date.now());
    await beat(
      { tab: tab(), page: `${SITE}/`, title: "a\u0000b\u0007c", referrer: "" },
      { key: publicKey },
    );
    // The hour may turn during the beat.
    const titles = await Promise.all(
      [hour, hour + 1].map((one) => valkey.hget(hourKey(id, one), `t:${SITE}/`)),
    );
    expect(titles).toContain("a b c");
  });
});

describe("the roll-up", () => {
  const rows = (workspaceId: string) =>
    owner.select().from(siteHour).where(eq(siteHour.workspaceId, workspaceId));

  test("copies each hour, a rerun changes nothing, and a finished hour leaves the set", async () => {
    const { id, publicKey } = await createWorkspace(db, "Roll-up", [SITE]);
    const hour = hourOf(Date.now());
    const finished = hourKey(id, hour - 2);
    await valkey.hset(finished, {
      v: 3,
      pv: 5,
      "m:7": 2,
      "m:9": 4,
      [`p:${SITE}/a`]: 5,
      [`t:${SITE}/a`]: "A",
      "r:": 2,
      "r:https://b.example": 1,
    });
    await valkey.sadd(HOURS_KEY, finished);
    // The hour just over may still get a beat that read its clock before the hour turned.
    const justOver = hourKey(id, hour - 1);
    await valkey.hset(justOver, { v: 1, pv: 1 });
    await valkey.sadd(HOURS_KEY, justOver);
    await beat({ tab: tab(), page: `${SITE}/now`, referrer: "" }, { key: publicKey });
    expect(await valkey.sismember(HOURS_KEY, hourKey(id, hour))).toBe(1);

    await rollUpHours(workerDb, valkey, hour * HOUR_MS);
    const copied = await rows(id);
    expect(copied.sort((one, other) => one.hour.getTime() - other.hour.getTime())).toEqual([
      {
        workspaceId: id,
        hour: new Date((hour - 2) * HOUR_MS),
        visits: 3,
        pageViews: 5,
        peak: 4,
        peakAt: new Date((hour - 2) * HOUR_MS + 9 * 60_000),
        pages: { [`${SITE}/a`]: 5 },
        referrers: { "": 2, "https://b.example": 1 },
        titles: { [`${SITE}/a`]: "A" },
      },
      expect.objectContaining({ hour: new Date((hour - 1) * HOUR_MS), visits: 1, pageViews: 1 }),
      expect.objectContaining({ hour: new Date(hour * HOUR_MS), visits: 1, pageViews: 1 }),
    ]);
    expect(await valkey.sismember(HOURS_KEY, finished)).toBe(0);
    expect(await valkey.sismember(HOURS_KEY, justOver)).toBe(1);
    expect(await valkey.sismember(HOURS_KEY, hourKey(id, hour))).toBe(1);

    await valkey.sadd(HOURS_KEY, finished);
    await rollUpHours(workerDb, valkey, hour * HOUR_MS);
    expect(await rows(id)).toEqual(expect.arrayContaining(copied));
    expect(await rows(id)).toHaveLength(3);
  });

  test("a workspace whose hours fail to save keeps them, and the others are saved", async () => {
    const bad = await createWorkspace(db, "Bad", [SITE]);
    const good = await createWorkspace(db, "Good", [SITE]);
    const hour = hourOf(Date.now()) - 2;
    // Postgres refuses a NUL in jsonb. The beat strips it, so only a hash written by hand has one.
    await valkey.hset(hourKey(bad.id, hour), { v: 1, [`t:${SITE}/`]: "a\u0000b" });
    await valkey.hset(hourKey(good.id, hour), { v: 2 });
    await valkey.sadd(HOURS_KEY, hourKey(bad.id, hour), hourKey(good.id, hour));
    await expect(rollUpHours(workerDb, valkey)).rejects.toThrow();
    expect((await rows(good.id))[0]).toMatchObject({ visits: 2 });
    expect(await valkey.sismember(HOURS_KEY, hourKey(bad.id, hour))).toBe(1);
    expect(await valkey.sismember(HOURS_KEY, hourKey(good.id, hour))).toBe(0);
    await valkey.srem(HOURS_KEY, hourKey(bad.id, hour));
  });

  test("an older copy never lowers a row, and a gone workspace gets none", async () => {
    const { id } = await createWorkspace(db, "Older", [SITE]);
    const key = hourKey(id, hourOf(Date.now()) - 1);
    await valkey.hset(key, { v: 5, pv: 5 });
    await valkey.sadd(HOURS_KEY, key);
    await rollUpHours(workerDb, valkey);
    await valkey.hset(key, { v: 1, pv: 1 });
    await valkey.sadd(HOURS_KEY, key);
    await rollUpHours(workerDb, valkey);
    expect((await rows(id))[0]).toMatchObject({ visits: 5, pageViews: 5 });

    const gone = hourKey("00000000-0000-4000-8000-000000000000", hourOf(Date.now()));
    await valkey.hset(gone, { v: 1 });
    await valkey.sadd(HOURS_KEY, gone);
    await rollUpHours(workerDb, valkey);
    expect(await valkey.sismember(HOURS_KEY, gone)).toBe(1);
    await rollUpHours(workerDb, valkey, Date.now() + 2 * HOUR_MS);
    expect(await valkey.sismember(HOURS_KEY, gone)).toBe(0);
  });

  test("the prune deletes hours older than 182 days", async () => {
    const { id } = await createWorkspace(db, "Prune", [SITE]);
    const daysAgo = (days: number) => new Date((hourOf(Date.now()) - days * 24) * HOUR_MS);
    await owner.insert(siteHour).values([hourRow(id, daysAgo(183)), hourRow(id, daysAgo(181))]);
    await pruneOnce(workerDb, new Date(0));
    expect((await rows(id)).map((row) => row.hour)).toEqual([daysAgo(181)]);
  });
});

/** A stored hour with these visits, as many page views, and nothing else. */
const hourRow = (
  workspaceId: string,
  hour: Date,
  visits = 1,
  more: Partial<typeof siteHour.$inferInsert> = {},
): typeof siteHour.$inferInsert => ({
  workspaceId,
  hour,
  visits,
  pageViews: visits,
  peak: 0,
  peakAt: null,
  pages: {},
  referrers: {},
  titles: {},
  ...more,
});

/** The stored stats of a period, as the route reads them. */
const read = (
  workspaceId: string,
  { days, timeZone = "UTC", now = new Date() }: { days: number; timeZone?: string; now?: Date },
) =>
  withWorkspace(db, workspaceId, (tx) => readSiteStats(tx, workspaceId, { days, timeZone, now }));

describe("the periods", () => {
  test("seven days start at midnight in the time zone, and the previous ones last as long", async () => {
    const { id } = await createWorkspace(db, "Week", [SITE]);
    // 05:30 on Wednesday 18 November in New York, five hours behind.
    const now = new Date("2026-11-18T10:30:00Z");
    const at = (iso: string, visits: number) => hourRow(id, new Date(iso), visits);
    await owner.insert(siteHour).values([
      at("2026-11-12T05:00:00Z", 1), // Midnight on the 12th: the first day.
      at("2026-11-18T04:00:00Z", 2), // 23:00 on the 17th.
      at("2026-11-18T10:00:00Z", 4), // Today.
      at("2026-11-12T04:00:00Z", 100), // Before the period, after the previous one ended.
      at("2026-11-11T11:00:00Z", 100),
      // The previous period ends 6 days 5.5 hours after it began, cut to the whole hour, so the
      // hour it ends in is left out, as its chats are.
      at("2026-11-11T10:00:00Z", 10),
      at("2026-11-05T05:00:00Z", 20), // The previous period's first hour.
      at("2026-11-05T04:00:00Z", 100),
    ]);
    const found = await read(id, { days: 7, timeZone: "America/New_York", now });
    expect(found).toMatchObject({ visits: 7, previous: { visits: 20 } });
    expect(found.series).toEqual([1, 0, 0, 0, 0, 2, 4]);
  });

  test("30 and 90 days have a slot per day, and the busiest minute is the period's", async () => {
    const { id } = await createWorkspace(db, "Months", [SITE]);
    const now = new Date("2026-11-18T10:30:00Z");
    await owner.insert(siteHour).values([
      hourRow(id, new Date("2026-08-21T00:00:00Z"), 1, {
        peak: 9,
        peakAt: new Date("2026-08-21T00:12:00Z"),
      }),
      hourRow(id, new Date("2026-10-20T00:00:00Z"), 2, {
        peak: 3,
        peakAt: new Date("2026-10-20T00:30:00Z"),
      }),
    ]);
    const month = await read(id, { days: 30, now });
    expect(month.series).toHaveLength(30);
    expect(month.series[0]).toBe(2);
    expect(month.peak).toEqual({ count: 3, at: "2026-10-20T00:30:00.000Z" });
    const quarter = await read(id, { days: 90, now });
    expect(quarter.series).toHaveLength(90);
    expect(quarter.series[0]).toBe(1);
    expect(quarter.visits).toBe(3);
    expect(quarter.peak).toEqual({ count: 9, at: "2026-08-21T00:12:00.000Z" });
  });

  test("the top lists add up the hours, keep eight, and take a page's latest title", async () => {
    const { id } = await createWorkspace(db, "Top", [SITE]);
    const now = new Date("2026-11-18T10:30:00Z");
    const pages = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`${SITE}/${index}`, index + 1]),
    );
    await owner.insert(siteHour).values([
      hourRow(id, new Date("2026-11-18T08:00:00Z"), 1, {
        pages,
        titles: { [`${SITE}/9`]: "Old" },
        referrers: { "": 2, "https://a.example": 1 },
      }),
      hourRow(id, new Date("2026-11-18T09:00:00Z"), 1, {
        pages: { [`${SITE}/0`]: 20 },
        titles: { [`${SITE}/9`]: "New" },
        referrers: { "https://a.example": 3 },
      }),
    ]);
    const found = await read(id, { days: 7, now });
    expect(found.pages.map((one) => one.count)).toEqual([21, 10, 9, 8, 7, 6, 5, 4]);
    expect(found.pages[1]).toEqual({ page: `${SITE}/9`, title: "New", count: 10 });
    expect(found.referrers).toEqual([
      { referrer: "https://a.example", count: 4 },
      { referrer: null, count: 2 },
    ]);
  });
});

describe("the stats route", () => {
  const get = async (query: string, as: string, workspace: { id: string }) =>
    app.request(`/v1/operator/workspaces/${workspace.id}/visitors/stats${query}`, {
      headers: { cookie: as },
    });
  type Body = {
    chats: number;
    visits: number;
    previous: { chats: number } | null;
    series: number[];
  };
  const read = async (query: string, as: string, workspace: { id: string }) =>
    (await (await get(query, as, workspace)).json()) as Body;

  test("counts the chats visitors started in the period without the welcome chat, for this workspace only", async () => {
    const mine = await createWorkspace(db, "Stats", [SITE]);
    const { cookie: mineCookie } = await signedInOperator({
      app,
      auth,
      owner,
      workspaceId: mine.id,
    });
    const { visitorId } = await newVisitor(mine.publicKey);
    const conversations = (more: Partial<typeof conversation.$inferInsert>[]) =>
      more.map((one) => ({ workspaceId: mine.id, visitorId, status: "closed" as const, ...one }));
    await owner.insert(conversation).values(
      conversations([
        { status: "open" },
        {},
        { welcome: true },
        // The team wrote first, so the visitor did not start a chat.
        { startedBy: "team" },
        // In the 30 days before the default period, not in it.
        { createdAt: new Date(Date.now() - 40 * DAY_MS) },
      ]),
    );
    await beat({ tab: tab(), page: `${SITE}/`, referrer: "" }, { key: mine.publicKey });
    await rollUpHours(workerDb, valkey);
    const response = await get("", mineCookie, mine);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Body & { lastHour?: unknown };
    // The counting started this hour, so the 30 days before have no numbers yet.
    expect(body).toMatchObject({ chats: 2, visits: 1, previous: null });
    expect(body.series).toHaveLength(30);
    // Once the stored hours reach back to the start of the 30 days before, they have them.
    await owner
      .insert(siteHour)
      .values(hourRow(mine.id, new Date((hourOf(Date.now()) - 60 * 24) * HOUR_MS), 0));
    expect(await read("", mineCookie, mine)).toMatchObject({ previous: { chats: 1 } });
    expect(body.lastHour).toBeUndefined();
    const week = await read("?days=7&tz=Europe/Paris", mineCookie, mine);
    expect(week.chats).toBe(2);
    expect(week.series).toHaveLength(7);

    expect((await get("", otherCookie, mine)).status).toBe(404);
    expect(await read("", otherCookie, other)).toMatchObject({ chats: 0, visits: 0 });
  });

  test("refuses another period or an unknown time zone", async () => {
    expect((await get("?days=2", cookie, space)).status).toBe(400);
    // The Visitors page once offered 24 hours.
    expect((await get("?days=1", cookie, space)).status).toBe(400);
    expect((await get("?days=7&tz=Mars/Base", cookie, space)).status).toBe(400);
  });
});

describe("waiting", () => {
  test("a chatting visitor waits from their message until an operator replies", async () => {
    const { token, conversationId } = await chattingVisitor("wait-1", "Anyone there?");
    const id = tab();
    await beat({ tab: id, page: `${SITE}/help` }, { token });
    const waiting = (await liveTab(id))?.visitor;
    expect(waiting?.conversationId).toBe(conversationId);
    expect(Date.now() - Date.parse(waiting?.waitingSince ?? "")).toBeLessThan(60_000);

    // A second message does not restart the wait.
    await sendAsVisitor(token, "wait-2", "Hello?");
    expect((await liveTab(id))?.visitor?.waitingSince).toBe(waiting?.waitingSince);

    const replied = await asOperator(
      app,
      cookie,
      "POST",
      `/v1/operator/workspaces/${space.id}/conversations/${conversationId}/messages`,
      { clientId: "wait-reply", body: "Yes, hello" },
    );
    expect(replied.status).toBe(201);
    expect((await liveTab(id))?.visitor?.waitingSince).toBeNull();
  });
});
