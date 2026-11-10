/** A signed token from the host backend, or a function that fetches a new one. */
export type Identity = string | (() => Promise<string>);

/** Unsigned facts from the page, such as a plan or a cart total. Operators see them as unverified. */
export type PageContext = Record<string, string | number | boolean | null>;

export interface OpenOptions {
  /** Fills the message box. The visitor still sends it. */
  message?: string;
}

/** What `configure` and the script tag's data attributes change. Invalid values are ignored. */
export interface Appearance {
  /** A six-digit hex color, such as `#0b2239`. */
  primary?: string;
  accent?: string;
  position?: "left" | "right";
  /** Pixels from the side and from the bottom of the window, 0 to 1000. */
  offsetX?: number;
  offsetY?: number;
  zIndex?: number;
}

export interface DinghyState {
  /** The chat bundle has loaded. */
  ready: boolean;
  open: boolean;
  unread: number;
}

/** Each event and what its callback receives. */
export interface DinghyEvents {
  ready: undefined;
  open: undefined;
  close: undefined;
  unread: number;
  /** The visitor's message reached the server. `body` is null for an image. */
  "message:sent": { body: string | null };
  /** A reply arrived while the page was open. `body` is null for an image. */
  "message:received": { body: string | null };
  "conversation:started": undefined;
}

export type DinghyEvent = keyof DinghyEvents;

/** The public API on the host page, `window.Dinghy`. */
export interface DinghyApi {
  open(options?: OpenOptions): void;
  close(): void;
  toggle(): void;
  /** Shows or hides the launcher button. */
  show(): void;
  hide(): void;
  identify(identity: Identity): void;
  reset(): void;
  setContext(data: PageContext): void;
  configure(options: Appearance): void;
  /** Calls `callback` on each event, and returns a function that removes it. */
  on<E extends DinghyEvent>(event: E, callback: (data: DinghyEvents[E]) => void): () => void;
  readonly state: DinghyState;
}

/** A call queued before the loader runs, as `Dinghy = { q: [["open"]] }`. */
export type QueuedCall = [string, ...unknown[]];

/** What the chat bundle gives the loader once it runs. */
export interface ChatHandlers {
  open(message: string | undefined): void;
  close(): void;
  /** identify() or reset(): start again. */
  session(): void;
  /** setContext() was called. */
  context(): void;
}

/** Each event's callbacks. The loader keeps them, and the chat bundle calls them. */
export type Listeners = { [E in DinghyEvent]?: Set<(data: DinghyEvents[E]) => void> };

/** What the loader hands to the chat bundle. */
export interface WidgetContext {
  publicKey: string;
  base: string;
  shadow: ShadowRoot;
  /** False when the page set data-mascot="false". Every state still has its text. */
  mascot: boolean;
  /** The full-page chat that a reply email opens, on the Dinghy server's own origin. */
  page?: boolean;
  /** Set by identify() and cleared by reset(). */
  identity: Identity | null;
  /** The last setContext() value, as the page gave it. */
  pageContext: unknown;
  /** The chat bundle sets this when it runs, then opens the chat if `wanted` asks for it. */
  chat?: ChatHandlers;
  /** An open() made before the chat bundle ran, with its message. */
  wanted?: [string | undefined] | undefined;
  /** The loader's `Dinghy.state`, which the chat bundle keeps up to date. */
  state: DinghyState;
  listeners: Listeners;
}

const TOKEN_PREFIX = "dinghy:token:";
export const RESET_PREFIX = "dinghy:reset:";
const OPEN_PREFIX = "dinghy:open:";

/** Storage can throw in a private window or with blocked site data. */
export function readToken(publicKey: string): string | null {
  try {
    return localStorage.getItem(TOKEN_PREFIX + publicKey);
  } catch {
    return null;
  }
}

export function writeToken(publicKey: string, token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_PREFIX + publicKey);
    else localStorage.setItem(TOKEN_PREFIX + publicKey, token);
  } catch {
    // The chat still works for this page view.
  }
}

/** Whether the chat was open in this tab before a reload. Only a visitor with a token has this. */
export function wasOpen(publicKey: string): boolean {
  try {
    return sessionStorage.getItem(OPEN_PREFIX + publicKey) !== null;
  } catch {
    return false;
  }
}

export function rememberOpen(publicKey: string, open: boolean): void {
  try {
    if (open) sessionStorage.setItem(OPEN_PREFIX + publicKey, "1");
    else sessionStorage.removeItem(OPEN_PREFIX + publicKey);
  } catch {
    // The chat starts closed after a reload.
  }
}

/**
 * Tells other tabs of this site to start again. A storage event fires only in other tabs. The key
 * goes at once, so nothing stays stored for a visitor who never chatted.
 */
export function broadcastReset(publicKey: string): void {
  try {
    // The key is always gone before this, so each signal is a change that fires the event.
    localStorage.setItem(RESET_PREFIX + publicKey, "1");
    localStorage.removeItem(RESET_PREFIX + publicKey);
  } catch {
    // Other tabs keep their session until their next page load.
  }
}
