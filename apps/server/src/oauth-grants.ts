import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { and, eq, exists, gt, inArray, isNull, sql } from "drizzle-orm";
import { type ApiKeyLevel, apiKey, apiKeyCredential, type CredentialKind } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace, workspaceAccess } from "./db/tenant.ts";
import { sha256Hex } from "./identity.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./time.ts";

// An OAuth grant is an `api_key` row with `source = 'oauth'`. Its codes and tokens are credentials,
// of which only the SHA-256 is stored. Every token names its workspace, as a static key does, so a
// lookup runs under that workspace's policy.

/** The prefixes of a static key, an authorization code, an access token and a refresh token. */
export const STATIC_KEY_PREFIX = "dk_";
const CODE_PREFIX = "dkc_";
export const ACCESS_PREFIX = "dko_";
const REFRESH_PREFIX = "dkr_";
const CODE_LIFETIME_MS = MINUTE_MS;
export const ACCESS_LIFETIME_MS = HOUR_MS;
export const REFRESH_LIFETIME_MS = 30 * DAY_MS;
/** A refresh token used again this soon after its rotation gets a new pair, not a revoke. */
const REFRESH_GRACE_SECONDS = 60;
/** The worker deletes a grant nobody used once it is this old. */
const UNUSED_GRANT_HOURS = 1;
const PRUNE_BATCH = 1000;

/** The workspace a token names and the hash it is stored by, or null for anything else. */
export function parseWorkspaceToken(
  token: string,
  prefix: string,
): { workspaceId: string; tokenHash: string } | null {
  if (!token.startsWith(prefix)) return null;
  const workspaceId = token.slice(prefix.length).split(".")[0] ?? "";
  if (!z.uuid().safeParse(workspaceId).success) return null;
  return { workspaceId, tokenHash: sha256Hex(token) };
}

export const newToken = (prefix: string, workspaceId: string) =>
  `${prefix}${workspaceId}.${randomBytes(32).toString("base64url")}`;

/** The scope a grant's tokens carry: a Setup grant also reaches what a Conversations one does. */
const scopeOf = (level: ApiKeyLevel) =>
  level === "setup" ? "conversations setup" : "conversations";

/** Ends keys or grants: each stays for the names on its replies, and its tokens are deleted. */
export async function revokeKeys(
  tx: Transaction,
  workspaceId: string,
  apiKeyIds: string[],
): Promise<void> {
  if (apiKeyIds.length === 0) return;
  await tx
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKey.workspaceId, workspaceId),
        inArray(apiKey.id, apiKeyIds),
        isNull(apiKey.revokedAt),
      ),
    );
  await tx
    .delete(apiKeyCredential)
    .where(
      and(
        eq(apiKeyCredential.workspaceId, workspaceId),
        inArray(apiKeyCredential.apiKeyId, apiKeyIds),
      ),
    );
}

/**
 * Whether the key in the query holds a credential that has not expired: one of `kinds`, or any,
 * a code included, without them.
 */
export const liveCredential = (tx: Transaction, kinds?: CredentialKind[]) =>
  exists(
    tx
      .select({ one: sql`1` })
      .from(apiKeyCredential)
      .where(
        and(
          eq(apiKeyCredential.workspaceId, apiKey.workspaceId),
          eq(apiKeyCredential.apiKeyId, apiKey.id),
          kinds === undefined ? undefined : inArray(apiKeyCredential.kind, kinds),
          gt(apiKeyCredential.expiresAt, sql`now()`),
        ),
      ),
  );

/** Ends every OAuth grant an operator approved in a workspace, as their removal or demotion does. */
export async function revokeGrantsOf(
  tx: Transaction,
  workspaceId: string,
  operatorId: string,
): Promise<void> {
  const grants = await tx
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(
      and(
        eq(apiKey.workspaceId, workspaceId),
        eq(apiKey.source, "oauth"),
        eq(apiKey.createdBy, operatorId),
        isNull(apiKey.revokedAt),
      ),
    );
  await revokeKeys(
    tx,
    workspaceId,
    grants.map((grant) => grant.id),
  );
}

interface CodeFacts {
  codeChallenge: string;
  redirectUri: string;
  resource: string;
}

/** Issues a grant's authorization code, which works once within a minute. */
export async function issueCode(
  tx: Transaction,
  workspaceId: string,
  apiKeyId: string,
  facts: CodeFacts,
): Promise<string> {
  const code = newToken(CODE_PREFIX, workspaceId);
  await tx.insert(apiKeyCredential).values({
    workspaceId,
    apiKeyId,
    kind: "code",
    tokenHash: sha256Hex(code),
    expiresAt: new Date(Date.now() + CODE_LIFETIME_MS),
    ...facts,
  });
  return code;
}

