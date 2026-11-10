import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { addOperator, signIn } from "../test/operators.ts";
import { type AnalyticsResult, isTimeZone } from "./analytics.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { apiKey, conversation, message, visitor } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
let seq = 0n;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({ db, logger, auth, checks: { postgres: ok, valkey: ok } });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

async function person(workspaceId: string, name: string, role: "owner" | "agent" = "owner") {
  const added = await addOperator({ auth, owner, name, workspaceId, role });
  return { id: added.id, cookie: await signIn(app, auth, added.email) };
}

/** A conversation that started at `startedAt`, with the first operator reply after `wait` ms. */
async function seed(
  workspaceId: string,
  {
    startedAt,
    reply,
    status = "open",
  }: {
    startedAt: Date;
    reply?: { by: string; afterMs: number };
    status?: "open" | "closed";
  },
) {
  const [made] = await owner
    .insert(visitor)
    .values({ workspaceId, tokenHash: randomUUID() })
    .returning({ id: visitor.id });
  const visitorId = made?.id ?? "";
  const [started] = await owner
    .insert(conversation)
    .values({ workspaceId, visitorId, status, createdAt: startedAt, updatedAt: startedAt })
    .returning({ id: conversation.id });
  const conversationId = started?.id ?? "";
  const line = (at: Date, author: { visitorId: string } | { operatorId: string }) => {
    seq += 1n;
    return {
      workspaceId,
      conversationId,
      seq,
      kind: "text" as const,
      clientId: randomUUID(),
      body: "hello",
      createdAt: at,
      ...("visitorId" in author
        ? { authorVisitorId: author.visitorId }
        : { authorOperatorId: author.operatorId }),
    };
  };
  await owner.insert(message).values(line(startedAt, { visitorId }));
  if (reply !== undefined) {
    const at = new Date(startedAt.getTime() + reply.afterMs);
    await owner.insert(message).values(line(at, { operatorId: reply.by }));
    // A later reply by someone else changes nothing: only the first one counts.
    await owner
      .insert(message)
      .values(line(new Date(at.getTime() + MINUTE), { operatorId: reply.by }));
  }
  return conversationId;
}

async function analytics(
  workspaceId: string,
  cookie: string,
  query: string,
): Promise<{ status: number; body: AnalyticsResult }> {
  const response = await app.request(`/v1/operator/workspaces/${workspaceId}/analytics?${query}`, {
    headers: { cookie, origin: ORIGIN },
  });
  return { status: response.status, body: (await response.json()) as AnalyticsResult };
}

/** The weekday (0 is Monday) and hour of an instant in a time zone, as the browser sees it. */
function cellOf(at: Date, timeZone: string): [number, number] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return [["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday), hour];
}

const localDate = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);

const total = (grid: number[][]) => grid.flat().reduce((sum, value) => sum + value, 0);

describe("an empty workspace", () => {
  test("has a day for each day of the period, and no numbers to show", async () => {
    const space = await createWorkspace(db, "Empty", []);
    const { cookie } = await person(space.id, "Eve");
    const { status, body } = await analytics(space.id, cookie, "days=7&tz=Europe/Paris");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      days: 7,
      timeZone: "Europe/Paris",
      started: 0,
      closed: 0,
      answered: 0,
      firstReply: { medianSeconds: null, p90Seconds: null, within5Minutes: null },
      operators: [],
    });
    expect(body.perDay).toHaveLength(7);
    expect(body.perDay.every((day) => day.conversations === 0)).toBe(true);
    expect(body.perDay.at(-1)?.date).toBe(localDate(new Date(), "Europe/Paris"));
    expect(body.hours).toHaveLength(7);
    expect(body.hours.every((day) => day.length === 24)).toBe(true);
    expect(total(body.hours)).toBe(0);
  });
});

