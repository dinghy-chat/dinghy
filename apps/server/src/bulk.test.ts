import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator } from "../test/requests.ts";
import { SITE, visitorSays, visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { conversation, type EventKind, event, subscription, workspace } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { noLive, OPERATORS } from "./live.ts";
import { createWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });

let database: TestDatabase;
let owner: Database;
let auth: Auth;
let app: App;
/** The workspaces whose operator streams were woken, once per wake. */
const operatorWakes: string[] = [];

const inSpace = (workspaceId: string, path: string) =>
  `/v1/operator/workspaces/${workspaceId}${path}`;

type Result = "ok" | "not_found" | "unchanged";

/** A workspace with an owner, a member and `count` conversations, each from its own visitor. */
async function team(count: number) {
  const space = await createWorkspace(owner, "Acme", [SITE]);
  const person = (role: "owner" | "member") =>
    signedInOperator({ app, auth, owner, workspaceId: space.id, role });
  const boss = await person("owner");
  const member = await person("member");
  const visitors = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      visitorStarts(app, space.publicKey, `Question ${index}`),
    ),
  );
  const ids = visitors.map((one) => one.conversationId);
  const bulk = (cookie: string, body: Record<string, unknown>) =>
    asOperator(app, cookie, "POST", inSpace(space.id, "/conversations/bulk"), body);
  /** The results of a bulk call that answered 200, in order. */
  const results = async (cookie: string, body: Record<string, unknown>) => {
    const response = await bulk(cookie, body);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as {
      results: { conversationId: string; result: Result }[];
    };
    return answer.results.map((one) => one.result);
  };
  return { space, boss, member, visitors, ids, bulk, results };
}

