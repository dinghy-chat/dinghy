import { z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import type { App } from "./app.ts";
import { type Database, operatorWorkspaces, type WorkspaceAccess, writable } from "./db/tenant.ts";
import { failure, NOT_FOUND } from "./errors.ts";
import type { Role } from "./team.ts";

export const WORKSPACE_PREFIX = "/v1/operator/workspaces";

const PAYMENT_REQUIRED = failure("payment_required", "This workspace waits for payment.");
const READ_ONLY = failure("read_only", "This workspace is read-only until its owner pays again.");
const SUSPENDED = failure("suspended", "This workspace is suspended. Nobody can send messages.");

/**
 * What a write in a workspace that is not open may still do. A route sets this OpenAPI extension
 * itself, so the rule sits next to the route and shows in the API document. A write without it is
 * refused while the workspace is read-only or suspended.
 * - `closed`: works while the workspace is read-only or suspended. Presence, paying, and what takes
 *   access away: removing a member, revoking an invite, deleting the workspace.
 * - `unpaid`: also works while the workspace waits for its first payment. Only Checkout.
 */
const ACCESS_EXTENSION = "x-workspace-access";
export const OPEN_WHILE_CLOSED = { [ACCESS_EXTENSION]: "closed" } as const;
export const OPEN_WHILE_UNPAID = { [ACCESS_EXTENSION]: "unpaid" } as const;
type AccessRule = "closed" | "unpaid";

/** Each route's rule, keyed as Hono matches it: `POST /v1/operator/workspaces/:workspaceId/...`. */
function accessRules(app: App): Map<string, AccessRule> {
  const rules = new Map<string, AccessRule>();
  for (const definition of app.openAPIRegistry.definitions) {
    if (definition.type !== "route") continue;
    const rule: unknown = definition.route[ACCESS_EXTENSION];
    if (rule !== "closed" && rule !== "unpaid") continue;
    const path = definition.route.path.replaceAll(/\/{(.+?)}/g, "/:$1");
    rules.set(`${definition.route.method.toUpperCase()} ${path}`, rule);
  }
  return rules;
}

/** The answer for a write that the workspace's access refuses. */
export function closedFailure(access: WorkspaceAccess) {
  if (access === "suspended") return { body: SUSPENDED, status: 403 as const };
  if (access === "waiting_payment") return { body: PAYMENT_REQUIRED, status: 402 as const };
  return { body: READ_ONLY, status: 402 as const };
}

/**
 * The member check for every route under `/v1/operator/workspaces/{workspaceId}`. `createApp`
 * mounts it right after the session check and before any workspace route, so no route can skip it.
 * Someone who is not a member gets the same answer as for a workspace that does not exist.
 */
export function registerMemberCheck(app: App, db: Database): void {
  // Read on the first request, after every route is registered.
  let rules: Map<string, AccessRule> | undefined;
  const ruleFor = (c: Parameters<typeof matchedRoutes>[0]): AccessRule | undefined => {
    rules ??= accessRules(app);
    const route = matchedRoutes(c).findLast((one) => one.method === c.req.method);
    return route === undefined ? undefined : rules.get(`${route.method} ${route.path}`);
  };

  const requireMember = createMiddleware<{
    Variables: { operatorId: string; memberWorkspaceId: string; memberRole: Role };
  }>(async (c, next) => {
    const workspaceId = c.req.param("workspaceId") ?? "";
    if (!z.uuid().safeParse(workspaceId).success) return c.json(NOT_FOUND, 404);
    const memberships = await operatorWorkspaces(db, c.get("operatorId"));
    const membership = memberships.find((row) => row.workspaceId === workspaceId);
    if (membership === undefined) return c.json(NOT_FOUND, 404);
    const { access } = membership;
    const rule = ruleFor(c);
    // A cloud signup that waits for payment: only its owner's Checkout works until then.
    if (access === "waiting_payment" && rule !== "unpaid") return c.json(PAYMENT_REQUIRED, 402);
    const writes = c.req.method !== "GET" && c.req.method !== "HEAD" && rule === undefined;
    if (writes && !writable(access)) {
      const refused = closedFailure(access);
      return c.json(refused.body, refused.status);
    }
    c.set("memberWorkspaceId", workspaceId);
    c.set("memberRole", membership.role);
    await next();
  });
  app.use(`${WORKSPACE_PREFIX}/:workspaceId/*`, requireMember);
  app.use(`${WORKSPACE_PREFIX}/:workspaceId`, requireMember);
}
