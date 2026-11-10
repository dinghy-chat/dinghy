import { z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import type { Actor } from "./api-keys.ts";
import type { App } from "./app.ts";
import { type Database, operatorWorkspaces, type WorkspaceAccess, writable } from "./db/tenant.ts";
import { FORBIDDEN, failure, NOT_FOUND } from "./errors.ts";
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

interface RouteRules {
  /** Each route's rule, keyed as Hono matches it: `POST /v1/operator/workspaces/:workspaceId/...`. */
  access: Map<string, AccessRule>;
  /** The routes whose security names `apiKey`, keyed the same way. Every other one refuses a key. */
  keys: Set<string>;
}

function routeRules(app: App): RouteRules {
  const rules: RouteRules = { access: new Map(), keys: new Set() };
  for (const definition of app.openAPIRegistry.definitions) {
    if (definition.type !== "route") continue;
    const path = definition.route.path.replaceAll(/\/{(.+?)}/g, "/:$1");
    const key = `${definition.route.method.toUpperCase()} ${path}`;
    if (definition.route.security?.some((scheme) => "apiKey" in scheme)) rules.keys.add(key);
    const rule: unknown = definition.route[ACCESS_EXTENSION];
    if (rule === "closed" || rule === "unpaid") rules.access.set(key, rule);
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
  let rules: RouteRules | undefined;
  const routeOf = (c: Parameters<typeof matchedRoutes>[0]) => {
    rules ??= routeRules(app);
    const route = matchedRoutes(c).findLast((one) => one.method === c.req.method);
    const key = route === undefined ? "" : `${route.method} ${route.path}`;
    return { rule: rules.access.get(key), keyAllowed: rules.keys.has(key) };
  };

  /** The workspace's access and the caller's role in it, or null when it is not theirs. */
  const membershipOf = async (actor: Actor, workspaceId: string) => {
    // A key has an agent's role in its own workspace, and does not exist anywhere else.
    if (actor.kind === "key") {
      return actor.workspaceId === workspaceId
        ? { access: actor.access, role: "agent" as const }
        : null;
    }
    const memberships = await operatorWorkspaces(db, actor.operatorId);
    return memberships.find((row) => row.workspaceId === workspaceId) ?? null;
  };

  const requireMember = createMiddleware<{
    Variables: { actor: Actor; memberWorkspaceId: string; memberRole: Role };
  }>(async (c, next) => {
    const workspaceId = c.req.param("workspaceId") ?? "";
    if (!z.uuid().safeParse(workspaceId).success) return c.json(NOT_FOUND, 404);
    const actor = c.get("actor");
    const membership = await membershipOf(actor, workspaceId);
    if (membership === null) return c.json(NOT_FOUND, 404);
    const { access } = membership;
    const { rule, keyAllowed } = routeOf(c);
    if (actor.kind === "key" && !keyAllowed) return c.json(FORBIDDEN, 403);
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
