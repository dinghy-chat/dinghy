import { createRoute, z } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { KeyName } from "./api-keys.ts";
import type { App } from "./app.ts";
import type { Database } from "./db/tenant.ts";
import { mcpResource, normalizeResource, SCOPES } from "./oauth-authorize.ts";
import {
  createClients,
  DEFAULT_CLIENT_NAME,
  type FetchClientDocument,
  isValidRedirectUri,
  REDIRECT_URIS_MAX,
  signClientId,
} from "./oauth-client.ts";
import { registerOAuthConsent } from "./oauth-consent.ts";
import { type Exchange, redeemCode, refreshGrant, revokeByToken } from "./oauth-grants.ts";
import type { RateLimit } from "./rate-limit.ts";

// Dinghy is its own OAuth 2.1 authorization server for MCP clients (MCP authorization 2026-07-28).
// An approved grant is an API key, so everything that works for a key works for a grant.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The issuer: the public URL's origin, with no trailing slash. OAuth is on only on https or a
 * loopback address, because OAuth 2.1 forbids an http issuer anywhere else. Null when it is off.
 */
export function oauthIssuer(publicUrl: string): string | null {
  const url = new URL(publicUrl);
  const on = url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
  return on ? url.origin : null;
}

/** Where a client finds how to get a token for the MCP endpoint (RFC 9728). */
export const resourceMetadataUrl = (issuer: string) =>
  `${issuer}/.well-known/oauth-protected-resource/v1/mcp`;

const REGISTRATIONS_PER_HOUR = 10;
const TOKEN_REQUESTS_PER_MINUTE = 60;
const FORM_MAX_BYTES = 16 * 1024;
/** The longest client ID: a registered one holds its redirect URIs. */
const CLIENT_ID_MAX = 4096;

const OAuthError = z
  .object({ error: z.string(), error_description: z.string() })
  .openapi("OAuthError", {
    example: { error: "invalid_grant", error_description: "The code is not valid." },
  });
const oauthErrorAnswer = (description: string) => ({
  description,
  content: { "application/json": { schema: OAuthError } },
});
const LIMITED = { 429: oauthErrorAnswer("temporarily_unavailable: over the rate limit") };

const oauthError = (error: string, description: string) => ({
  error,
  error_description: description,
});

const ProtectedResource = z
  .object({
    resource: z.string(),
    authorization_servers: z.array(z.string()),
    scopes_supported: z.array(z.string()),
    bearer_methods_supported: z.array(z.string()),
    resource_name: z.string(),
  })
  .openapi("OAuthProtectedResource");

const protectedResourceRoute = (path: string) =>
  createRoute({
    method: "get",
    path,
    summary: "OAuth protected resource metadata for the MCP endpoint (RFC 9728)",
    responses: {
      200: {
        description: "The metadata",
        content: { "application/json": { schema: ProtectedResource } },
      },
    },
  });

const authorizationServerRoute = createRoute({
  method: "get",
  path: "/.well-known/oauth-authorization-server",
  summary: "OAuth authorization server metadata (RFC 8414)",
  responses: {
    200: {
      description: "The metadata",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()).openapi("OAuthAuthorizationServer"),
        },
      },
    },
  },
});

const registerRoute = createRoute({
  method: "post",
  path: "/v1/oauth/register",
  summary:
    "Register a public OAuth client (RFC 7591). Dinghy stores nothing: the client ID holds the name and redirect URIs, signed. 10 an hour per address",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            // 1 to 60 characters on one line. Without one, the client is "MCP client".
            client_name: z.string().max(200).optional(),
            // https, http on a loopback host, or a private-use scheme with a dot. No fragment.
            redirect_uris: z.array(z.string().max(2048)).min(1).max(REDIRECT_URIS_MAX),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The client, as registered",
      content: {
        "application/json": {
          schema: z.object({
            client_id: z.string(),
            client_id_issued_at: z.number().int(),
            client_name: z.string(),
            redirect_uris: z.array(z.string()),
            grant_types: z.array(z.string()),
            response_types: z.array(z.string()),
            token_endpoint_auth_method: z.literal("none"),
          }),
        },
      },
    },
    400: oauthErrorAnswer("invalid_client_metadata or invalid_redirect_uri"),
    ...LIMITED,
  },
});

