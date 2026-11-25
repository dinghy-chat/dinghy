import type { Quote } from "./quote.ts";
import type { Locale, OutboundButton, OutboundShow, PageContext } from "./shared.ts";
import { readStream, retryAfterMs } from "./stream.ts";

/** The presence answer. */
export interface Presence {
  /** Null means unknown, and then the panel says nothing about the team. */
  online: boolean | null;
  /** The members online now, by the hash on their faces. */
  members: string[];
  /** Whether this server sends reply emails. */
  emailReplies: boolean;
  /** The header's usual reply time, in seconds, while it shows and someone is online. */
  replySeconds: number | null;
}

/** An image, or a file that only downloads. `size` is in bytes. */
export type Attachment = { url: string; removed?: never } & (
  | { type: "image"; width: number; height: number }
  | { type: "file"; name: string; size: number }
);

/** A reply's card under its text: the page's title and thumbnail, and the link it opens. */
export interface LinkCard {
  url: string;
  title: string;
  image: { url: string; width: number; height: number } | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  seq: string;
  /** `closed` and `reopened` are status lines, with no body. */
  kind: "text" | "image" | "file" | "closed" | "reopened";
  fromVisitor: boolean;
  clientId: string | null;
  body: string | null;
  /** An `image` or `file` message's attachment. One deleted after 12 months keeps only its type. */
  attachment: Attachment | { type: "image" | "file"; removed: true } | null;
  /** A reply from a workspace API key, such as the site's own bot. */
  fromBot: boolean;
  /** A hash of the operator's or the key's ID, which tells two authors with one name apart. */
  authorId: string | null;
  /** A reply's author: an operator's first name or a key's name. Null for the visitor's own. */
  authorName: string | null;
  authorPictureUrl: string | null;
  /** The message this one quotes. Its author is an operator's first name or a key's name. */
  replyTo: Quote | null;
  /** The card of a reply's first link. */
  link: LinkCard | null;
  /** The team deleted it, so it shows a placeholder. */
  deleted: boolean;
  /** The outbound message this reply came from, which the widget showed apart before. */
  outboundId: string | null;
  /** That outbound message's buttons. Empty otherwise. */
  buttons: OutboundButton[];
  createdAt: string;
}

/** An outbound message that waits to show, outside any conversation. */
export interface Waiting {
  id: string;
  body: string;
  buttons: OutboundButton[];
  show: OutboundShow;
  /** The visitor read it already, in this tab or another. */
  read: boolean;
  fromBot: boolean;
  authorId: string | null;
  authorName: string | null;
  authorPictureUrl: string | null;
  /** The campaign it comes from, or null. */
  campaignId: string | null;
  createdAt: string;
  /** A page campaign's card, which has no ID of its own until the visitor answers: its campaign's. */
  page?: true;
}

/**
 * What a visitor's message answers: the outbound messages they read, a button they chose, and a
 * page campaign's card they read, with its button.
 */
export interface Answer {
  outboundIds: string[];
  button?: { outboundMessageId: string; index: number };
  /** The card's language, so its message comes in as the visitor read it. */
  pageCampaign?: { id: string; language: Locale; button?: number };
}

/** A send's answer: the message, and whether it started a new conversation. */
export interface SentMessage extends ChatMessage {
  conversationStarted: boolean;
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
  /** The visitor gave an email, so the widget does not ask again. */
  hasEmail: boolean;
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
    /** As `me`, after moving the anonymous chats of this browser into the signed-in visitor. */
    meMerging: (token: string, browserToken: string) =>
      call<Me>("me/merge", token, { method: "POST", body: JSON.stringify({ browserToken }) }),
    /** The token only on the chat page, where it is what lets the request in. */
    presence: (token: string | null) => call<Presence>("presence", token),
    reportPage: (token: string, address: string, title: string) =>
      call<{ ok: true }>("page", token, {
        method: "POST",
        body: JSON.stringify({ page: address, title }),
      }),
    /**
     * The chat's language, for the visitor's emails, and the page's setContext() data, which
     * replaces what the server kept before. Null leaves that data as it is.
     */
    reportContext: (token: string, locale: Locale, context: PageContext | null) =>
      call<{ ok: true }>("context", token, {
        method: "POST",
        body: JSON.stringify({ locale, ...(context !== null && { context }) }),
      }),
    /** The message box's text, for operators to see before it is sent. Empty when it is gone. */
    typing: (token: string, draft: string) =>
      call<{ ok: true }>("typing", token, { method: "POST", body: JSON.stringify({ draft }) }),
    saveEmail: (token: string, email: string) =>
      call<Me>("me", token, { method: "PATCH", body: JSON.stringify({ email }) }),
    markRead: (token: string, seq: string) =>
      // keepalive, so a page reload right after reading does not lose the position.
      call<{ ok: true }>("read", token, {
        method: "POST",
        body: JSON.stringify({ seq }),
        keepalive: true,
      }),
    sendUpload: async (token: string, clientId: string, file: File) => {
      const at = page();
      const response = await fetch(
        url(
          `uploads?clientId=${clientId}&filename=${encodeURIComponent(file.name)}${at === undefined ? "" : `&page=${encodeURIComponent(at)}`}`,
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
      return (await response.json()) as SentMessage;
    },
    send: (
      token: string,
      clientId: string,
      body: string,
      replyToMessageId?: string,
      answer: Answer = { outboundIds: [] },
    ) =>
      call<SentMessage>("messages", token, {
        method: "POST",
        body: JSON.stringify({ clientId, body, page: page(), replyToMessageId, ...answer }),
      }),
    waiting: async (token: string) =>
      (await call<{ outboundMessages: Waiting[] }>("outbound-messages", token)).outboundMessages,
    readOutbound: (token: string, id: string) =>
      call<{ ok: true }>(`outbound-messages/${id}/read`, token, { method: "POST" }),
    /** A button that dismisses the message, or opens a page, by its place. */
    press: (token: string, id: string, action: "dismiss" | "click", button: number) =>
      call<{ ok: true }>(`outbound-messages/${id}/${action}`, token, {
        method: "POST",
        body: JSON.stringify({ button }),
      }),
    /** A page campaign's card, shown now. The visitor may not exist yet. */
    showPage: async (token: string | null, id: string, language: Locale) => ({
      ...(
        await call<{ outboundMessage: Waiting }>(`campaigns/${id}/show`, token, {
          method: "POST",
          body: JSON.stringify({ language }),
        })
      ).outboundMessage,
      page: true as const,
    }),
    /**
     * The visitor read a page campaign's card, or chose a button that opens a page or dismisses,
     * by its place in the card's language.
     */
    countPage: (token: string | null, id: string, language: Locale, button?: number) =>
      call<{ ok: true }>(`campaigns/${id}/${button === undefined ? "read" : "press"}`, token, {
        method: "POST",
        body: JSON.stringify({ language, button }),
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
        notice(value: unknown): void;
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
        notice: handlers.notice,
      });
    },
  };
}
