import { API_KEY_LEVELS, type ApiKeyLevel } from "./db/schema.ts";
import { isValidRedirectUri, type OAuthClient, redirectMatches } from "./oauth-client.ts";

/** The scopes a client may ask for: the two key levels. Never `offline_access`. */
export const SCOPES = API_KEY_LEVELS;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
];

/** The audience every token has: the MCP endpoint. Both resource values name it. */
export const mcpResource = (issuer: string) => `${issuer}/v1/mcp`;

/** The resource a request names, as stored on a code, or null when it is not this server. */
export function normalizeResource(value: string, issuer: string): string | null {
  const plain = value.endsWith("/") ? value.slice(0, -1) : value;
  return plain === mcpResource(issuer) || plain === issuer ? mcpResource(issuer) : null;
}

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  /** The known scopes the client asked for, in order. Unknown ones are dropped. */
  scopes: ApiKeyLevel[];
  /** The level the consent screen starts with: Setup when the client asked for it. */
  level: ApiKeyLevel;
  resource: string;
}

/**
 * What to do with an authorization request:
 * - `invalid`: the client or its redirect URI is not valid. The page shows an error and never
 *   redirects, because the redirect could go anywhere.
 * - `refused`: another parameter is not valid. The browser goes back to the client with the error.
 * - `valid`: the operator may approve it.
 */
export type AuthorizeResult =
  | { kind: "invalid"; error: "invalid_client" | "invalid_redirect_uri" }
  | { kind: "refused"; redirectTo: string }
  | { kind: "valid"; request: AuthorizeRequest };

/** The client's redirect URI with the answer's parameters and the issuer (RFC 9207). */
export function redirectWith(
  redirectUri: string,
  issuer: string,
  answer: Record<string, string | null>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(answer)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  url.searchParams.set("iss", issuer);
  return url.href;
}

/**
 * Checks an authorization request (OAuth 2.1 with PKCE), given the client its `client_id` names, or
 * null when it names none Dinghy knows. It reads nothing else, so the page's check and the approval
 * give the same answer.
 */
export function resolveAuthorizeRequest(
  params: URLSearchParams,
  client: OAuthClient | null,
  issuer: string,
): AuthorizeResult {
  if (client === null || params.getAll("client_id").length !== 1) {
    return { kind: "invalid", error: "invalid_client" };
  }
  const redirectUri = params.getAll("redirect_uri");
  const [uri] = redirectUri;
  if (
    uri === undefined ||
    redirectUri.length !== 1 ||
    !isValidRedirectUri(uri) ||
    !client.redirectUris.some((registered) => redirectMatches(registered, uri))
  ) {
    return { kind: "invalid", error: "invalid_redirect_uri" };
  }
  const state = params.get("state");
  const refuse = (error: string, description: string): AuthorizeResult => ({
    kind: "refused",
    redirectTo: redirectWith(uri, issuer, { error, error_description: description, state }),
  });
  if (AUTHORIZE_PARAMS.some((name) => params.getAll(name).length > 1)) {
    return refuse("invalid_request", "A parameter is repeated.");
  }
  if (params.get("response_type") !== "code") {
    return refuse("unsupported_response_type", "Only the code flow is supported.");
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !CODE_CHALLENGE.test(codeChallenge)) {
    return refuse("invalid_request", "PKCE with S256 is required.");
  }
  const asked = params.get("resource");
  const resource = asked === null ? mcpResource(issuer) : normalizeResource(asked, issuer);
  if (resource === null)
    return refuse("invalid_target", "This server serves only its MCP endpoint.");
  const words = (params.get("scope") ?? "").split(" ");
  const scopes = SCOPES.filter((scope) => words.includes(scope));
  return {
    kind: "valid",
    request: {
      client,
      redirectUri: uri,
      codeChallenge,
      state,
      scopes,
      level: scopes.includes("setup") ? "setup" : "conversations",
      resource,
    },
  };
}
