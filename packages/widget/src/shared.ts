/** A signed token from the host backend, or a function that fetches a new one. */
export type Identity = string | (() => Promise<string>);

/** What the loader hands to the chat bundle. */
export interface WidgetContext {
  publicKey: string;
  base: string;
  shadow: ShadowRoot;
  /** False when the page set data-mascot="false". Every state still has its text. */
  mascot: boolean;
  /** The full-page chat that a reply email opens, on the Dinghy server's own origin. */
  page?: boolean;
  getIdentity(): Identity | null;
  /** The chat registers here to start again after identify() or reset(). */
  setSessionHandler(handler: () => void): void;
  setOpenHandlers(open: () => void, close: () => void): void;
  setLauncherHidden(hidden: boolean): void;
  focusLauncher(): void;
  setUnread(count: number): void;
}

/** The public API on the host page. */
export interface DinghyApi {
  open(): void;
  close(): void;
  identify(identity: Identity): void;
  reset(): void;
  onUnreadChange(callback: (count: number) => void): () => void;
}

declare global {
  var __dinghy: WidgetContext | undefined;
  /** Before the loader runs, a page can queue calls as `Dinghy = { q: [["open"]] }`. */
  var Dinghy: DinghyApi | { q?: [keyof DinghyApi, ...unknown[]][] } | undefined;
}

const TOKEN_PREFIX = "dinghy:token:";
export const RESET_PREFIX = "dinghy:reset:";

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

/** Tells other tabs of this site to start again. A storage event fires only in other tabs. */
export function broadcastReset(publicKey: string): void {
  try {
    localStorage.setItem(RESET_PREFIX + publicKey, String(Date.now()));
  } catch {
    // Other tabs keep their session until their next page load.
  }
}
