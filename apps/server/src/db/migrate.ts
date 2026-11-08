import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { ensureRoles, ROLES, type RoleName } from "./roles.ts";

function parseAdminUrl(adminUrl: string): URL {
  try {
    return new URL(adminUrl);
  } catch {
    // Not the original error, which holds the whole value, password included.
    throw new Error("ADMIN_DATABASE_URL is not a valid URL. Encode special characters in it.");
  }
}

/** A connection string for one of the roles, on the same server and database as the admin's. */
export function roleUrl(adminUrl: string, role: RoleName, password: string | undefined): string {
  const url = parseAdminUrl(adminUrl);
  url.username = ROLES[role];
  url.password = password === undefined ? "" : encodeURIComponent(password);
  // A query's user and password would win over the two above, and the run would keep the admin's
  // login. This edits the text, because searchParams would turn %20 into +, which pg_dump misreads.
  url.search = url.search
    .slice(1)
    .split("&")
    .filter((part) => !/^(user|password)=/i.test(part))
    .join("&");
  return url.toString();
}

interface MigrateOptions {
  adminUrl: string;
  migrationsFolder: string;
  passwords?: Partial<Record<RoleName, string>>;
  /** Runs before a migration changes an install that already holds data. */
  backup(): Promise<unknown>;
  /** A database older than this time must first upgrade through a release that knows it. */
  oldestSupported?: number;
}

export class UnsupportedVersionError extends Error {}

/** The name of the newest migration this database has run. */
export async function lastMigrationTag(
  client: pg.ClientBase,
  migrationsFolder: string,
): Promise<string | null> {
  const history = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists",
  );
  if (!history.rows[0]?.exists) return null;
  const [row] = (
    await client.query<{ created_at: string }>(
      "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
    )
  ).rows;
  if (row === undefined) return null;
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { when: number; tag: string }[] };
  const when = Number(row.created_at);
  return journal.entries.find((entry) => entry.when === when)?.tag ?? String(when);
}

interface MigrateResult {
  applied: number;
  backedUp: boolean;
}

/**
 * Creates the roles, and runs pending migrations as the role that owns the tables. A session lock
 * covers the whole run, so instances that start together take turns, and the later ones find
 * nothing to do. A failed backup stops the run before anything changes.
 */
export async function runMigrations({
  adminUrl,
  migrationsFolder,
  passwords = {},
  backup,
  oldestSupported = 0,
}: MigrateOptions): Promise<MigrateResult> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_advisory_lock(hashtext('dinghy_migrate'))");
    await ensureRoles(admin, passwords);
    const current = await admin.query<{ name: string }>("SELECT current_database() AS name");
    const database = admin.escapeIdentifier(current.rows[0]?.name ?? "");
    await admin.query(`ALTER DATABASE ${database} OWNER TO ${ROLES.migrator}`);

    const history = await admin.query<{ exists: boolean }>(
      "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists",
    );
    const lastApplied = history.rows[0]?.exists
      ? (
          await admin.query<{ created_at: string }>(
            "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
          )
        ).rows[0]
      : undefined;
    const last = lastApplied === undefined ? null : Number(lastApplied.created_at);
    const files = readMigrationFiles({ migrationsFolder });
    const newest = files.at(-1)?.folderMillis ?? 0;
    if (last !== null && last > newest) {
      throw new UnsupportedVersionError(
        "This database comes from a newer release than this image. Use that release or a later one.",
      );
    }
    if (last !== null && last < oldestSupported) {
      throw new UnsupportedVersionError(
        "This database is too old for this release to upgrade directly. Upgrade through the releases in between. See the upgrade notes.",
      );
    }
    const pending = files.filter((file) => last === null || file.folderMillis > last);
    if (pending.length === 0) return { applied: 0, backedUp: false };

    // A first install holds nothing worth saving yet.
    const hasData = last !== null;
    if (hasData) await backup();

    const pool = new pg.Pool({
      connectionString: roleUrl(adminUrl, "migrator", passwords.migrator),
      max: 1,
    });
    try {
      await applyMigrations(drizzle(pool), { migrationsFolder });
    } finally {
      await pool.end();
    }
    return { applied: pending.length, backedUp: hasData };
  } finally {
    // Ending the session also releases the lock, even after a failure above.
    await admin.end();
  }
}

interface DumpOptions {
  /** The backup role's connection string. Its password never goes on a command line. */
  url: string;
  file: string;
  command?: string;
}

