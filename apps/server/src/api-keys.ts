import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import { API_KEY_LEVELS, type ApiKeyLevel, apiKey, operator } from "./db/schema.ts";
import {
  type Database,
  type WorkspaceAccess,
  withWorkspace,
  workspaceAccess,
} from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  MEMBER_ERRORS,
  okContent,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { sha256Hex } from "./identity.ts";
import { OPEN_WHILE_CLOSED } from "./member.ts";
import { allowed } from "./team.ts";

const PREFIX = "/v1/operator/workspaces/{workspaceId}";
const TOKEN_PREFIX = "dk_";
/** Requests a minute for one API key, across every instance, the operator API and MCP together. */
export const KEY_REQUESTS_PER_MINUTE = 300;
/** A key's last use is noted to the minute, so a busy key does not write on every request. */
const LAST_USED_STEP_MS = 60_000;

/** Who makes a request: a signed-in operator, or a workspace API key. */
export type Actor =
  | { kind: "operator"; operatorId: string; name: string }
  | {
      kind: "key";
      apiKeyId: string;
      name: string;
      /** Conversations, or Setup, which also reaches the webhooks. */
      level: ApiKeyLevel;
      workspaceId: string;
      /** The workspace's access when the request came in. */
      access: WorkspaceAccess;
    };
export type KeyActor = Extract<Actor, { kind: "key" }>;

export const KEY_INVALID = failure("unauthorized", "This API key is not valid or was revoked.");

/** The token names its workspace, so a lookup runs under that workspace's policy. */
function parseToken(token: string): { workspaceId: string; tokenHash: string } | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const workspaceId = token.slice(TOKEN_PREFIX.length).split(".")[0] ?? "";
  if (!z.uuid().safeParse(workspaceId).success) return null;
  return { workspaceId, tokenHash: sha256Hex(token) };
}

/** The API key in an `Authorization: Bearer dk_...` header, or null for anything else. */
export function apiKeyToken(authorization: string | undefined): string | null {
  const token = authorization?.match(/^Bearer\s+(dk_\S+)$/i)?.[1];
  return token ?? null;
}

/** The key behind a token, or null when it is unknown, revoked, or its workspace is deleted. */
export async function authenticateApiKey(db: Database, token: string): Promise<KeyActor | null> {
  const parsed = parseToken(token);
  if (parsed === null) return null;
  const { workspaceId, tokenHash } = parsed;
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        id: apiKey.id,
        name: apiKey.name,
        level: apiKey.level,
        lastUsedAt: apiKey.lastUsedAt,
      })
      .from(apiKey)
      .where(
        and(
          eq(apiKey.workspaceId, workspaceId),
          eq(apiKey.tokenHash, tokenHash),
          isNull(apiKey.revokedAt),
        ),
      );
    if (row === undefined) return null;
    const access = await workspaceAccess(tx, workspaceId);
    if (access === "deleted") return null;
    if (row.lastUsedAt === null || Date.now() - row.lastUsedAt.getTime() > LAST_USED_STEP_MS) {
      const stale = new Date(Date.now() - LAST_USED_STEP_MS);
      await tx
        .update(apiKey)
        .set({ lastUsedAt: new Date() })
        .where(
          and(
            eq(apiKey.workspaceId, workspaceId),
            eq(apiKey.id, row.id),
            or(isNull(apiKey.lastUsedAt), lt(apiKey.lastUsedAt, stale)),
          ),
        );
    }
    return {
      kind: "key" as const,
      apiKeyId: row.id,
      name: row.name,
      level: row.level,
      workspaceId,
      access,
    };
  });
}

/** The key is still there and not revoked: a long upload checks this again before it commits. */
export async function keyStillValid(db: Database, actor: KeyActor): Promise<boolean> {
  const [row] = await withWorkspace(db, actor.workspaceId, (tx) =>
    tx
      .select({ id: apiKey.id })
      .from(apiKey)
      .where(
        and(
          eq(apiKey.workspaceId, actor.workspaceId),
          eq(apiKey.id, actor.apiKeyId),
          isNull(apiKey.revokedAt),
        ),
      ),
  );
  return row !== undefined;
}

