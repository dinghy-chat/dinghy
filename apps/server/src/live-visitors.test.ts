import { eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { visitor } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createLiveVisitors, LIVE_TAB_CAP } from "./live-visitors.ts";
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
        visitor: { id: string; conversationId: string | null } | null;
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
    await beat({ tab: id, page: `${SITE}/app`, timeZone: "Europe/Lisbon" }, token);
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
