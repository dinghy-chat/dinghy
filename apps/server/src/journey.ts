import { z } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { conversation, pageView, visitor } from "./db/schema.ts";
import type { Database, Transaction } from "./db/tenant.ts";

/** The newest rows a visitor keeps, so a long visit cannot grow without end. */
const PAGES_KEPT = 100;
/** The newest rows an operator sees. */
const PAGES_SHOWN = 20;
export const PAGE_TITLE_MAX = 200;
/** The longest page address kept, for the starting page, the last page and the journey alike. */
export const PAGE_PATH_MAX = 2000;
const KEPT_DAYS = 90;

/**
 * What a host page sent with `Dinghy.setContext()`: a few unsigned values for operators to read.
 * The widget checks the same limits before it sends.
 */
export const PageContextSchema = z
  .record(
    z.string().min(1).max(40),
    z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 20)
  .openapi("PageContext", { example: { plan: "pro", seats: 4, trial: false } });
export type PageContext = z.infer<typeof PageContextSchema>;

interface PageSeen {
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
  const path = page.path;
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

/**
 * Replaces what the host page sent with setContext(). Like a page, it is kept only for a visitor who
 * has chatted, so a page that calls it for every visitor stores nothing. Returns false then.
 */
export async function recordPageContext(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  context: PageContext,
): Promise<boolean> {
  const updated = await tx
    .update(visitor)
    .set({ pageContext: Object.keys(context).length === 0 ? null : context })
    .where(
      and(
        eq(visitor.workspaceId, workspaceId),
        eq(visitor.id, visitorId),
        sql`exists (select 1 from ${conversation} where ${conversation.workspaceId} = ${workspaceId} and ${conversation.visitorId} = ${visitorId})`,
      ),
    )
    .returning({ id: visitor.id });
  return updated.length > 0;
}

/**
 * Takes the visitor row's lock, as an update of it would. A caller that also writes the workspace
 * takes this first, as a send and a block do, so the two locks never come in opposite orders. It
 * leaves the key alone, so a send that starts a conversation can still check its foreign key.
 */
export async function lockVisitor(tx: Transaction, workspaceId: string, visitorId: string) {
  await tx
    .select({ id: visitor.id })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)))
    .for("no key update");
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
 * The journey, and what the page sent, belong to a visitor who chatted. When their last conversation goes, it goes too, so
 * a delete leaves no trace of where they browsed. The caller holds the visitor's lock already, from
 * before the workspace's.
 */
export async function forgetPagesWithoutChat(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM page_view WHERE workspace_id = ${workspaceId} AND visitor_id = ${visitorId}
      AND NOT EXISTS (SELECT 1 FROM conversation
        WHERE workspace_id = ${workspaceId} AND visitor_id = ${visitorId})`);
  // What the page sent goes with the journey.
  await tx.execute(sql`
    UPDATE visitor SET page_context = NULL WHERE workspace_id = ${workspaceId} AND id = ${visitorId}
      AND page_context IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation
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
