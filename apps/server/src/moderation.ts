import { createHmac } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import {
  attachment,
  conversation,
  ipBlock,
  message,
  storageDeletion,
  visitor,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  FORBIDDEN,
  INVALID,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  okContent,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { forgetPagesWithoutChat, lockVisitor } from "./journey.ts";
import { type Live, OPERATORS } from "./live.ts";
import { findConversation, recordConversationChange, recordTeamChange } from "./messages.ts";
import { allowed } from "./team.ts";

// Long enough to stop someone who clears their browser, and short enough for an address that a
// later, innocent person gets from their network.
const IP_BLOCK_MS = 7 * 24 * 3_600_000;
const BLOCKED_PAGE_SIZE = 50;

/** Keyed, so the table cannot be read back into addresses by trying all of IPv4. */
export const hashIp = (secret: string, workspaceId: string, ip: string) =>
  createHmac("sha256", secret).update(`${workspaceId}|${ip}`).digest("hex");

/** A blocked visitor cannot send. Only a signed-out visitor is subject to an address block. */
export async function isBlocked(
  tx: Transaction,
  workspaceId: string,
  identified: { visitorId: string; signedIn: boolean },
  ipHash: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ blockedAt: visitor.blockedAt })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, identified.visitorId)));
  if (row?.blockedAt !== null && row?.blockedAt !== undefined) return true;
  return !identified.signedIn && (await isAddressBlocked(tx, workspaceId, ipHash));
}

export async function isAddressBlocked(
  tx: Transaction,
  workspaceId: string,
  ipHash: string,
): Promise<boolean> {
  const rows = await tx
    .select({ ipHash: ipBlock.ipHash })
    .from(ipBlock)
    .where(
      and(
        eq(ipBlock.workspaceId, workspaceId),
        eq(ipBlock.ipHash, ipHash),
        gt(ipBlock.expiresAt, sql`now()`),
      ),
    );
  return rows.length > 0;
}

/** Remembers a signed-out visitor's latest address, which a block then applies to. */
export async function noteVisitorAddress(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  ipHash: string,
): Promise<void> {
  await tx
    .update(visitor)
    .set({ lastIpHash: ipHash })
    .where(
      and(
        eq(visitor.workspaceId, workspaceId),
        eq(visitor.id, visitorId),
        sql`${visitor.lastIpHash} is distinct from ${ipHash}`,
        sql`${visitor.tokenHash} is not null`,
      ),
    );
}

async function block(tx: Transaction, workspaceId: string, visitorId: string): Promise<void> {
  const [row] = await tx
    .update(visitor)
    .set({ blockedAt: new Date() })
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)))
    .returning({ lastIpHash: visitor.lastIpHash });
  // Only a signed-out visitor has an address here, so a signed-in visitor gets no address block.
  if (row === undefined || row.lastIpHash === null) return;
  const expiresAt = new Date(Date.now() + IP_BLOCK_MS);
  await tx
    .insert(ipBlock)
    .values({ workspaceId, ipHash: row.lastIpHash, visitorId, expiresAt })
    .onConflictDoUpdate({
      target: [ipBlock.workspaceId, ipBlock.ipHash, ipBlock.visitorId],
      set: { expiresAt },
    });
}

async function unblock(tx: Transaction, workspaceId: string, visitorId: string): Promise<void> {
  await tx
    .update(visitor)
    .set({ blockedAt: null })
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  await tx
    .delete(ipBlock)
    .where(and(eq(ipBlock.workspaceId, workspaceId), eq(ipBlock.visitorId, visitorId)));
}

/**
 * Deletes a conversation and queues its stored files, in one transaction. The worker deletes the
 * files, because an object store can be down, and the database must not wait for it.
 */
export async function deleteConversation(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  visitorId: string,
): Promise<void> {
  // The visitor's lock comes before the workspace's, as in a block, and in a send that notes a new
  // address. A page report holds it too, so a report and this delete take turns, and the delete
  // never leaves a page behind.
  await lockVisitor(tx, workspaceId, visitorId);
  // Then the workspace's, as in every other write. A send that holds this lock and checks the
  // conversation with a foreign key would deadlock with a delete that took the conversation first.
  // One that waits here finds the conversation gone, and goes to another of the visitor's, or a new one.
  await recordConversationChange(tx, workspaceId, conversationId, "conversation.deleted");
  const messages = tx
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.workspaceId, workspaceId), eq(message.conversationId, conversationId)));
  const files = await tx
    .delete(attachment)
    .where(and(eq(attachment.workspaceId, workspaceId), inArray(attachment.messageId, messages)))
    .returning({ storageKey: attachment.storageKey });
  if (files.length > 0) {
    await tx
      .insert(storageDeletion)
      .values(files.map(({ storageKey }) => ({ workspaceId, storageKey })));
  }
  await tx
    .delete(message)
    .where(and(eq(message.workspaceId, workspaceId), eq(message.conversationId, conversationId)));
  await tx
    .delete(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  await forgetPagesWithoutChat(tx, workspaceId, visitorId);
}

