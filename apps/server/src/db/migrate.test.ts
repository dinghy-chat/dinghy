import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../test/database.ts";
import { MIGRATIONS, migrationsBefore } from "../../test/migrations.ts";
import { pgDumpWorks } from "../../test/pg-dump.ts";
import { editMessage, emailedAt } from "../message-changes.ts";
import {
  newGeneration,
  restoreDatabase,
  roleUrl,
  runDump,
  runMigrations,
  UnsupportedVersionError,
} from "./migrate.ts";
import { withWorkspace } from "./tenant.ts";

let database: TestDatabase;
let backups: number;
const backup = async () => {
  backups += 1;
};

beforeEach(async () => {
  backups = 0;
  database = await createTestDatabase();
});

afterEach(async () => {
  await database.drop();
});

const run = (migrationsFolder = MIGRATIONS, onBackup = backup) =>
  runMigrations({ adminUrl: database.adminUrl(), migrationsFolder, backup: onBackup });

async function query<T extends pg.QueryResultRow>(text: string, url = database.adminUrl()) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

const appliedCount = async () =>
  Number(
    (await query<{ count: string }>("select count(*) from drizzle.__drizzle_migrations"))[0]?.count,
  );

/** The real migrations with one more, so an up-to-date database has something pending. */
async function withExtraMigration(sql: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "dinghy-migrations-"));
  await cp(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const last = journal.entries.at(-1);
  journal.entries.push({
    idx: last.idx + 1,
    version: last.version,
    when: last.when + 1000,
    tag: "9999_extra",
    breakpoints: true,
  });
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(join(folder, "9999_extra.sql"), sql);
  return folder;
}

