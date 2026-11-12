import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { widgetSettings } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });

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
  const ok = async () => {};
  app = createApp({
    db,
    logger,
    auth,
    alerts: { emailAvailable: true, secret: AUTH_SECRET },
    checks: { postgres: ok, valkey: ok },
  });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

test("each step turns done with what it asks, and a dismiss hides them for that member only", async () => {
  const space = await createWorkspace(db, "Steps", [SITE]);
  const boss = await signedInOperator({ app, auth, owner, workspaceId: space.id });
  const base = `/v1/operator/workspaces/${space.id}`;
  const read = async (cookie = boss.cookie) =>
    (await (await app.request(`${base}/get-started`, { headers: { cookie } })).json()) as Record<
      string,
      boolean
    >;
  const write = (method: string, path: string, body?: unknown, cookie = boss.cookie) =>
    app.request(`${base}${path}`, {
      method,
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect(await read()).toEqual({
    install: false,
    logo: false,
    widget: false,
    team: false,
    notifications: false,
    chat: false,
    dismissed: false,
  });

  // A beat from an allowed site installs the widget.
  await app.request(`/v1/widget/${space.publicKey}/beat`, {
    method: "POST",
    headers: { origin: SITE, "content-type": "application/json" },
    body: JSON.stringify({ tab: "steptab01", page: `${SITE}/` }),
  });
  expect((await read()).install).toBe(true);

  const settings = (await (
    await app.request(`${base}/widget`, { headers: { cookie: boss.cookie } })
  ).json()) as Record<string, unknown>;
  expect((await write("PUT", "/widget", { ...settings, title: "Ask us" })).status).toBe(200);
  expect((await write("PATCH", "/alerts", { email: true })).status).toBe(200);
  expect(
    (await write("POST", "/invites", { email: "new@example.com", role: "member" })).status,
  ).toBe(201);
  const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  const { token } = (await created.json()) as { token: string };
  await app.request(`/v1/widget/${space.publicKey}/messages`, {
    method: "POST",
    headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ clientId: "first", body: "Test" }),
  });
  expect(await read()).toMatchObject({
    install: true,
    widget: true,
    team: true,
    notifications: true,
    chat: true,
    logo: false,
  });

  const other = await signedInOperator({ app, auth, owner, workspaceId: space.id, role: "admin" });
  expect((await write("POST", "/get-started/dismiss")).status).toBe(200);
  expect((await read()).dismissed).toBe(true);
  // Notifications are this operator's own, and the dismiss is this member's.
  expect(await read(other.cookie)).toMatchObject({ dismissed: false, notifications: false });
});

test("a workspace with no widget settings yet reads its steps as not done", async () => {
  const space = await createWorkspace(db, "Bare", [SITE]);
  const { cookie } = await signedInOperator({ app, auth, owner, workspaceId: space.id });
  await owner.delete(widgetSettings).where(eq(widgetSettings.workspaceId, space.id));
  const response = await app.request(`/v1/operator/workspaces/${space.id}/get-started`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ logo: false, widget: false });
});
