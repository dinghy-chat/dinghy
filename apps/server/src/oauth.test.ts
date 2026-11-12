import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, fromSocket, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import { apiKey, apiKeyCredential, workspace, workspaceMember } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { oauthIssuer } from "./oauth.ts";
import { resolveAuthorizeRequest } from "./oauth-authorize.ts";
import {
  fetchClientDocument,
  isValidRedirectUri,
  type OAuthClient,
  redirectMatches,
} from "./oauth-client.ts";
import { GRANT_LIMIT } from "./oauth-consent.ts";
import { pruneOAuth } from "./oauth-grants.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const MCP_URL = `${ORIGIN}/v1/mcp`;
const SITE = "https://app.example.com";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const CALLBACK = "http://localhost/callback";
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
let a: NewWorkspace;
let b: NewWorkspace;
let boss: { id: string; cookie: string };
let admin: { id: string; cookie: string };
let agent: { id: string; cookie: string };

/** Metadata documents the fake fetch serves, and the URLs it was asked for. */
const documents = new Map<string, unknown>();
const fetched: string[] = [];
const fetchDocument = async (url: string) => {
  fetched.push(url);
  return documents.get(url) ?? null;
};

const inWorkspace = (id: string, path = "") => `/v1/operator/workspaces/${id}${path}`;

const asOperator = (cookie: string, method: string, path: string, body?: unknown, server = app) =>
  server.request(path, {
    method,
    headers: {
      cookie,
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const withToken = (token: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(body: unknown, server = app, address = "192.0.2.1") {
  return server.request(
    "/v1/oauth/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    fromSocket(address),
  );
}

/**
 * A registered client. Its ID is its signed name and redirect URIs, so each test client gets its
 * own name: the same name and URIs are the same client, whose new approval replaces the old grant.
 */
async function registered(redirectUris = [CALLBACK], name = `Client ${randomUUID().slice(0, 8)}`) {
  const response = await register({ client_name: name, redirect_uris: redirectUris });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

interface Authorize {
  clientId: string;
  redirectUri?: string;
  challenge: string;
  state?: string;
  scope?: string;
  resource?: string;
}

const authorizeQuery = (request: Authorize) =>
  new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri ?? CALLBACK,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
    state: request.state ?? "the-state",
    ...(request.scope === undefined ? {} : { scope: request.scope }),
    ...(request.resource === undefined ? {} : { resource: request.resource }),
  }).toString();

const authorizeInfo = (cookie: string, query: string, server = app) =>
  asOperator(cookie, "GET", `/v1/operator/oauth/authorize-info?${query}`, undefined, server);

function approve(
  cookie: string,
  workspaceId: string,
  query: string,
  choice: { level?: string; replyMode?: string } = {},
) {
  return asOperator(cookie, "POST", inWorkspace(workspaceId, "/oauth/grants"), {
    request: query,
    level: choice.level ?? "conversations",
    ...(choice.replyMode === undefined ? {} : { replyMode: choice.replyMode }),
  });
}

/** The code in an approval's redirect, after checking its state and issuer. */
async function codeOf(response: Response) {
  expect(response.status).toBe(201);
  const { redirectTo } = (await response.json()) as { redirectTo: string };
  const url = new URL(redirectTo);
  expect(url.searchParams.get("state")).toBe("the-state");
  expect(url.searchParams.get("iss")).toBe(ORIGIN);
  return url.searchParams.get("code") ?? "";
}

const token = (form: Record<string, string>, server = app) =>
  server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });

interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
  token_type: string;
}

interface Connection extends Tokens {
  clientId: string;
}

/** The whole flow: register, approve as `as`, and trade the code. */
async function connect(
  options: {
    as?: { cookie: string };
    workspaceId?: string;
    level?: string;
    clientId?: string;
  } = {},
): Promise<Connection> {
  const clientId = options.clientId ?? (await registered());
  const { verifier, challenge } = pkce();
  const code = await codeOf(
    await approve(
      (options.as ?? boss).cookie,
      options.workspaceId ?? a.id,
      authorizeQuery({ clientId, challenge }),
      { level: options.level ?? "conversations" },
    ),
  );
  const answer = await token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: CALLBACK,
    resource: MCP_URL,
  });
  expect(answer.status).toBe(200);
  return { ...((await answer.json()) as Tokens), clientId };
}

const refresh = (refreshToken: string, clientId?: string) =>
  token({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(clientId === undefined ? {} : { client_id: clientId }),
  });

const errorOf = async (response: Response) => ((await response.json()) as { error: unknown }).error;