describe("chat migrate", () => {
  test("a first install runs everything, with no backup, and the migrator owns the tables", async () => {
    const result = await run();
    expect(result.applied).toBeGreaterThan(10);
    expect(result.backedUp).toBe(false);
    expect(backups).toBe(0);
    const owners = await query<{ tableowner: string }>(
      "select distinct tableowner from pg_tables where schemaname = 'public'",
    );
    expect(owners.map((row) => row.tableowner)).toEqual(["dinghy_migrator"]);
  });

  test("accounts and visitor tokens from before verification and expiry keep working", async () => {
    await run(await migrationsBefore("0038_"));
    await query(
      `insert into operator (id, name, email, email_verified)
       values ('00000000-0000-4000-8000-0000000000aa', 'Joined', 'joined@example.com', false)`,
    );
    await query(
      `insert into workspace (id, name, public_key, signing_secret)
       values ('00000000-0000-4000-8000-000000000001', 'Before', 'wk_before', 'secret')`,
    );
    await query(
      `insert into visitor (workspace_id, token_hash, created_at)
       values ('00000000-0000-4000-8000-000000000001', 'old-token', now() - interval '3 years')`,
    );
    await run();
    const [account] = await query<{ email_verified: boolean }>(
      "select email_verified from operator where email = 'joined@example.com'",
    );
    expect(account?.email_verified).toBe(true);
    // Its year counts from the upgrade, not from when the visitor first came.
    const [fresh] = await query<{ fresh: boolean }>(
      "select token_used_at > now() - interval '1 minute' as fresh from visitor where token_hash = 'old-token'",
    );
    expect(fresh?.fresh).toBe(true);
  });

  test("an account BetterAuth did not count as verified stays unproven in email_proven", async () => {
    await run(await migrationsBefore("0041_"));
    await query(
      `insert into operator (name, email, email_verified) values
       ('Imported', 'imported@example.com', false), ('Known', 'known@example.com', true)`,
    );
    await run();
    expect(
      await query("select email, email_verified, email_proven from operator order by email"),
    ).toEqual([
      { email: "imported@example.com", email_verified: true, email_proven: false },
      { email: "known@example.com", email_verified: true, email_proven: true },
    ]);
  });

  test("the widget's words and the logo's time move to widget_settings, with the defaults", async () => {
    await run(await migrationsBefore("0066_"));
    const [worded, plain] = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ];
    await query(
      `insert into workspace (id, name, public_key, signing_secret, widget_title, widget_greeting, widget_away)
       values ('${worded}', 'Worded', 'wk_worded', 's', 'Ask Acme', 'Hello there', 'Back soon'),
              ('${plain}', 'Plain', 'wk_plain', 's', null, null, null)`,
    );
    await query(
      `insert into workspace_logo (workspace_id, data, updated_at)
       values ('${worded}', '\\x00', '2026-11-01T10:00:00Z')`,
    );
    await run();
    expect(
      await query(
        `select workspace_id, title, greeting, away, logo_updated_at, launcher, radius, branding
         from widget_settings order by workspace_id`,
      ),
    ).toEqual([
      {
        workspace_id: worded,
        title: "Ask Acme",
        greeting: "Hello there",
        away: "Back soon",
        logo_updated_at: new Date("2026-11-01T10:00:00Z"),
        launcher: "boat",
        radius: 16,
        branding: true,
      },
      {
        workspace_id: plain,
        title: null,
        greeting: null,
        away: null,
        logo_updated_at: null,
        launcher: "boat",
        radius: 16,
        branding: true,
      },
    ]);
  });

  test("stored passwords go, and the accounts and their sessions stay", async () => {
    await run(await migrationsBefore("0040_"));
    const id = "00000000-0000-4000-8000-0000000000bb";
    await query(
      `insert into operator (id, name, email, email_verified)
       values ('${id}', 'Old', 'old@example.com', true)`,
    );
    await query(
      `insert into account (user_id, account_id, provider_id, password)
       values ('${id}', '${id}', 'credential', 'scrypt-hash')`,
    );
    await query(
      `insert into session (user_id, token, expires_at)
       values ('${id}', 'kept-session', now() + interval '1 day')`,
    );
    await run();
    expect(await query("select 1 from account")).toEqual([]);
    expect(await query("select email from operator")).toEqual([{ email: "old@example.com" }]);
    expect(await query("select token from session")).toEqual([{ token: "kept-session" }]);
  });

  test("a visitor's claims from 0.5.0 become its attributes", async () => {
    await run(await migrationsBefore("0043_"));
    const workspace = "00000000-0000-4000-8000-0000000000cc";
    await query(
      `insert into workspace (id, name, public_key, signing_secret)
       values ('${workspace}', 'Old', 'wk_00000000000000000000000000000000', 'secret')`,
    );
    await query(
      `insert into visitor (workspace_id, external_id, claims)
       values ('${workspace}', 'user-1', '{"plan":"pro"}')`,
    );
    await run();
    expect(await query("select attributes, name, device from visitor")).toEqual([
      { attributes: { plan: "pro" }, name: null, device: null },
    ]);
  });

  test("the page journey and the search index arrive on a database with messages", async () => {
    await run(await migrationsBefore("0046_"));
    const workspace = "00000000-0000-4000-8000-0000000000dd";
    const visitor = "00000000-0000-4000-8000-0000000000de";
    const conversation = "00000000-0000-4000-8000-0000000000df";
    await query(
      `insert into workspace (id, name, public_key, signing_secret)
       values ('${workspace}', 'Old', 'wk_00000000000000000000000000000001', 'secret')`,
    );
    await query(
      `insert into visitor (workspace_id, id, token_hash) values ('${workspace}', '${visitor}', 'h')`,
    );
    await query(
      `insert into conversation (workspace_id, id, visitor_id)
       values ('${workspace}', '${conversation}', '${visitor}')`,
    );
    await query(
      `insert into message (workspace_id, conversation_id, seq, kind, author_visitor_id, client_id, body)
       values ('${workspace}', '${conversation}', 1, 'text', '${visitor}', 'c1', 'My invoice 4417')`,
    );
    await run();
    // Made by the database's owner, which is not a superuser.
    expect(
      await query(
        "select extname from pg_extension where extname in ('pg_trgm', 'btree_gin') order by extname",
      ),
    ).toEqual([{ extname: "btree_gin" }, { extname: "pg_trgm" }]);
    expect(
      await query(
        "select indexname from pg_indexes where indexname in ('message_body_trgm_idx', 'message_workspace_body_trgm_idx', 'page_view_visitor_idx', 'conversation_created_idx') order by indexname",
      ),
    ).toEqual([
      { indexname: "conversation_created_idx" },
      { indexname: "message_workspace_body_trgm_idx" },
      { indexname: "page_view_visitor_idx" },
    ]);
    expect(await query("select body from message where body ilike '%invoice%'")).toEqual([
      { body: "My invoice 4417" },
    ]);
    expect(await query("select count(*)::int as count from page_view")).toEqual([{ count: 0 }]);
  });

  test("a message event without fromVisitor gets it from its message", async () => {
    await run(await migrationsBefore("0052_"));
    const workspace = "00000000-0000-4000-8000-0000000000ee";
    const visitor = "00000000-0000-4000-8000-0000000000e1";
    const conversation = "00000000-0000-4000-8000-0000000000e2";
    const message = "00000000-0000-4000-8000-0000000000e3";
    await query(
      `insert into workspace (id, name, public_key, signing_secret)
       values ('${workspace}', 'Old', 'wk_00000000000000000000000000000002', 'secret')`,
    );
    await query(
      `insert into visitor (workspace_id, id, token_hash) values ('${workspace}', '${visitor}', 'h')`,
    );
    await query(
      `insert into conversation (workspace_id, id, visitor_id)
       values ('${workspace}', '${conversation}', '${visitor}')`,
    );
    await query(
      `insert into message (workspace_id, id, conversation_id, seq, kind, author_visitor_id, client_id, body)
       values ('${workspace}', '${message}', '${conversation}', 1, 'text', '${visitor}', 'c1', 'Hi')`,
    );
    const payload = (id: string) => `{"messageId":"${id}","conversationId":"${conversation}"}`;
    await query(
      `insert into event (workspace_id, seq, kind, payload) values
       ('${workspace}', 1, 'message.created', '${payload(message)}'),
       ('${workspace}', 2, 'message.created', '${payload("00000000-0000-4000-8000-0000000000e4")}'),
       ('${workspace}', 3, 'conversation.closed', '{"conversationId":"${conversation}"}')`,
    );
    await run();
    expect(await query("select payload->'fromVisitor' as from from event order by seq")).toEqual([
      { from: true },
      { from: false },
      { from: null },
    ]);
  });

  test("replies emailed before ranges were recorded stay sent by email, and cannot change", async () => {
    await run(await migrationsBefore("0082_"));
    const workspace = "00000000-0000-4000-8000-0000000000f1";
    const visitor = "00000000-0000-4000-8000-0000000000f2";
    const conversation = "00000000-0000-4000-8000-0000000000f3";
    const reply = "00000000-0000-4000-8000-0000000000f4";
    const anna = "00000000-0000-4000-8000-0000000000f5";
    // Written after the reply that queued the email, and carried by it all the same.
    const later = "00000000-0000-4000-8000-0000000000f6";
    await query(
      `insert into workspace (id, name, public_key, signing_secret, event_seq)
       values ('${workspace}', 'Old', 'wk_00000000000000000000000000000003', 'secret', 3)`,
    );
    await query(
      `insert into operator (id, name, email, email_verified)
       values ('${anna}', 'Anna', 'anna-f5@example.com', true)`,
    );
    await query(
      `insert into workspace_member (workspace_id, operator_id, role)
       values ('${workspace}', '${anna}', 'member')`,
    );
    await query(
      `insert into visitor (workspace_id, id, token_hash, email)
       values ('${workspace}', '${visitor}', 'h', 'v@example.com')`,
    );
    await query(
      `insert into conversation (workspace_id, id, visitor_id)
       values ('${workspace}', '${conversation}', '${visitor}')`,
    );
    await query(
      `insert into message (workspace_id, id, conversation_id, seq, kind, author_operator_id, client_id, body)
       values ('${workspace}', '${reply}', '${conversation}', 2, 'text', '${anna}', 'c2', 'Answer'),
              ('${workspace}', '${later}', '${conversation}', 3, 'text', '${anna}', 'c3', 'And more')`,
    );
    await query(
      `insert into alert_delivery (workspace_id, event_seq, conversation_id, message_id, visitor_id,
         channel, finished_at, outcome)
       values ('${workspace}', 2, '${conversation}', '${reply}', '${visitor}', 'email', now(), 'sent'),
              ('${workspace}', 2, '${conversation}', '${reply}', '${visitor}', 'transcript', now(), 'sent')`,
    );
    await run();
    expect(
      await query(
        "select channel, covered_from_seq, covered_to_seq from alert_delivery order by channel",
      ),
    ).toEqual([
      { channel: "email", covered_from_seq: "0", covered_to_seq: "3" },
      { channel: "transcript", covered_from_seq: "0", covered_to_seq: "3" },
    ]);
    const app = database.connect("app").db;
    const line = { conversationId: conversation, seq: 2n };
    const after = await withWorkspace(app, workspace, async (tx) => ({
      sentAt: await emailedAt(tx, workspace, visitor, line),
      edit: await editMessage(tx, workspace, conversation, reply, anna, "Changed"),
      laterEdit: await editMessage(tx, workspace, conversation, later, anna, "Changed"),
    }));
    expect(after.sentAt).toBeInstanceOf(Date);
    expect(after.edit.kind).toBe("seen");
    expect(after.laterEdit.kind).toBe("seen");
  });

  test("keys made before reply modes keep sending, and new keys draft", async () => {
    await run(await migrationsBefore("0085_"));
    const workspace = "00000000-0000-4000-8000-0000000000e1";
    const anna = "00000000-0000-4000-8000-0000000000e2";
    await query(
      `insert into workspace (id, name, public_key, signing_secret)
       values ('${workspace}', 'Old', 'wk_00000000000000000000000000000004', 'secret')`,
    );
    await query(
      `insert into operator (id, name, email, email_verified)
       values ('${anna}', 'Anna', 'anna-e2@example.com', true)`,
    );
    await query(
      `insert into workspace_member (workspace_id, operator_id, role)
       values ('${workspace}', '${anna}', 'owner')`,
    );
    await query(
      `insert into api_key (workspace_id, name, token_hash, created_by)
       values ('${workspace}', 'Old bot', 'old-hash', '${anna}')`,
    );
    await run();
    await query(
      `insert into api_key (workspace_id, name, token_hash, created_by)
       values ('${workspace}', 'New bot', 'new-hash', '${anna}')`,
    );
    expect(await query("select name, source, reply_mode from api_key order by name")).toEqual([
      { name: "New bot", source: "static", reply_mode: "draft" },
      { name: "Old bot", source: "static", reply_mode: "send" },
    ]);
  });

  test("page addresses longer than 2,000 characters are shortened", async () => {
    await run(await migrationsBefore("0053_"));
    const workspace = "00000000-0000-4000-8000-0000000000ef";
    const visitor = "00000000-0000-4000-8000-0000000000f1";
    const long = `https://example.com/${"a".repeat(2028)}`;
    await query(
      `insert into workspace (id, name, public_key, signing_secret)
       values ('${workspace}', 'Long', 'wk_00000000000000000000000000000003', 'secret')`,
    );
    await query(
      `insert into visitor (workspace_id, id, token_hash, last_page)
       values ('${workspace}', '${visitor}', 'h2', '${long}')`,
    );
    await query(
      `insert into conversation (workspace_id, visitor_id, started_page)
       values ('${workspace}', '${visitor}', '${long}'), ('${workspace}', '${visitor}', 'https://example.com/')`,
    );
    await run();
    expect(await query("select length(last_page) as n from visitor")).toEqual([{ n: 2000 }]);
    expect(await query("select length(started_page) as n from conversation order by n")).toEqual([
      { n: 20 },
      { n: 2000 },
    ]);
  });

  test("a run with no pending migration takes no backup and changes nothing", async () => {
    await run();
    const before = await appliedCount();
    const result = await run();
    expect(result).toEqual({ applied: 0, backedUp: false });
    expect(backups).toBe(0);
    expect(await appliedCount()).toBe(before);
  });

  test("instances that start together run the migrations once", async () => {
    const results = await Promise.all([run(), run(), run(), run()]);
    const applied = results.map((result) => result.applied).sort((a, b) => b - a);
    expect(applied[0]).toBeGreaterThan(10);
    expect(applied.slice(1)).toEqual([0, 0, 0]);
    expect(backups).toBe(0);
    expect(await appliedCount()).toBe(applied[0]);
  }, 30_000);

  test("a pending migration on an install with data takes a backup first", async () => {
    await run();
    const folder = await withExtraMigration("CREATE TABLE extra_table (id integer);");
    let tableAtBackup: unknown;
    const result = await run(folder, async () => {
      backups += 1;
      tableAtBackup = (
        await query<{ exists: string | null }>("select to_regclass('extra_table') as exists")
      )[0]?.exists;
    });
    expect(result).toEqual({ applied: 1, backedUp: true });
    expect(backups).toBe(1);
    // The backup ran before the change.
    expect(tableAtBackup).toBeNull();
    const [after] = await query<{ exists: string | null }>(
      "select to_regclass('extra_table') as exists",
    );
    expect(after?.exists).toBe("extra_table");
    await rm(folder, { recursive: true });
  });

  test("a failed backup stops the run before anything changes", async () => {
    await run();
    const before = await appliedCount();
    const folder = await withExtraMigration("CREATE TABLE extra_table (id integer);");
    await expect(
      run(folder, async () => {
        throw new Error("The disk is full");
      }),
    ).rejects.toThrow("The disk is full");
    expect(await appliedCount()).toBe(before);
    await rm(folder, { recursive: true });
  });

  test("a failed migration can run again, and another run is not blocked", async () => {
    await run();
    const folder = await withExtraMigration("CREATE TABLE this is not sql;");
    await expect(run(folder)).rejects.toThrow();
    // The lock went with the session, so this does not hang.
    const result = await run();
    expect(result.applied).toBe(0);
    await rm(folder, { recursive: true });
  });

  test("the app role still cannot change the schema after a migrate", async () => {
    await run();
    await expect(
      query("create table not_allowed (id integer)", database.url("app")),
    ).rejects.toThrow();
  });
});

