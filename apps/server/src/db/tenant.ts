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

/**
 * Whether a message goes in. A welcome chat with Dinghy's founder is the one exception to the
 * payment states: it takes messages while the workspace waits for payment or is read-only, so the
 * founder's reply waits in the inbox and the owner can still answer. Suspended and deleted refuse.
 */
export const writableFor = (access: WorkspaceAccess, { welcome }: { welcome: boolean }) =>
  writable(access) || (welcome && (access === "waiting_payment" || access === "read_only"));

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

/**
 * The access a welcome chat's message goes in by. `workspace_access` reports waiting for payment
 * before suspension, which the payment screen and the member check rely on, so the welcome
 * exception reads the suspension itself: a suspended workspace takes no message whatever it paid.
 */
export async function welcomeAccess(
  tx: Transaction,
  workspaceId: string,
  access: WorkspaceAccess,
): Promise<WorkspaceAccess> {
  if (access !== "waiting_payment") return access;
  const result = await tx.execute<{ suspended: boolean }>(
    sql`select suspended_at is not null as suspended from workspace where id = ${workspaceId}`,
  );
  return result.rows[0]?.suspended === true ? "suspended" : access;
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
  role: "owner" | "admin" | "member";
  access: WorkspaceAccess;
}

/** Lists an operator's workspaces. Sign-in has no workspace yet, so this is a named lookup. */
export async function operatorWorkspaces(
  db: Database | Transaction,
  operatorId: string,
): Promise<Membership[]> {
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
