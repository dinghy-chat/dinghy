import { eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator } from "../test/requests.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { conversation, visitor } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createLiveVisitors, HOUR_FIELD_CAP, hourKey, LIVE_TAB_CAP } from "./live-visitors.ts";
import { HOUR_MS } from "./time.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const logger = pino({ level: "silent" });

let database: TestDatabase;
let db: Database;
let owner: Database;
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
  const stats = (workspaceId: string) => createLiveVisitors(valkey, logger).stats(workspaceId);
  const fresh = () => createWorkspace(db, "History", [SITE]);
  const thisHour = (workspaceId: string, back = 0) =>
    hourKey(workspaceId, Math.floor(Date.now() / HOUR_MS) - back);

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
      referrers: [
        { referrer: "https://news.example.org", count: 1 },
        { referrer: null, count: 1 },
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

  test("each minute keeps the most tabs open at once", async () => {
    const { id, publicKey } = await fresh();
    const tabs = [tab(), tab(), tab()];
    for (const one of tabs) await beat({ tab: one, page: `${SITE}/` }, undefined, publicKey);
    await beat({ tab: tabs[0], page: `${SITE}/` }, undefined, publicKey);
    const found = await stats(id);
    expect(found?.lastHour).toHaveLength(60);
    expect(Math.max(...(found?.lastHour ?? []))).toBe(3);
    expect(found?.peak?.count).toBe(3);
    expect(Date.now() - Date.parse(found?.peak?.at ?? "")).toBeLessThan(2 * 60_000);
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
    expect(found?.pages).toEqual([{ page: `${SITE}/kept`, title: null, count: 2 }]);
    expect(found?.referrers).toEqual([{ referrer: null, count: 2 }]);
    expect(found?.visits).toBe(2);
  });

  test("the top lists keep five, and the last 24 hours leave out older hours", async () => {
    const { id } = await fresh();
    const pages = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`p:${SITE}/${index}`, index + 1]),
    );
    await valkey.hset(thisHour(id, 23), { v: 2, pv: 28, ...pages, "r:https://a.example": 2 });
    await valkey.hset(thisHour(id, 24), { v: 5, "p:/old": 50, "m:0": 40 });
    await valkey.hset(thisHour(id, 47), { v: 1 });
    await valkey.hset(thisHour(id, 48), { v: 100 });
    const found = await stats(id);
    expect(found).toMatchObject({ visits: 2, visitsBefore: 6, pageViews: 28, peak: null });
    expect(found?.pages.map((one) => one.count)).toEqual([7, 6, 5, 4, 3]);
    expect(found?.referrers).toEqual([{ referrer: "https://a.example", count: 2 }]);
    expect(found?.lastHour.every((count) => count === 0)).toBe(true);
  });
});

describe("the stats route", () => {
  const read = async (as = cookie, workspace = space) =>
    app.request(`/v1/operator/workspaces/${workspace.id}/visitors/stats`, {
      headers: { cookie: as },
    });

  test("counts the chats visitors started in the last 24 hours without the welcome chat, for this workspace only", async () => {
    const before = ((await (await read()).json()) as { chats: number }).chats;
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
    const response = await read();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { chats: number; stats: { visits: number } | null };
    expect(body.chats).toBe(before + 2);
    expect(body.stats?.visits).toBeGreaterThan(0);

    expect((await read(otherCookie)).status).toBe(404);
    const theirs = (await (await read(otherCookie, other)).json()) as {
      chats: number;
      stats: { visits: number } | null;
    };
    expect(theirs).toMatchObject({ chats: 0, stats: { visits: 0 } });
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
