import { createRoute, z } from "@hono/zod-openapi";
import { and, count, eq, isNull, not, notInArray } from "drizzle-orm";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import {
  API_KEY_LEVELS,
  type ApiKeyLevel,
  apiKey,
  REPLY_MODES,
  type ReplyMode,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import {
  type Database,
  lockWrites,
  operatorWorkspaces,
  type Transaction,
  withWorkspace,
  writable,
} from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  OPERATOR_ERRORS,
  OPERATOR_WRITE_ERRORS,
  RATE_LIMITED,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { WORKSPACE_PREFIX } from "./member.ts";
import {
  type AuthorizeRequest,
  type AuthorizeResult,
  redirectWith,
  resolveAuthorizeRequest,
} from "./oauth-authorize.ts";
import { type FindClient, metadataOrigin, redirectHost } from "./oauth-client.ts";
import { issueCode, liveCredential, revokeKeys } from "./oauth-grants.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { allowed } from "./team.ts";
import { MINUTE_SECONDS } from "./time.ts";

// The consent page's API. The page at /oauth/authorize sends its own query string here, so the
// server checks every parameter again on each step and trusts nothing the page kept.

/** A workspace keeps at most this many live grants, which bounds what a stolen session can add. */
export const GRANT_LIMIT = 50;
const APPROVALS_PER_MINUTE = 20;
/** Room for the longest client ID and redirect URI Dinghy accepts, percent-encoded, and the rest. */
const REQUEST_MAX_LENGTH = 16 * 1024;

const INVALID_CLIENT = failure(
  "invalid_client",
  "This app is not registered, or its client ID is not valid.",
);
const INVALID_REDIRECT = failure(
  "invalid_redirect_uri",
  "This app asked to return to an address it did not register.",
);
const INVALID_REQUEST = failure("invalid_request", "This sign-in request is not valid.");
const GRANT_LIMIT_REACHED = failure(
  "grant_limit",
  `A workspace can connect ${GRANT_LIMIT} apps. Disconnect one in Settings first.`,
);

const AuthorizeRequestText = z
  .string()
  .min(1)
  .max(REQUEST_MAX_LENGTH)
  .describe("The query string of the /oauth/authorize page, as the client sent it");

const Client = z.object({
  // What the app calls itself. Nothing verifies it.
  name: z.string(),
  // `cimd`: the host of its metadata URL, which published it. `dcr`: the host or scheme it returns to.
  host: z.string(),
  // `dcr`: registered with /v1/oauth/register. `cimd`: a client ID metadata document.
  kind: z.enum(["dcr", "cimd"]),
  // It returns to this computer, by a loopback address or its own scheme: its host names nobody.
  local: z.boolean(),
  // Always false: Dinghy has no list of verified apps.
  verified: z.literal(false),
});

const infoRoute = createRoute({
  method: "get",
  path: "/v1/operator/oauth/authorize-info",
  security: SESSION,
  summary:
    "Check an OAuth authorization request for the consent page: who asks, which access, and the workspaces this operator may connect it to",
  request: {
    query: z.object({
      response_type: z.string().optional(),
      client_id: z.string().optional(),
      redirect_uri: z.string().optional(),
      code_challenge: z.string().optional(),
      code_challenge_method: z.string().optional(),
      state: z.string().optional(),
      scope: z.string().optional(),
      resource: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description:
        "`consent`: show the screen. `redirect`: a parameter is not valid, so send the browser back to the app with the error",
      content: {
        "application/json": {
          schema: z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("consent"),
              client: Client,
              // The known scopes asked for. Unknown ones, such as offline_access, are dropped.
              scopes: z.array(z.enum(API_KEY_LEVELS)),
              // The level to preselect.
              level: z.enum(API_KEY_LEVELS),
              // Where this operator is an owner or admin.
              workspaces: z.array(z.object({ id: z.string(), name: z.string() })),
            }),
            z.object({ kind: z.literal("redirect"), redirectTo: z.string() }),
          ]),
        },
      },
    },
    400: errorAnswer(
      "invalid_client or invalid_redirect_uri: show an error. Never send the browser to the app",
    ),
    ...OPERATOR_ERRORS,
    ...RATE_LIMITED,
  },
});

const redirectAnswer = {
  description: "Where to send the browser",
  content: { "application/json": { schema: z.object({ redirectTo: z.string() }) } },
};