const params = z.object({ workspaceId: z.uuid(), conversationId: z.uuid() });
const responses = {
  200: {
    description: "Done",
    content: okContent,
  },
  ...MEMBER_WRITE_ERRORS,
};

const blockRoute = createRoute({
  method: "post",
  path: "/v1/operator/workspaces/{workspaceId}/conversations/{conversationId}/block",
  security: SESSION,
  summary: "Block this conversation's visitor from sending",
  request: { params },
  responses,
});

const unblockRoute = createRoute({
  method: "delete",
  path: "/v1/operator/workspaces/{workspaceId}/conversations/{conversationId}/block",
  security: SESSION,
  summary: "Let this conversation's visitor send again",
  request: { params },
  responses,
});

const blockedList = createRoute({
  method: "get",
  path: "/v1/operator/workspaces/{workspaceId}/blocked-visitors",
  security: SESSION,
  summary: "List blocked visitors, including those with no conversation left",
  request: {
    params: z.object({ workspaceId: z.uuid() }),
    query: z.object({ offset: z.coerce.number().int().min(0).default(0) }),
  },
  responses: {
    200: {
      description: "The visitors, newest block first",
      content: {
        "application/json": {
          schema: z.object({
            hasMore: z.boolean(),
            visitors: z.array(
              z.object({
                id: z.string(),
                email: z.string().nullable(),
                externalId: z.string().nullable(),
                name: z.string().nullable(),
                blockedAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

const unblockVisitorRoute = createRoute({
  method: "delete",
  path: "/v1/operator/workspaces/{workspaceId}/blocked-visitors/{visitorId}",
  security: SESSION,
  summary: "Let a visitor send again",
  request: { params: z.object({ workspaceId: z.uuid(), visitorId: z.uuid() }) },
  responses,
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/operator/workspaces/{workspaceId}/conversations/{conversationId}",
  security: SESSION,
  summary: "Delete a conversation, its messages and its images",
  request: { params },
  responses: { ...responses, ...ROLE_WRITE_ERRORS },
});

export function registerModerationRoutes(app: App, db: Database, live: Live): void {
  const onVisitor = async (
    workspaceId: string,
    conversationId: string,
    work: (tx: Transaction, visitorId: string) => Promise<void>,
  ) =>
    withWorkspace(db, workspaceId, async (tx) => {
      const found = await findConversation(tx, workspaceId, conversationId);
      if (found === null) return null;
      await work(tx, found.visitorId);
      await recordConversationChange(tx, workspaceId, conversationId, "conversation.moderated");
      return found.visitorId;
    });

  app.openapi(blockRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const visitorId = await onVisitor(id, conversationId, (tx, target) => block(tx, id, target));
    if (visitorId === null) return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(unblockRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const visitorId = await onVisitor(id, conversationId, (tx, target) => unblock(tx, id, target));
    if (visitorId === null) return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(blockedList, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { offset } = c.req.valid("query");
    const rows = await withWorkspace(db, id, (tx) =>
      tx
        .select({
          id: visitor.id,
          email: visitor.email,
          externalId: visitor.externalId,
          name: visitor.name,
          blockedAt: visitor.blockedAt,
        })
        .from(visitor)
        .where(and(eq(visitor.workspaceId, id), isNotNull(visitor.blockedAt)))
        .orderBy(desc(visitor.blockedAt), desc(visitor.id))
        .limit(BLOCKED_PAGE_SIZE + 1)
        .offset(offset),
    );
    return c.json(
      {
        hasMore: rows.length > BLOCKED_PAGE_SIZE,
        visitors: rows.slice(0, BLOCKED_PAGE_SIZE).map((row) => ({
          ...row,
          blockedAt: (row.blockedAt as Date).toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(unblockVisitorRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { visitorId } = c.req.valid("param");
    const found = await withWorkspace(db, id, async (tx) => {
      const [row] = await tx
        .select({ id: visitor.id })
        .from(visitor)
        .where(and(eq(visitor.workspaceId, id), eq(visitor.id, visitorId)));
      if (row === undefined) return false;
      await unblock(tx, id, visitorId);
      await recordTeamChange(tx, id);
      return true;
    });
    if (!found) return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { conversationId } = c.req.valid("param");
    const visitorId = await withWorkspace(db, id, async (tx) => {
      const found = await findConversation(tx, id, conversationId);
      if (found === null) return null;
      await deleteConversation(tx, id, conversationId, found.visitorId);
      return found.visitorId;
    });
    if (visitorId === null) return c.json(NOT_FOUND, 404);
    live.wake(id, OPERATORS);
    live.wake(id, visitorId);
    return c.json({ ok: true as const }, 200);
  });
}