const TokenForm = z.object({
  grant_type: z.string().max(64).describe("`authorization_code` or `refresh_token`"),
  code: z.string().max(256).optional(),
  code_verifier: z.string().max(256).optional(),
  redirect_uri: z.string().max(2048).optional(),
  client_id: z.string().max(CLIENT_ID_MAX).optional(),
  refresh_token: z.string().max(256).optional(),
  resource: z.string().max(2048).optional(),
  scope: z.string().max(256).optional(),
});

const tokenRoute = createRoute({
  method: "post",
  path: "/v1/oauth/token",
  summary:
    "Trade an authorization code with its PKCE verifier, or a refresh token, for an access token (1 hour) and a new refresh token (30 days). 60 a minute per address",
  request: {
    body: {
      required: true,
      content: { "application/x-www-form-urlencoded": { schema: TokenForm } },
    },
  },
  responses: {
    200: {
      description: "The tokens",
      content: {
        "application/json": {
          schema: z.object({
            access_token: z.string(),
            token_type: z.literal("Bearer"),
            expires_in: z.number().int(),
            refresh_token: z.string(),
            scope: z.string(),
          }),
        },
      },
    },
    400: oauthErrorAnswer(
      "invalid_request, invalid_grant, unsupported_grant_type or invalid_target",
    ),
    ...LIMITED,
  },
});

