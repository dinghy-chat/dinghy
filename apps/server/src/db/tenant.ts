import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type * as schema from "./schema.ts";

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Enters a workspace's context for the rest of the transaction. `set_config(..., true)` ends with
 * the transaction, so a pooled connection keeps no context. Use `withWorkspace`; call this directly
 * only where a transaction must start before its workspace is known, or needs its own settings.
 */
export async function enterWorkspace(tx: Transaction, workspaceId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
}

/**
 * Runs `work` in a transaction scoped to one workspace. Every tenant query goes through here.
 * Keep the work short: do not make a network call or hold a stream open inside it.
 *
 * It takes a pool-backed database and rejects a transaction. A nested call would run in a savepoint,
 * and its release keeps the inner setting, so the outer queries would read the other workspace.
 */
export function withWorkspace<T>(
  db: Database,
  workspaceId: string,
  work: (tx: Transaction) => Promise<T>,
  config?: Parameters<Database["transaction"]>[1],
): Promise<T> {
  if (!("$client" in db)) {
    return Promise.reject(new Error("withWorkspace cannot run inside a transaction"));
  }
  return db.transaction(async (tx) => {
    await enterWorkspace(tx, workspaceId);
    return work(tx);
  }, config);
}

/**
 * What a workspace allows, from the `workspace_access` SQL function, which works it out for the
 * operator API, the widget and a write under the workspace row lock.
 */
export type WorkspaceAccess =
  | "active"
  | "waiting_cloud"
  | "read_only"
  | "suspended"
  | "waiting_payment"
  | "deleted";

/** Messages and other changes go in only while the workspace is active or waits for the cloud. */
export const writable = (access: WorkspaceAccess) =>
  access === "active" || access === "waiting_cloud";

/** Reads the access again. Under the workspace row lock, nothing can change it until commit. */
export async function workspaceAccess(
  tx: Transaction,
  workspaceId: string,
): Promise<WorkspaceAccess> {
  const result = await tx.execute<{ access: WorkspaceAccess }>(
    sql`select workspace_access(${workspaceId}) as access`,
  );
  return result.rows[0]?.access ?? "deleted";
}

/** The access as the operator app reads it: whether the workspace is paid for, and what is off. */
export function accessFlags(access: WorkspaceAccess) {
  return {
    active: access !== "waiting_payment" && access !== "waiting_cloud",
    waiting: access === "waiting_cloud",
    readOnly: access === "read_only",
    suspended: access === "suspended",
  };
}

interface Membership {
  workspaceId: string;
  role: "owner" | "admin" | "agent";
  access: WorkspaceAccess;
}

/** Lists an operator's workspaces. Sign-in has no workspace yet, so this is a named lookup. */
export async function operatorWorkspaces(db: Database, operatorId: string): Promise<Membership[]> {
  const result = await db.execute<{
    workspace_id: string;
    role: Membership["role"];
    access: WorkspaceAccess;
  }>(sql`select workspace_id, role, access from operator_workspaces(${operatorId})`);
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    role: row.role,
    access: row.access,
  }));
}
