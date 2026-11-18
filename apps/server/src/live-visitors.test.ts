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
import { createLiveVisitors, HOUR_FIELD_CAP, hourKey, LIVE_TAB_CAP } from "./live-visitors.ts";
import { HOURS_KEY, readSiteStats, rollUpHours } from "./site-hours.ts";
import { HOUR_MS } from "./time.ts";
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
};

const beat = (body: Record<string, unknown>, token?: string, key = space.publicKey) =>
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

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  workerDb = database.connect("worker", 2).db;
  valkey = new Redis(VALKEY_URL, { lazyConnect: true });
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
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
    const shown = (await live()).visitors?.find((one) => one.tab === id);
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
    expect(JSON.stringify(await live())).not.toContain("81.2.69.160");
    const stored = await valkey.hgetall(`dinghy:live:${space.id}:tabs`);
    expect(JSON.stringify(stored)).not.toContain("81.2.69.160");
    expect(await count()).toBeGreaterThanOrEqual(1);
  });

  test("the referrer stays from the first beat, and the site's own, a bad time zone or another site's page is dropped", async () => {
    const id = tab();
    await beat({ tab: id, page: `${SITE}/a`, referrer: "https://first.example" });
    await beat({ tab: id, page: `${SITE}/b`, timeZone: "Not/AZone" });
    expect((await live()).visitors?.find((one) => one.tab === id)).toMatchObject({
      page: `${SITE}/b`,
      referrer: "https://first.example",
      timeZone: null,
    });
    const inside = tab();
    await beat({ tab: inside, page: `${SITE}/c`, referrer: `${SITE}/a` });
    expect((await live()).visitors?.find((one) => one.tab === inside)?.referrer).toBeNull();
    const elsewhere = tab();
    expect((await beat({ tab: elsewhere, page: "https://evil.example/x" })).status).toBe(200);
    expect((await live()).visitors?.some((one) => one.tab === elsewhere)).toBe(false);
  });

  test("a visitor with a token gets their country and time zone saved, and a Chatting link", async () => {
    const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: SITE },
    });
    const { token, visitorId } = (await created.json()) as { token: string; visitorId: string };
    const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "live-1", body: "Hi" }),
    });
    const { conversationId } = (await sent.json()) as { conversationId: string };
    const id = tab();
    // A zone in another case is stored under the one spelling.
    await beat({ tab: id, page: `${SITE}/app`, timeZone: "europe/lisbon" }, token);
    const [row] = await owner
      .select({ country: visitor.country, timeZone: visitor.timeZone })
      .from(visitor)
      .where(eq(visitor.id, visitorId));
    expect(row).toEqual({ country: "GB", timeZone: "Europe/Lisbon" });
    expect((await live()).visitors?.find((one) => one.tab === id)?.visitor).toMatchObject({
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
    const order = `dinghy:live:${full.id}`;
    const later = Date.now() + 60_000;
    const batch = valkey.multi();
    for (let index = 0; index < LIVE_TAB_CAP; index += 1)
      batch.zadd(order, later, `filled${index}`);
    await batch.exec();
    const id = tab();
    expect((await beat({ tab: id, page: `${SITE}/x` }, undefined, full.publicKey)).status).toBe(
      200,
    );
    expect(await valkey.zscore(order, id)).toBeNull();
    expect(await valkey.zcard(order)).toBe(LIVE_TAB_CAP);
    await beat({ tab: "filled0", page: `${SITE}/y` }, undefined, full.publicKey);
    expect(Number(await valkey.zscore(order, "filled0"))).toBeGreaterThan(later);
  });

  test("beats at once never take a workspace past its cap", async () => {
    const full = await createWorkspace(db, "Nearly full", [SITE]);
    const order = `dinghy:live:${full.id}`;
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
          first: true,
          entrance: true,
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
  const currentHour = () => Math.floor(Date.now() / HOUR_MS);
  const thisHour = (workspaceId: string, back = 0) => hourKey(workspaceId, currentHour() - back);
  /** Copies the hours to Postgres, as the worker does, and reads them back. */
  const stats = async (workspaceId: string) => {
    await rollUpHours(workerDb, valkey);
    return read(workspaceId, { days: 1 });
  };

  test("a tab from outside is a visit, a click inside the site is not, and every new page is a view", async () => {
    const { id, publicKey } = await fresh();
    const outside = tab();
    await beat(
      { tab: outside, page: `${SITE}/`, referrer: "https://news.example.org/a" },
      undefined,
      publicKey,
    );
    await beat({ tab: outside, page: `${SITE}/` }, undefined, publicKey);
    // A single-page app moves to another page in the same tab.
    await beat({ tab: outside, page: `${SITE}/pricing` }, undefined, publicKey);
    await beat({ tab: tab(), page: `${SITE}/docs`, referrer: `${SITE}/` }, undefined, publicKey);
    // The widget sends "" on a tab's first beat when nothing referred it.
    await beat(
      { tab: tab(), page: `${SITE}/docs`, title: "Docs", referrer: "" },
      undefined,
      publicKey,
    );
    expect(await stats(id)).toMatchObject({
      visits: 2,
      visitsBefore: 0,
      pageViews: 4,
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

  test("a tab that comes back after its presence expired is no new visit, and beats at once count once", async () => {
    const { id, publicKey } = await fresh();
    const back = tab();
    await beat({ tab: back, page: `${SITE}/`, referrer: "" }, undefined, publicKey);
    // The tab was hidden for longer than the live view keeps it.
    await valkey.zrem(`dinghy:live:${id}`, back);
    await valkey.hdel(`dinghy:live:${id}:tabs`, back);
    await beat({ tab: back, page: `${SITE}/` }, undefined, publicKey);
    const twice = tab();
    await Promise.all([
      beat({ tab: twice, page: `${SITE}/`, referrer: "" }, undefined, publicKey),
      beat({ tab: twice, page: `${SITE}/`, referrer: "" }, undefined, publicKey),
    ]);
    expect(await stats(id)).toMatchObject({ visits: 2, pageViews: 2 });
  });

  test("each minute keeps the most tabs open at once, for the last hour and the peak", async () => {
    const { id, publicKey } = await fresh();
    const tabs = [tab(), tab(), tab()];
    for (const one of tabs) await beat({ tab: one, page: `${SITE}/` }, undefined, publicKey);
    await beat({ tab: tabs[0], page: `${SITE}/` }, undefined, publicKey);
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
    await valkey.hset(thisHour(id), {
      np: HOUR_FIELD_CAP,
      nr: HOUR_FIELD_CAP,
      [`p:${SITE}/kept`]: 1,
      "r:": 1,
    });
    await beat(
      { tab: tab(), page: `${SITE}/new`, referrer: "https://new.example" },
      undefined,
      publicKey,
    );
    await beat({ tab: tab(), page: `${SITE}/kept`, referrer: "" }, undefined, publicKey);
    const found = await stats(id);
    expect(found.pages).toEqual([{ page: `${SITE}/kept`, title: null, count: 2 }]);
    expect(found.referrers).toEqual([{ referrer: null, count: 2 }]);
    expect(found.visits).toBe(2);
  });
});

describe("the roll-up", () => {
  const rows = (workspaceId: string) =>
    owner.select().from(siteHour).where(eq(siteHour.workspaceId, workspaceId));

  test("copies each hour, a rerun changes nothing, and a finished hour leaves the set", async () => {
    const { id, publicKey } = await createWorkspace(db, "Roll-up", [SITE]);
    const hour = Math.floor(Date.now() / HOUR_MS);
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
    await beat({ tab: tab(), page: `${SITE}/now`, referrer: "" }, undefined, publicKey);
    expect(await valkey.sismember(HOURS_KEY, hourKey(id, hour))).toBe(1);

    await rollUpHours(workerDb, valkey);
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
      expect.objectContaining({ hour: new Date(hour * HOUR_MS), visits: 1, pageViews: 1 }),
    ]);
    expect(await valkey.sismember(HOURS_KEY, finished)).toBe(0);
    expect(await valkey.sismember(HOURS_KEY, hourKey(id, hour))).toBe(1);

    await valkey.sadd(HOURS_KEY, finished);
    await rollUpHours(workerDb, valkey);
    expect(await rows(id)).toEqual(expect.arrayContaining(copied));
    expect(await rows(id)).toHaveLength(2);
  });

  test("an older copy never lowers a row, and a gone workspace gets none", async () => {
    const { id } = await createWorkspace(db, "Older", [SITE]);
    const key = hourKey(id, Math.floor(Date.now() / HOUR_MS) - 1);
    await valkey.hset(key, { v: 5, pv: 5 });
    await valkey.sadd(HOURS_KEY, key);
    await rollUpHours(workerDb, valkey);
    await valkey.hset(key, { v: 1, pv: 1 });
    await valkey.sadd(HOURS_KEY, key);
    await rollUpHours(workerDb, valkey);
    expect((await rows(id))[0]).toMatchObject({ visits: 5, pageViews: 5 });

    const gone = hourKey("00000000-0000-4000-8000-000000000000", Math.floor(Date.now() / HOUR_MS));
    await valkey.hset(gone, { v: 1 });
    await valkey.sadd(HOURS_KEY, gone);
    await rollUpHours(workerDb, valkey);
    expect(await valkey.sismember(HOURS_KEY, gone)).toBe(1);
    await rollUpHours(workerDb, valkey, Date.now() + HOUR_MS);
    expect(await valkey.sismember(HOURS_KEY, gone)).toBe(0);
  });

  test("the prune deletes hours older than 92 days", async () => {
    const { id } = await createWorkspace(db, "Prune", [SITE]);
    const daysAgo = (days: number) =>
      new Date((Math.floor(Date.now() / HOUR_MS) - days * 24) * HOUR_MS);
    await owner.insert(siteHour).values([hourRow(id, daysAgo(93)), hourRow(id, daysAgo(91))]);
    await pruneOnce(workerDb, new Date(0));
    expect((await rows(id)).map((row) => row.hour)).toEqual([daysAgo(91)]);
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
  test("one day is the current hour and the 23 before, against the 24 before those", async () => {
    const { id } = await createWorkspace(db, "Day", [SITE]);
    const now = new Date("2026-11-18T10:30:00Z");
    const back = (hours: number) => new Date(Date.parse("2026-11-18T10:00:00Z") - hours * HOUR_MS);
    await owner
      .insert(siteHour)
      .values([
        hourRow(id, back(0), 1),
        hourRow(id, back(23), 2),
        hourRow(id, back(24), 4),
        hourRow(id, back(47), 8),
        hourRow(id, back(48), 16),
      ]);
    const found = await read(id, { days: 1, now });
    expect(found).toMatchObject({ visits: 3, visitsBefore: 12, pageViews: 3, pageViewsBefore: 12 });
    expect(found.series).toEqual([2, ...Array.from({ length: 22 }, () => 0), 1]);
  });

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
      at("2026-11-11T10:00:00Z", 10), // The previous period ends 6 days 5.5 hours after it began.
      at("2026-11-05T05:00:00Z", 20), // The previous period's first hour.
      at("2026-11-05T04:00:00Z", 100),
    ]);
    const found = await read(id, { days: 7, timeZone: "America/New_York", now });
    expect(found).toMatchObject({ visits: 7, visitsBefore: 30 });
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
    const found = await read(id, { days: 1, now });
    expect(found.pages.map((one) => one.count)).toEqual([21, 10, 9, 8, 7, 6, 5, 4]);
    expect(found.pages[1]).toEqual({ page: `${SITE}/9`, title: "New", count: 10 });
    expect(found.referrers).toEqual([
      { referrer: "https://a.example", count: 4 },
      { referrer: null, count: 2 },
    ]);
  });
});

