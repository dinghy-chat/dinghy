import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../test/database.ts";
import { ROLES } from "./roles.ts";
import {
  apiKey,
  attachment,
  conversation,
  event,
  message,
  operator,
  stripeEvent,
  subscription,
  visitor,
  webhook,
  webhookDelivery,
  workspace,
  workspaceMember,
} from "./schema.ts";
import { type Database, operatorWorkspaces, withWorkspace } from "./tenant.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const OPERATOR = "00000000-0000-4000-8000-0000000000c1";
const REMOVED = "00000000-0000-4000-8000-0000000000c2";
const uuidFor = (workspaceId: string, suffix: number) =>
  `${workspaceId.slice(0, -2)}${workspaceId.slice(-1)}${suffix}`;

const TENANT_TABLES = [
  workspaceMember,
  visitor,
  conversation,
  message,
  attachment,
  event,
  subscription,
  stripeEvent,
  apiKey,
  webhook,
  webhookDelivery,
];

let database: TestDatabase;
let owner: Database;
let app: Database;

async function seed(workspaceId: string): Promise<void> {
  const visitorId = uuidFor(workspaceId, 1);
  const conversationId = uuidFor(workspaceId, 2);
  const messageId = uuidFor(workspaceId, 3);
  await owner.insert(workspace).values({
    id: workspaceId,
    name: workspaceId,
    publicKey: `wk_${workspaceId}`,
    signingSecret: "test-secret",
  });
  await owner.insert(workspaceMember).values({ workspaceId, operatorId: OPERATOR, role: "owner" });
  await owner.insert(visitor).values({ workspaceId, id: visitorId, externalId: "user-1" });
  await owner.insert(conversation).values({ workspaceId, id: conversationId, visitorId });
  await owner.insert(message).values({
    workspaceId,
    id: messageId,
    conversationId,
    seq: 1n,
    kind: "text",
    authorVisitorId: visitorId,
    clientId: "first",
    body: `secret of ${workspaceId}`,
  });
  await owner.insert(attachment).values({
    workspaceId,
    messageId,
    storageKey: "k",
    byteSize: 1,
    contentType: "image/png",
    width: 1,
    height: 1,
  });
  await owner.insert(event).values({ workspaceId, seq: 1n, kind: "message.created" });
  await owner.insert(subscription).values({ workspaceId, stripeCustomerId: `cus_${workspaceId}` });
  await owner.insert(stripeEvent).values({ workspaceId, eventId: `evt_${workspaceId}` });
  await owner.insert(apiKey).values({
    workspaceId,
    name: "Helper",
    tokenHash: `hash-${workspaceId}`,
    createdBy: OPERATOR,
  });
  const webhookId = uuidFor(workspaceId, 4);
  await owner.insert(webhook).values({
    workspaceId,
    id: webhookId,
    url: "https://hooks.example.com",
    secret: "whsec_test",
    events: ["message.created"],
  });
  await owner.insert(webhookDelivery).values({
    workspaceId,
    webhookId,
    eventId: uuidFor(workspaceId, 5),
    type: "message.created",
    conversationId,
    messageId,
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  owner = database.connect("migrator").db;
  app = database.connect("app").db;
  await owner.insert(operator).values([
    { id: OPERATOR, name: "Anna", email: "anna@example.com" },
    { id: REMOVED, name: "Ben", email: "ben@example.com" },
  ]);
  await seed(A);
  await seed(B);
});

afterAll(async () => {
  await database.drop();
});

describe("migrations", () => {
  test("a second run on the same database does nothing", async () => {
    await expect(database.migrate()).resolves.toBeUndefined();
  });

  test("the app role is not a superuser and owns no table", async () => {
    const roles = await owner.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = ${ROLES.app}`,
    );
    expect(roles.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const owned = await owner.execute(
      sql`select tablename from pg_tables where schemaname = 'public' and tableowner = ${ROLES.app}`,
    );
    expect(owned.rows).toEqual([]);
  });

  test("the app role cannot change the schema or read the migration history", async () => {
    await expect(app.execute(sql`create table stolen (id int)`)).rejects.toThrow();
    await expect(
      app.execute(sql`alter table message disable row level security`),
    ).rejects.toThrow();
    await expect(app.execute(sql`select * from drizzle.__drizzle_migrations`)).rejects.toThrow();
  });

  test("the app role has lock and idle timeouts", async () => {
    const result = await app.execute<{ lock: string; idle: string }>(
      sql`select current_setting('lock_timeout') as lock,
                 current_setting('idle_in_transaction_session_timeout') as idle`,
    );
    expect(result.rows).toEqual([{ lock: "5s", idle: "30s" }]);
  });

  test("every foreign key has an index that starts with its columns, or a reason it needs none", async () => {
    // A parent's delete runs one lookup per row. With no index, each lookup reads the whole table.
    const small: Record<string, string> = {
      conversation_assignee_fk: "a member's removal, at most 5 members per workspace",
      alert_delivery_operator_fk: "a member's removal, at most 5 members per workspace",
      invite_created_by_fk: "a member's removal, a handful of invites per workspace",
      api_key_created_by_fk: "a member's removal, a handful of keys per workspace",
    };
    const result = await owner.execute<{ name: string }>(sql`
      select c.conname as name from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        and not exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid and i.indpred is null
            and (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey
            and (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] <@ c.conkey
        )
      order by name`);
    expect(result.rows.map((row) => row.name).filter((name) => !(name in small))).toEqual([]);
    // A key that gains an index leaves the list.
    expect(
      Object.keys(small).filter((name) => !result.rows.some((row) => row.name === name)),
    ).toEqual([]);
  });

  test("every public table except the global auth tables has a policy", async () => {
    const result = await owner.execute<{ tablename: string }>(
      sql`select tablename from pg_tables
          where schemaname = 'public' and not rowsecurity order by tablename`,
    );
    expect(result.rows.map((row) => row.tablename)).toEqual([
      "account",
      "instance_setting",
      "operator",
      "push_subscription",
      "session",
      "verification",
      "worker_heartbeat",
    ]);
  });
});

describe("reads", () => {
  test.each(TENANT_TABLES.map((table, index) => [index, table] as const))(
    "table %i shows only the current workspace",
    async (_index, table) => {
      const rows = await withWorkspace(app, A, (tx) => tx.select().from(table));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.workspaceId === A)).toBe(true);
    },
  );

  test("the workspace table shows only the current workspace", async () => {
    const rows = await withWorkspace(app, A, (tx) => tx.select().from(workspace));
    expect(rows.map((row) => row.id)).toEqual([A]);
  });

  test.each(TENANT_TABLES.map((table, index) => [index, table] as const))(
    "table %i returns nothing with no context, and does not throw",
    async (_index, table) => {
      expect(await app.select().from(table)).toEqual([]);
    },
  );
});

describe("writes", () => {
  test("an insert for another workspace fails", async () => {
    await expect(
      withWorkspace(app, A, (tx) =>
        tx.insert(visitor).values({ workspaceId: B, externalId: "cross" }),
      ),
    ).rejects.toThrow();
  });

  test("an update cannot reach another workspace", async () => {
    const changed = await withWorkspace(app, A, (tx) =>
      tx.update(message).set({ body: "changed" }).where(eq(message.workspaceId, B)).returning(),
    );
    expect(changed).toEqual([]);
  });

  test("an update cannot move a row into another workspace", async () => {
    await expect(
      withWorkspace(app, A, (tx) =>
        tx.update(visitor).set({ workspaceId: B }).where(eq(visitor.workspaceId, A)),
      ),
    ).rejects.toThrow();
  });

  test("a delete cannot reach another workspace", async () => {
    const deleted = await withWorkspace(app, A, (tx) =>
      tx.delete(attachment).where(eq(attachment.workspaceId, B)).returning(),
    );
    expect(deleted).toEqual([]);
  });

  test("the app cannot change or delete the event feed", async () => {
    await expect(
      withWorkspace(app, A, (tx) => tx.update(event).set({ kind: "team.changed" })),
    ).rejects.toThrow();
    await expect(withWorkspace(app, A, (tx) => tx.delete(event))).rejects.toThrow();
  });
});

describe("the connection pool", () => {
  test("a reused connection behaves the same as a new one", async () => {
    const { db: single, pool } = database.connect("app", 1);
    expect(await single.select().from(visitor)).toEqual([]);
    await withWorkspace(single, A, (tx) => tx.select().from(visitor));
    expect(pool.totalCount).toBe(1);
    // This connection now returns an empty string for the setting, not NULL.
    const raw = await single.execute<{ value: string }>(
      sql`select current_setting('app.workspace_id', true) as value`,
    );
    expect(raw.rows).toEqual([{ value: "" }]);
    expect(await single.select().from(visitor)).toEqual([]);
  });

  test("commit clears the context", async () => {
    const { db: single } = database.connect("app", 1);
    await withWorkspace(single, A, (tx) => tx.select().from(visitor));
    expect(await single.select().from(visitor)).toEqual([]);
  });

  test("rollback clears the context", async () => {
    const { db: single } = database.connect("app", 1);
    await expect(
      withWorkspace(single, A, async () => {
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await single.select().from(visitor)).toEqual([]);
  });

  test("a nested call fails, so it cannot switch the outer workspace", async () => {
    await expect(
      withWorkspace(app, A, async (tx) => {
        // @ts-expect-error A transaction is not a Database, so this does not compile either.
        await withWorkspace(tx, B, (inner) => inner.select().from(visitor));
      }),
    ).rejects.toThrow("cannot run inside a transaction");
  });

  test("concurrent tenants on a small pool each see only their own rows", async () => {
    const { db: small } = database.connect("app", 3);
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, index) => {
        const workspaceId = index % 2 === 0 ? A : B;
        return withWorkspace(small, workspaceId, async (tx) => {
          await tx.execute(sql`select pg_sleep(0.005)`);
          const rows = await tx.select().from(message);
          return rows.every((row) => row.workspaceId === workspaceId) && rows.length > 0;
        });
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });
});

describe("foreign keys", () => {
  // The owner role bypasses the policies, as foreign key checks do.
  test("a conversation cannot use another workspace's visitor", async () => {
    await expect(
      owner.insert(conversation).values({ workspaceId: A, visitorId: uuidFor(B, 1) }),
    ).rejects.toThrow();
  });

  test("a message cannot join another workspace's conversation", async () => {
    await expect(
      owner.insert(message).values({
        workspaceId: A,
        conversationId: uuidFor(B, 2),
        seq: 90n,
        kind: "text",
        authorVisitorId: uuidFor(A, 1),
        clientId: "cross",
      }),
    ).rejects.toThrow();
  });

  test("a message author must belong to the workspace", async () => {
    await expect(
      owner.insert(message).values({
        workspaceId: A,
        conversationId: uuidFor(A, 2),
        seq: 91n,
        kind: "text",
        authorVisitorId: uuidFor(B, 1),
        clientId: "cross-visitor",
      }),
    ).rejects.toThrow();
    await expect(
      owner.insert(message).values({
        workspaceId: A,
        conversationId: uuidFor(A, 2),
        seq: 92n,
        kind: "text",
        authorOperatorId: REMOVED,
        clientId: "not-a-member",
      }),
    ).rejects.toThrow();
  });

  test("an attachment cannot use another workspace's message", async () => {
    await expect(
      owner.insert(attachment).values({
        workspaceId: A,
        messageId: uuidFor(B, 3),
        storageKey: "k",
        byteSize: 1,
        contentType: "image/png",
        width: 1,
        height: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("message rules", () => {
  const base = { workspaceId: A, conversationId: uuidFor(A, 2), kind: "text" as const };
  let seq = 100n;
  const nextSeq = () => {
    seq += 1n;
    return seq;
  };

  test("a message has exactly one author", async () => {
    await expect(
      owner.insert(message).values({ ...base, seq: nextSeq(), clientId: "none" }),
    ).rejects.toThrow();
    await expect(
      owner.insert(message).values({
        ...base,
        seq: nextSeq(),
        authorVisitorId: uuidFor(A, 1),
        authorOperatorId: OPERATOR,
        clientId: "both",
      }),
    ).rejects.toThrow();
  });

  test("a client ID is unique per sender, not per workspace", async () => {
    await expect(
      owner
        .insert(message)
        .values({ ...base, seq: nextSeq(), authorVisitorId: uuidFor(A, 1), clientId: "first" }),
    ).rejects.toThrow();
    await expect(
      owner
        .insert(message)
        .values({ ...base, seq: nextSeq(), authorOperatorId: OPERATOR, clientId: "first" }),
    ).resolves.toBeDefined();
  });
});

describe("the operator lookup", () => {
  test("it lists active workspaces and skips a removed membership", async () => {
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: B, operatorId: REMOVED, role: "agent", removedAt: new Date() });
    expect(await operatorWorkspaces(app, REMOVED)).toEqual([]);
    const active = await operatorWorkspaces(app, OPERATOR);
    expect(active.map((row) => row.workspaceId).sort()).toEqual([A, B]);
  });

  test("the worker role cannot call it", async () => {
    const { db: worker } = database.connect("worker");
    await expect(operatorWorkspaces(worker, OPERATOR)).rejects.toThrow();
  });
});

describe("the worker and backup roles", () => {
  test("the worker finds events across workspaces with no context", async () => {
    const { db: worker } = database.connect("worker");
    const rows = await worker.select().from(event);
    expect(new Set(rows.map((row) => row.workspaceId))).toEqual(new Set([A, B]));
  });

  test("the worker sees no message without a context, and only its own with one", async () => {
    const { db: worker } = database.connect("worker");
    expect(await worker.select().from(message)).toEqual([]);
    const rows = await withWorkspace(worker, B, (tx) => tx.select().from(message));
    expect(rows.every((row) => row.workspaceId === B)).toBe(true);
  });

  test("the worker cannot write a message", async () => {
    const { db: worker } = database.connect("worker");
    await expect(
      withWorkspace(worker, A, (tx) => tx.update(message).set({ body: "changed" })),
    ).rejects.toThrow();
  });

  test("a message sequence is unique in its workspace", async () => {
    await expect(
      owner.insert(message).values({
        workspaceId: A,
        conversationId: uuidFor(A, 2),
        seq: 1n,
        kind: "text",
        authorOperatorId: OPERATOR,
        clientId: "same-seq",
      }),
    ).rejects.toThrow();
  });

  test("the backup role can read the migration history", async () => {
    const { db: backup } = database.connect("backup");
    const rows = await backup.execute(sql`select id from drizzle.__drizzle_migrations`);
    expect(rows.rows.length).toBeGreaterThan(0);
    const sequence = await backup.execute(
      sql`select last_value from drizzle.__drizzle_migrations_id_seq`,
    );
    expect(sequence.rows).toHaveLength(1);
  });

  test("the backup role reads every workspace and writes nothing", async () => {
    const { db: backup } = database.connect("backup");
    const rows = await backup.select().from(message);
    expect(new Set(rows.map((row) => row.workspaceId))).toEqual(new Set([A, B]));
    await expect(backup.update(message).set({ body: "changed" })).rejects.toThrow();
  });
});