const conversationsOf = (access: string) =>
  withToken(access, "GET", inWorkspace(a.id, "/conversations"));

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({
    db,
    logger,
    auth,
    checks: { postgres: ok, valkey: ok },
    fetchClientDocument: fetchDocument,
  });
  a = await createWorkspace(db, "Acme", [SITE]);
  b = await createWorkspace(db, "Beta", [SITE]);
  const person = async (workspaceId: string, name: string, role: "owner" | "admin" | "member") => {
    const made = await signedInOperator({ app, auth, owner, name, workspaceId, role });
    return { id: made.id, cookie: made.cookie };
  };
  boss = await person(a.id, "Olivia", "owner");
  admin = await person(a.id, "Ada", "admin");
  agent = await person(a.id, "Abel", "member");
  await person(b.id, "Bea", "owner");
  // Olivia is a plain member of Beta, so she may not connect apps there.
  await owner
    .insert(workspaceMember)
    .values({ workspaceId: b.id, operatorId: boss.id, role: "member" });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("discovery", () => {
  test("both protected resource paths name the MCP endpoint and this server", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/v1/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resource: MCP_URL,
        authorization_servers: [ORIGIN],
        scopes_supported: ["conversations", "setup"],
        bearer_methods_supported: ["header"],
        resource_name: "Dinghy",
      });
    }
  });

  test("the authorization server metadata lists what Claude needs, and never offline_access", async () => {
    const response = await app.request("/.well-known/oauth-authorization-server");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/v1/oauth/token`,
      registration_endpoint: `${ORIGIN}/v1/oauth/register`,
      revocation_endpoint: `${ORIGIN}/v1/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["conversations", "setup"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(JSON.stringify(body)).not.toContain("offline_access");
    expect((await app.request("/.well-known/openid-configuration")).status).toBe(404);
  });

  test("OAuth is on for https and loopback addresses only", () => {
    expect(oauthIssuer("https://chat.example.com/")).toBe("https://chat.example.com");
    expect(oauthIssuer("http://localhost:3000")).toBe("http://localhost:3000");
    expect(oauthIssuer("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(oauthIssuer("http://[::1]:8080")).toBe("http://[::1]:8080");
    expect(oauthIssuer("http://chat.example.com")).toBeNull();
  });

  test("MCP's 401 names the resource metadata, and says when a token failed", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const bare = await app.request("/v1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ping),
    });
    expect(bare.status).toBe(401);
    const metadata = `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/v1/mcp"`;
    expect(bare.headers.get("www-authenticate")).toBe(`Bearer ${metadata}, scope="conversations"`);
    const bad = await withToken(`dko_${a.id}.nothing`, "POST", "/v1/mcp", ping);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", ${metadata}, scope="conversations"`,
    );
  });

  test("on a plain http address OAuth is off, and MCP answers as before", async () => {
    const offDb = database.connect("app", 2).db;
    const off = createApp({
      db: offDb,
      logger,
      auth: createAuth({ db: offDb, secret: AUTH_SECRET, baseURL: "http://chat.example.com" }),
      checks: { postgres: ok, valkey: ok },
    });
    expect((await off.request("/.well-known/oauth-authorization-server")).status).toBe(404);
    expect((await register({ redirect_uris: [CALLBACK] }, off)).status).toBe(404);
    const bare = await off.request("/v1/mcp", { method: "POST", body: "{}" });
    expect(bare.headers.get("www-authenticate")).toBe('Bearer realm="dinghy"');
  });
});

