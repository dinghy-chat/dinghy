import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { addOperator, signIn as signInTo } from "../test/operators.ts";
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

const signIn = (email: string) => signInTo(app, auth, email);

const newOperator = (email: string) =>
  addOperator({ auth, owner, email, name: "Anna", workspaceId, role: "member" });

const me = async (cookie: string) => app.request("/v1/operator/me", { headers: { cookie } });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app").db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await new Promise((resolve) => valkey.once("ready", resolve));
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
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