const workspaceParams = z.object({ workspaceId: z.uuid() });
const ApiKey = z
  .object({
    id: z.string(),
    // The author name visitors and operators see on the key's replies.
    name: z.string(),
    // `conversations` reaches the conversations. `setup` reaches them and the webhooks.
    level: z.enum(API_KEY_LEVELS),
    createdByName: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi("ApiKey");

const KeyName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);

const denied = { ...MEMBER_ERRORS, 403: errorAnswer("forbidden: this role may not do this") };

const listRoute = createRoute({
  method: "get",
  path: `${PREFIX}/api-keys`,
  security: SESSION,
  summary: "List the workspace's API keys that are not revoked. Owners and admins only",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The keys, newest first",
      content: { "application/json": { schema: z.object({ apiKeys: z.array(ApiKey) }) } },
    },
    ...denied,
  },
});

const createKeyRoute = createRoute({
  method: "post",
  path: `${PREFIX}/api-keys`,
  security: SESSION,
  summary: "Create an API key. Its token is shown only in this response",
  request: {
    params: workspaceParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: KeyName,
            level: z.enum(API_KEY_LEVELS).default("conversations"),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The key, with its token",
      content: { "application/json": { schema: ApiKey.extend({ token: z.string() }) } },
    },
    ...ROLE_WRITE_ERRORS,
  },
});

const revokeRoute = createRoute({
  method: "delete",
  ...OPEN_WHILE_CLOSED,
  path: `${PREFIX}/api-keys/{keyId}`,
  security: SESSION,
  summary: "Revoke an API key. Its replies keep its name",
  request: { params: workspaceParams.extend({ keyId: z.uuid() }) },
  responses: { 200: { description: "Revoked", content: okContent }, ...ROLE_WRITE_ERRORS },
});

const iso = (value: Date | null) => value?.toISOString() ?? null;

export function registerApiKeyRoutes(app: App, db: Database, logger: Logger): void {
  app.openapi(listRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const rows = await withWorkspace(db, id, (tx) =>
      tx
        .select({
          id: apiKey.id,
          name: apiKey.name,
          level: apiKey.level,
          createdByName: operator.name,
          createdAt: apiKey.createdAt,
          lastUsedAt: apiKey.lastUsedAt,
        })
        .from(apiKey)
        .leftJoin(operator, eq(operator.id, apiKey.createdBy))
        .where(and(eq(apiKey.workspaceId, id), isNull(apiKey.revokedAt)))
        .orderBy(desc(apiKey.createdAt)),
    );
    return c.json(
      {
        apiKeys: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: iso(row.lastUsedAt),
        })),
      },
      200,
    );
  });

  app.openapi(createKeyRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const operatorId = c.get("operatorId");
    const { name, level } = c.req.valid("json");
    const token = `${TOKEN_PREFIX}${id}.${randomBytes(32).toString("base64url")}`;
    const [row] = await withWorkspace(db, id, (tx) =>
      tx
        .insert(apiKey)
        .values({
          workspaceId: id,
          name,
          level,
          tokenHash: sha256Hex(token),
          createdBy: operatorId,
        })
        .returning({ id: apiKey.id, createdAt: apiKey.createdAt }),
    );
    if (row === undefined) throw new Error("The key insert returned no row");
    audit(logger, "api_key.created", { workspaceId: id, operatorId, apiKeyId: row.id, level });
    return c.json(
      {
        id: row.id,
        name,
        level,
        createdByName: c.get("operatorName"),
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: null,
        token,
      },
      201,
    );
  });

  app.openapi(revokeRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { keyId } = c.req.valid("param");
    await withWorkspace(db, id, (tx) =>
      tx
        .update(apiKey)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKey.workspaceId, id), eq(apiKey.id, keyId), isNull(apiKey.revokedAt))),
    );
    audit(logger, "api_key.revoked", {
      workspaceId: id,
      operatorId: c.get("operatorId"),
      apiKeyId: keyId,
    });
    return c.json({ ok: true as const }, 200);
  });
}