const eventsOf = (workspaceId: string, kind: EventKind) =>
  owner
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.workspaceId, workspaceId), eq(event.kind, kind)));

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  const db = database.connect("app", 20).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const ok = async () => {};
  const live = {
    ...noLive,
    wake(workspaceId: string, subscriber: string) {
      if (subscriber === OPERATORS) operatorWakes.push(workspaceId);
    },
  };
  app = createApp({ db, logger, auth, live, checks: { postgres: ok, valkey: ok } });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("bulk actions", () => {
  test("close answers per conversation, in order, with an event each", async () => {
    const { space, member, ids, results } = await team(2);
    const [first, second] = ids as [string, string];
    const missing = randomUUID();
    expect(await results(member.cookie, { action: "close", conversationIds: [first] })).toEqual([
      "ok",
    ]);
    const mixed = await results(member.cookie, {
      action: "close",
      conversationIds: [first, missing, second, second],
    });
    // A repeated ID counts once.
    expect(mixed).toEqual(["unchanged", "not_found", "ok"]);
    expect(await eventsOf(space.id, "conversation.closed")).toHaveLength(2);
  });

  test("assign sets a member, and refuses someone who is not one", async () => {
    const { space, boss, member, ids, bulk, results } = await team(2);
    const assign = (operatorId: string | null) =>
      results(member.cookie, { action: "assign", conversationIds: ids, operatorId });
    const handled = async (assignee: string | null) => {
      const rows = await owner
        .select({ assignee: conversation.assigneeOperatorId, humanSince: conversation.humanSince })
        .from(conversation)
        .where(eq(conversation.workspaceId, space.id));
      return rows.every((row) => row.assignee === assignee && row.humanSince !== null);
    };
    expect(await assign(boss.id)).toEqual(["ok", "ok"]);
    expect(await handled(boss.id)).toBe(true);
    // With no assignee and no person handling it, an assign to nobody still makes a person handle it.
    await owner
      .update(conversation)
      .set({ assigneeOperatorId: null, humanSince: null })
      .where(eq(conversation.workspaceId, space.id));
    expect(await assign(null)).toEqual(["ok", "ok"]);
    expect(await handled(null)).toBe(true);
    const stranger = await bulk(member.cookie, {
      action: "assign",
      conversationIds: ids,
      operatorId: randomUUID(),
    });
    expect(stranger.status).toBe(400);
    expect(await stranger.json()).toMatchObject({ error: { code: "not_a_member" } });
  });

  test("label puts one label on each, and refuses a missing label", async () => {
    const { space, member, ids, bulk, results } = await team(2);
    const made = await asOperator(app, member.cookie, "POST", inSpace(space.id, "/labels"), {
      name: "Billing",
    });
    const { id: labelId } = (await made.json()) as { id: string };
    const [first] = ids as [string, string];
    await asOperator(
      app,
      member.cookie,
      "PUT",
      inSpace(space.id, `/conversations/${first}/labels/${labelId}`),
    );
    expect(
      await results(member.cookie, { action: "label", conversationIds: ids, labelId }),
    ).toEqual(["unchanged", "ok"]);
    expect(await eventsOf(space.id, "conversation.labeled")).toHaveLength(2);
    const missing = await bulk(member.cookie, {
      action: "label",
      conversationIds: ids,
      labelId: randomUUID(),
    });
    expect(missing.status).toBe(404);
  });

  test("mark_read reads each up to its newest message, for the caller only", async () => {
    const { space, boss, member, ids, results } = await team(2);
    const unread = async (cookie: string) => {
      const response = await asOperator(app, cookie, "GET", inSpace(space.id, "/conversations"));
      const { conversations } = (await response.json()) as { conversations: { unread: boolean }[] };
      return conversations.map((one) => one.unread);
    };
    expect(await unread(member.cookie)).toEqual([true, true]);
    expect(await results(member.cookie, { action: "mark_read", conversationIds: ids })).toEqual([
      "ok",
      "ok",
    ]);
    expect(await unread(member.cookie)).toEqual([false, false]);
    expect(await unread(boss.cookie)).toEqual([true, true]);
    expect(await results(member.cookie, { action: "mark_read", conversationIds: ids })).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  test("each batch wakes the operators once it commits", async () => {
    const { space, member, ids, results } = await team(30);
    const wakes = () => operatorWakes.filter((one) => one === space.id).length;
    const before = wakes();
    await results(member.cookie, { action: "close", conversationIds: ids });
    // 30 conversations are two batches, so a later batch's failure cannot hide the first one.
    expect(wakes() - before).toBe(2);
  });

  test("a read-only or suspended workspace allows only mark_read", async () => {
    const { space, member, ids, bulk, results } = await team(1);
    const refusedCode = async (body: Record<string, unknown>, status: number) => {
      const response = await bulk(member.cookie, body);
      expect(response.status).toBe(status);
      return ((await response.json()) as { error: { code: string } }).error.code;
    };
    await owner
      .insert(subscription)
      .values({ workspaceId: space.id, stripeCustomerId: "cus_test", readOnlyAt: new Date() });
    expect(await refusedCode({ action: "close", conversationIds: ids }, 402)).toBe("read_only");
    expect(await results(member.cookie, { action: "mark_read", conversationIds: ids })).toEqual([
      "ok",
    ]);
    await owner
      .update(workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(workspace.id, space.id));
    expect(await refusedCode({ action: "delete", conversationIds: ids }, 403)).toBe("suspended");
    expect(await results(member.cookie, { action: "mark_read", conversationIds: ids })).toEqual([
      "unchanged",
    ]);
  });

  test("delete is for owners and admins, and goes in batches", async () => {
    const { space, boss, member, ids, bulk, results } = await team(30);
    const deleteAll = (cookie: string) =>
      results(cookie, { action: "delete", conversationIds: ids });
    const refused = await bulk(member.cookie, { action: "delete", conversationIds: ids });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(await eventsOf(space.id, "conversation.deleted")).toHaveLength(0);
    expect(new Set(await deleteAll(boss.cookie))).toEqual(new Set(["ok"]));
    expect(await deleteAll(boss.cookie)).toEqual(Array(30).fill("not_found"));
    expect(await eventsOf(space.id, "conversation.deleted")).toHaveLength(30);
    const left = await owner
      .select({ id: conversation.id })
      .from(conversation)
      .where(inArray(conversation.id, ids));
    expect(left).toEqual([]);
  });

  test("a delete and the visitors' messages at the same time all finish", async () => {
    const { boss, visitors, ids, space, results } = await team(30);
    // The delete locks the visitors in ID order before the workspace, as each send does, so the
    // sends wait or go to a new conversation, and nothing deadlocks.
    const [deleted, ...sends] = await Promise.allSettled([
      results(boss.cookie, { action: "delete", conversationIds: ids }),
      ...visitors.map((one) => visitorSays(app, space.publicKey, one.token, "Still there?")),
    ]);
    expect(deleted?.status).toBe("fulfilled");
    expect(sends.every((one) => one.status === "fulfilled")).toBe(true);
  });

  test("two reads of the same conversations in another order both finish", async () => {
    const { member, ids, results } = await team(20);
    const reads = await Promise.all([
      results(member.cookie, { action: "mark_read", conversationIds: ids }),
      results(member.cookie, { action: "mark_read", conversationIds: ids.toReversed() }),
    ]);
    // The two take turns, so each conversation moves once.
    expect(reads.flat().filter((one) => one === "ok")).toHaveLength(ids.length);
  });

  test("an empty list, more than 100 IDs and an unknown action are refused", async () => {
    const { member, bulk } = await team(0);
    const tooMany = Array.from({ length: 101 }, () => randomUUID());
    for (const body of [
      { action: "close", conversationIds: [] },
      { action: "close", conversationIds: tooMany },
      { action: "reply", conversationIds: [randomUUID()] },
      { action: "assign", conversationIds: [randomUUID()] },
    ]) {
      expect((await bulk(member.cookie, body)).status).toBe(400);
    }
  });
});
