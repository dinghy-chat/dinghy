import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { fanOutOne } from "./alerts.ts";
import { label, operator, savedReply, visitor, workspaceMember } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { CONVERSATIONS, ROUTINE_CONVERSATIONS } from "./demo-harbor.ts";
import { newBrowserToken, sha256Hex } from "./identity.ts";
import { appendMessage } from "./messages.ts";
import { createWorkspace } from "./workspaces.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const STORY_CONVERSATIONS = CONVERSATIONS.length + ROUTINE_CONVERSATIONS.length;

let database: TestDatabase;
let db: Database;
let owner: Database;
let worker: Database;

/** `chat demo`, as the cloud's admin runs it on the migrate service. */
function chat(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "demo", ...args], {
      env: { PATH: process.env.PATH, ADMIN_DATABASE_URL: database.adminUrl() },
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** A workspace with an owner, other members, and a chat, a label and a saved reply of its own. */
async function workspaceWithData(name: string, otherMembers = 0) {
  const space = await createWorkspace(db, name, ["https://site.example"]);
  const members = [];
  for (let index = 0; index <= otherMembers; index++) {
    const [row] = await owner
      .insert(operator)
      .values({ name: `${name} ${index}`, email: `${randomUUID()}@example.com` })
      .returning({ id: operator.id });
    if (row === undefined) throw new Error("No operator");
    members.push({
      workspaceId: space.id,
      operatorId: row.id,
      role: index === 0 ? ("owner" as const) : ("member" as const),
    });
  }
  await owner.insert(workspaceMember).values(members);
  await withWorkspace(db, space.id, async (tx) => {
    const [guest] = await tx
      .insert(visitor)
      .values({ workspaceId: space.id, tokenHash: sha256Hex(newBrowserToken()) })
      .returning({ id: visitor.id });
    if (guest === undefined) throw new Error("No visitor");
    await appendMessage(
      tx,
      space.id,
      { kind: "visitor", visitorId: guest.id },
      { clientId: randomUUID(), body: "Hello" },
    );
    await tx.insert(label).values({ workspaceId: space.id, name: "Old", color: "red" });
    await tx
      .insert(savedReply)
      .values({ workspaceId: space.id, shortcut: "old", body: "An old reply" });
  });
  return { id: space.id, ownerId: members[0]?.operatorId ?? "" };
}

/** What a workspace holds, read past row-level security. */
async function contents(workspaceId: string) {
  const result = await owner.execute<Record<string, number>>(sql`select
    (select count(*)::int from conversation where workspace_id = ${workspaceId}) as conversations,
    (select count(*)::int from message where workspace_id = ${workspaceId}) as messages,
    (select count(*)::int from visitor where workspace_id = ${workspaceId}) as visitors,
    (select count(*)::int from label where workspace_id = ${workspaceId}) as labels,
    (select count(*)::int from saved_reply where workspace_id = ${workspaceId}) as "savedReplies",
    (select count(*)::int from campaign where workspace_id = ${workspaceId}) as campaigns,
    (select count(*)::int from workspace_member
      where workspace_id = ${workspaceId} and removed_at is null) as members,
    (select count(*)::int from alert_delivery where workspace_id = ${workspaceId}) as alerts`);
  return result.rows[0];
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 5).db;
  owner = database.connect("migrator", 1).db;
  worker = database.connect("worker", 1).db;
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("chat demo", () => {
  test("without --yes, it prints the plan and changes nothing", async () => {
    const review = await workspaceWithData("Dry Run");
    const before = await contents(review.id);
    const { code, out } = await chat(review.id);
    expect(code).toBe(0);
    expect(out).toContain("It deletes 1 conversations");
    expect(out).toContain("Teammates it adds: Kenji Watanabe, Amara Mensah, Lucía Fernández.");
    expect(out).toContain("This was a dry run");
    expect(await contents(review.id)).toEqual(before);
  });

  test("it refills one workspace, leaves another alone, and gives the same result twice", async () => {
    const review = await workspaceWithData("Harbor Coffee");
    const other = await workspaceWithData("Other");
    const untouched = await contents(other.id);

    const first = await chat(review.id, "--yes");
    expect(first.code, first.out).toBe(0);
    // The worker's step that turns events into pushes and emails finds nothing to send.
    while (await fanOutOne(worker, { push: true, email: true }));
    const filled = await contents(review.id);
    expect(filled).toMatchObject({
      conversations: STORY_CONVERSATIONS,
      labels: 4,
      savedReplies: 5,
      campaigns: 2,
      members: 4,
      alerts: 0,
    });
    // The review account plays the story's owner, so its chats show as theirs.
    const [assigned] = (
      await owner.execute<{ count: number }>(sql`select count(*)::int as count from conversation
        where workspace_id = ${review.id} and assignee_operator_id = ${review.ownerId}`)
    ).rows;
    expect(assigned?.count).toBeGreaterThan(0);
    expect(await contents(other.id)).toEqual(untouched);

    const second = await chat(review.id, "--yes");
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain(
      "Teammates already here: Kenji Watanabe, Amara Mensah, Lucía Fernández.",
    );
    expect(await contents(review.id)).toEqual(filled);
    expect(await contents(other.id)).toEqual(untouched);
  }, 60_000);

  test("past the operator limit, the owner takes the lines of the teammates who do not fit", async () => {
    const full = await workspaceWithData("Full", 3);
    const { code, out } = await chat(full.id, "--yes");
    expect(code, out).toBe(0);
    expect(out).toContain("Teammates it adds: Kenji Watanabe.");
    expect(out).toContain("no room for Amara Mensah, Lucía Fernández");
    expect(await contents(full.id)).toMatchObject({
      conversations: STORY_CONVERSATIONS,
      members: 5,
    });
  }, 60_000);

  test("it refuses a workspace that does not exist", async () => {
    const { code, out } = await chat(randomUUID(), "--yes");
    expect(code).toBe(1);
    expect(out).toContain("Nothing was changed.");
  });
});
