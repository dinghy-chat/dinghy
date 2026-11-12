import { createHmac, timingSafeEqual } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { z } from "@hono/zod-openapi";
import type { Redis } from "iovalkey";
import type { Logger } from "pino";
import { KeyName } from "./api-keys.ts";
import { sha256Hex } from "./identity.ts";
import type { RateLimit } from "./rate-limit.ts";
import { HOUR_SECONDS, MINUTE_SECONDS } from "./time.ts";
import { endpointProblem, guardedLookup, PUBLIC_ONLY } from "./webhooks.ts";

// An OAuth client is a public client, with no secret. Dinghy knows two kinds and stores neither:
// - `dcr`: registered at /v1/oauth/register. Its client ID holds its name and redirect URIs, signed
//   with the server's secret, so registration needs no table and nothing to prune.
// - `cimd`: a client ID that is an https URL of a metadata document, which Dinghy fetches only
//   for a signed-in operator.

export interface OAuthClient {
  kind: "dcr" | "cimd";
  id: string;
  /** What the client calls itself. Nothing verifies it. */
  name: string;
  redirectUris: string[];
}

export const DEFAULT_CLIENT_NAME = "MCP client";
export const REDIRECT_URIS_MAX = 5;
const REDIRECT_URI_MAX_LENGTH = 500;
/** The longest client ID: a registered one holds its redirect URIs. */
export const CLIENT_ID_MAX_LENGTH = 4096;
const DCR_PREFIX = "dcr1.";
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
/** Schemes that run code or read files where a browser lands, never a redirect target. */
const REFUSED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);
const PRIVATE_SCHEME = /^[a-z][a-z0-9+.-]*:$/;
/** A redirect URI as a client sends it, already encoded, so its length bounds the client ID's. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

const isLoopback = (url: URL) => url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);

/**
 * Whether a redirect URI is one Dinghy sends a code to: `https` on any host, `http` on a loopback
 * host (RFC 8252 section 7.3), or a private-use scheme with a dot in it or in its host, such as
 * `com.example.app:/done` or `cursor://anysphere.cursor-retrieval/oauth` (section 7.1). Never one
 * with a fragment, userinfo, a space or a character that is not ASCII.
 */
export function isValidRedirectUri(value: string): boolean {
  if (value.length > REDIRECT_URI_MAX_LENGTH || !PRINTABLE_ASCII.test(value)) return false;
  if (value.includes("#") || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return url.hostname !== "";
  if (url.protocol === "http:") return isLoopback(url);
  if (REFUSED_SCHEMES.has(url.protocol) || !PRIVATE_SCHEME.test(url.protocol)) return false;
  return url.protocol.includes(".") || url.hostname.includes(".");
}

/**
 * Whether a requested redirect URI is a registered one. They must be equal, except that a loopback
 * one may use any port, because a native app gets its port when it starts (RFC 8252 section 7.3).
 * `localhost` and `127.0.0.1` are different hosts.
 */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  if (!URL.canParse(registered) || !URL.canParse(requested)) return false;
  const one = new URL(registered);
  const two = new URL(requested);
  return (
    isLoopback(one) &&
    isLoopback(two) &&
    one.hostname === two.hostname &&
    one.pathname === two.pathname &&
    one.search === two.search
  );
}

/**
 * Where a redirect URI sends people: its host, or its scheme. `local` when it stays on the person's
 * computer, as a loopback address or an app's own scheme does, so its host names nobody.
 */
export function redirectHost(uri: string): { host: string; local: boolean } {
  const url = new URL(uri);
  return {
    host: url.hostname === "" ? url.protocol.slice(0, -1) : url.hostname,
    // A valid redirect URI that is not https is a loopback address or a private-use scheme.
    local: url.protocol !== "https:",
  };
}

/** Who a client is, as Dinghy can tell: where its metadata document lives, or where it returns. */
interface ClientOrigin {
  kind: "dcr" | "cimd";
  host: string;
  local: boolean;
}

const DcrPayload = z.object({ n: z.string(), r: z.array(z.string()).min(1) });

const dcrMac = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(`dinghy-oauth-client.${payload}`).digest("base64url");

/**
 * A registered client's ID: `dcr1.` + its name and redirect URIs + their signature. Null when it
 * would be longer than an ID Dinghy reads back, such as with long non-ASCII redirect URIs.
 */
export function signClientId(secret: string, name: string, redirectUris: string[]): string | null {
  const payload = Buffer.from(JSON.stringify({ n: name, r: redirectUris })).toString("base64url");
  const clientId = `${DCR_PREFIX}${payload}.${dcrMac(secret, payload)}`;
  return clientId.length > CLIENT_ID_MAX_LENGTH ? null : clientId;
}

/** The parts of a registered client's ID. Only `verifyClientId` says Dinghy signed it. */
function decodeClientId(clientId: string): { payload: string; mac: string } | null {
  if (!clientId.startsWith(DCR_PREFIX) || clientId.length > CLIENT_ID_MAX_LENGTH) return null;
  const [payload, mac, ...rest] = clientId.slice(DCR_PREFIX.length).split(".");
  if (payload === undefined || mac === undefined || rest.length > 0) return null;
  return { payload, mac };
}