describe("the role's connection string", () => {
  test("encodes a password with special characters", () => {
    const url = roleUrl("postgres://postgres:admin@db:5432/dinghy", "app", "p@ss/w:rd");
    const parsed = new URL(url);
    expect(parsed.username).toBe("dinghy_app");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss/w:rd");
    expect(parsed.pathname).toBe("/dinghy");
    expect(parsed.host).toBe("db:5432");
  });
});

test("query-string credentials cannot keep the admin's login", () => {
  const url = roleUrl(
    "postgres://db:5432/dinghy?user=postgres&password=admin-secret&sslmode=require",
    "app",
    "app-password",
  );
  expect(url).not.toContain("admin-secret");
  const parsed = new URL(url);
  expect(parsed.username).toBe("dinghy_app");
  expect(parsed.searchParams.has("user")).toBe(false);
  // Other settings stay.
  expect(parsed.searchParams.get("sslmode")).toBe("require");
});

test("other query options keep their exact text, which pg_dump needs", () => {
  const options = "options=-c%20lock_timeout%3D0&sslmode=require";
  expect(roleUrl(`postgres://postgres@db/dinghy?${options}`, "backup", undefined)).toContain(
    `?${options}`,
  );
  expect(
    roleUrl(`postgres://db/dinghy?user=postgres&${options}&password=secret`, "backup", undefined),
  ).toContain(`?${options}`);
});

