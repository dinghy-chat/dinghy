import type { components, paths } from "./openapi.ts";

type Method = "get" | "post" | "put" | "patch" | "delete";
type Schemas = components["schemas"];
export type ErrorCode = Schemas["Error"]["error"]["code"] | "unexpected_response";

/** Anything that answers like `fetch`, such as `app.request` in a test. */
export type Fetch = (input: string, init: RequestInit) => Response | Promise<Response>;

/** Every route of a workspace. The SDK fills `{workspaceId}` from the API key. */
export type WorkspacePath = Extract<keyof paths, `/v1/operator/workspaces/{workspaceId}${string}`>;

/** The methods a path has. */
export type MethodOf<P extends WorkspacePath> = {
  [M in Method]: [NonNullable<paths[P][M]>] extends [never] ? never : M;
}[Method];

type Operation<P extends WorkspacePath, M extends Method> = NonNullable<paths[P][M]>;

type PathParams<O> = O extends { parameters: { path: infer T } } ? Omit<T, "workspaceId"> : never;
type Query<O> = O extends { parameters: { query?: infer Q } } ? Q : never;
type JsonBody<O> = O extends { requestBody: { content: { "application/json": infer B } } }
  ? B
  : O extends { requestBody?: { content: { "application/json": infer B } } }
    ? B | undefined
    : never;

type SuccessStatus = 200 | 201 | 202;
type Success<O> = O extends { responses: infer R }
  ? {
      [S in keyof R]: S extends SuccessStatus
        ? R[S] extends { content: { "application/json": infer J } }
          ? J
          : never
        : never;
    }[keyof R]
  : never;

/** A field that is required when its type has a required key, optional when not, gone if never. */
type Field<K extends string, T> = [T] extends [never]
  ? unknown
  : Partial<T> extends T
    ? { [Key in K]?: T }
    : { [Key in K]: T };

type RequestOptions<O> = Field<"path", PathParams<O>> &
  Field<"query", Query<O>> &
  Field<"body", JsonBody<O>> & {
    /** Raw bytes for an upload, sent instead of a JSON body. */
    bytes?: Blob | Uint8Array<ArrayBuffer>;
  };

export type RequestArgs<P extends WorkspacePath, M extends MethodOf<P>> =
  Partial<RequestOptions<Operation<P, M>>> extends RequestOptions<Operation<P, M>>
    ? [options?: RequestOptions<Operation<P, M>>]
    : [options: RequestOptions<Operation<P, M>>];

export type Answer<P extends WorkspacePath, M extends MethodOf<P>> = Success<Operation<P, M>>;

/** A request the server refused, with its `{ error: { code, message } }`. */
export class DinghyError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "DinghyError";
    this.status = status;
    this.code = code;
  }
}

const MAX_TRIES = 3;
const BACKOFF_MS = 250;
// A longer `retry-after` is cut to this, so a caller never waits minutes inside one call.
const MAX_WAIT_MS = 30_000;
export const RETRY_STATUSES = new Set([429, 503]);

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait before try number `tries + 1`: `retry-after`, or a doubling backoff. */
function retryDelayMs(response: Response | null, tries: number): number {
  const seconds = Number(response?.headers.get("retry-after") ?? Number.NaN);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : BACKOFF_MS * 2 ** (tries - 1);
  return Math.min(Math.max(ms, 0), MAX_WAIT_MS);
}

/** The server's error, or a generic one when the body is not the API's error shape. */
export async function errorOf(response: Response): Promise<DinghyError> {
  const body = (await response.json().catch(() => null)) as Schemas["Error"] | null;
  if (body?.error?.code === undefined) {
    return new DinghyError(response.status, "unexpected_response", `HTTP ${response.status}`);
  }
  return new DinghyError(response.status, body.error.code, body.error.message);
}

interface Raw {
  method: Method;
  url: string;
  headers: Record<string, string>;
  body?: string | Blob | Uint8Array<ArrayBuffer>;
}

/**
 * Sends with retries for 429, 503 and network errors. A network error is retried only when a
 * repeat cannot do the work twice: any method but POST, or a POST that carries a `clientId`.
 */
export async function withRetries(fetch: Fetch, raw: Raw, isRepeatable: boolean) {
  for (let tries = 1; ; tries++) {
    const init: RequestInit = { method: raw.method.toUpperCase(), headers: raw.headers };
    if (raw.body !== undefined) init.body = raw.body;
    let response: Response;
    try {
      response = await fetch(raw.url, init);
    } catch (error) {
      if (!isRepeatable || tries >= MAX_TRIES) throw error;
      await wait(retryDelayMs(null, tries));
      continue;
    }
    if (!RETRY_STATUSES.has(response.status) || tries >= MAX_TRIES) return response;
    await response.body?.cancel();
    await wait(retryDelayMs(response, tries));
  }
}

interface Target {
  baseUrl: string;
  workspaceId: string;
}

/** The URL of a route, with its path parameters and query filled in. */
function urlOf(target: Target, template: string, path: object, query: object): string {
  const params: Record<string, unknown> = { ...path, workspaceId: target.workspaceId };
  const filled = template.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(String(params[name])),
  );
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) search.set(name, String(value));
  }
  const text = search.toString();
  return new URL(text === "" ? filled : `${filled}?${text}`, target.baseUrl).href;
}

interface LooseOptions {
  path?: object;
  query?: object;
  body?: object;
  bytes?: Blob | Uint8Array<ArrayBuffer>;
}

/** One API call: the URL, the bearer token, JSON in and out, retries and errors. */
export async function call(
  client: Target & { apiKey: string; fetch: Fetch },
  method: Method,
  template: string,
  options: LooseOptions,
): Promise<unknown> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${client.apiKey}`,
    accept: "application/json",
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.bytes !== undefined) headers["content-type"] = "application/octet-stream";
  const raw: Raw = {
    method,
    url: urlOf(client, template, options.path ?? {}, options.query ?? {}),
    headers,
  };
  const body =
    options.bytes ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined) raw.body = body;
  const hasClientId = "clientId" in (options.body ?? {}) || "clientId" in (options.query ?? {});
  const response = await withRetries(client.fetch, raw, method !== "post" || hasClientId);
  if (!response.ok) throw await errorOf(response);
  return response.json();
}