const grantRoute = createRoute({
  method: "post",
  path: `${WORKSPACE_PREFIX}/{workspaceId}/oauth/grants`,
  security: SESSION,
  summary:
    "Approve an OAuth client for this workspace. Owners and admins only. It replaces the operator's earlier grant to the same client, and answers the redirect with the code",
  request: {
    params: z.object({ workspaceId: z.uuid() }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            request: AuthorizeRequestText,
            level: z.enum(API_KEY_LEVELS),
            replyMode: z.enum(REPLY_MODES).default("draft"),
          }),
        },
      },
    },
  },
  responses: {
    201: redirectAnswer,
    ...ROLE_WRITE_ERRORS,
    400: errorAnswer("invalid_client, invalid_redirect_uri or invalid_request"),
    409: errorAnswer(`grant_limit: the workspace already has ${GRANT_LIMIT} connected apps`),
    ...RATE_LIMITED,
  },
});

const denyRoute = createRoute({
  method: "post",
  path: "/v1/operator/oauth/deny",
  security: SESSION,
  summary: "Cancel an OAuth authorization request: the app gets access_denied",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ request: AuthorizeRequestText }) } },
    },
  },
  responses: {
    200: redirectAnswer,
    ...OPERATOR_WRITE_ERRORS,
    400: errorAnswer("invalid_client or invalid_redirect_uri: there is nowhere safe to return"),
    ...RATE_LIMITED,
  },
});

interface ConsentOptions {
  db: Database;
  logger: Logger;
  rateLimit: RateLimit;
  issuer: string;
  findClient: FindClient;
}

type Approval =
  | { kind: "approved"; apiKeyId: string; code: string }
  | { kind: "forbidden" }
  | { kind: "limit" };

/** The app as the consent page shows it: its name, and who published it or where it returns. */
function clientView(request: AuthorizeRequest): z.infer<typeof Client> {
  const { client } = request;
  const origin =
    client.kind === "cimd"
      ? metadataOrigin(client.id)
      : { kind: client.kind, ...redirectHost(request.redirectUri) };
  return { name: client.name, verified: false, ...origin };
}

/** The workspaces where the operator may approve a grant, with their names. */
async function approvableWorkspaces(db: Database, operatorId: string) {
  const memberships = (await operatorWorkspaces(db, operatorId)).filter(
    (one) => allowed.settings(one.role) && writable(one.access),
  );
  return Promise.all(
    memberships.map(async ({ workspaceId }) => {
      const [row] = await withWorkspace(db, workspaceId, (tx) =>
        tx.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId)),
      );
      return { id: workspaceId, name: row?.name ?? "" };
    }),
  );
}

/**
 * The grants that hold a token that has not expired, a code, an access or a refresh token, leaving
 * out the ones this approval replaces.
 */
async function liveGrantCount(
  tx: Transaction,
  workspaceId: string,
  replaced: string[],
): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(apiKey)
    .where(
      and(
        eq(apiKey.workspaceId, workspaceId),
        eq(apiKey.source, "oauth"),
        isNull(apiKey.revokedAt),
        notInArray(apiKey.id, replaced),
        liveCredential(tx),
      ),
    );
  return row?.total ?? 0;
}

/**
 * The operator's grants for this client that no longer work, which a new approval replaces. The same
 * app on a second computer keeps the first one's grant.
 */
async function replaceableGrants(
  tx: Transaction,
  workspaceId: string,
  operatorId: string,
  clientId: string,
): Promise<string[]> {
  const older = await tx
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(
      and(
        eq(apiKey.workspaceId, workspaceId),
        eq(apiKey.clientId, clientId),
        eq(apiKey.createdBy, operatorId),
        isNull(apiKey.revokedAt),
        not(liveCredential(tx, ["access", "refresh"])),
      ),
    );
  return older.map((grant) => grant.id);
}

/**
 * Makes the grant and its code. The approver's member row is locked while this reads their role,
 * as an invite does: a removal or demotion then either waits and revokes this grant, or goes first
 * and this one is refused.
 */