describe("registration", () => {
  test("it echoes the client, with a signed client ID and no secret", async () => {
    const response = await register({
      client_name: "Claude Code",
      redirect_uris: [CALLBACK, "https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "client_secret_post",
      application_type: "native",
      logo_uri: "https://claude.ai/logo.png",
      scope: "conversations offline_access",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      client_id: expect.stringMatching(/^dcr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/),
      client_id_issued_at: expect.any(Number),
      client_name: "Claude Code",
      redirect_uris: [CALLBACK, "https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  test("a client with no name is an MCP client", async () => {
    const response = await register({ redirect_uris: [CALLBACK] });
    expect(((await response.json()) as { client_name: string }).client_name).toBe("MCP client");
  });

  test.each([
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["file:///etc/passwd"],
    ["http://evil.example/callback"],
    ["https://app.example/callback#fragment"],
    ["https://user:pass@app.example/callback"],
    ["myapp:/callback"],
    ["not a url"],
  ])("it refuses the redirect URI %s", async (uri) => {
    const response = await register({ redirect_uris: [uri] });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_redirect_uri");
  });

  test("it refuses a bad name, no redirect URI, or more than 5", async () => {
    for (const body of [
      { client_name: "Two\nlines", redirect_uris: [CALLBACK] },
      { client_name: "x".repeat(61), redirect_uris: [CALLBACK] },
      { redirect_uris: [] },
      { redirect_uris: Array.from({ length: 6 }, (_, index) => `${CALLBACK}${index}`) },
      {},
    ]) {
      const response = await register(body);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe("invalid_client_metadata");
    }
  });

  test("a changed client ID is not a client", async () => {
    const clientId = await registered();
    const [, payload, mac] = clientId.split(".");
    const forged = Buffer.from(
      JSON.stringify({ n: "Claude Code", r: ["https://evil.example/steal"] }),
    ).toString("base64url");
    const { challenge } = pkce();
    for (const tampered of [`dcr1.${forged}.${mac}`, `dcr1.${payload}.${"A".repeat(43)}`]) {
      const query = authorizeQuery({
        clientId: tampered,
        redirectUri: "https://evil.example/steal",
        challenge,
      });
      const response = await authorizeInfo(boss.cookie, query);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code: "invalid_client" });
    }
  });

  test("an address gets 10 registrations an hour", async () => {
    const valkey = new Redis(VALKEY_URL, { lazyConnect: true });
    const limited = createApp({ db, logger, auth, valkey, checks: { postgres: ok, valkey: ok } });
    // An address of this run's own, so no other test's count reaches it.
    const address = `10.${randomBytes(3).join(".")}`;
    for (let index = 0; index < 10; index++) {
      const made = await register({ redirect_uris: [CALLBACK] }, limited, address);
      expect(made.status).toBe(201);
    }
    const refused = await register({ redirect_uris: [CALLBACK] }, limited, address);
    expect(refused.status).toBe(429);
    expect(await errorOf(refused)).toBe("temporarily_unavailable");
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect((await register({ redirect_uris: [CALLBACK] }, limited)).status).toBe(201);
    valkey.disconnect();
  });
});

describe("redirect URIs", () => {
  test.each([
    ["https://app.example/cb", true],
    ["http://127.0.0.1/cb", true],
    ["http://[::1]:5000/cb", true],
    ["http://localhost:33418/callback", true],
    ["com.example.app:/oauth", true],
    ["cursor://anysphere.cursor-retrieval/oauth/callback", true],
    ["http://192.168.1.10/cb", false],
    ["myapp://callback", false],
    ["javascript://example.com/%0aalert(1)", false],
    ["https://app.example/cb#x", false],
  ])("%s is valid: %s", (uri, valid) => {
    expect(isValidRedirectUri(uri)).toBe(valid);
  });

  test("a loopback redirect matches on any port, and nothing else does", () => {
    expect(redirectMatches("http://127.0.0.1/cb", "http://127.0.0.1:53111/cb")).toBe(true);
    expect(redirectMatches("http://localhost:1/cb", "http://localhost:2/cb")).toBe(true);
    expect(redirectMatches("http://localhost/cb", "http://127.0.0.1/cb")).toBe(false);
    expect(redirectMatches("http://localhost/cb", "http://localhost/other")).toBe(false);
    expect(redirectMatches("http://localhost/cb?a=1", "http://localhost/cb?a=2")).toBe(false);
    expect(redirectMatches("https://app.example/cb", "https://app.example:444/cb")).toBe(false);
  });
});

describe("an authorization request", () => {
  const client: OAuthClient = {
    kind: "dcr",
    id: "dcr1.example",
    name: "Claude Code",
    redirectUris: ["http://127.0.0.1/callback", "https://app.example/cb"],
  };
  const { challenge } = pkce();
  const base = {
    response_type: "code",
    client_id: client.id,
    redirect_uri: "http://127.0.0.1:61234/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
  };
  const resolve = (changes: Record<string, string | null>, known: OAuthClient | null = client) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries({ ...base, ...changes })) {
      if (value !== null) params.append(name, value);
    }
    return resolveAuthorizeRequest(params, known, ORIGIN);
  };
  const refusedWith = (result: ReturnType<typeof resolve>) => {
    if (result.kind !== "refused") return null;
    const url = new URL(result.redirectTo);
    expect(url.searchParams.get("iss")).toBe(ORIGIN);
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.port).toBe("61234");
    return url.searchParams.get("error");
  };

  test("an unknown client or redirect never redirects", () => {
    expect(resolve({}, null)).toEqual({ kind: "invalid", error: "invalid_client" });
    for (const redirect of [
      "https://evil.example/cb",
      "http://localhost/callback",
      "https://app.example/cb#x",
      null,
    ]) {
      expect(resolve({ redirect_uri: redirect })).toEqual({
        kind: "invalid",
        error: "invalid_redirect_uri",
      });
    }
  });

  test.each([
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ response_type: null }, "unsupported_response_type"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge_method: null }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ code_challenge: null }, "invalid_request"],
    [{ resource: "https://other.example/v1/mcp" }, "invalid_target"],
    [{ resource: `${ORIGIN}/v1/other` }, "invalid_target"],
  ])("%j redirects with %s", (changes, error) => {
    expect(refusedWith(resolve(changes))).toBe(error);
  });

  test("a repeated parameter redirects with invalid_request", () => {
    const params = new URLSearchParams(base);
    params.append("state", "s2");
    const result = resolveAuthorizeRequest(params, client, ORIGIN);
    expect(result.kind).toBe("refused");
  });

  test("scopes are read leniently, and both resource values name the MCP endpoint", () => {
    for (const resource of [MCP_URL, ORIGIN, `${ORIGIN}/`, null]) {
      const result = resolve({ scope: "offline_access setup conversations", resource });
      expect(result).toMatchObject({
        kind: "valid",
        request: {
          scopes: ["conversations", "setup"],
          level: "setup",
          resource: MCP_URL,
          redirectUri: "http://127.0.0.1:61234/callback",
          state: "s1",
        },
      });
    }
    expect(resolve({ scope: "offline_access" })).toMatchObject({
      request: { scopes: [], level: "conversations" },
    });
  });
});