const revokeRoute = createRoute({
  method: "post",
  path: "/v1/oauth/revoke",
  summary:
    "Revoke the grant of an access or refresh token (RFC 7009). An unknown token also answers 200",
  request: {
    body: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: z.object({
            token: z.string().max(256),
            token_type_hint: z.string().max(64).optional(),
            client_id: z.string().max(CLIENT_ID_MAX).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Revoked, or the token was not known" },
    400: oauthErrorAnswer("invalid_request"),
    ...LIMITED,
  },
});

interface OAuthOptions {
  db: Database;
  logger: Logger;
  rateLimit: RateLimit;
  valkey: Redis | null;
  /** Signs registered client IDs. */
  secret: string;
  issuer: string;
  fetchDocument: FetchClientDocument;
}

export function registerOAuth(app: App, options: OAuthOptions): void {
  registerDiscovery(app, options.issuer);
  registerClientRegistration(app, options);
  registerTokenRoutes(app, options);
  registerOAuthConsent(app, {
    db: options.db,
    logger: options.logger,
    rateLimit: options.rateLimit,
    issuer: options.issuer,
    findClient: createClients(options),
  });
}

function registerDiscovery(app: App, issuer: string): void {
  const resource = {
    resource: mcpResource(issuer),
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Dinghy",
  };
  // Clients look at the path of the MCP endpoint first, then at the root.
  for (const path of [
    "/.well-known/oauth-protected-resource/v1/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    app.openapi(protectedResourceRoute(path), (c) => c.json(resource, 200));
  }
  // `offline_access` is not listed: a client that sees it asks for it, and a refresh token always
  // comes anyway.
  const server = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/v1/oauth/token`,
    registration_endpoint: `${issuer}/v1/oauth/register`,
    revocation_endpoint: `${issuer}/v1/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
  app.openapi(authorizationServerRoute, (c) => c.json(server, 200));
}

/** A rate limit per client address that answers in OAuth's shape. */
const limitByAddress =
  (rateLimit: RateLimit, name: string, max: number, windowSeconds: number) =>
  async (c: Context, next: Next) => {
    const wait = await rateLimit.hit(name, c.get("clientIp"), max, windowSeconds);
    if (wait === null) return next();
    c.header("retry-after", String(wait));
    return c.json(
      oauthError("temporarily_unavailable", "Too many requests. Try again later."),
      429,
    );
  };

function registerClientRegistration(app: App, { rateLimit, secret }: OAuthOptions): void {
  app.use(
    "/v1/oauth/register",
    bodyLimit({ maxSize: FORM_MAX_BYTES }),
    limitByAddress(rateLimit, "oauth-register", REGISTRATIONS_PER_HOUR, 60 * 60),
  );
  app.openapi(
    registerRoute,
    (c) => {
      const body = c.req.valid("json");
      const name = KeyName.safeParse(body.client_name?.trim() || DEFAULT_CLIENT_NAME);
      if (!name.success) {
        return c.json(
          oauthError(
            "invalid_client_metadata",
            "client_name must be 1 to 60 characters on one line.",
          ),
          400,
        );
      }
      if (!body.redirect_uris.every(isValidRedirectUri)) {
        return c.json(
          oauthError(
            "invalid_redirect_uri",
            "Use https, http on 127.0.0.1, [::1] or localhost, or a private-use scheme with a dot, with no fragment.",
          ),
          400,
        );
      }
      return c.json(
        {
          client_id: signClientId(secret, name.data, body.redirect_uris),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: name.data,
          redirect_uris: body.redirect_uris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none" as const,
        },
        201,
      );
    },
    (result, c) => {
      if (!result.success) {
        return c.json(
          oauthError("invalid_client_metadata", "Send redirect_uris: 1 to 5 addresses."),
          400,
        );
      }
    },
  );
}

/** A form that does not parse, in OAuth's shape. */
const invalidForm = (result: { success: boolean }, c: Context) => {
  if (result.success) return;
  c.header("cache-control", "no-store");
  return c.json(oauthError("invalid_request", "The request is not valid."), 400);
};

type TokenRequest = z.infer<typeof TokenForm>;

/** Runs the grant a token request names, or says what it lacks. */
function exchange(
  db: Database,
  form: TokenRequest,
  resource: string | null,
): Promise<Exchange> | "missing" | "unsupported" {
  if (form.grant_type === "authorization_code") {
    const { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri } = form;
    if (code === undefined || verifier === undefined) return "missing";
    if (clientId === undefined || redirectUri === undefined) return "missing";
    return redeemCode(db, { code, verifier, clientId, redirectUri, resource });
  }
  if (form.grant_type === "refresh_token") {
    if (form.refresh_token === undefined) return "missing";
    return refreshGrant(db, { refreshToken: form.refresh_token, clientId: form.client_id ?? null });
  }
  return "unsupported";
}

/** The token and revoke endpoints take a form body only (RFC 6749 section 3.2). */
const requireForm = async (c: Context, next: Next) => {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded") return next();
  c.header("cache-control", "no-store");
  return c.json(
    oauthError("invalid_request", "Send an application/x-www-form-urlencoded body."),
    400,
  );
};

function registerTokenRoutes(app: App, { db, rateLimit, issuer }: OAuthOptions): void {
  for (const [path, name] of [
    ["/v1/oauth/token", "oauth-token"],
    ["/v1/oauth/revoke", "oauth-revoke"],
  ] as const) {
    app.use(
      path,
      bodyLimit({ maxSize: FORM_MAX_BYTES }),
      limitByAddress(rateLimit, name, TOKEN_REQUESTS_PER_MINUTE, 60),
      requireForm,
    );
  }

  app.openapi(
    tokenRoute,
    async (c) => {
      // Tokens must never sit in a cache (RFC 6749 section 5.1).
      c.header("cache-control", "no-store");
      c.header("pragma", "no-cache");
      const form = c.req.valid("form");
      const resource =
        form.resource === undefined ? null : normalizeResource(form.resource, issuer);
      if (resource === null && form.resource !== undefined) {
        return c.json(
          oauthError("invalid_target", "This server serves only its MCP endpoint."),
          400,
        );
      }
      const result = exchange(db, form, resource);
      if (result === "unsupported") {
        return c.json(
          oauthError("unsupported_grant_type", "Use authorization_code or refresh_token."),
          400,
        );
      }
      if (result === "missing") {
        return c.json(oauthError("invalid_request", "A required parameter is missing."), 400);
      }
      const done = await result;
      if (done.kind === "invalid_grant") {
        return c.json(
          oauthError("invalid_grant", "The code or refresh token is not valid, or was used."),
          400,
        );
      }
      return c.json(done.tokens, 200);
    },
    invalidForm,
  );

  app.openapi(
    revokeRoute,
    async (c) => {
      const { token, client_id: clientId } = c.req.valid("form");
      await revokeByToken(db, token, clientId ?? null);
      return c.body(null, 200);
    },
    invalidForm,
  );
}
