import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { contactChanged } from "./contact-checks.ts";
import { conversation, visitor } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { sha256Hex } from "./identity.ts";
import { lockVisitors } from "./journey.ts";
import { lockWorkspace, recordConversationChanges } from "./messages.ts";

/**
 * Moves everything of the anonymous visitor that this browser token names into the signed-in
 * visitor, then deletes it, as when a person signs in where they chatted before. A token of
 * another workspace, an expired one, or one of a signed-in visitor changes nothing. Answers
 * whether a visitor was merged.
 */
export async function mergeBrowserVisitor(
  tx: Transaction,
  workspaceId: string,
  targetId: string,
  browserToken: string,
): Promise<boolean> {
  const [source] = await tx
    .select({ id: visitor.id })
    .from(visitor)
    .where(
      and(
        eq(visitor.workspaceId, workspaceId),
        eq(visitor.tokenHash, sha256Hex(browserToken)),
        isNull(visitor.userId),
        ne(visitor.id, targetId),
        gt(visitor.tokenUsedAt, sql`now() - interval '1 year'`),
      ),
    );
  if (source === undefined) return false;
  // In the order a send and a delete take them, so a send to either visitor waits for the merge.
  await lockVisitors(tx, workspaceId, [source.id, targetId]);
  await lockWorkspace(tx, workspaceId);
  const merged = await mergeVisitorRow(tx, workspaceId, source.id, targetId);
  if (!merged) return false;
  const moved = await moveVisitorRows(tx, workspaceId, source.id, targetId);
  await tx
    .delete(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, source.id)));
  // `moderated` is the change on a visitor, which makes open operator apps read all threads again.
  await recordConversationChanges(tx, workspaceId, moved, "conversation.moderated");
  await contactChanged(tx, workspaceId, targetId, "all");
  return true;
}

/**
 * The signed-in visitor keeps its own name, email and attributes. It takes the anonymous one's note
 * when it has none, its block, the earlier start and the further read position. False when the
 * source went away in another merge.
 */
async function mergeVisitorRow(
  tx: Transaction,
  workspaceId: string,
  sourceId: string,
  targetId: string,
): Promise<boolean> {
  const updated = await tx.execute(sql`
    UPDATE visitor AS t SET
      note = coalesce(t.note, s.note),
      blocked_at = coalesce(t.blocked_at, s.blocked_at),
      created_at = least(t.created_at, s.created_at),
      last_read_seq = greatest(t.last_read_seq, s.last_read_seq)
    FROM visitor AS s
    WHERE t.workspace_id = ${workspaceId} AND t.id = ${targetId}
      AND s.workspace_id = ${workspaceId} AND s.id = ${sourceId}`);
  return (updated.rowCount ?? 0) > 0;
}

/**
 * Points every row of the source at the target. A row whose key the target already holds stays,
 * and the source's delete removes it: the target's block from that address, its dedupe key, or a
 * scheduled run's message. Answers the moved conversations.
 */
async function moveVisitorRows(
  tx: Transaction,
  workspaceId: string,
  sourceId: string,
  targetId: string,
): Promise<string[]> {
  const moved = await tx
    .update(conversation)
    .set({ visitorId: targetId })
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.visitorId, sourceId)))
    .returning({ id: conversation.id });
  const scope = sql`workspace_id = ${workspaceId} AND visitor_id = ${sourceId}`;
  await tx.execute(sql`
    UPDATE message SET author_visitor_id = ${targetId}
    WHERE workspace_id = ${workspaceId} AND author_visitor_id = ${sourceId}`);
  for (const table of ["chat_link", "reply_address", "page_view", "alert_delivery"]) {
    await tx.execute(
      sql`UPDATE ${sql.identifier(table)} SET visitor_id = ${targetId} WHERE ${scope}`,
    );
  }
  await tx.execute(sql`
    UPDATE ip_block AS s SET visitor_id = ${targetId}
    WHERE s.workspace_id = ${workspaceId} AND s.visitor_id = ${sourceId} AND NOT EXISTS (
      SELECT 1 FROM ip_block AS t WHERE t.workspace_id = s.workspace_id
        AND t.visitor_id = ${targetId} AND t.ip_hash = s.ip_hash)`);
  await tx.execute(sql`
    UPDATE outbound_message AS s SET visitor_id = ${targetId}
    WHERE s.workspace_id = ${workspaceId} AND s.visitor_id = ${sourceId}
      AND (s.campaign_run_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM outbound_message AS t WHERE t.workspace_id = s.workspace_id
          AND t.visitor_id = ${targetId} AND t.campaign_run_id = s.campaign_run_id))`);
  await tx.execute(sql`
    UPDATE outbound_dedupe AS s SET visitor_id = ${targetId}
    WHERE s.workspace_id = ${workspaceId} AND s.visitor_id = ${sourceId} AND NOT EXISTS (
      SELECT 1 FROM outbound_dedupe AS t WHERE t.workspace_id = s.workspace_id
        AND t.visitor_id = ${targetId} AND t.dedupe_key = s.dedupe_key)`);
  // An event both tracked adds its counts and spans both periods.
  await tx.execute(sql`
    INSERT INTO contact_event (workspace_id, visitor_id, name, count, first_at, last_at, recent_ids)
    SELECT workspace_id, ${targetId}, name, count, first_at, last_at, recent_ids
    FROM contact_event WHERE ${scope}
    ON CONFLICT (workspace_id, visitor_id, name) DO UPDATE SET
      count = contact_event.count + excluded.count,
      first_at = least(contact_event.first_at, excluded.first_at),
      last_at = greatest(contact_event.last_at, excluded.last_at)`);
  return moved.map((row) => row.id);
}
