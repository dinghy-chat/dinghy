import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import {
  addOperator,
  cookieOf,
  TEST_PASSWORD as PASSWORD,
  signIn as signInTo,
} from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import type { Database } from "./db/tenant.ts";
import { createWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });
const ok = async () => {};
const ORIGIN = new URL(PUBLIC_URL).origin;

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
let valkey: Redis;
let workspaceId: string;

const post = (path: string, body: unknown, cookie: string) =>
  app.request(path, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const signIn = (email: string, password?: string) => signInTo(app, email, password);

const newOperator = (email: string) =>
  addOperator({ auth, owner, email, name: "Anna", workspaceId, role: "agent" });

const me = async (cookie: string) => app.request("/v1/operator/me", { headers: { cookie } });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app").db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await new Promise((resolve) => valkey.once("ready", resolve));
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger });
  app = createApp({ db, logger, valkey, checks: { postgres: ok, valkey: ok }, auth });
  workspaceId = (await createWorkspace(db, "Acme", ["https://app.example.com"])).id;
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await database.drop();
});

describe("your name", () => {
  test("an operator changes their own name, and the team list shows it", async () => {
    await newOperator("name@example.com");
    const cookie = await signIn("name@example.com");
    expect((await post("/v1/auth/update-user", { name: "Anna Berg" }, cookie)).status).toBe(200);
    expect(await (await me(cookie)).json()).toMatchObject({ name: "Anna Berg" });
    const team = await app.request(`/v1/operator/workspaces/${workspaceId}/members`, {
      headers: { cookie },
    });
    const { members } = (await team.json()) as { members: { email: string; name: string }[] };
    expect(members.find((member) => member.email === "name@example.com")?.name).toBe("Anna Berg");
  });

  test.each([
    ["an empty name", { name: "" }],
    ["a name of only spaces", { name: "   " }],
    ["a name with spaces around it", { name: " Anna " }],
    ["a name over 100 characters", { name: "a".repeat(101) }],
    ["another field", { name: "Anna", image: "https://evil.example/x.png" }],
    ["an email change", { name: "Anna", email: "other@example.com" }],
  ])("%s is refused", async (_, body) => {
    const email = `bad-${crypto.randomUUID()}@example.com`;
    await newOperator(email);
    const cookie = await signIn(email);
    expect((await post("/v1/auth/update-user", body, cookie)).status).toBe(400);
    expect(await (await me(cookie)).json()).toMatchObject({ name: "Anna", email });
  });

  test("a name change needs a session", async () => {
    expect((await post("/v1/auth/update-user", { name: "Nobody" }, "")).status).toBe(401);
  });
});

describe("your password", () => {
  test("a change ends the other sessions, keeps this one, and the new password works", async () => {
    await newOperator("pw@example.com");
    const here = await signIn("pw@example.com");
    const laptop = await signIn("pw@example.com");
    const changed = await post(
      "/v1/auth/change-password",
      { currentPassword: PASSWORD, newPassword: "a-brand-new-password", revokeOtherSessions: true },
      here,
    );
    expect(changed.status).toBe(200);
    // This browser gets a new session cookie with the answer.
    const stillHere = cookieOf(changed);
    expect((await me(stillHere)).status).toBe(200);
    expect((await me(laptop)).status).toBe(401);
    const old = await post(
      "/v1/auth/sign-in/email",
      { email: "pw@example.com", password: PASSWORD },
      "",
    );
    expect(old.status).toBe(401);
    await signIn("pw@example.com", "a-brand-new-password");
  });

  test("a change that keeps the other sessions is refused", async () => {
    await newOperator("keep@example.com");
    const cookie = await signIn("keep@example.com");
    for (const revokeOtherSessions of [false, undefined]) {
      const response = await post(
        "/v1/auth/change-password",
        { currentPassword: PASSWORD, newPassword: "a-brand-new-password", revokeOtherSessions },
        cookie,
      );
      expect(response.status).toBe(400);
    }
    await signIn("keep@example.com");
  });

  test("a wrong current password or a short new one changes nothing", async () => {
    await newOperator("wrong@example.com");
    const cookie = await signIn("wrong@example.com");
    const wrong = await post(
      "/v1/auth/change-password",
      {
        currentPassword: "not-the-password",
        newPassword: "a-brand-new-password",
        revokeOtherSessions: true,
      },
      cookie,
    );
    expect(wrong.status).toBe(400);
    const short = await post(
      "/v1/auth/change-password",
      { currentPassword: PASSWORD, newPassword: "short", revokeOtherSessions: true },
      cookie,
    );
    expect(short.status).toBe(400);
    expect((await me(cookie)).status).toBe(200);
    await signIn("wrong@example.com");
  });

  test("guesses at the current password stop after 10 in 15 minutes, across instances", async () => {
    await newOperator("guess@example.com");
    const cookie = await signIn("guess@example.com");
    const guess = () =>
      post(
        "/v1/auth/change-password",
        {
          currentPassword: "a-wrong-guess",
          newPassword: "a-brand-new-password",
          revokeOtherSessions: true,
        },
        cookie,
      );
    for (let attempt = 0; attempt < 10; attempt++) expect((await guess()).status).toBe(400);
    expect((await guess()).status).toBe(429);
    // The count lives in Valkey, so a second instance sees it too.
    const other = createApp({
      db,
      logger,
      valkey,
      checks: { postgres: ok, valkey: ok },
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger }),
    });
    const fromOther = await other.request("/v1/auth/change-password", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: PASSWORD,
        newPassword: "a-brand-new-password",
        revokeOtherSessions: true,
      }),
    });
    expect(fromOther.status).toBe(429);
  });
});