describe("a workspace with conversations", () => {
  let space: NewWorkspace;
  let sam: { id: string; cookie: string };
  let lea: { id: string; cookie: string };
  const now = Date.now();
  const recent = new Date(now - 60 * MINUTE);

  beforeAll(async () => {
    space = await createWorkspace(db, "Busy", []);
    sam = await person(space.id, "Sam");
    lea = await person(space.id, "Lea", "agent");
    await seed(space.id, {
      startedAt: recent,
      reply: { by: sam.id, afterMs: MINUTE },
      status: "closed",
    });
    await seed(space.id, {
      startedAt: new Date(now - 2 * DAY),
      reply: { by: sam.id, afterMs: 10 * MINUTE },
    });
    await seed(space.id, {
      startedAt: new Date(now - 3 * DAY),
      reply: { by: lea.id, afterMs: 2 * MINUTE },
      status: "closed",
    });
    await seed(space.id, { startedAt: new Date(now - 4 * DAY) });
    // In the 30-day period only.
    await seed(space.id, {
      startedAt: new Date(now - 20 * DAY),
      reply: { by: lea.id, afterMs: 30_000 },
      status: "closed",
    });
    // In no period.
    await seed(space.id, {
      startedAt: new Date(now - 100 * DAY),
      reply: { by: sam.id, afterMs: 1000 },
    });
  }, 30_000);

  test("counts the conversations started, closed and answered in the period", async () => {
    const week = (await analytics(space.id, sam.cookie, "days=7&tz=UTC")).body;
    expect([week.started, week.closed, week.answered]).toEqual([4, 2, 3]);
    const month = (await analytics(space.id, sam.cookie, "days=30&tz=UTC")).body;
    expect([month.started, month.closed, month.answered]).toEqual([5, 3, 4]);
    const quarter = (await analytics(space.id, sam.cookie, "days=90&tz=UTC")).body;
    expect(quarter.started).toBe(5);
  });

  test("gives the median and 90th percentile of the first reply, and the share within 5 minutes", async () => {
    const { firstReply } = (await analytics(space.id, sam.cookie, "days=7&tz=UTC")).body;
    // Waits of 60, 120 and 600 seconds. The 90th percentile is interpolated, as Postgres does.
    expect(firstReply.medianSeconds).toBe(120);
    expect(firstReply.p90Seconds).toBeCloseTo(504, 5);
    // Two of the four started conversations, since the unanswered one counts as not answered.
    expect(firstReply.within5Minutes).toBe(0.5);
  });

  test("counts conversations by who sent the first reply, most first", async () => {
    const { operators } = (await analytics(space.id, sam.cookie, "days=7&tz=UTC")).body;
    expect(operators).toEqual([
      { operatorId: sam.id, apiKeyId: null, name: "Sam", conversations: 2 },
      { operatorId: lea.id, apiKeyId: null, name: "Lea", conversations: 1 },
    ]);
  });

  test("puts each conversation on its day in the period", async () => {
    const { perDay } = (await analytics(space.id, sam.cookie, "days=30&tz=UTC")).body;
    expect(perDay).toHaveLength(30);
    expect(perDay.reduce((sum, day) => sum + day.conversations, 0)).toBe(5);
    const counts = new Map(perDay.map((day) => [day.date, day.conversations]));
    expect(counts.get(localDate(new Date(now - 20 * DAY), "UTC"))).toBe(1);
    expect(counts.get(localDate(new Date(now - 4 * DAY), "UTC"))).toBe(1);
  });

  test("reads days and hours in the operator's time zone", async () => {
    for (const zone of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
      const { body } = await analytics(space.id, lea.cookie, `days=7&tz=${zone}`);
      expect(total(body.hours)).toBe(4);
      const [day, hour] = cellOf(recent, zone);
      expect(body.hours[day]?.[hour]).toBeGreaterThanOrEqual(1);
      expect(body.perDay.at(-1)?.date).toBe(localDate(new Date(), zone));
    }
    const utc = (await analytics(space.id, lea.cookie, "days=7&tz=UTC")).body.hours;
    const tokyo = (await analytics(space.id, lea.cookie, "days=7&tz=Asia/Tokyo")).body.hours;
    expect(tokyo).not.toEqual(utc);
  });

  test("an agent can read them", async () => {
    expect((await analytics(space.id, lea.cookie, "days=7&tz=UTC")).status).toBe(200);
  });

  test("refuses a period or a time zone it does not offer", async () => {
    for (const query of [
      "days=10&tz=UTC",
      "days=7&tz=Not/AZone",
      "days=7&tz=%2B01:00",
      "days=7&tz=Europe/Paris;drop",
      `days=7&tz=${"A".repeat(80)}`,
    ]) {
      expect((await analytics(space.id, sam.cookie, query)).status).toBe(400);
    }
  });

  test("another workspace's operator gets nothing", async () => {
    const other = await createWorkspace(db, "Other", []);
    const stranger = await person(other.id, "Stranger");
    expect((await analytics(space.id, stranger.cookie, "days=7&tz=UTC")).status).toBe(404);
    expect((await analytics(other.id, stranger.cookie, "days=90&tz=UTC")).body.started).toBe(0);
  });
});

test("a first reply sent with an API key counts under the key's name", async () => {
  const space = await createWorkspace(db, "Keys", []);
  const owen = await person(space.id, "Owen");
  const [key] = await owner
    .insert(apiKey)
    .values({
      workspaceId: space.id,
      name: "Helper bot",
      tokenHash: randomUUID(),
      createdBy: owen.id,
    })
    .returning({ id: apiKey.id });
  const keyId = key?.id ?? "";
  const startedAt = new Date(Date.now() - DAY);
  const conversationId = await seed(space.id, { startedAt });
  seq += 1n;
  await owner.insert(message).values({
    workspaceId: space.id,
    conversationId,
    seq,
    kind: "text",
    clientId: randomUUID(),
    body: "An answer from the bot",
    createdAt: new Date(startedAt.getTime() + MINUTE),
    authorApiKeyId: keyId,
  });
  const { body } = await analytics(space.id, owen.cookie, "days=7&tz=UTC");
  expect(body.answered).toBe(1);
  expect(body.firstReply.medianSeconds).toBe(60);
  expect(body.operators).toEqual([
    { operatorId: null, apiKeyId: keyId, name: "Helper bot", conversations: 1 },
  ]);
});

test("a time zone is an IANA name that this Node knows", () => {
  expect(isTimeZone("Europe/Paris")).toBe(true);
  expect(isTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
  expect(isTimeZone("Etc/GMT+5")).toBe(true);
  expect(isTimeZone("UTC")).toBe(true);
  expect(isTimeZone("+01:00")).toBe(false);
  expect(isTimeZone("Mars/Olympus")).toBe(false);
  expect(isTimeZone("")).toBe(false);
});