describe("client ID metadata documents", () => {
  beforeEach(() => {
    documents.clear();
    fetched.length = 0;
    documents.set(CLAUDE_CODE, {
      client_id: CLAUDE_CODE,
      client_name: "Claude Code",
      redirect_uris: [CALLBACK, "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  test("a signed-in operator sees the client's host, and the flow works", async () => {
    const { verifier, challenge } = pkce();
    const query = authorizeQuery({ clientId: CLAUDE_CODE, challenge, scope: "conversations" });
    const info = await authorizeInfo(boss.cookie, query);
    expect(await info.json()).toEqual({
      kind: "consent",
      client: {
        name: "Claude Code",
        host: "claude.ai",
        kind: "cimd",
        loopback: false,
        verified: false,
      },
      scopes: ["conversations"],
      level: "conversations",
      workspaces: [{ id: a.id, name: "Acme" }],
    });
    const code = await codeOf(await approve(boss.cookie, a.id, query));
    const answer = await token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE_CODE,
      redirect_uri: CALLBACK,
    });
    expect(answer.status).toBe(200);
  });

  test("it never fetches for someone who is not signed in", async () => {
    const { challenge } = pkce();
    const response = await app.request(
      `/v1/operator/oauth/authorize-info?${authorizeQuery({ clientId: CLAUDE_CODE, challenge })}`,
    );
    expect(response.status).toBe(401);
    expect(fetched).toEqual([]);
  });

  test.each([
    ["names another client ID", { client_id: "https://evil.example/meta" }],
    ["asks for a client secret", { token_endpoint_auth_method: "client_secret_basic" }],
    ["has no valid redirect URI", { redirect_uris: ["javascript:alert(1)"] }],
  ])("a document that %s is not a client", async (_name, change) => {
    documents.set(CLAUDE_CODE, { ...(documents.get(CLAUDE_CODE) as object), ...change });
    const { challenge } = pkce();
    const response = await authorizeInfo(
      boss.cookie,
      authorizeQuery({ clientId: CLAUDE_CODE, challenge }),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid_client" });
  });

  test("a redirect URI the document does not hold never redirects", async () => {
    const { challenge } = pkce();
    const query = authorizeQuery({
      clientId: CLAUDE_CODE,
      redirectUri: "https://evil.example/cb",
      challenge,
    });
    const response = await authorizeInfo(boss.cookie, query);
    expect(await errorOf(response)).toMatchObject({ code: "invalid_redirect_uri" });
  });

  test("a client ID that is not an https URL with a path is never fetched", async () => {
    const { challenge } = pkce();
    for (const clientId of ["http://claude.ai/meta", "https://claude.ai/", "https://claude.ai"]) {
      const response = await authorizeInfo(boss.cookie, authorizeQuery({ clientId, challenge }));
      expect(await errorOf(response)).toMatchObject({ code: "invalid_client" });
    }
    expect(fetched).toEqual([]);
  });

  test("Valkey keeps a document for an hour, and an operator gets 20 fetches a minute", async () => {
    const valkey = new Redis(VALKEY_URL, { lazyConnect: true });
    // The documents cached by an earlier run. The fetch limit is per operator, new in each run.
    await valkey.del(...(await valkey.keys("dinghy:oauth-client:*")), "none");
    const cached = createApp({
      db,
      logger,
      auth,
      valkey,
      checks: { postgres: ok, valkey: ok },
      fetchClientDocument: fetchDocument,
    });
    const { challenge } = pkce();
    for (let index = 0; index < 3; index++) {
      const info = await authorizeInfo(
        boss.cookie,
        authorizeQuery({ clientId: CLAUDE_CODE, challenge }),
        cached,
      );
      expect(info.status).toBe(200);
    }
    expect(fetched).toEqual([CLAUDE_CODE]);
    const unknown = authorizeQuery({ clientId: "https://unknown.example/meta", challenge });
    for (let index = 0; index < 19; index++) {
      expect((await authorizeInfo(boss.cookie, unknown, cached)).status).toBe(400);
    }
    expect((await authorizeInfo(boss.cookie, unknown, cached)).status).toBe(429);
    valkey.disconnect();
  });

  test("the real fetch refuses http and private addresses before it connects", async () => {
    expect(await fetchClientDocument("http://example.com/meta")).toBeNull();
    expect(await fetchClientDocument("https://127.0.0.1/meta")).toBeNull();
    expect(await fetchClientDocument("https://[::1]/meta")).toBeNull();
    expect(await fetchClientDocument("https://10.0.0.1/meta")).toBeNull();
  });
});

describe("consent", () => {
  test("the page learns the client, the level asked for and where it may connect", async () => {
    const clientId = await registered(["http://127.0.0.1/callback"], "Claude Code");
    const { challenge } = pkce();
    const query = authorizeQuery({
      clientId,
      redirectUri: "http://127.0.0.1:45000/callback",
      challenge,
      scope: "conversations setup offline_access",
    });
    expect(await (await authorizeInfo(boss.cookie, query)).json()).toEqual({
      kind: "consent",
      client: {
        name: "Claude Code",
        host: "127.0.0.1",
        kind: "dcr",
        loopback: true,
        verified: false,
      },
      scopes: ["conversations", "setup"],
      level: "setup",
      workspaces: [{ id: a.id, name: "Acme" }],
    });
    // A member connects nothing anywhere.
    const forAgent = (await (await authorizeInfo(agent.cookie, query)).json()) as {
      workspaces: unknown[];
    };
    expect(forAgent.workspaces).toEqual([]);
  });

  test("a DCR client's headline is its redirect host", async () => {
    const clientId = await registered(["https://evil.example/cb"]);
    const { challenge } = pkce();
    const query = authorizeQuery({ clientId, redirectUri: "https://evil.example/cb", challenge });
    const body = (await (await authorizeInfo(boss.cookie, query)).json()) as {
      client: { host: string; loopback: boolean };
    };
    expect(body.client).toMatchObject({ host: "evil.example", loopback: false });
  });

  test("a bad parameter sends the browser back with the error", async () => {
    const clientId = await registered();
    const query = authorizeQuery({ clientId, challenge: "too-short" });
    const body = (await (await authorizeInfo(boss.cookie, query)).json()) as {
      kind: string;
      redirectTo: string;
    };
    expect(body.kind).toBe("redirect");
    const url = new URL(body.redirectTo);
    expect(`${url.origin}${url.pathname}`).toBe(CALLBACK);
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(url.searchParams.get("iss")).toBe(ORIGIN);
    expect((await approve(boss.cookie, a.id, query)).status).toBe(400);
  });

  test("only an owner or admin approves, and only in a workspace of theirs", async () => {
    const clientId = await registered();
    const { challenge } = pkce();
    const query = authorizeQuery({ clientId, challenge });
    expect((await approve(agent.cookie, a.id, query)).status).toBe(403);
    // Olivia is only a member in Beta, and Ada is not in it at all.
    expect((await approve(boss.cookie, b.id, query)).status).toBe(403);
    expect((await approve(admin.cookie, b.id, query)).status).toBe(404);
    expect((await approve(admin.cookie, a.id, query)).status).toBe(201);
  });

  test("approval needs the session and this server's Origin, never a key", async () => {
    const clientId = await registered();
    const { challenge } = pkce();
    const body = JSON.stringify({
      request: authorizeQuery({ clientId, challenge }),
      level: "setup",
    });
    const path = inWorkspace(a.id, "/oauth/grants");
    const elsewhere = await app.request(path, {
      method: "POST",
      headers: {
        cookie: boss.cookie,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body,
    });
    expect(elsewhere.status).toBe(403);
    const grant = await connect({ level: "setup" });
    const withGrant = await withToken(grant.access_token, "POST", path, JSON.parse(body));
    expect(withGrant.status).toBe(403);
    const info = await withToken(grant.access_token, "GET", "/v1/operator/oauth/authorize-info");
    expect(info.status).toBe(403);
  });

  test("approving the same app again ends the approver's older grant", async () => {
    const clientId = await registered();
    const first = await connect({ clientId });
    const theirs = await connect({ clientId, as: admin });
    expect((await conversationsOf(first.access_token)).status).toBe(200);
    const second = await connect({ clientId });
    expect((await conversationsOf(first.access_token)).status).toBe(401);
    expect((await conversationsOf(second.access_token)).status).toBe(200);
    // Another approver's grant to the same app stays.
    expect((await conversationsOf(theirs.access_token)).status).toBe(200);
  });

  test("the grant carries the level, the reply mode and the client's name", async () => {
    const clientId = await registered([CALLBACK], "Cursor");
    const { challenge } = pkce();
    const query = authorizeQuery({ clientId, challenge });
    await codeOf(await approve(boss.cookie, a.id, query, { level: "setup", replyMode: "send" }));
    const [row] = await owner.select().from(apiKey).where(eq(apiKey.clientId, clientId));
    expect(row).toMatchObject({
      name: "Cursor",
      source: "oauth",
      level: "setup",
      replyMode: "send",
      createdBy: boss.id,
      tokenHash: null,
    });
    await codeOf(await approve(boss.cookie, a.id, query));
    const rows = await owner
      .select()
      .from(apiKey)
      .where(and(eq(apiKey.clientId, clientId)));
    expect(rows.find((one) => one.revokedAt === null)?.replyMode).toBe("draft");
  });

  test("a workspace keeps at most 50 live grants", async () => {
    const space = await createWorkspace(db, "Crowded", [SITE]);
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: space.id, operatorId: boss.id, role: "owner" });
    const rows = await owner
      .insert(apiKey)
      .values(
        Array.from({ length: GRANT_LIMIT }, (_, index) => ({
          workspaceId: space.id,
          name: `App ${index}`,
          source: "oauth" as const,
          clientId: `https://app${index}.example/meta`,
          createdBy: boss.id,
        })),
      )
      .returning({ id: apiKey.id });
    await owner.insert(apiKeyCredential).values(
      rows.map((row) => ({
        workspaceId: space.id,
        apiKeyId: row.id,
        kind: "refresh" as const,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      })),
    );
    const clientId = await registered();
    const { challenge } = pkce();
    const refused = await approve(boss.cookie, space.id, authorizeQuery({ clientId, challenge }));
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toMatchObject({ code: "grant_limit" });
    // A grant whose tokens all expired does not count.
    await owner
      .update(apiKeyCredential)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeyCredential.apiKeyId, rows[0]?.id ?? ""));
    expect(
      (await approve(boss.cookie, space.id, authorizeQuery({ clientId, challenge }))).status,
    ).toBe(201);
  });

  test("cancel sends access_denied with the state and issuer", async () => {
    const clientId = await registered();
    const { challenge } = pkce();
    const query = authorizeQuery({ clientId, challenge });
    const denied = await asOperator(boss.cookie, "POST", "/v1/operator/oauth/deny", {
      request: query,
    });
    expect(denied.status).toBe(200);
    const url = new URL(((await denied.json()) as { redirectTo: string }).redirectTo);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("iss")).toBe(ORIGIN);
    const nowhere = await asOperator(boss.cookie, "POST", "/v1/operator/oauth/deny", {
      request: authorizeQuery({ clientId, redirectUri: "https://evil.example/cb", challenge }),
    });
    expect(nowhere.status).toBe(400);
  });
});

