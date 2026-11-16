import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { SITE } from "../test/visitors.ts";
import { ConditionSchema, toSql } from "./conditions.ts";
import { conversation, visitor } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

let database: TestDatabase;
let db: Database;
let owner: Database;
let space: NewWorkspace;

const DAY_MS = 86_400_000;

/** The user IDs of the contacts that match, in order. */
async function matching(condition: unknown): Promise<string[]> {
  const parsed = ConditionSchema.parse(condition);
  const rows = await withWorkspace(db, space.id, (tx) =>
    tx
      .select({ userId: visitor.userId })
      .from(visitor)
      .where(and(eq(visitor.workspaceId, space.id), toSql(parsed)))
      .orderBy(visitor.userId),
  );
  return rows.map((row) => row.userId ?? "");
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 5).db;
  owner = database.connect("migrator").db;
  space = await createWorkspace(db, "Conditions", [SITE]);
  const rows = await owner
    .insert(visitor)
    .values([
      {
        workspaceId: space.id,
        userId: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        attributes: { plan: "pro", seats: 12, domainVerified: true, tags: ["beta"] },
        country: "GB",
        locale: "en",
        lastSeenAt: new Date(Date.now() - 10 * DAY_MS),
      },
      {
        workspaceId: space.id,
        userId: "bob",
        name: "Bob",
        attributes: { plan: "trial", seats: "many" },
        country: "FR",
        locale: "fr",
        lastSeenAt: new Date(),
      },
      { workspaceId: space.id, userId: "cy", attributes: null },
    ])
    .returning({ id: visitor.id, userId: visitor.userId });
  const bob = rows.find((row) => row.userId === "bob");
  await owner.insert(conversation).values({ workspaceId: space.id, visitorId: bob?.id ?? "" });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("the SQL", () => {
  test.each([
    [{ field: "attributes.plan", op: "eq", value: "pro" }, ["ada"]],
    // `ne` and `not_in` match a missing value, as "is not verified" reads.
    [{ field: "attributes.domainVerified", op: "ne", value: true }, ["bob", "cy"]],
    [{ field: "attributes.plan", op: "in", value: ["trial", "pro"] }, ["ada", "bob"]],
    [{ field: "attributes.plan", op: "not_in", value: ["trial"] }, ["ada", "cy"]],
    [{ field: "attributes.plan", op: "exists" }, ["ada", "bob"]],
    [{ field: "attributes.plan", op: "missing" }, ["cy"]],
    // A comparison reads only a value of its own type.
    [{ field: "attributes.seats", op: "gte", value: 10 }, ["ada"]],
    [{ field: "attributes.tags", op: "contains", value: "beta" }, ["ada"]],
    [{ field: "firstName", op: "eq", value: "Ada" }, ["ada"]],
    [{ field: "email", op: "contains", value: "EXAMPLE" }, ["ada"]],
    [{ field: "language", op: "eq", value: "fr" }, ["bob"]],
    [{ field: "signedIn", op: "eq", value: true }, ["ada", "bob", "cy"]],
    [{ field: "hasChatted", op: "eq", value: true }, ["bob"]],
    [{ field: "conversationCount", op: "lt", value: 1 }, ["ada", "cy"]],
    [{ field: "lastSeenAt", op: "older_than", value: "7d" }, ["ada"]],
    [
      {
        all: [
          { field: "attributes.plan", op: "in", value: ["trial", "pro"] },
          {
            any: [
              { field: "country", op: "eq", value: "FR" },
              { not: { field: "name", op: "exists" } },
            ],
          },
        ],
      },
      ["bob"],
    ],
  ])("%j matches %j", async (condition, expected) => {
    expect(await matching(condition)).toEqual(expected);
  });
});

describe("the schema", () => {
  test.each([
    [{ field: "plan", op: "eq", value: "pro" }, "Unknown field plan"],
    [{ field: "signedIn", op: "gt", value: true }, "signedIn does not take gt"],
    [{ field: "conversationCount", op: "eq", value: "3" }, "conversationCount takes a number"],
    [{ field: "lastSeenAt", op: "older_than", value: "a week" }, "A duration, such as 7d"],
    [{ field: "country", op: "in", value: "FR" }, "in takes a list"],
    [{ field: "country", op: "exists", value: "FR" }, "exists takes no value"],
  ])("refuses %j", (condition, message) => {
    const parsed = ConditionSchema.safeParse(condition);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(message);
  });

  test("refuses a condition with too many rules", () => {
    const rule = { field: "country", op: "eq", value: "FR" };
    const parsed = ConditionSchema.safeParse({ any: Array.from({ length: 60 }, () => rule) });
    expect(parsed.success).toBe(false);
  });
});
