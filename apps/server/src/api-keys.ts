import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, exists, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { audit } from "./audit.ts";
import {
  API_KEY_LEVELS,
  API_KEY_SOURCES,
  type ApiKeyLevel,
  apiKey,
  apiKeyCredential,
  operator,
  REPLY_MODES,
} from "./db/schema.ts";
import {
  type Database,
  type Transaction,
  type WorkspaceAccess,
  withWorkspace,
  workspaceAccess,
} from "./db/tenant.ts";
import {
  errorAnswer,
  FORBIDDEN,
  failure,
  MEMBER_ERRORS,
  NOT_FOUND,
  okContent,
  ROLE_WRITE_ERRORS,
} from "./errors.ts";
import { sha256Hex } from "./identity.ts";
import { OPEN_WHILE_CLOSED } from "./member.ts";
import { clientHost } from "./oauth-client.ts";
import {
  ACCESS_PREFIX,
  newToken,
  parseWorkspaceToken,
  revokeKey,
  STATIC_KEY_PREFIX,
} from "./oauth-grants.ts";
import { allowed } from "./team.ts";
import { MINUTE_MS } from "./time.ts";

const PREFIX = "/v1/operator/workspaces/{workspaceId}";
/** Requests a minute for one API key, across every instance, the operator API and MCP together. */
export const KEY_REQUESTS_PER_MINUTE = 300;
/** A key's last use is noted to the minute, so a busy key does not write on every request. */
const LAST_USED_STEP_MS = MINUTE_MS;

/** Who makes a request: a signed-in operator, or a workspace API key or OAuth grant. */
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

/**
 * The bearer token in an `Authorization` header: a static key, `dk_...`, or an OAuth access token,
 * `dko_...`. Null for anything else, such as a refresh token or a code, which never work as one.
 */
export function apiKeyToken(authorization: string | undefined): string | null {
  const token = authorization?.match(/^Bearer\s+((?:dk_|dko_)\S+)$/i)?.[1];
  return token ?? null;
}

const keyColumns = {
  id: apiKey.id,
  name: apiKey.name,
  level: apiKey.level,
  lastUsedAt: apiKey.lastUsedAt,
};

/** A static key by its hash, or an OAuth grant by a live access token's hash. */
async function findKey(tx: Transaction, workspaceId: string, token: string) {
  const tokenHash = sha256Hex(token);
  if (token.startsWith(STATIC_KEY_PREFIX)) {
    const [row] = await tx
      .select(keyColumns)
      .from(apiKey)
      .where(
        and(
          eq(apiKey.workspaceId, workspaceId),
          eq(apiKey.tokenHash, tokenHash),
          isNull(apiKey.revokedAt),
        ),
      );
    return row;
  }
  const [row] = await tx
    .select(keyColumns)
    .from(apiKeyCredential)
    .innerJoin(
      apiKey,
      and(
        eq(apiKey.workspaceId, apiKeyCredential.workspaceId),
        eq(apiKey.id, apiKeyCredential.apiKeyId),
      ),
    )
    .where(
      and(
        eq(apiKeyCredential.workspaceId, workspaceId),
        eq(apiKeyCredential.tokenHash, tokenHash),
        eq(apiKeyCredential.kind, "access"),
        gt(apiKeyCredential.expiresAt, sql`now()`),
        isNull(apiKey.revokedAt),
      ),
    );
  return row;
}

/** The key behind a token, or null when it is unknown, expired, revoked, or its workspace is deleted. */
export async function authenticateApiKey(db: Database, token: string): Promise<KeyActor | null> {
  const parsed =
    parseWorkspaceToken(token, STATIC_KEY_PREFIX) ?? parseWorkspaceToken(token, ACCESS_PREFIX);
  if (parsed === null) return null;
  const { workspaceId } = parsed;
  return withWorkspace(db, workspaceId, async (tx) => {
    const row = await findKey(tx, workspaceId, token);
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
const keyParams = workspaceParams.extend({ keyId: z.uuid() });
const ApiKey = z
  .object({
    id: z.string(),
    // The author name visitors and operators see on the key's replies.
    name: z.string(),
    // `conversations` reaches the conversations. `setup` reaches them and the webhooks.
    level: z.enum(API_KEY_LEVELS),
    // `static`, a key made in Settings, or `oauth`, an app that an owner or admin connected.
    source: z.enum(API_KEY_SOURCES),
    // `send` replies go to the visitor. `draft` replies wait for an operator.
    replyMode: z.enum(REPLY_MODES),
    // A connected app's host, from its client ID. Null for a static key.
    clientHost: z.string().nullable(),
    // Who made the key or approved the app.
    createdByName: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi("ApiKey");

export const KeyName = z
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
  summary:
    "List the workspace's API keys and connected apps that are not revoked. Owners and admins only",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The keys and connected apps, newest first",
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
            replyMode: z.enum(REPLY_MODES).default("draft"),
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

const updateKeyRoute = createRoute({
  method: "patch",
  path: `${PREFIX}/api-keys/{keyId}`,
  security: SESSION,
  summary: "Change an API key's or a connected app's name, reply mode or level",
  request: {
    params: keyParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              name: KeyName.optional(),
              replyMode: z.enum(REPLY_MODES).optional(),
              level: z.enum(API_KEY_LEVELS).optional(),
            })
            .refine((change) => Object.values(change).some((value) => value !== undefined), {
              message: "Change at least one field",
            }),
        },
      },
    },
  },
  responses: {
    200: { description: "The key as changed", content: { "application/json": { schema: ApiKey } } },
    ...ROLE_WRITE_ERRORS,
  },
});