/** The token endpoint's answer for a grant (RFC 6749 section 5.1). */
interface TokenAnswer {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface LiveGrant {
  id: string;
  level: ApiKeyLevel;
  clientId: string | null;
}

async function issueTokens(
  tx: Transaction,
  workspaceId: string,
  grant: LiveGrant,
  familyId: string,
): Promise<TokenAnswer> {
  const access = newToken(ACCESS_PREFIX, workspaceId);
  const refresh = newToken(REFRESH_PREFIX, workspaceId);
  const now = Date.now();
  await tx.insert(apiKeyCredential).values([
    {
      workspaceId,
      apiKeyId: grant.id,
      kind: "access",
      tokenHash: sha256Hex(access),
      expiresAt: new Date(now + ACCESS_LIFETIME_MS),
    },
    {
      workspaceId,
      apiKeyId: grant.id,
      kind: "refresh",
      tokenHash: sha256Hex(refresh),
      expiresAt: new Date(now + REFRESH_LIFETIME_MS),
      familyId,
    },
  ]);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_LIFETIME_MS / 1000,
    refresh_token: refresh,
    scope: scopeOf(grant.level),
  };
}

/** The grant when it is not revoked and its workspace is not deleted. */
async function liveGrant(
  tx: Transaction,
  workspaceId: string,
  apiKeyId: string,
): Promise<LiveGrant | null> {
  const [grant] = await tx
    .select({ id: apiKey.id, level: apiKey.level, clientId: apiKey.clientId })
    .from(apiKey)
    .where(
      and(
        eq(apiKey.workspaceId, workspaceId),
        eq(apiKey.id, apiKeyId),
        eq(apiKey.source, "oauth"),
        isNull(apiKey.revokedAt),
      ),
    );
  if (grant === undefined) return null;
  return (await workspaceAccess(tx, workspaceId)) === "deleted" ? null : grant;
}

export type Exchange = { kind: "issued"; tokens: TokenAnswer } | { kind: "invalid_grant" };
const INVALID_GRANT: Exchange = { kind: "invalid_grant" };

/** PKCE S256: the challenge is the base64url SHA-256 of the verifier (RFC 7636). */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const pkceMatches = (verifier: string, challenge: string | null) =>
  challenge !== null &&
  VERIFIER.test(verifier) &&
  createHash("sha256").update(verifier).digest("base64url") === challenge;

interface CodeExchange {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  /** The normalized resource the request named, or null when it named none. */
  resource: string | null;
}

/**
 * Trades a code for tokens. One statement claims the code, so it works once. A code that was used
 * before is a replay, which revokes its grant. A failed check still uses the code up.
 */
export function redeemCode(db: Database, input: CodeExchange): Promise<Exchange> {
  const parsed = parseWorkspaceToken(input.code, CODE_PREFIX);
  if (parsed === null) return Promise.resolve(INVALID_GRANT);
  const { workspaceId, tokenHash } = parsed;
  return withWorkspace(db, workspaceId, async (tx) => {
    const [code] = await tx
      .update(apiKeyCredential)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(apiKeyCredential.workspaceId, workspaceId),
          eq(apiKeyCredential.tokenHash, tokenHash),
          eq(apiKeyCredential.kind, "code"),
          isNull(apiKeyCredential.usedAt),
          gt(apiKeyCredential.expiresAt, sql`now()`),
        ),
      )
      .returning({
        apiKeyId: apiKeyCredential.apiKeyId,
        codeChallenge: apiKeyCredential.codeChallenge,
        redirectUri: apiKeyCredential.redirectUri,
        resource: apiKeyCredential.resource,
      });
    if (code === undefined) {
      await revokeReplayedCode(tx, workspaceId, tokenHash);
      return INVALID_GRANT;
    }
    const grant = await liveGrant(tx, workspaceId, code.apiKeyId);
    const matches =
      grant !== null &&
      grant.clientId === input.clientId &&
      code.redirectUri === input.redirectUri &&
      (input.resource === null || input.resource === code.resource) &&
      pkceMatches(input.verifier, code.codeChallenge);
    if (grant === null || !matches) return INVALID_GRANT;
    return { kind: "issued", tokens: await issueTokens(tx, workspaceId, grant, randomUUID()) };
  });
}

/** A code that was used before: someone replays it, so the grant ends. */
async function revokeReplayedCode(
  tx: Transaction,
  workspaceId: string,
  tokenHash: string,
): Promise<void> {
  const [used] = await tx
    .select({ apiKeyId: apiKeyCredential.apiKeyId })
    .from(apiKeyCredential)
    .where(
      and(
        eq(apiKeyCredential.workspaceId, workspaceId),
        eq(apiKeyCredential.tokenHash, tokenHash),
        eq(apiKeyCredential.kind, "code"),
        sql`${apiKeyCredential.usedAt} is not null`,
      ),
    );
  if (used !== undefined) await revokeKeys(tx, workspaceId, [used.apiKeyId]);
}

/**
 * Trades a refresh token for a new pair, and uses it up. A token used again within 60 seconds of
 * its rotation gets another pair in the same family: two processes of one client that refresh at
 * once, or a lost answer that the client retries. Later, a second use is a replay and ends the grant.
 */