describe("the stats route", () => {
  const get = async (query = "", as = cookie, workspace = space) =>
    app.request(`/v1/operator/workspaces/${workspace.id}/visitors/stats${query}`, {
      headers: { cookie: as },
    });
  type Body = { chats: number; chatsBefore: number; visits: number; lastHour: number[] | null };

  test("counts the chats visitors started in the period without the welcome chat, for this workspace only", async () => {
    const before = (await (await get()).json()) as Body;
    const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: SITE },
    });
    const { visitorId } = (await created.json()) as { visitorId: string };
    await owner.insert(conversation).values([
      { workspaceId: space.id, visitorId },
      { workspaceId: space.id, visitorId, status: "closed" },
      { workspaceId: space.id, visitorId, status: "closed", welcome: true },
      // The team wrote first, so the visitor did not start a chat.
      { workspaceId: space.id, visitorId, status: "closed", startedBy: "team" },
      {
        workspaceId: space.id,
        visitorId,
        status: "closed",
        createdAt: new Date(Date.now() - 25 * HOUR_MS),
      },
    ]);
    await rollUpHours(workerDb, valkey);
    const response = await get();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    expect(body.chats).toBe(before.chats + 2);
    expect(body.chatsBefore).toBe(before.chatsBefore + 1);
    expect(body.visits).toBeGreaterThan(0);
    expect(body.lastHour).toHaveLength(60);
    const week = (await (await get("?days=7&tz=Europe/Paris")).json()) as Body & {
      series: number[];
    };
    expect(week.chats).toBe(body.chats + body.chatsBefore);
    expect(week.series).toHaveLength(7);

    expect((await get("", otherCookie)).status).toBe(404);
    const theirs = (await (await get("", otherCookie, other)).json()) as Body;
    expect(theirs).toMatchObject({ chats: 0, visits: 0 });
  });

  test("refuses another period or an unknown time zone", async () => {
    expect((await get("?days=2")).status).toBe(400);
    expect((await get("?days=7&tz=Mars/Base")).status).toBe(400);
  });
});