function readPayload(payload: string): z.infer<typeof DcrPayload> | null {
  try {
    const parsed = DcrPayload.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A registered client, when Dinghy signed its ID. */
function verifyClientId(secret: string, clientId: string): OAuthClient | null {
  const parts = decodeClientId(clientId);
  if (parts === null) return null;
  const expected = Buffer.from(dcrMac(secret, parts.payload));
  const given = Buffer.from(parts.mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const data = readPayload(parts.payload);
  return data === null ? null : { kind: "dcr", id: clientId, name: data.n, redirectUris: data.r };
}

/** A metadata document's URL: https, with a path, as the client ID itself (CIMD). */
function isMetadataUrl(clientId: string): boolean {
  if (clientId.length > REDIRECT_URI_MAX_LENGTH || clientId.includes("#")) return false;
  if (!URL.canParse(clientId)) return false;
  const url = new URL(clientId);
  return url.protocol === "https:" && url.pathname !== "/" && url.username === "";
}

/**
 * What Settings shows for a grant's client, from its client ID alone: a metadata URL's host, or a
 * registered client's first redirect host. The ID was checked when the grant was approved.
 */
export function clientOrigin(clientId: string): ClientOrigin | null {
  if (isMetadataUrl(clientId)) return metadataOrigin(clientId);
  const parts = decodeClientId(clientId);
  const first = parts === null ? undefined : readPayload(parts.payload)?.r[0];
  return first === undefined || !URL.canParse(first)
    ? null
    : { kind: "dcr", ...redirectHost(first) };
}

/** A metadata document's host, which the fetch proved serves it. */
export const metadataOrigin = (clientId: string): ClientOrigin => ({
  kind: "cimd",
  host: new URL(clientId).hostname,
  local: false,
});

/** Fetches a metadata document. It answers null for anything but a small JSON answer. */
export type FetchClientDocument = (url: string) => Promise<unknown>;

const DOCUMENT_TIMEOUT_MS = 5000;
const DOCUMENT_MAX_BYTES = 5 * 1024;

/**
 * Fetches a JSON document with the webhook sender's guard for public addresses, always, whatever
 * the server allows webhooks. It follows no redirect, and gives up after 5 seconds or 5 KB.
 */
export const fetchClientDocument: FetchClientDocument = (address) => {
  const target = new URL(address);
  if (endpointProblem(target, PUBLIC_ONLY) !== null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = httpsRequest(
      target,
      {
        method: "GET",
        lookup: guardedLookup(PUBLIC_ONLY),
        signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
        headers: { accept: "application/json", "user-agent": "Dinghy-OAuth" },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          return resolve(null);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > DOCUMENT_MAX_BYTES) {
            response.destroy();
            resolve(null);
          } else chunks.push(chunk);
        });
        response.on("error", () => resolve(null));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("error", () => resolve(null));
    request.end();
  });
};

const ClientDocument = z.object({
  client_id: z.string(),
  client_name: z.unknown().optional(),
  redirect_uris: z.array(z.string()).min(1).max(20),
  token_endpoint_auth_method: z.literal("none").optional(),
});

/** The client a metadata document describes, when it is one Dinghy can use. */
function readClientDocument(url: string, document: unknown): OAuthClient | null {
  const parsed = ClientDocument.safeParse(document);
  if (!parsed.success || parsed.data.client_id !== url) return null;
  const redirectUris = parsed.data.redirect_uris.filter(isValidRedirectUri);
  if (redirectUris.length === 0) return null;
  const name = KeyName.safeParse(parsed.data.client_name);
  return {
    kind: "cimd",
    id: url,
    name: name.success ? name.data : new URL(url).hostname,
    redirectUris,
  };
}

const DOCUMENT_CACHE_SECONDS = HOUR_SECONDS;
const FETCHES_PER_MINUTE = 20;

interface ClientsOptions {
  secret: string;
  valkey: Redis | null;
  rateLimit: RateLimit;
  logger: Logger;
  fetchDocument: FetchClientDocument;
}

/**
 * Finds a client by its ID, for a signed-in operator. A metadata document comes from Valkey's cache
 * of an hour, or a fetch, of which an operator gets 20 a minute. A lost cache only fetches again.
 */
export function createClients({
  secret,
  valkey,
  rateLimit,
  logger,
  fetchDocument,
}: ClientsOptions) {
  const cacheKey = (url: string) => `dinghy:oauth-client:${sha256Hex(url)}`;
  const cached = async (url: string): Promise<unknown> => {
    const text = await valkey?.get(cacheKey(url)).catch((err: unknown) => {
      logger.warn({ err }, "client document cache unavailable");
      return null;
    });
    return typeof text === "string" ? JSON.parse(text) : null;
  };
  return async function findClient(
    clientId: string,
    operatorId: string,
  ): Promise<OAuthClient | { waitSeconds: number } | null> {
    if (clientId.startsWith(DCR_PREFIX)) return verifyClientId(secret, clientId);
    if (!isMetadataUrl(clientId)) return null;
    const hit = readClientDocument(clientId, await cached(clientId));
    if (hit !== null) return hit;
    const wait = await rateLimit.hit(
      "oauth-client-fetch",
      operatorId,
      FETCHES_PER_MINUTE,
      MINUTE_SECONDS,
    );
    if (wait !== null) return { waitSeconds: wait };
    const document = await fetchDocument(clientId);
    const client = readClientDocument(clientId, document);
    if (client !== null) {
      await valkey
        ?.set(cacheKey(clientId), JSON.stringify(document), "EX", DOCUMENT_CACHE_SECONDS)
        .catch((err: unknown) => logger.warn({ err }, "client document cache unavailable"));
    }
    return client;
  };
}

export type FindClient = ReturnType<typeof createClients>;