describe("the token endpoint", () => {
  test("a code becomes an hour's access token and a refresh token, never cached", async () => {
    const clientId = await registered();
    const { verifier, challenge } = pkce();
    const code = await codeOf(
      await approve(boss.cookie, a.id, authorizeQuery({ clientId, challenge })),
    );
    expect(code).toMatch(new RegExp(`^dkc_${a.id}\\.[A-Za-z0-9_-]{43}$`));
    const answer = await token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const body = (await answer.json()) as Tokens;
    expect(body).toEqual({
      access_token: expect.stringMatching(new RegExp(`^dko_${a.id}\\.`)),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: expect.stringMatching(new RegExp(`^dkr_${a.id}\\.`)),
      scope: "conversations",
    });
    // Only hashes are stored.
    const stored = JSON.stringify(await owner.select().from(apiKeyCredential));
    expect(stored).not.toContain(body.access_token);
    expect(stored).not.toContain(body.refresh_token);
    expect(stored).not.toContain(code);
  });

  test("a Setup grant's scope names both levels", async () => {
    expect((await connect({ level: "setup" })).scope).toBe("conversations setup");
  });

  /** An approval and its code, for one exchange to change. */
  async function freshCode(redirectUri = CALLBACK, registeredUri = CALLBACK) {
    const clientId = await registered([registeredUri]);
    const { verifier, challenge } = pkce();
    const code = await codeOf(
      await approve(boss.cookie, a.id, authorizeQuery({ clientId, redirectUri, challenge })),
    );
    const form = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    };
    return { form, clientId };
  }

  const grantOf = async (clientId: string) =>
    (await owner.select().from(apiKey).where(eq(apiKey.clientId, clientId)))[0];

  test("a wrong verifier uses the code up, and the code's replay ends the grant", async () => {
    const { form, clientId } = await freshCode();
    const wrong = await token({ ...form, code_verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe("invalid_grant");
    expect(await errorOf(await token(form))).toBe("invalid_grant");
    expect((await grantOf(clientId))?.revokedAt).toBeInstanceOf(Date);
  });

  test("a code used twice ends the grant and its tokens", async () => {
    const { form, clientId } = await freshCode();
    const first = (await (await token(form)).json()) as Tokens;
    expect((await conversationsOf(first.access_token)).status).toBe(200);
    expect(await errorOf(await token(form))).toBe("invalid_grant");
    expect((await conversationsOf(first.access_token)).status).toBe(401);
    expect(await errorOf(await refresh(first.refresh_token))).toBe("invalid_grant");
    expect((await grantOf(clientId))?.revokedAt).toBeInstanceOf(Date);
  });

  test("the redirect URI and client must be the code's", async () => {
    const one = await freshCode();
    const other = await registered();
    expect(
      await errorOf(await token({ ...one.form, redirect_uri: "http://localhost/other" })),
    ).toBe("invalid_grant");
    const two = await freshCode();
    expect(await errorOf(await token({ ...two.form, client_id: other }))).toBe("invalid_grant");
  });

  test("a resource that is not this server is invalid_target, and both of its names work", async () => {
    const { form } = await freshCode();
    const wrong = await token({ ...form, resource: "https://other.example/v1/mcp" });
    expect(await errorOf(wrong)).toBe("invalid_target");
    expect((await token({ ...form, resource: ORIGIN })).status).toBe(200);
    const again = await freshCode();
    expect((await token({ ...again.form, resource: MCP_URL })).status).toBe(200);
  });

  test("a loopback redirect on another port than registered works, and must stay the same", async () => {
    const used = "http://127.0.0.1:53111/callback";
    const { form } = await freshCode(used, "http://127.0.0.1/callback");
    expect(
      await errorOf(await token({ ...form, redirect_uri: "http://127.0.0.1:53112/callback" })),
    ).toBe("invalid_grant");
    const again = await freshCode(used, "http://127.0.0.1/callback");
    expect((await token(again.form)).status).toBe(200);
  });

  test("a code expires after a minute", async () => {
    const { form } = await freshCode();
    await owner
      .update(apiKeyCredential)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeyCredential.kind, "code"));
    expect(await errorOf(await token(form))).toBe("invalid_grant");
  });

  test("a request that is not a valid form is refused in OAuth's shape", async () => {
    expect(await errorOf(await token({ grant_type: "password" }))).toBe("unsupported_grant_type");
    expect(await errorOf(await token({ grant_type: "authorization_code", code: "dkc_x" }))).toBe(
      "invalid_request",
    );
    expect(await errorOf(await token({ grant_type: "refresh_token" }))).toBe("invalid_request");
    const json = await app.request("/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "dkr_x" }),
    });
    expect(json.status).toBe(400);
    expect(await errorOf(json)).toBe("invalid_request");
    expect(await errorOf(await refresh(`dkr_${a.id}.unknown`))).toBe("invalid_grant");
    expect(await errorOf(await refresh("not-a-token"))).toBe("invalid_grant");
  });
});

