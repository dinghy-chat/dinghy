import type pg from "pg";
import type { EventKind } from "./db/schema.ts";
import { OPERATORS, type Signals, VISITORS } from "./live.ts";

const WORKSPACE_CHANGED: EventKind = "workspace.changed";

/**
 * Suspends a workspace, or lifts it with `suspend: false`. A suspended workspace cannot send or
 * upload, its widget gets the answer for an unknown key, and its operators can read and see why.
 * It runs with the admin login, as `chat suspend` does, and records the change on the workspace's
 * feed in the same transaction, so open inboxes learn of it even if a signal is lost.
 *
 * Returns false if no workspace has this ID, or it was deleted.
 */
export async function setSuspended(
  client: pg.ClientBase,
  workspaceId: string,
  suspend: boolean,
  reason: string | null = null,
): Promise<boolean> {
  await client.query("BEGIN");
  try {
    const updated = await client.query<{ seq: string }>(
      `UPDATE workspace
       SET suspended_at = CASE WHEN $2 THEN coalesce(suspended_at, now()) END,
           suspended_reason = CASE WHEN $2 THEN $3 END,
           event_seq = event_seq + 1
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING event_seq AS seq`,
      [workspaceId, suspend, reason],
    );
    const seq = updated.rows[0]?.seq;
    if (seq === undefined) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("INSERT INTO event (workspace_id, seq, kind) VALUES ($1, $2, $3)", [
      workspaceId,
      seq,
      WORKSPACE_CHANGED,
    ]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * After the commit: open inboxes read `me` again and show the banner, and every widget stream
 * closes. A lost signal only delays this, because a widget stream checks its workspace on each read
 * and ends within its 15-minute lifetime.
 */
export function signalSuspension(signals: Signals, workspaceId: string, suspend: boolean): void {
  signals.wake(workspaceId, OPERATORS);
  if (suspend) signals.revoke(workspaceId, VISITORS);
}
