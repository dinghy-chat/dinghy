import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, callTool, withKey } from "../test/requests.ts";
import { SITE } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { savedReply } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });

let database: TestDatabase;
let owner: Database;
let auth: Auth;
let app: App;

interface SavedReply {
  id: string;
  shortcut: string;
  body: string;
  createdBy: string | null;
}

/** A workspace of its own, with an owner, a member and a key. */
async function team() {
  const space: NewWorkspace = await createWorkspace(owner, "Acme", [SITE]);
  const person = (role: "owner" | "member") =>
    signedInOperator({ app, auth, owner, workspaceId: space.id, role });
  const boss = await person("owner");
  const member = await person("member");
  const made = await asOperator(app, boss.cookie, "POST", inSpace(space.id, "/api-keys"), {
    name: "Helper bot",
  });
  const { token } = (await made.json()) as { token: string };
  return { space, boss, member, token };
}

const inSpace = (workspaceId: string, path: string) =>
  `/v1/operator/workspaces/${workspaceId}${path}`;
const base = (workspaceId: string) => inSpace(workspaceId, "/saved-replies");

async function list(cookie: string, workspaceId: string) {
  const response = await asOperator(app, cookie, "GET", base(workspaceId));
  expect(response.status).toBe(200);
  return ((await response.json()) as { savedReplies: SavedReply[] }).savedReplies;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  const db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const ok = async () => {};
  app = createApp({ db, logger, auth, checks: { postgres: ok, valkey: ok } });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("saved replies", () => {
  test("any member adds, changes and deletes one, and the list goes by shortcut", async () => {
    const { space, member } = await team();
    const add = (shortcut: string, body: string) =>
      asOperator(app, member.cookie, "POST", base(space.id), { shortcut, body });
    const refund = await add("refund", "Full refund within 30 days.");
    expect(refund.status).toBe(201);
    const made = (await refund.json()) as SavedReply;
    expect(made).toMatchObject({ shortcut: "refund", createdBy: member.id });
    expect((await add("hello", "Hi there!")).status).toBe(201);
    expect((await list(member.cookie, space.id)).map((one) => one.shortcut)).toEqual([
      "hello",
      "refund",
    ]);

    const changed = await asOperator(app, member.cookie, "PATCH", `${base(space.id)}/${made.id}`, {
      body: "Full refund within 60 days.",
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      shortcut: "refund",
      body: "Full refund within 60 days.",
    });
    const gone = await asOperator(app, member.cookie, "DELETE", `${base(space.id)}/${made.id}`);
    expect(gone.status).toBe(200);
    expect((await list(member.cookie, space.id)).map((one) => one.shortcut)).toEqual(["hello"]);
    const again = await asOperator(app, member.cookie, "DELETE", `${base(space.id)}/${made.id}`);
    expect(again.status).toBe(404);
  });

  test("a shortcut is unique in its workspace, and only lowercase letters, digits and dashes", async () => {
    const { space, boss } = await team();
    const add = (shortcut: string) =>
      asOperator(app, boss.cookie, "POST", base(space.id), { shortcut, body: "Hi" });
    expect((await add("hello")).status).toBe(201);
    const taken = await add("hello");
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { code: "shortcut_taken" } });
    for (const bad of ["Hello", "-hello", "hello world", "a".repeat(33)]) {
      expect((await add(bad)).status).toBe(400);
    }
    const other = (await (await add("other")).json()) as SavedReply;
    const renamed = await asOperator(app, boss.cookie, "PATCH", `${base(space.id)}/${other.id}`, {
      shortcut: "hello",
    });
    expect(renamed.status).toBe(409);
    // Another workspace has its own shortcuts.
    const elsewhere = await team();
    const theirs = await asOperator(app, elsewhere.boss.cookie, "POST", base(elsewhere.space.id), {
      shortcut: "hello",
      body: "Hi",
    });
    expect(theirs.status).toBe(201);
  });

  test("a workspace keeps at most 200", async () => {
    const { space, boss } = await team();
    await owner.insert(savedReply).values(
      Array.from({ length: 200 }, (_, index) => ({
        workspaceId: space.id,
        shortcut: `reply-${index}`,
        body: "Hi",
      })),
    );
    const over = await asOperator(app, boss.cookie, "POST", base(space.id), {
      shortcut: "one-more",
      body: "Hi",
    });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "saved_reply_limit" } });
  });

  test("an API key reads them, through the API and MCP, and cannot change them", async () => {
    const { space, boss, token } = await team();
    await asOperator(app, boss.cookie, "POST", base(space.id), {
      shortcut: "hello",
      body: "Hi there!",
    });
    const read = await withKey(app, token, "GET", base(space.id));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      savedReplies: [{ shortcut: "hello", body: "Hi there!" }],
    });
    const tool = await callTool(app, token, "list_saved_replies");
    expect(tool.structuredContent).toMatchObject({
      savedReplies: [{ shortcut: "hello", body: "Hi there!" }],
    });
    const add = await withKey(app, token, "POST", base(space.id), { shortcut: "bot", body: "Hi" });
    expect(add.status).toBe(403);
  });

  test("a member who leaves no longer names their saved replies, which stay", async () => {
    const { space, boss, member } = await team();
    await asOperator(app, member.cookie, "POST", base(space.id), {
      shortcut: "hello",
      body: "Hi",
    });
    const removed = await asOperator(
      app,
      boss.cookie,
      "DELETE",
      inSpace(space.id, `/members/${member.id}`),
    );
    expect(removed.status).toBe(200);
    expect(await list(boss.cookie, space.id)).toMatchObject([
      { shortcut: "hello", createdBy: null },
    ]);
  });

  test("a missing saved reply is not found", async () => {
    const { space, boss } = await team();
    const missing = await asOperator(
      app,
      boss.cookie,
      "PATCH",
      `${base(space.id)}/${randomUUID()}`,
      {
        body: "Hi",
      },
    );
    expect(missing.status).toBe(404);
  });
});
