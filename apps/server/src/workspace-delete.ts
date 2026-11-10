import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { workspace } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  MEMBER_ERRORS,
  OPERATOR_WRITE_ERRORS,
  okContent,
  WRONG_ORIGIN_TEXT,
} from "./errors.ts";
import { type Live, OPERATORS } from "./live.ts";
import { OPEN_WHILE_CLOSED } from "./member.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";

/** Whether `workspaceId` is the only workspace on the server that is not deleted. */
export async function isOnlyWorkspace(tx: Transaction, workspaceId: string): Promise<boolean> {
  const result = await tx.execute<{ other: boolean }>(
    sql`select other_workspace_exists(${workspaceId}) as other`,
  );
  return result.rows[0]?.other !== true;
}

const ONLY_WORKSPACE = failure("last_workspace", "This is the only workspace on this server.");

/**
 * Removes deleted workspaces' data. A workspace row goes once the worker has removed its images,
 * and, on the cloud, once its billing is cleared.
 */
export async function purgeDeletedWorkspaces(db: Database): Promise<number> {
  const result = await db.execute<{ removed: number }>(
    sql`select purge_deleted_workspaces() as removed`,
  );
  return Number(result.rows[0]?.removed ?? 0);
}

const deleteRoute = createRoute({
  method: "delete",
  ...OPEN_WHILE_CLOSED,
  path: "/v1/operator/workspaces/{workspaceId}",
  security: SESSION,
  summary: "Delete a workspace and all its data, now",
  request: {
    params: z.object({ workspaceId: z.uuid() }),
    body: {
      required: true,
      content: {
        // The workspace's name, typed by the owner, so a stray request cannot delete it.
        "application/json": { schema: z.object({ name: z.string().max(100) }) },
      },
    },
  },
  responses: {
    200: {
      description: "Deleted. The worker removes the data and images within minutes.",
      content: okContent,
    },
    ...MEMBER_ERRORS,
    ...OPERATOR_WRITE_ERRORS,
    400: errorAnswer(
      "invalid_request: the request is not valid. name_mismatch: the typed name does not match",
    ),
    403: errorAnswer(`forbidden: only an owner can delete it. ${WRONG_ORIGIN_TEXT}`),
    409: errorAnswer(
      "last_workspace: on a self-hosted server, the last workspace that is not deleted stays",
    ),
    429: errorAnswer("too_many_requests: too many attempts. Retry after `retry-after`"),
    502: errorAnswer(
      "billing_unavailable: the subscription could not be canceled, so nothing was deleted",
    ),
  },
});

interface WorkspaceDeleteOptions {
  db: Database;
  /**
   * Runs before the delete, and a throw stops it. The cloud cancels the subscription here, so a
   * deleted workspace is not charged.
   */
  beforeDelete?: ((workspaceId: string) => Promise<void>) | undefined;
  /** The clock for the deletion time, which the cloud's tests control. */
  now?: (() => Date) | undefined;
  /** True on a self-hosted server, which keeps its last workspace. The cloud has no such limit. */
  keepsLastWorkspace: boolean;
  live: Live;
  logger: Logger;
  rateLimit: RateLimit;
}

/** The owner's delete. Call this after the inbox routes, so it runs behind their member check. */
export function registerWorkspaceDelete(
  app: App,
  {
    db,
    beforeDelete,
    now = () => new Date(),
    keepsLastWorkspace,
    live,
    logger,
    rateLimit,
  }: WorkspaceDeleteOptions,
) {
  app.openapi(deleteRoute, async (c) => {
    if (c.get("memberRole") !== "owner") {
      return c.json(failure("forbidden", "Only an owner can delete this workspace."), 403);
    }
    const wait = await rateLimit.hit("workspace-delete", c.get("operatorId"), 10, 60);
    if (wait !== null) return tooManyRequests(c, wait);
    const id = c.get("memberWorkspaceId");
    const [found] = await withWorkspace(db, id, (tx) =>
      tx.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, id)),
    );
    if (found === undefined) throw new Error("A member's workspace is missing");
    if (c.req.valid("json").name.trim() !== found.name) {
      return c.json(failure("name_mismatch", "Type the workspace's name to delete it."), 400);
    }
    try {
      await beforeDelete?.(id);
    } catch (err) {
      logger.error({ err, workspaceId: id }, "a deleted workspace's subscription was not canceled");
      return c.json(
        failure(
          "billing_unavailable",
          "The subscription could not be canceled, so nothing was deleted. Try again.",
        ),
        502,
      );
    }
    // On the cloud, the worker closes a payment page opened from now on, before the purge.
    const deleted = await withWorkspace(db, id, async (tx) => {
      if (keepsLastWorkspace) {
        // Two owners who delete the last two workspaces at once take turns, and the second stops.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('workspace-delete'))`);
        if (await isOnlyWorkspace(tx, id)) return false;
      }
      await tx
        .update(workspace)
        .set({ deletedAt: now() })
        .where(and(eq(workspace.id, id), isNull(workspace.deletedAt)));
      return true;
    });
    if (!deleted) return c.json(ONLY_WORKSPACE, 409);
    logger.info({ workspaceId: id }, "an owner deleted a workspace");
    // Open inboxes reconnect, and find the workspace gone.
    live.wake(id, OPERATORS);
    return c.json({ ok: true as const }, 200);
  });
}