const revokeRoute = createRoute({
  method: "delete",
  ...OPEN_WHILE_CLOSED,
  path: `${PREFIX}/api-keys/{keyId}`,
  security: SESSION,
  summary: "Revoke an API key or disconnect an app. Its replies keep its name",
  request: { params: keyParams },
  responses: { 200: { description: "Revoked", content: okContent }, ...ROLE_WRITE_ERRORS },
});

const iso = (value: Date | null) => value?.toISOString() ?? null;

/**
 * Settings lists a grant while its app can use it: one never redeemed holds only a code, and one
 * whose tokens all expired is gone for its app.
 */
const redeemed = (tx: Transaction) =>
  or(
    eq(apiKey.source, "static"),
    exists(
      tx
        .select({ one: sql`1` })
        .from(apiKeyCredential)
        .where(
          and(
            eq(apiKeyCredential.workspaceId, apiKey.workspaceId),
            eq(apiKeyCredential.apiKeyId, apiKey.id),
            inArray(apiKeyCredential.kind, ["access", "refresh"]),
            gt(apiKeyCredential.expiresAt, sql`now()`),
          ),
        ),
    ),
  );

/** The live keys of a workspace as Settings shows them, or one of them. */
async function readKeys(tx: Transaction, workspaceId: string, keyId?: string) {
  const rows = await tx
    .select({
      id: apiKey.id,
      name: apiKey.name,
      level: apiKey.level,
      source: apiKey.source,
      replyMode: apiKey.replyMode,
      clientId: apiKey.clientId,
      createdByName: operator.name,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt,
    })
    .from(apiKey)
    .leftJoin(operator, eq(operator.id, apiKey.createdBy))
    .where(
      and(
        eq(apiKey.workspaceId, workspaceId),
        isNull(apiKey.revokedAt),
        keyId === undefined ? redeemed(tx) : eq(apiKey.id, keyId),
      ),
    )
    .orderBy(desc(apiKey.createdAt));
  return rows.map(({ clientId, ...row }) => ({
    ...row,
    clientHost: clientId === null ? null : clientHost(clientId),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
  }));
}

export function registerApiKeyRoutes(app: App, db: Database, logger: Logger): void {
  app.openapi(listRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    return c.json({ apiKeys: await withWorkspace(db, id, (tx) => readKeys(tx, id)) }, 200);
  });

  app.openapi(createKeyRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const operatorId = c.get("operatorId");
    const { name, level, replyMode } = c.req.valid("json");
    const token = newToken(STATIC_KEY_PREFIX, id);
    const [row] = await withWorkspace(db, id, (tx) =>
      tx
        .insert(apiKey)
        .values({
          workspaceId: id,
          name,
          level,
          replyMode,
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
        source: "static" as const,
        replyMode,
        clientHost: null,
        createdByName: c.get("operatorName"),
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: null,
        token,
      },
      201,
    );
  });

  app.openapi(updateKeyRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { keyId } = c.req.valid("param");
    const change = c.req.valid("json");
    const [changed] = await withWorkspace(db, id, async (tx) => {
      const updated = await tx
        .update(apiKey)
        .set(change)
        .where(and(eq(apiKey.workspaceId, id), eq(apiKey.id, keyId), isNull(apiKey.revokedAt)))
        .returning({ id: apiKey.id });
      return updated.length === 0 ? [] : readKeys(tx, id, keyId);
    });
    if (changed === undefined) return c.json(NOT_FOUND, 404);
    audit(logger, "api_key.updated", {
      workspaceId: id,
      operatorId: c.get("operatorId"),
      apiKeyId: keyId,
      level: change.level,
      replyMode: change.replyMode,
    });
    return c.json(changed, 200);
  });

  app.openapi(revokeRoute, async (c) => {
    if (!allowed.settings(c.get("memberRole"))) return c.json(FORBIDDEN, 403);
    const id = c.get("memberWorkspaceId");
    const { keyId } = c.req.valid("param");
    await withWorkspace(db, id, (tx) => revokeKey(tx, id, keyId));
    audit(logger, "api_key.revoked", {
      workspaceId: id,
      operatorId: c.get("operatorId"),
      apiKeyId: keyId,
    });
    return c.json({ ok: true as const }, 200);
  });
}
