import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";

// Table owners and superusers bypass row-level security, so the app never connects as either.
export const ROLES = {
  migrator: "dinghy_migrator",
  app: "dinghy_app",
  worker: "dinghy_worker",
  backup: "dinghy_backup",
} as const;

export type RoleName = keyof typeof ROLES;

const OPTIONS: Record<RoleName, string> = {
  migrator: "LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS",
  app: "LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS",
  worker: "LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS",
  backup: "LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS",
};

// One stuck workspace row must not drain the shared connection pool.
const TIMEOUTS = { lock_timeout: "5s", idle_in_transaction_session_timeout: "30s" };

/**
 * Creates the roles if they are missing, and sets their options. Run this as a superuser.
 * It lives outside the migrations, because a role's password cannot go in a committed file.
 */
export async function ensureRoles(
  admin: pg.ClientBase,
  passwords: Partial<Record<RoleName, string>> = {},
): Promise<void> {
  // Roles belong to the whole server, but an advisory lock only to one database. A setup from
  // another database at the same moment makes Postgres refuse one of the two, which then tries again.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await setUpRoles(admin, passwords);
    } catch (error) {
      if (attempt >= 5 || !(error instanceof Error && error.message === CONCURRENT)) throw error;
      await delay(50 * attempt);
    }
  }
}

/** Postgres's answer when two sessions change the same role at once. */
const CONCURRENT = "tuple concurrently updated";

async function setUpRoles(
  admin: pg.ClientBase,
  passwords: Partial<Record<RoleName, string>>,
): Promise<void> {
  // Two instances that start together must not race, so hold a lock for the whole setup.
  await admin.query("BEGIN");
  try {
    await admin.query("SELECT pg_advisory_xact_lock(hashtext('dinghy_ensure_roles'))");
    for (const key of Object.keys(ROLES) as RoleName[]) {
      const role = ROLES[key];
      const found = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (found.rowCount === 0) await admin.query(`CREATE ROLE ${role}`);
      await admin.query(`ALTER ROLE ${role} ${OPTIONS[key]}`);
      const password = passwords[key];
      if (password !== undefined) {
        await admin.query(`ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(password)}`);
      }
      if (key === "app" || key === "worker") {
        for (const [name, value] of Object.entries(TIMEOUTS)) {
          await admin.query(`ALTER ROLE ${role} SET ${name} = '${value}'`);
        }
      }
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