export function refreshGrant(
  db: Database,
  input: { refreshToken: string; clientId: string | null },
): Promise<Exchange> {
  const parsed = parseWorkspaceToken(input.refreshToken, REFRESH_PREFIX);
  if (parsed === null) return Promise.resolve(INVALID_GRANT);
  const { workspaceId, tokenHash } = parsed;
  return withWorkspace(db, workspaceId, async (tx) => {
    const found = await claimRefresh(tx, workspaceId, tokenHash);
    if (found === null) return INVALID_GRANT;
    if (found.kind === "replayed") {
      await revokeKeys(tx, workspaceId, [found.apiKeyId]);
      return INVALID_GRANT;
    }
    const grant = await liveGrant(tx, workspaceId, found.apiKeyId);
    if (grant === null || (input.clientId !== null && input.clientId !== grant.clientId)) {
      return INVALID_GRANT;
    }
    const familyId = found.familyId ?? randomUUID();
    return { kind: "issued", tokens: await issueTokens(tx, workspaceId, grant, familyId) };
  });
}

type RefreshClaim = {
  kind: "valid" | "replayed";
  apiKeyId: string;
  familyId: string | null;
};

/** Claims a refresh token, or finds it rotated within the grace period, or finds it replayed. */
async function claimRefresh(
  tx: Transaction,
  workspaceId: string,
  tokenHash: string,
): Promise<RefreshClaim | null> {
  const where = and(
    eq(apiKeyCredential.workspaceId, workspaceId),
    eq(apiKeyCredential.tokenHash, tokenHash),
    eq(apiKeyCredential.kind, "refresh"),
  );
  const [claimed] = await tx
    .update(apiKeyCredential)
    .set({ usedAt: sql`now()` })
    .where(and(where, isNull(apiKeyCredential.usedAt), gt(apiKeyCredential.expiresAt, sql`now()`)))
    .returning({ apiKeyId: apiKeyCredential.apiKeyId, familyId: apiKeyCredential.familyId });
  if (claimed !== undefined) return { kind: "valid", ...claimed };
  const [row] = await tx
    .select({
      apiKeyId: apiKeyCredential.apiKeyId,
      familyId: apiKeyCredential.familyId,
      used: sql<boolean>`${apiKeyCredential.usedAt} is not null`,
      inGrace: sql<boolean>`coalesce(${apiKeyCredential.usedAt} > now() - make_interval(secs => ${REFRESH_GRACE_SECONDS}) and ${apiKeyCredential.expiresAt} > now(), false)`,
    })
    .from(apiKeyCredential)
    .where(where);
  if (row === undefined || !row.used) return null;
  return {
    kind: row.inGrace ? "valid" : "replayed",
    apiKeyId: row.apiKeyId,
    familyId: row.familyId,
  };
}

/**
 * Revokes the grant that a token belongs to (RFC 7009). A client that names itself must be the
 * grant's. An unknown token changes nothing.
 */
export async function revokeByToken(
  db: Database,
  token: string,
  clientId: string | null,
): Promise<void> {
  const parsed =
    parseWorkspaceToken(token, ACCESS_PREFIX) ?? parseWorkspaceToken(token, REFRESH_PREFIX);
  if (parsed === null) return;
  const { workspaceId, tokenHash } = parsed;
  await withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({ apiKeyId: apiKey.id, clientId: apiKey.clientId })
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
        ),
      );
    if (row === undefined || (clientId !== null && clientId !== row.clientId)) return;
    await revokeKeys(tx, workspaceId, [row.apiKeyId]);
  });
}

/**
 * The worker's pass over every workspace: it deletes expired codes and tokens, then the grants that
 * nobody ever used and that hold no token any more, such as one approved and never redeemed. A
 * used refresh token stays until it expires, so a late replay still ends its grant.
 */
export async function pruneOAuth(db: Database): Promise<number> {
  let removed = 0;
  for (;;) {
    const credentials = await db.execute(sql`
      DELETE FROM api_key_credential
      WHERE (workspace_id, id) IN (
        SELECT workspace_id, id FROM api_key_credential
        WHERE expires_at < now()
        LIMIT ${PRUNE_BATCH})`);
    const grants = await db.execute(sql`
      DELETE FROM api_key
      WHERE (workspace_id, id) IN (
        SELECT k.workspace_id, k.id FROM api_key AS k
        WHERE k.source = 'oauth' AND k.last_used_at IS NULL
          AND k.created_at < now() - make_interval(hours => ${UNUSED_GRANT_HOURS})
          AND NOT EXISTS (
            SELECT 1 FROM api_key_credential AS c
            WHERE c.workspace_id = k.workspace_id AND c.api_key_id = k.id AND c.kind <> 'code'
          )
        LIMIT ${PRUNE_BATCH})`);
    const counts = [credentials.rowCount ?? 0, grants.rowCount ?? 0];
    removed += counts.reduce((sum, count) => sum + count, 0);
    if (counts.every((count) => count < PRUNE_BATCH)) return removed;
  }
}