test("a malformed URL's password stays out of the error", () => {
  let message = "";
  try {
    roleUrl("postgres://postgres:ab/cd-secret@db:not-a-port/dinghy", "backup", undefined);
  } catch (error) {
    message = String(error) + JSON.stringify(error);
  }
  expect(message).toContain("not a valid URL");
  expect(message).not.toContain("cd-secret");
});

describe("the version checks", () => {
  test("data from a newer release stops the run with a clear error", async () => {
    const folder = await withExtraMigration("CREATE TABLE extra_table (id integer);");
    await run(folder);
    // This image's list of migrations does not know the newest one that ran.
    await expect(run()).rejects.toBeInstanceOf(UnsupportedVersionError);
    await rm(folder, { recursive: true });
  });

  test("data too old for a direct upgrade stops the run, before any backup", async () => {
    await run();
    const folder = await withExtraMigration("CREATE TABLE extra_table (id integer);");
    await expect(
      runMigrations({
        adminUrl: database.adminUrl(),
        migrationsFolder: folder,
        backup,
        oldestSupported: Date.now() + 86_400_000 * 3650,
      }),
    ).rejects.toThrow("too old");
    expect(backups).toBe(0);
    const [row] = await query<{ exists: string | null }>(
      "select to_regclass('extra_table') as exists",
    );
    expect(row?.exists).toBeNull();
    await rm(folder, { recursive: true });
  });
});