describe("waiting", () => {
  test("a chatting visitor waits from their message until an operator replies", async () => {
    const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: SITE },
    });
    const { token } = (await created.json()) as { token: string };
    const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "wait-1", body: "Anyone there?" }),
    });
    const { conversationId } = (await sent.json()) as { conversationId: string };
    const id = tab();
    await beat({ tab: id, page: `${SITE}/help` }, token);
    const waiting = (await live()).visitors?.find((one) => one.tab === id)?.visitor;
    expect(waiting?.conversationId).toBe(conversationId);
    expect(Date.now() - Date.parse(waiting?.waitingSince ?? "")).toBeLessThan(60_000);

    // A second message does not restart the wait.
    await app.request(`/v1/widget/${space.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "wait-2", body: "Hello?" }),
    });
    expect((await live()).visitors?.find((one) => one.tab === id)?.visitor?.waitingSince).toBe(
      waiting?.waitingSince,
    );

    const replied = await asOperator(
      app,
      cookie,
      "POST",
      `/v1/operator/workspaces/${space.id}/conversations/${conversationId}/messages`,
      { clientId: "wait-reply", body: "Yes, hello" },
    );
    expect(replied.status).toBe(201);
    expect(
      (await live()).visitors?.find((one) => one.tab === id)?.visitor?.waitingSince,
    ).toBeNull();
  });
});