describe("refresh tokens", () => {
  const familyOf = async (refreshToken: string) =>
    (
      await owner
        .select({ familyId: apiKeyCredential.familyId, apiKeyId: apiKeyCredential.apiKeyId })
        .from(apiKeyCredential)
        .where(
          eq(apiKeyCredential.tokenHash, createHash("sha256").update(refreshToken).digest("hex")),
        )
    )[0];

  test("a refresh rotates the pair, and the new one works", async () => {
    const first = await connect();
    const answer = await refresh(first.refresh_token, first.clientId);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const second = (await answer.json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await conversationsOf(second.access_token)).status).toBe(200);
    expect((await refresh(second.refresh_token)).status).toBe(200);
    expect((await familyOf(second.refresh_token))?.familyId).toBe(
      (await familyOf(first.refresh_token))?.familyId,
    );
  });

  test("a refresh used again within 60 seconds gets another pair in the same family", async () => {
    const first = await connect();
    const one = (await (await refresh(first.refresh_token)).json()) as Tokens;
    const retried = await refresh(first.refresh_token);
    expect(retried.status).toBe(200);
    const two = (await retried.json()) as Tokens;
    expect(two.refresh_token).not.toBe(one.refresh_token);
    expect((await familyOf(two.refresh_token))?.familyId).toBe(
      (await familyOf(one.refresh_token))?.familyId,
    );
    expect((await conversationsOf(one.access_token)).status).toBe(200);
    expect((await conversationsOf(two.access_token)).status).toBe(200);
  });

  test("a refresh used again after 60 seconds ends the grant", async () => {
    const first = await connect();
    const next = (await (await refresh(first.refresh_token)).json()) as Tokens;
    const hash = createHash("sha256").update(first.refresh_token).digest("hex");
    await owner
      .update(apiKeyCredential)
      .set({ usedAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(apiKeyCredential.tokenHash, hash));
    expect(await errorOf(await refresh(first.refresh_token))).toBe("invalid_grant");
    expect((await conversationsOf(next.access_token)).status).toBe(401);
    expect(await errorOf(await refresh(next.refresh_token))).toBe("invalid_grant");
  });

  test("another client's ID cannot refresh", async () => {
    const first = await connect();
    const other = await registered();
    expect(await errorOf(await refresh(first.refresh_token, other))).toBe("invalid_grant");
  });

  test("a deleted workspace's grant cannot refresh, a suspended one's can", async () => {
    const space = await createWorkspace(db, "Leaving", [SITE]);
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: space.id, operatorId: boss.id, role: "owner" });
    const grant = await connect({ workspaceId: space.id });
    await owner
      .update(workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(workspace.id, space.id));
    const kept = await refresh(grant.refresh_token);
    expect(kept.status).toBe(200);
    const next = (await kept.json()) as Tokens;
    await owner.update(workspace).set({ deletedAt: new Date() }).where(eq(workspace.id, space.id));
    expect(await errorOf(await refresh(next.refresh_token))).toBe("invalid_grant");
    const call = await withToken(next.access_token, "GET", inWorkspace(space.id, "/conversations"));
    expect(call.status).toBe(401);
  });

  test("an expired access token is refused", async () => {
    const grant = await connect();
    await owner
      .update(apiKeyCredential)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        eq(
          apiKeyCredential.tokenHash,
          createHash("sha256").update(grant.access_token).digest("hex"),
        ),
      );
    expect((await conversationsOf(grant.access_token)).status).toBe(401);
  });
});

