import { and, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { SITE } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { businessHours, event } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });
const ok = async () => {};

const WEEK = {
  mon: [["09:00", "18:00"]],
  tue: [
    ["08:00", "12:00"],
    ["14:00", "24:00"],
  ],
  wed: [],
  thu: [],
  fri: [["09:00", "17:00"]],
  sat: [],
  sun: [],
};
const HOURS = { enabled: true, timeZone: "Europe/Paris", week: WEEK };

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({
    db,
    logger,
    auth,
    publicUrl: PUBLIC_URL,
    checks: { postgres: ok, valkey: ok },
  });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

async function workspaceWithOwner(name = "Acme") {
  const space = await createWorkspace(db, name, [SITE]);
  const boss = await signedInOperator({ app, auth, owner, workspaceId: space.id });
  return { space, boss };
}

const hoursPath = (space: NewWorkspace) => `/v1/operator/workspaces/${space.id}/business-hours`;

const save = (space: NewWorkspace, cookie: string, body: unknown) =>
  app.request(hoursPath(space), {
    method: "PUT",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const read = async (space: NewWorkspace, cookie: string) =>
  (await app.request(hoursPath(space), { headers: { cookie } })).json();

const appearanceHours = async (space: NewWorkspace) =>
  (
    (await (await app.request(`/v1/widget/${space.publicKey}/appearance`)).json()) as {
      hours: unknown;
    }
  ).hours;

describe("business hours", () => {
  test("are off until saved, and the widget gets them with its appearance only while on", async () => {
    const { space, boss } = await workspaceWithOwner();
    expect(await read(space, boss.cookie)).toBeNull();
    expect(await appearanceHours(space)).toBeNull();

    const saved = await save(space, boss.cookie, HOURS);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(HOURS);
    expect(await read(space, boss.cookie)).toEqual(HOURS);
    expect(await appearanceHours(space)).toEqual({ timeZone: "Europe/Paris", week: WEEK });

    expect((await save(space, boss.cookie, { ...HOURS, enabled: false })).status).toBe(200);
    expect(await appearanceHours(space)).toBeNull();
    expect(await read(space, boss.cookie)).toEqual({ ...HOURS, enabled: false });
  });

  test("a time zone in another case is saved under its one spelling", async () => {
    const { space, boss } = await workspaceWithOwner();
    const saved = await save(space, boss.cookie, { ...HOURS, timeZone: "europe/paris" });
    expect(saved.status).toBe(200);
    expect(await read(space, boss.cookie)).toEqual(HOURS);
  });

  test("a save records workspace.changed, so open operator apps read them again", async () => {
    const { space, boss } = await workspaceWithOwner();
    const changes = () =>
      owner
        .select({ seq: event.seq })
        .from(event)
        .where(and(eq(event.workspaceId, space.id), eq(event.kind, "workspace.changed")));
    const before = (await changes()).length;
    expect((await save(space, boss.cookie, HOURS)).status).toBe(200);
    expect(await changes()).toHaveLength(before + 1);
  });

  test.each([
    ["an unknown time zone", { timeZone: "Mars/Olympus" }],
    ["an hour past 23", { week: { ...WEEK, mon: [["25:00", "26:00"]] } }],
    ["a range that ends before it starts", { week: { ...WEEK, mon: [["18:00", "09:00"]] } }],
    ["an empty range", { week: { ...WEEK, mon: [["09:00", "09:00"]] } }],
    ["a range that starts at 24:00", { week: { ...WEEK, mon: [["24:00", "24:00"]] } }],
    [
      "ranges that overlap",
      {
        week: {
          ...WEEK,
          mon: [
            ["09:00", "13:00"],
            ["12:00", "18:00"],
          ],
        },
      },
    ],
    [
      "ranges out of order",
      {
        week: {
          ...WEEK,
          mon: [
            ["14:00", "18:00"],
            ["09:00", "12:00"],
          ],
        },
      },
    ],
    [
      "four ranges in a day",
      {
        week: {
          ...WEEK,
          mon: [
            ["01:00", "02:00"],
            ["03:00", "04:00"],
            ["05:00", "06:00"],
            ["07:00", "08:00"],
          ],
        },
      },
    ],
    ["a missing day", { week: { ...WEEK, sun: undefined } }],
    ["a time without minutes", { week: { ...WEEK, mon: [["9", "18"]] } }],
  ])("%s is refused, and nothing is saved", async (_name, change) => {
    const { space, boss } = await workspaceWithOwner();
    expect((await save(space, boss.cookie, { ...HOURS, ...change })).status).toBe(400);
    expect(await read(space, boss.cookie)).toBeNull();
  });

  test("a member reads them and cannot change them", async () => {
    const { space, boss } = await workspaceWithOwner();
    await save(space, boss.cookie, HOURS);
    const member = await signedInOperator({
      app,
      auth,
      owner,
      workspaceId: space.id,
      role: "member",
    });
    expect(await read(space, member.cookie)).toEqual(HOURS);
    expect((await save(space, member.cookie, { ...HOURS, enabled: false })).status).toBe(403);
    expect(await read(space, boss.cookie)).toEqual(HOURS);
  });

  test("row-level security shows and changes only the workspace's own row", async () => {
    const { space: mine, boss } = await workspaceWithOwner("Mine");
    const { space: theirs, boss: other } = await workspaceWithOwner("Theirs");
    await save(mine, boss.cookie, HOURS);
    await save(theirs, other.cookie, HOURS);
    const rows = await withWorkspace(db, mine.id, async (tx) => {
      // No filter on purpose: the policy alone decides what this sees and changes.
      await tx.update(businessHours).set({ enabled: false });
      return tx.select({ workspaceId: businessHours.workspaceId }).from(businessHours);
    });
    expect(rows).toEqual([{ workspaceId: mine.id }]);
    const [row] = await owner
      .select({ enabled: businessHours.enabled })
      .from(businessHours)
      .where(eq(businessHours.workspaceId, theirs.id));
    expect(row?.enabled).toBe(true);
  });
});
