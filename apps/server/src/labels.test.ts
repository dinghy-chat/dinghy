import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, callTool, withKey } from "../test/requests.ts";
import { SITE, visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { event, label } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });

let database: TestDatabase;
let owner: Database;
let auth: Auth;
let app: App;

interface Label {
  id: string;
  name: string;
  color: string;
}

const inSpace = (workspaceId: string, path: string) =>
  `/v1/operator/workspaces/${workspaceId}${path}`;

/** A workspace of its own, with an owner, a member, a key and one conversation. */
async function team() {
  const space = await createWorkspace(owner, "Acme", [SITE]);
  const person = (role: "owner" | "member") =>
    signedInOperator({ app, auth, owner, workspaceId: space.id, role });
  const boss = await person("owner");
  const member = await person("member");
  const made = await asOperator(app, boss.cookie, "POST", inSpace(space.id, "/api-keys"), {
    name: "Helper bot",
  });
  const { token } = (await made.json()) as { token: string };
  const { conversationId } = await visitorStarts(app, space.publicKey, "My invoice is wrong");
  const add = async (cookie: string, name: string, color?: string) => {
    const response = await asOperator(app, cookie, "POST", inSpace(space.id, "/labels"), {
      name,
      color,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as Label;
  };
  const onConversation = (labelId: string, id = conversationId) =>
    inSpace(space.id, `/conversations/${id}/labels/${labelId}`);
  return { space, boss, member, token, conversationId, add, onConversation };
}

/** The conversation's label IDs, as the list shows them. */
async function labelsOf(cookie: string, workspaceId: string, query = "") {
  const response = await asOperator(
    app,
    cookie,
    "GET",
    inSpace(workspaceId, `/conversations${query}`),
  );
  expect(response.status).toBe(200);
  const { conversations } = (await response.json()) as {
    conversations: { id: string; labelIds: string[] }[];
  };
  return conversations;
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

describe("labels", () => {
  test("a member adds one and puts it on a conversation, and owners rename, recolor and delete it", async () => {
    const { space, boss, member, add, onConversation, conversationId } = await team();
    // The picker's inline create: an add, then a put.
    const billing = await add(member.cookie, "Billing");
    expect(billing).toMatchObject({ name: "Billing", color: "gray" });
    expect((await asOperator(app, member.cookie, "PUT", onConversation(billing.id))).status).toBe(
      200,
    );
    await add(member.cookie, "bug", "red");
    const listed = await asOperator(app, member.cookie, "GET", inSpace(space.id, "/labels"));
    expect(((await listed.json()) as { labels: Label[] }).labels.map((one) => one.name)).toEqual([
      "Billing",
      "bug",
    ]);
    expect(await labelsOf(member.cookie, space.id)).toEqual([
      expect.objectContaining({ id: conversationId, labelIds: [billing.id] }),
    ]);

    const path = inSpace(space.id, `/labels/${billing.id}`);
    expect((await asOperator(app, member.cookie, "PATCH", path, { name: "Money" })).status).toBe(
      403,
    );
    expect((await asOperator(app, member.cookie, "DELETE", path)).status).toBe(403);
    const changed = await asOperator(app, boss.cookie, "PATCH", path, {
      name: "Money",
      color: "green",
    });
    expect(await changed.json()).toMatchObject({ id: billing.id, name: "Money", color: "green" });
    expect((await asOperator(app, boss.cookie, "DELETE", path)).status).toBe(200);
    expect((await asOperator(app, boss.cookie, "DELETE", path)).status).toBe(404);
    // The delete took the label off the conversation.
    expect(await labelsOf(boss.cookie, space.id)).toEqual([
      expect.objectContaining({ labelIds: [] }),
    ]);
  });

  test("a name is unique in its workspace, ignoring case, and on one line", async () => {
    const { space, boss, add } = await team();
    const first = await add(boss.cookie, "Billing");
    const post = (name: string) =>
      asOperator(app, boss.cookie, "POST", inSpace(space.id, "/labels"), { name });
    const taken = await post("BILLING");
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { code: "label_name_taken" } });
    // Postgres's lower() maps these together, as the unique index does, and JavaScript's does not.
    await add(boss.cookie, "istanbul");
    const turkish = await post("İstanbul");
    expect(turkish.status).toBe(409);
    expect(await turkish.json()).toMatchObject({ error: { code: "label_name_taken" } });
    for (const bad of ["", "   ", "a".repeat(41), "two\nlines"])
      expect((await post(bad)).status).toBe(400);
    // A label may change its own name's case.
    const recased = await asOperator(
      app,
      boss.cookie,
      "PATCH",
      inSpace(space.id, `/labels/${first.id}`),
      {
        name: "billing",
      },
    );
    expect(recased.status).toBe(200);
    const empty = asOperator(
      app,
      boss.cookie,
      "PATCH",
      inSpace(space.id, `/labels/${first.id}`),
      {},
    );
    expect((await empty).status).toBe(400);
  });

  test("a rename and a delete of one label at once both finish", async () => {
    const { space, boss, add } = await team();
    const billing = await add(boss.cookie, "Billing");
    const path = inSpace(space.id, `/labels/${billing.id}`);
    const [renamed, deleted] = await Promise.all([
      asOperator(app, boss.cookie, "PATCH", path, { name: "Money" }),
      asOperator(app, boss.cookie, "DELETE", path),
    ]);
    expect([200, 404]).toContain(renamed.status);
    expect(deleted.status).toBe(200);
  });

  test("a workspace keeps at most 100", async () => {
    const { space, boss } = await team();
    await owner
      .insert(label)
      .values(
        Array.from({ length: 100 }, (_, index) => ({ workspaceId: space.id, name: `L${index}` })),
      );
    const over = await asOperator(app, boss.cookie, "POST", inSpace(space.id, "/labels"), {
      name: "One more",
    });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "label_limit" } });
  });

  test("a put or a delete changes one label, a repeat changes nothing, and each change is one event", async () => {
    const { space, boss, add, onConversation, conversationId } = await team();
    const billing = await add(boss.cookie, "Billing");
    const bug = await add(boss.cookie, "Bug");
    const call = (method: string, labelId: string) =>
      asOperator(app, boss.cookie, method, onConversation(labelId));
    for (const [method, labelId] of [
      ["PUT", billing.id],
      ["PUT", billing.id],
      ["PUT", bug.id],
      ["DELETE", billing.id],
      ["DELETE", billing.id],
    ] as const) {
      expect((await call(method, labelId)).status).toBe(200);
    }
    expect(await labelsOf(boss.cookie, space.id)).toEqual([
      expect.objectContaining({ labelIds: [bug.id] }),
    ]);
    const events = await owner
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.kind, "conversation.labeled")))
      .orderBy(event.seq);
    expect(events.map((one) => one.payload)).toEqual([
      { conversationId, labelId: billing.id, added: true },
      { conversationId, labelId: bug.id, added: true },
      { conversationId, labelId: billing.id, added: false },
    ]);
    expect((await call("PUT", randomUUID())).status).toBe(404);
    const elsewhere = onConversation(billing.id, randomUUID());
    expect((await asOperator(app, boss.cookie, "PUT", elsewhere)).status).toBe(404);
  });

  test("the list filters by a label", async () => {
    const { space, boss, add, onConversation, conversationId } = await team();
    const other = await visitorStarts(app, space.publicKey, "Hello");
    const billing = await add(boss.cookie, "Billing");
    await asOperator(app, boss.cookie, "PUT", onConversation(billing.id));
    const filtered = await labelsOf(boss.cookie, space.id, `?label=${billing.id}`);
    expect(filtered.map((one) => one.id)).toEqual([conversationId]);
    expect((await labelsOf(boss.cookie, space.id)).map((one) => one.id).sort()).toEqual(
      [conversationId, other.conversationId].sort(),
    );
    expect(await labelsOf(boss.cookie, space.id, `?label=${randomUUID()}`)).toEqual([]);
  });

  test("analytics count the period's conversations by label, most first", async () => {
    const { space, boss, add, onConversation } = await team();
    const other = await visitorStarts(app, space.publicKey, "Hello");
    const billing = await add(boss.cookie, "Billing", "blue");
    const bug = await add(boss.cookie, "Bug");
    await add(boss.cookie, "Unused");
    await asOperator(app, boss.cookie, "PUT", onConversation(billing.id));
    await asOperator(app, boss.cookie, "PUT", onConversation(billing.id, other.conversationId));
    await asOperator(app, boss.cookie, "PUT", onConversation(bug.id));
    const response = await asOperator(
      app,
      boss.cookie,
      "GET",
      inSpace(space.id, "/analytics?days=7"),
    );
    expect(((await response.json()) as { labels: unknown }).labels).toEqual([
      { labelId: billing.id, name: "Billing", color: "blue", conversations: 2 },
      { labelId: bug.id, name: "Bug", color: "gray", conversations: 1 },
    ]);
  });

  test("an API key reads labels and puts them on conversations, through the API and MCP, and cannot change them", async () => {
    const { space, boss, token, add, onConversation, conversationId } = await team();
    const billing = await add(boss.cookie, "Billing");
    const read = await withKey(app, token, "GET", inSpace(space.id, "/labels"));
    expect(await read.json()).toMatchObject({ labels: [{ id: billing.id, name: "Billing" }] });
    expect((await withKey(app, token, "PUT", onConversation(billing.id))).status).toBe(200);
    expect(
      (await withKey(app, token, "POST", inSpace(space.id, "/labels"), { name: "Bot" })).status,
    ).toBe(403);

    const listed = await callTool(app, token, "list_labels");
    expect(listed.structuredContent).toMatchObject({ labels: [{ id: billing.id }] });
    const removed = await callTool(app, token, "unlabel_conversation", {
      conversationId,
      labelId: billing.id,
    });
    expect(removed.isError).toBe(false);
    expect(await labelsOf(boss.cookie, space.id)).toEqual([
      expect.objectContaining({ labelIds: [] }),
    ]);
    const added = await callTool(app, token, "label_conversation", {
      conversationId,
      labelId: billing.id,
    });
    expect(added.isError).toBe(false);
    expect(await labelsOf(boss.cookie, space.id)).toEqual([
      expect.objectContaining({ labelIds: [billing.id] }),
    ]);
    const missing = await callTool(app, token, "label_conversation", {
      conversationId,
      labelId: randomUUID(),
    });
    expect(missing.isError).toBe(true);
  });

  test("MCP's list_conversations keeps the conversations with a label, as the list route does", async () => {
    const { space, boss, token, add, onConversation, conversationId } = await team();
    await visitorStarts(app, space.publicKey, "No label here");
    const billing = await add(boss.cookie, "Billing");
    await asOperator(app, boss.cookie, "PUT", onConversation(billing.id));
    const ids = async (args: Record<string, unknown>) => {
      const answer = await callTool(app, token, "list_conversations", args);
      return (answer.structuredContent as { conversations: { id: string }[] }).conversations.map(
        (one) => one.id,
      );
    };
    expect(await ids({})).toHaveLength(2);
    expect(await ids({ label: billing.id })).toEqual([conversationId]);
    expect(await ids({ label: randomUUID() })).toEqual([]);
    const invalid = await callTool(app, token, "list_conversations", { label: "billing" });
    expect(invalid.isError).toBe(true);
  });
});
