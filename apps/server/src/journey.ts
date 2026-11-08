import { and, desc, eq, sql } from "drizzle-orm";
import { conversation, pageView, visitor } from "./db/schema.ts";
import type { Database, Transaction } from "./db/tenant.ts";

/** The newest rows a visitor keeps, so a long visit cannot grow without end. */
export const PAGES_KEPT = 100;
/** The newest rows an operator sees. */
export const PAGES_SHOWN = 20;
export const PAGE_TITLE_MAX = 200;
export const PAGE_PATH_MAX = 2000;
const KEPT_DAYS = 90;

export interface PageSeen {
  path: string;
  title: string | null;
  viewedAt: Date;
}

/** One line of at most 200 characters, or null when nothing is left. */
export function pageTitle(title: string | undefined): string | null {
  const line = title?.replace(/\s+/g, " ").trim().slice(0, PAGE_TITLE_MAX).trim() ?? "";
  return line === "" ? null : line;
}

/**
 * Notes the page a visitor is on: the visitor's last page and time, and a row of their journey.
 * Only a visitor who has chatted gets anything, so a widget report alone stores nothing. Returns
 * false when nothing was stored.
 */
export async function recordPage(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  page: { path: string | null; title: string | null; device: string },
): Promise<boolean> {
  const isVisitor = and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId));
  // The visitor row's lock makes this take turns with another report and with the delete of the
  // visitor's last conversation, so a delete can never leave a page behind.
  await lockVisitor(tx, workspaceId, visitorId);
  const chatted = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.visitorId, visitorId)))
    .limit(1);
  if (chatted.length === 0) return false;
  await tx
    .update(visitor)
    .set({
      ...(page.path === null ? {} : { lastPage: page.path }),
      lastSeenAt: sql`now()`,
      device: page.device,
    })
    .where(isVisitor);
  if (page.path === null) return true;
  const path = page.path.slice(0, PAGE_PATH_MAX);
  const ofVisitor = and(eq(pageView.workspaceId, workspaceId), eq(pageView.visitorId, visitorId));
  const [newest] = await tx
    .select({ id: pageView.id, path: pageView.path, title: pageView.title })
    .from(pageView)
    .where(ofVisitor)
    .orderBy(desc(pageView.viewedAt))
    .limit(1);
  if (newest?.path === path) {
    // A single-page app often sets the title after it changes the address.
    if (page.title !== null && page.title !== newest.title) {
      await tx
        .update(pageView)
        .set({ title: page.title })
        .where(and(eq(pageView.workspaceId, workspaceId), eq(pageView.id, newest.id)));
    }
    return true;
  }
  await tx.insert(pageView).values({ workspaceId, visitorId, path, title: page.title });
  await tx.execute(sql`
    DELETE FROM page_view WHERE workspace_id = ${workspaceId} AND id IN (
      SELECT id FROM page_view WHERE workspace_id = ${workspaceId} AND visitor_id = ${visitorId}
      ORDER BY viewed_at DESC OFFSET ${PAGES_KEPT})`);
  return true;
}

async function lockVisitor(tx: Transaction, workspaceId: string, visitorId: string) {
  await tx
    .select({ id: visitor.id })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)))
    .for("update");
}

/** A visitor's newest pages, newest first. */
export function visitorPages(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  limit = PAGES_SHOWN,
): Promise<PageSeen[]> {
  return tx
    .select({ path: pageView.path, title: pageView.title, viewedAt: pageView.viewedAt })
    .from(pageView)
    .where(and(eq(pageView.workspaceId, workspaceId), eq(pageView.visitorId, visitorId)))
    .orderBy(desc(pageView.viewedAt))
    .limit(limit);
}

/**
 * The journey belongs to a visitor who chatted. When their last conversation goes, it goes too, so
 * a delete leaves no trace of where they browsed.
 */
export async function forgetPagesWithoutChat(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
): Promise<void> {
  await lockVisitor(tx, workspaceId, visitorId);
  await tx.execute(sql`
    DELETE FROM page_view WHERE workspace_id = ${workspaceId} AND visitor_id = ${visitorId}
      AND NOT EXISTS (SELECT 1 FROM conversation
        WHERE workspace_id = ${workspaceId} AND visitor_id = ${visitorId})`);
}

/** Deletes up to `limit` rows older than 90 days, across workspaces. For the worker. */
export async function prunePageViews(db: Database, limit: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM page_view WHERE (workspace_id, id) IN (
      SELECT workspace_id, id FROM page_view
      WHERE viewed_at < now() - make_interval(days => ${KEPT_DAYS}) LIMIT ${limit})`);
  return result.rowCount ?? 0;
}
