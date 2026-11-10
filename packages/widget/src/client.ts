import type { PageContext } from "./shared.ts";
import { readStream, retryAfterMs } from "./stream.ts";

export interface ChatMessage {
  id: string;
  conversationId: string;
  seq: string;
  kind: "text" | "image";
  fromVisitor: boolean;
  clientId: string | null;
  body: string | null;
  image: { url: string; width: number; height: number } | null;
  /** The image was deleted after 12 months, on Dinghy Cloud. */
  imageRemoved: boolean;
  createdAt: string;
}

export class ApiError extends Error {
  readonly status: number;
  /** The server's error code, such as blocked or origin_not_allowed, when its answer had one. */
  readonly code: string | null;
  /** On a refused stream, how long to wait before the next try, from Retry-After. */
  readonly retryMs: number | undefined;
  constructor(status: number, code: string | null = null, retryMs?: number) {
    super(`The request failed with status ${status}`);
    this.status = status;
    this.code = code;
    this.retryMs = retryMs;
  }
}

/** The error for a failed response, with the code from its body when it has one. */
async function refused(response: Response, retryMs?: number): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  const code = body?.error?.code;
  return new ApiError(response.status, typeof code === "string" ? code : null, retryMs);
}

interface Me {
  visitorId: string;
  signedIn: boolean;
  openConversation: boolean;
  /** Has a conversation, open or closed. Only then does the widget report pages. */
  chatted: boolean;
  lastReadSeq: string;
  unread: number;
  /** A stream from here reads only what follows the read position. */
  readCursor: string;
}

/**
 * A request that never answers must end, so a send turns into "not sent" with a retry. An upload
 * from a phone can take minutes, so it gets longer. The stream has no limit, because it stays open.
 */
const DEADLINES = { requestMs: 30_000, uploadMs: 5 * 60_000 };

/** The longest page address the server keeps, as PAGE_PATH_MAX in the server's journey.ts. */
const PAGE_PATH_MAX = 2000;

/** The host page, so an operator sees where a chat started. It never holds a query or hash. */
export const pageAddress = () => (location.origin + location.pathname).slice(0, PAGE_PATH_MAX);

/** The page's title on one line, as the server keeps it. */
export const pageTitle = () => document.title.replace(/\s+/g, " ").trim().slice(0, 200);

/** The workspace's own widget text. Null means the default. */
export interface Texts {
  title: string | null;
  greeting: string | null;
  away: string | null;
}

/**
 * `hostPage` is false on the chat page that a reply email opens, whose address holds its token and
 * must never reach the server as a page.
 */
export type Client = ReturnType<typeof createClient>;

export function createClient(
  base: string,
  publicKey: string,
  deadlines = DEADLINES,
  hostPage = true,
) {
  const url = (path: string) => `${base}../v1/widget/${publicKey}/${path}`;
  const page = () => (hostPage ? pageAddress() : undefined);

  async function call<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url(path), {
      cache: "no-store",
      signal: AbortSignal.timeout(deadlines.requestMs),
      ...init,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
    if (!response.ok) throw await refused(response);
    return (await response.json()) as T;
  }

  return {
    newVisitor: () =>
      call<{ visitorId: string; token: string }>("visitors", null, { method: "POST" }),
    me: (token: string) => call<Me>("me", token),
    /** The token only on the chat page, where it is what lets the request in. */
    presence: (token: string | null) =>
      call<{ online: boolean | null; emailReplies: boolean; texts: Texts }>("presence", token),
    reportPage: (token: string, address: string, title: string) =>
      call<{ ok: true }>("page", token, {
        method: "POST",
        body: JSON.stringify({ page: address, title }),
      }),
    /** The page's setContext() data. It replaces what the server kept before. */
    reportContext: (token: string, context: PageContext) =>
      call<{ ok: true }>("context", token, { method: "POST", body: JSON.stringify({ context }) }),
    saveEmail: (token: string, email: string) =>
      call<Me>("me", token, { method: "PATCH", body: JSON.stringify({ email }) }),
    markRead: (token: string, seq: string) =>
      // keepalive, so a page reload right after reading does not lose the position.
      call<{ ok: true }>("read", token, {
        method: "POST",
        body: JSON.stringify({ seq }),
        keepalive: true,
      }),
    sendImage: async (token: string, clientId: string, file: File) => {
      const at = page();
      const response = await fetch(
        url(
          `images?clientId=${clientId}${at === undefined ? "" : `&page=${encodeURIComponent(at)}`}`,
        ),
        {
          method: "POST",
          cache: "no-store",
          signal: AbortSignal.timeout(deadlines.uploadMs),
          headers: { authorization: `Bearer ${token}`, "content-type": file.type },
          body: file,
        },
      );
      if (!response.ok) throw await refused(response);
      return (await response.json()) as ChatMessage;
    },
    send: (token: string, clientId: string, body: string) =>
      call<ChatMessage>("messages", token, {
        method: "POST",
        body: JSON.stringify({ clientId, body, page: page() }),
      }),

    /** Reads the stream until it ends. See readStream. */
    async stream(
      token: string,
      after: string | null,
      signal: AbortSignal,
      handlers: {
        message(message: ChatMessage, cursor: string): void;
        ready(cursor: string | null): void;
        resync(cursor: string): void;
      },
    ): Promise<string | null> {
      const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
      const response = await fetch(url(`stream${query}`), {
        headers: { authorization: `Bearer ${token}` },
        // Firefox holds a second identical GET until the first ends, because of its cache lock.
        // A second tab's stream would hang for as long as the first tab's stays open.
        cache: "no-store",
        signal,
      });
      // A 429 means the server holds too many streams, and the client must wait as long as it says.
      if (!response.ok) {
        throw await refused(
          response,
          response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined,
        );
      }
      return readStream<ChatMessage>(response, "message", {
        data: handlers.message,
        ready: handlers.ready,
        resync: handlers.resync,
      });
    },
  };
}