describe("an access token as a bearer", () => {
  test("it works on MCP and on a route that takes a key, with the grant's name and level", async () => {
    const grant = await connect();
    const listed = await withToken(grant.access_token, "POST", "/v1/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = (
      (await listed.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name);
    expect(names).toContain("reply");
    expect(names).not.toContain("create_webhook");
    expect((await conversationsOf(grant.access_token)).status).toBe(200);
    const [row] = await owner.select().from(apiKey).where(eq(apiKey.clientId, grant.clientId));
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  test("a Conversations grant on a Setup route asks for the setup scope", async () => {
    const grant = await connect();
    const refused = await withToken(grant.access_token, "GET", inWorkspace(a.id, "/webhooks"));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="setup"',
    );
    const setup = await connect({ level: "setup" });
    expect(
      (await withToken(setup.access_token, "GET", inWorkspace(a.id, "/webhooks"))).status,
    ).toBe(200);
  });

  test("a refresh token or a code never works as a bearer", async () => {
    const grant = await connect();
    expect((await conversationsOf(grant.refresh_token)).status).toBe(401);
    const mcp = await withToken(grant.refresh_token, "POST", "/v1/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(mcp.status).toBe(401);
    const clientId = await registered();
    const code = await codeOf(
      await approve(boss.cookie, a.id, authorizeQuery({ clientId, challenge: pkce().challenge })),
    );
    expect((await conversationsOf(code)).status).toBe(401);
  });

  test("it works only in its own workspace", async () => {
    const grant = await connect();
    const theirs = await withToken(grant.access_token, "GET", inWorkspace(b.id, "/conversations"));
    expect(theirs.status).toBe(404);
    const renamed = grant.access_token.replace(a.id, b.id);
    expect((await withToken(renamed, "GET", inWorkspace(b.id, "/conversations"))).status).toBe(401);
    expect(await errorOf(await refresh(grant.refresh_token.replace(a.id, b.id)))).toBe(
      "invalid_grant",
    );
  });
});

describe("revocation", () => {
  const revoke = (form: Record<string, string>) =>
    app.request("/v1/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });

  test("revoking either token ends the grant", async () => {
    for (const which of ["access_token", "refresh_token"] as const) {
      const grant = await connect();
      expect((await revoke({ token: grant[which], client_id: grant.clientId })).status).toBe(200);
      expect((await conversationsOf(grant.access_token)).status).toBe(401);
      expect(await errorOf(await refresh(grant.refresh_token))).toBe("invalid_grant");
    }
  });

  test("another client cannot revoke, an unknown token answers 200, no token is refused", async () => {
    const grant = await connect();
    const other = await registered();
    expect((await revoke({ token: grant.access_token, client_id: other })).status).toBe(200);
    expect((await conversationsOf(grant.access_token)).status).toBe(200);
    expect((await revoke({ token: `dko_${a.id}.unknown` })).status).toBe(200);
    expect((await revoke({ token: "anything" })).status).toBe(200);
    expect(await errorOf(await revoke({}))).toBe("invalid_request");
  });
});

describe("the approver", () => {
  test("a demotion below admin or a removal ends their grants, not others'", async () => {
    const space = await createWorkspace(db, "Team", [SITE]);
    const join = (operatorId: string, role: "owner" | "admin") =>
      owner.insert(workspaceMember).values({ workspaceId: space.id, operatorId, role });
    await join(boss.id, "owner");
    await join(admin.id, "admin");
    const hers = await connect({ as: admin, workspaceId: space.id });
    const mine = await connect({ workspaceId: space.id });
    const inSpace = (access: string) =>
      withToken(access, "GET", inWorkspace(space.id, "/conversations"));
    const change = (role: string) =>
      asOperator(boss.cookie, "PATCH", inWorkspace(space.id, `/members/${admin.id}`), { role });
    expect((await change("member")).status).toBe(200);
    expect((await inSpace(hers.access_token)).status).toBe(401);
    expect(await errorOf(await refresh(hers.refresh_token))).toBe("invalid_grant");
    expect((await inSpace(mine.access_token)).status).toBe(200);
    expect((await change("admin")).status).toBe(200);
    const again = await connect({ as: admin, workspaceId: space.id });
    const removed = await asOperator(
      boss.cookie,
      "DELETE",
      inWorkspace(space.id, `/members/${admin.id}`),
    );
    expect(removed.status).toBe(200);
    expect((await inSpace(again.access_token)).status).toBe(401);
    expect((await inSpace(mine.access_token)).status).toBe(200);
  });

  test("deleting their account ends their grants", async () => {
    const space = await createWorkspace(db, "Deleting", [SITE]);
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: space.id, operatorId: boss.id, role: "owner" });
    const leaving = await signedInOperator({
      app,
      auth,
      owner,
      name: "Lea",
      workspaceId: space.id,
      role: "admin",
    });
    const grant = await connect({ as: leaving, workspaceId: space.id });
    const inSpace = () =>
      withToken(grant.access_token, "GET", inWorkspace(space.id, "/conversations"));
    expect((await inSpace()).status).toBe(200);
    const deleted = await asOperator(leaving.cookie, "POST", "/v1/operator/account/delete", {
      email: leaving.email,
    });
    expect(await deleted.json()).toEqual({ deleted: true });
    expect((await inSpace()).status).toBe(401);
    expect(await errorOf(await refresh(grant.refresh_token))).toBe("invalid_grant");
  });

  test("a static key they made keeps working", async () => {
    const space = await createWorkspace(db, "Keys stay", [SITE]);
    await owner.insert(workspaceMember).values([
      { workspaceId: space.id, operatorId: boss.id, role: "owner" },
      { workspaceId: space.id, operatorId: admin.id, role: "admin" },
    ]);
    const made = await asOperator(admin.cookie, "POST", inWorkspace(space.id, "/api-keys"), {
      name: "Script",
    });
    const { token: key } = (await made.json()) as { token: string };
    await asOperator(boss.cookie, "PATCH", inWorkspace(space.id, `/members/${admin.id}`), {
      role: "member",
    });
    expect((await withToken(key, "GET", inWorkspace(space.id, "/conversations"))).status).toBe(200);
  });
});

describe("Settings", () => {
  type Listed = {
    id: string;
    name: string;
    source: string;
    replyMode: string;
    clientHost: string | null;
    createdByName: string | null;
  };
  const listed = async () =>
    (
      (await (await asOperator(boss.cookie, "GET", inWorkspace(a.id, "/api-keys"))).json()) as {
        apiKeys: Listed[];
      }
    ).apiKeys;

  test("a redeemed grant is listed with its host, and an unredeemed one is not", async () => {
    const clientId = await registered(["https://agent.example/cb"], "Agent app");
    const { verifier, challenge } = pkce();
    const query = authorizeQuery({ clientId, redirectUri: "https://agent.example/cb", challenge });
    const code = await codeOf(await approve(boss.cookie, a.id, query));
    expect((await listed()).some((key) => key.name === "Agent app")).toBe(false);
    await token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: "https://agent.example/cb",
    });
    expect((await listed()).find((key) => key.name === "Agent app")).toMatchObject({
      source: "oauth",
      replyMode: "draft",
      clientHost: "agent.example",
      createdByName: "Olivia",
    });
  });

  test("an owner renames a grant, changes its reply mode and level, and revokes it", async () => {
    const grant = await connect();
    const [row] = await owner.select().from(apiKey).where(eq(apiKey.clientId, grant.clientId));
    const path = inWorkspace(a.id, `/api-keys/${row?.id}`);
    const changed = await asOperator(boss.cookie, "PATCH", path, {
      name: "Support agent",
      replyMode: "send",
      level: "setup",
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      name: "Support agent",
      replyMode: "send",
      level: "setup",
      source: "oauth",
    });
    expect(
      (await withToken(grant.access_token, "GET", inWorkspace(a.id, "/webhooks"))).status,
    ).toBe(200);
    expect((await asOperator(boss.cookie, "DELETE", path)).status).toBe(200);
    expect((await conversationsOf(grant.access_token)).status).toBe(401);
    const left = await owner
      .select()
      .from(apiKeyCredential)
      .where(eq(apiKeyCredential.apiKeyId, row?.id ?? ""));
    expect(left).toEqual([]);
    expect((await asOperator(boss.cookie, "PATCH", path, { name: "Again" })).status).toBe(404);
  });
});