async function approve(
  tx: Transaction,
  workspaceId: string,
  operatorId: string,
  request: AuthorizeRequest,
  choice: { level: ApiKeyLevel; replyMode: ReplyMode },
): Promise<Approval> {
  const [approver] = await tx
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.operatorId, operatorId),
        isNull(workspaceMember.removedAt),
      ),
    )
    .for("no key update");
  if (approver === undefined || !allowed.settings(approver.role)) return { kind: "forbidden" };
  // Two approvals at once take turns, so neither passes the limit.
  await lockWrites(tx, "oauth-grants", workspaceId);
  const replaced = await replaceableGrants(tx, workspaceId, operatorId, request.client.id);
  if ((await liveGrantCount(tx, workspaceId, replaced)) >= GRANT_LIMIT) return { kind: "limit" };
  await revokeKeys(tx, workspaceId, replaced);
  const [grant] = await tx
    .insert(apiKey)
    .values({
      workspaceId,
      name: request.client.name,
      source: "oauth",
      clientId: request.client.id,
      createdBy: operatorId,
      ...choice,
    })
    .returning({ id: apiKey.id });
  if (grant === undefined) throw new Error("The grant insert returned no row");
  const code = await issueCode(tx, workspaceId, grant.id, {
    codeChallenge: request.codeChallenge,
    redirectUri: request.redirectUri,
    resource: request.resource,
  });
  return { kind: "approved", apiKeyId: grant.id, code };
}

export function registerOAuthConsent(
  app: App,
  { db, logger, rateLimit, issuer, findClient }: ConsentOptions,
): void {
  /** Reads the request as the page got it, with its client, which may need a fetch. */
  const resolve = async (
    raw: string,
    operatorId: string,
  ): Promise<AuthorizeResult | { kind: "limited"; waitSeconds: number }> => {
    const params = new URLSearchParams(raw);
    const clientId = params.get("client_id");
    const client = clientId === null ? null : await findClient(clientId, operatorId);
    if (client !== null && "waitSeconds" in client) return { kind: "limited", ...client };
    return resolveAuthorizeRequest(params, client, issuer);
  };
  const invalidAnswer = (error: "invalid_client" | "invalid_redirect_uri") =>
    error === "invalid_client" ? INVALID_CLIENT : INVALID_REDIRECT;

  app.openapi(infoRoute, async (c) => {
    const operatorId = c.get("operatorId");
    const resolved = await resolve(new URL(c.req.url).search, operatorId);
    if (resolved.kind === "limited") return tooManyRequests(c, resolved.waitSeconds);
    if (resolved.kind === "invalid") return c.json(invalidAnswer(resolved.error), 400);
    if (resolved.kind === "refused") {
      return c.json({ kind: "redirect" as const, redirectTo: resolved.redirectTo }, 200);
    }
    const { request } = resolved;
    return c.json(
      {
        kind: "consent" as const,
        client: clientView(request),
        scopes: request.scopes,
        level: request.level,
        workspaces: await approvableWorkspaces(db, operatorId),
      },
      200,
    );
  });

  app.openapi(grantRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const operatorId = c.get("operatorId");
    const workspaceId = c.get("memberWorkspaceId");
    const wait = await rateLimit.hit(
      "oauth-approve",
      operatorId,
      APPROVALS_PER_MINUTE,
      MINUTE_SECONDS,
    );
    if (wait !== null) return tooManyRequests(c, wait);
    const body = c.req.valid("json");
    const resolved = await resolve(body.request, operatorId);
    if (resolved.kind === "limited") return tooManyRequests(c, resolved.waitSeconds);
    if (resolved.kind === "invalid") return c.json(invalidAnswer(resolved.error), 400);
    if (resolved.kind === "refused") return c.json(INVALID_REQUEST, 400);
    const { request } = resolved;
    const choice = { level: body.level, replyMode: body.replyMode };
    const approval = await withWorkspace(db, workspaceId, (tx) =>
      approve(tx, workspaceId, operatorId, request, choice),
    );
    if (approval.kind === "forbidden") return c.json(FORBIDDEN, 403);
    if (approval.kind === "limit") return c.json(GRANT_LIMIT_REACHED, 409);
    audit(logger, "api_key.created", {
      workspaceId,
      operatorId,
      apiKeyId: approval.apiKeyId,
      level: body.level,
      source: "oauth",
    });
    const answer = { code: approval.code, state: request.state };
    return c.json({ redirectTo: redirectWith(request.redirectUri, issuer, answer) }, 201);
  });

  app.openapi(denyRoute, async (c) => {
    const resolved = await resolve(c.req.valid("json").request, c.get("operatorId"));
    if (resolved.kind === "limited") return tooManyRequests(c, resolved.waitSeconds);
    if (resolved.kind === "invalid") return c.json(invalidAnswer(resolved.error), 400);
    if (resolved.kind === "refused") return c.json({ redirectTo: resolved.redirectTo }, 200);
    const { request } = resolved;
    const answer = { error: "access_denied", state: request.state };
    return c.json({ redirectTo: redirectWith(request.redirectUri, issuer, answer) }, 200);
  });
}
