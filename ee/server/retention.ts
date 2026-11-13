// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { and, eq, inArray, sql } from "drizzle-orm";
import { message, storageDeletion } from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";

/** The cloud keeps images and files this long. Text stays while the subscription is active. */
const RETENTION_MONTHS = 12;

const BATCH = 100;

/** 12 months before `now`, at the same time of day, clamped to the last day of the target month. */
export function uploadCutoff(now: Date): Date {
  const cutoff = new Date(now);
  const month = now.getUTCMonth() - RETENTION_MONTHS;
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), month + 1, 0)).getUTCDate();
  cutoff.setUTCFullYear(now.getUTCFullYear(), month, Math.min(now.getUTCDate(), lastDay));
  return cutoff;
}

/**
 * Removes images and files older than 12 months, in each workspace's own context. Each row goes
 * with its attachment, its message is marked so the apps show that the image or file was removed,
 * and the stored object joins the deletions the worker already retries. Rows another worker holds
 * are skipped, so two workers never take the same one. Returns how many it removed.
 */
export async function removeOldUploads(db: Database, now = new Date()): Promise<number> {
  const cutoff = uploadCutoff(now);
  const found = await db.execute<{ workspace_id: string }>(
    sql`select workspace_id from workspaces_with_old_images(${cutoff.toISOString()}, ${BATCH})`,
  );
  let removed = 0;
  for (const { workspace_id: workspaceId } of found.rows) {
    removed += await withWorkspace(db, workspaceId, async (tx) => {
      const claimed = await tx.execute<{ message_id: string; storage_key: string }>(sql`
        DELETE FROM attachment
        WHERE workspace_id = ${workspaceId} AND id IN (
          SELECT id FROM attachment
          WHERE workspace_id = ${workspaceId} AND created_at < ${cutoff.toISOString()}
          ORDER BY created_at
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING message_id, storage_key`);
      if (claimed.rows.length === 0) return 0;
      await tx
        .insert(storageDeletion)
        .values(claimed.rows.map((row) => ({ workspaceId, storageKey: row.storage_key })));
      await tx
        .update(message)
        .set({
          metadata: sql`(${message.metadata} - 'image' - 'file') || jsonb_build_object(case when ${message.metadata} ? 'file' then 'fileRemoved' else 'imageRemoved' end, true)`,
        })
        .where(
          and(
            eq(message.workspaceId, workspaceId),
            inArray(
              message.id,
              claimed.rows.map((row) => row.message_id),
            ),
          ),
        );
      return claimed.rows.length;
    });
  }
  return removed;
}