describe("the feed generation after a restore", () => {
  test("it always fits a cursor and differs from the current one", () => {
    for (const current of [1, 999_999_999]) {
      for (let index = 0; index < 1000; index++) {
        const drawn = newGeneration(current);
        expect(drawn).not.toBe(current);
        expect(drawn).toBeLessThanOrEqual(999_999_999);
        expect(drawn).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe("a dump and a restore", () => {
  // Needs a pg_dump that can dump the test server, which CI's runner does not have.
  const dumpTest = test.skipIf(!pgDumpWorks);

  test("a failed dump reports why", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dinghy-dump-"));
    const failing = join(directory, "fake");
    await writeFile(failing, "#!/bin/sh\necho broken >&2\nexit 1\n", { mode: 0o755 });
    await expect(
      runDump({ url: database.url("backup"), file: join(directory, "x"), command: failing }),
    ).rejects.toThrow("broken");
  });

  test("a password goes in the environment, and it never asks for one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dinghy-dump-"));
    const fake = join(directory, "fake");
    const seen = join(directory, "seen");
    await writeFile(
      fake,
      `#!/bin/sh\necho "$@" > ${seen}.args\necho "$PGPASSWORD" > ${seen}.env\n`,
      {
        mode: 0o755,
      },
    );
    await runDump({
      url: "postgres://dinghy_backup:s3cret-value@db:5432/dinghy",
      file: join(directory, "x"),
      command: fake,
    });
    const args = await readFile(`${seen}.args`, "utf8");
    expect(args).not.toContain("s3cret-value");
    expect(args).toContain("--no-password");
    expect((await readFile(`${seen}.env`, "utf8")).trim()).toBe("s3cret-value");
  });

  test("a failed restore leaves the old data, and removes its temporary database", async () => {
    await run();
    await query(
      "insert into instance_setting (key, value) values ('marker', 'old data')",
      database.adminUrl(),
    );
    const directory = await mkdtemp(join(tmpdir(), "dinghy-restore-"));
    const failing = join(directory, "fake");
    await writeFile(failing, "#!/bin/sh\necho broken >&2\nexit 1\n", { mode: 0o755 });
    await expect(
      restoreDatabase({
        adminUrl: database.adminUrl(),
        dumpFile: join(directory, "dump"),
        command: failing,
      }),
    ).rejects.toThrow("broken");
    const [row] = await query<{ value: string }>(
      "select value from instance_setting where key = 'marker'",
    );
    expect(row?.value).toBe("old data");
    const leftovers = await query<{ datname: string }>(
      "select datname from pg_database where datname like '%_restore_%'",
    );
    const name = new URL(database.adminUrl()).pathname.slice(1);
    expect(leftovers.filter((one) => one.datname.startsWith(name))).toEqual([]);
  });

  test("a restore refuses to run while something is connected", async () => {
    await run();
    const holder = new pg.Client({ connectionString: database.adminUrl() });
    await holder.connect();
    try {
      await expect(
        restoreDatabase({ adminUrl: database.adminUrl(), dumpFile: "/no/such/file" }),
      ).rejects.toThrow("Stop the app first");
    } finally {
      await holder.end();
    }
  });

  dumpTest(
    "a failure before the swap leaves the old data, and the step sees the new database",
    async () => {
      await run();
      await query("insert into instance_setting (key, value) values ('marker', 'in the backup')");
      const file = join(await mkdtemp(join(tmpdir(), "dinghy-restore-")), "dump");
      await runDump({ url: database.url("backup"), file });
      await query("update instance_setting set value = 'old data' where key = 'marker'");
      let seen: string | undefined;
      await expect(
        restoreDatabase({
          adminUrl: database.adminUrl(),
          dumpFile: file,
          prepare: async (url) => {
            seen = (
              await query<{ value: string }>(
                "select value from instance_setting where key = 'marker'",
                url,
              )
            )[0]?.value;
            throw new Error("this image cannot read that");
          },
        }),
      ).rejects.toThrow("cannot read");
      expect(seen).toBe("in the backup");
      const [row] = await query<{ value: string }>(
        "select value from instance_setting where key = 'marker'",
      );
      expect(row?.value).toBe("old data");
      const name = new URL(database.adminUrl()).pathname.slice(1);
      const leftovers = await query<{ datname: string }>(
        "select datname from pg_database where datname like '%_restore_%'",
      );
      expect(leftovers.filter((one) => one.datname.startsWith(name))).toEqual([]);
    },
  );

  dumpTest("a failed commit after the swap puts the old data back", async () => {
    await run();
    await query("insert into instance_setting (key, value) values ('marker', 'in the backup')");
    const file = join(await mkdtemp(join(tmpdir(), "dinghy-restore-")), "dump");
    await runDump({ url: database.url("backup"), file });
    await query("update instance_setting set value = 'old data' where key = 'marker'");
    await expect(
      restoreDatabase({
        adminUrl: database.adminUrl(),
        dumpFile: file,
        commit: async () => {
          // A new session here would block the swap back, so it must not get in.
          await expect(query("select 1")).rejects.toThrow("not currently accepting connections");
          throw new Error("a secret cannot be replaced");
        },
      }),
    ).rejects.toThrow("cannot be replaced");
    const [row] = await query<{ value: string }>(
      "select value from instance_setting where key = 'marker'",
    );
    expect(row?.value).toBe("old data");
    const name = new URL(database.adminUrl()).pathname.slice(1);
    const leftovers = await query<{ datname: string }>(
      "select datname from pg_database where datname like '%_restore_%' or datname like '%_old_%'",
    );
    expect(leftovers.filter((one) => one.datname.startsWith(name))).toEqual([]);
  });

  dumpTest("a restore recovers a database that a killed restore left closed", async () => {
    await run();
    const file = join(await mkdtemp(join(tmpdir(), "dinghy-restore-")), "dump");
    await runDump({ url: database.url("backup"), file });
    const name = new URL(database.adminUrl()).pathname.slice(1);
    const maintenance = new URL(database.adminUrl());
    maintenance.pathname = "/postgres";
    await query(`alter database "${name}" allow_connections false`, maintenance.toString());
    await restoreDatabase({
      adminUrl: database.adminUrl(),
      dumpFile: file,
      prepare: async () => {
        await query("select 1");
      },
    });
    expect(await query("select 1 as ok")).toEqual([{ ok: 1 }]);
  });

  dumpTest(
    "a dump with an object only a superuser can make is refused, and the old data stays",
    async () => {
      await run();
      await query(
        "insert into instance_setting (key, value) values ('marker', 'kept') on conflict (key) do update set value = 'kept'",
        database.adminUrl(),
      );
      const file = join(await mkdtemp(join(tmpdir(), "dinghy-restore-")), "dump");
      await query(
        "create function hostile() returns event_trigger language plpgsql as $$ begin end $$",
        database.adminUrl(),
      );
      // Owned by the restoring role, so only the event trigger itself needs a superuser.
      await query("alter function hostile() owner to dinghy_migrator", database.adminUrl());
      await query(
        "create event trigger hostile on ddl_command_start execute function hostile()",
        database.adminUrl(),
      );
      try {
        await runDump({ url: database.adminUrl(), file });
      } finally {
        await query("drop event trigger hostile", database.adminUrl());
        await query("drop function hostile()", database.adminUrl());
      }
      await expect(
        restoreDatabase({ adminUrl: database.adminUrl(), dumpFile: file }),
      ).rejects.toThrow(/permission denied to create event trigger/);
      const [row] = await query<{ value: string }>(
        "select value from instance_setting where key = 'marker'",
      );
      expect(row?.value).toBe("kept");
    },
  );

  dumpTest(
    "a dump's SQL runs as the migrator itself, so RESET ROLE cannot reach the superuser",
    async () => {
      await run();
      const file = join(await mkdtemp(join(tmpdir(), "dinghy-restore-")), "dump");
      // A check constraint calls its function for each row the restore loads. This one records who
      // the restore runs as, after trying to drop a --role switch.
      await query(
        `create table restore_probe (who text, superuser text);
       create function probe(value text) returns text language plpgsql as $$
       begin
         reset role;
         insert into public.restore_probe values (session_user, current_setting('is_superuser'));
         return value;
       end $$;
       create table probed (value text check (probe(value) is not null));
       insert into probed values ('x');`,
        database.adminUrl(),
      );
      await query("alter table restore_probe owner to dinghy_migrator", database.adminUrl());
      await query("alter function probe(text) owner to dinghy_migrator", database.adminUrl());
      await query("alter table probed owner to dinghy_migrator", database.adminUrl());
      await query("delete from restore_probe", database.adminUrl());
      await runDump({ url: database.adminUrl(), file });
      await restoreDatabase({ adminUrl: database.adminUrl(), dumpFile: file });
      const rows = await query<{ who: string; superuser: string }>(
        "select who, superuser from restore_probe",
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.who === "dinghy_migrator" && row.superuser === "off")).toBe(
        true,
      );
    },
  );

  dumpTest("a database whose name needs encoding also gets a new generation", async () => {
    await run();
    await query(
      `insert into workspace (id, name, public_key, signing_secret, feed_generation)
       values ('00000000-0000-4000-8000-000000000001', 'Before', 'wk_before', 'secret', 5)`,
    );
    const file = join(await mkdtemp(join(tmpdir(), "dinghy-restore-")), "dump");
    await runDump({ url: database.url("backup"), file });
    const spaced = `${new URL(database.adminUrl()).pathname.slice(1)} spaced`;
    const url = new URL(database.adminUrl());
    url.pathname = `/${encodeURIComponent(spaced)}`;
    const maintenance = new URL(database.adminUrl());
    maintenance.pathname = "/postgres";
    await query(`create database "${spaced}"`, maintenance.toString());
    try {
      await restoreDatabase({ adminUrl: url.toString(), dumpFile: file });
      const [space] = await query<{ feed_generation: number }>(
        "select feed_generation from workspace",
        url.toString(),
      );
      expect(space?.feed_generation).not.toBe(5);
    } finally {
      await query(`drop database "${spaced}"`, maintenance.toString());
    }
  });

  dumpTest(
    "a real restore replaces the data, and gives each workspace a new generation",
    async () => {
      await run();
      await query(
        `insert into workspace (id, name, public_key, signing_secret, feed_generation)
       values ('00000000-0000-4000-8000-000000000001', 'Before', 'wk_before', 'secret', 5)`,
      );
      const directory = await mkdtemp(join(tmpdir(), "dinghy-restore-"));
      const file = join(directory, "dump");
      await runDump({ url: database.url("backup"), file });
      await query("update workspace set name = 'Changed after the backup'");

      const generations = new Set<number>([5]);
      for (let round = 0; round < 2; round++) {
        await restoreDatabase({ adminUrl: database.adminUrl(), dumpFile: file });
        // This query also shows that the database accepts connections again.
        const [space] = await query<{ name: string; feed_generation: number }>(
          "select name, feed_generation from workspace",
        );
        expect(space?.name).toBe("Before");
        // Restoring one backup twice still gives a generation that old cursors do not hold.
        expect(generations.has(space?.feed_generation ?? 5)).toBe(false);
        generations.add(space?.feed_generation ?? 5);
      }
      // The roles and policies came along.
      const owners = await query<{ tableowner: string }>(
        "select distinct tableowner from pg_tables where schemaname = 'public'",
      );
      expect(owners.map((row) => row.tableowner)).toEqual(["dinghy_migrator"]);
      expect(await query("select 1 from workspace", database.url("app"))).toEqual([]);
    },
  );
});