/** Writes one database dump to a file. */
export async function runDump({ url, file, command = "pg_dump" }: DumpOptions): Promise<void> {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      command,
      // No prompt, because a run waiting for a password would hold the migration lock.
      ["--format=custom", "--no-password", `--file=${file}`, `--dbname=${parsed.toString()}`],
      {
        env: { ...process.env, ...(password === "" ? {} : { PGPASSWORD: password }) },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", reject);
    // Not exit, which can come before the error text has arrived.
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited with ${code}: ${errors.trim()}`));
    });
  });
}

interface RestoreDatabaseOptions {
  adminUrl: string;
  dumpFile: string;
  passwords?: Partial<Record<RoleName, string>>;
  command?: string;
  /** Runs on the new database before the swap, so a failure here also leaves the old data in place. */
  prepare?(restoredUrl: string): Promise<void>;
  /** Runs after the swap and before the old database goes, and a failure here swaps it back. */
  commit?(): Promise<void>;
}

function databaseOf(adminUrl: string): string {
  return decodeURIComponent(parseAdminUrl(adminUrl).pathname.slice(1));
}

function urlOfDatabase(adminUrl: string, name: string): URL {
  const url = parseAdminUrl(adminUrl);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url;
}

/** A closed client's session can take a moment to end. It returns false if sessions remain. */
async function waitForNoSessions(admin: pg.Client, databases: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const open = await admin.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE datname = ANY($1) AND pid <> pg_backend_pid()",
      [databases],
    );
    if (Number(open.rows[0]?.count) === 0) return true;
    await delay(100);
  }
  return false;
}

/**
 * Loads a dump into a new database, prepares it, and swaps it in only after all of that works, so a
 * failed restore leaves the old data usable. Every workspace gets a random new feed generation, so a client's cursor from
 * before the restore gets resync, even when one backup is restored twice.
 */
export async function restoreDatabase({
  adminUrl,
  dumpFile,
  passwords = {},
  command = "pg_restore",
  prepare,
  commit,
}: RestoreDatabaseOptions): Promise<void> {
  const target = databaseOf(adminUrl);
  const temporary = `${target}_restore_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({
    connectionString: urlOfDatabase(adminUrl, "postgres").toString(),
  });
  await admin.connect();
  const quote = (name: string) => admin.escapeIdentifier(name);
  try {
    await ensureRoles(admin, passwords);
    // A restore killed during its commit leaves the database closed, and this run must recover it.
    await admin.query(`ALTER DATABASE ${quote(target)} ALLOW_CONNECTIONS true`);
    if (!(await waitForNoSessions(admin, [target]))) {
      throw new Error("Something is still connected to the database. Stop the app first.");
    }
    await admin.query(`CREATE DATABASE ${quote(temporary)} OWNER ${ROLES.migrator}`);
    try {
      const restoredUrl = urlOfDatabase(adminUrl, temporary).toString();
      // Signed in as the role that owns the tables, not the superuser: a dump is SQL, and a crafted
      // one could otherwise run programs on the database server (COPY ... TO PROGRAM). A
      // `--role` switch is not enough, because the dump's SQL could switch back with RESET ROLE.
      const url = new URL(roleUrl(restoredUrl, "migrator", passwords.migrator));
      const password = decodeURIComponent(url.password);
      url.password = "";
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          command,
          ["--no-password", "--exit-on-error", "--single-transaction", `--dbname=${url}`, dumpFile],
          {
            env: { ...process.env, ...(password === "" ? {} : { PGPASSWORD: password }) },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let errors = "";
        child.stderr.on("data", (chunk) => {
          errors += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`pg_restore exited with ${code}: ${errors.trim()}`));
        });
      });

      const restored = new pg.Client({ connectionString: restoredUrl });
      await restored.connect();
      try {
        const spaces = await restored.query<{ id: string; feed_generation: number }>(
          "SELECT id, feed_generation FROM workspace",
        );
        for (const space of spaces.rows) {
          await restored.query("UPDATE workspace SET feed_generation = $1 WHERE id = $2", [
            newGeneration(space.feed_generation),
            space.id,
          ]);
        }
      } finally {
        await restored.end();
      }

      await prepare?.(restoredUrl);
      await waitForNoSessions(admin, [target, temporary]);
      // Closed until the commit works, because a new session, such as a cron backup, would block the
      // rename that swaps the old database back.
      await admin.query(`ALTER DATABASE ${quote(temporary)} ALLOW_CONNECTIONS false`);

      const retired = `${target}_old_${randomBytes(4).toString("hex")}`;
      await admin.query(`ALTER DATABASE ${quote(target)} RENAME TO ${quote(retired)}`);
      try {
        await admin.query(`ALTER DATABASE ${quote(temporary)} RENAME TO ${quote(target)}`);
        try {
          await commit?.();
          await admin.query(`ALTER DATABASE ${quote(target)} ALLOW_CONNECTIONS true`);
        } catch (error) {
          await admin.query(`ALTER DATABASE ${quote(target)} RENAME TO ${quote(temporary)}`);
          throw error;
        }
      } catch (error) {
        await admin.query(`ALTER DATABASE ${quote(retired)} RENAME TO ${quote(target)}`);
        throw error;
      }
      await admin.query(`DROP DATABASE ${quote(retired)}`);
    } catch (error) {
      await admin.query(`DROP DATABASE IF EXISTS ${quote(temporary)}`).catch(() => undefined);
      throw error;
    }
  } finally {
    await admin.end();
  }
}

// The largest generation a cursor can carry, because CURSOR_PATTERN allows nine digits.
const MAX_GENERATION = 999_999_999;

/** Random and not the current value, so a cursor from before a move or a restore gets resync. */
export function newGeneration(current: number): number {
  const drawn = randomInt(1, MAX_GENERATION);
  return drawn >= current ? drawn + 1 : drawn;
}