describe("the worker's prune", () => {
  test("it deletes expired tokens and grants nobody used, and keeps the rest", async () => {
    const worker = database.connect("worker", 1).db;
    const used = await connect();
    await conversationsOf(used.access_token);
    const clientId = await registered();
    await codeOf(
      await approve(boss.cookie, a.id, authorizeQuery({ clientId, challenge: pkce().challenge })),
    );
    const unredeemed = (await owner.select().from(apiKey).where(eq(apiKey.clientId, clientId)))[0];
    await owner
      .update(apiKey)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) })
      .where(eq(apiKey.id, unredeemed?.id ?? ""));
    await owner
      .update(apiKeyCredential)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeyCredential.kind, "code"));
    expect(await pruneOAuth(worker)).toBeGreaterThan(0);
    expect(
      await owner.select().from(apiKeyCredential).where(eq(apiKeyCredential.kind, "code")),
    ).toEqual([]);
    expect(
      await owner
        .select()
        .from(apiKey)
        .where(eq(apiKey.id, unredeemed?.id ?? "")),
    ).toEqual([]);
    expect((await conversationsOf(used.access_token)).status).toBe(200);
  });
});

describe("from start to end", () => {
  test("register, approve, trade the code and list the tools over MCP 2026-07-28", async () => {
    const registration = await register({
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback"],
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const query = authorizeQuery({
      clientId,
      redirectUri: "http://localhost:59123/callback",
      challenge,
      scope: "conversations offline_access",
      resource: MCP_URL,
    });
    const info = (await (await authorizeInfo(boss.cookie, query)).json()) as { kind: string };
    expect(info.kind).toBe("consent");
    const code = await codeOf(await approve(boss.cookie, a.id, query));
    const exchanged = await token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: "http://localhost:59123/callback",
      resource: MCP_URL,
    });
    const { access_token: access } = (await exchanged.json()) as Tokens;
    const response = await app.request("/v1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: { name: string }[]; resultType: string; cacheScope: string };
    };
    expect(body.result.resultType).toBe("complete");
    expect(body.result.cacheScope).toBe("private");
    expect(body.result.tools.map((tool) => tool.name)).toContain("list_conversations");
  });
});
