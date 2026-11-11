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

/** What an owner saves in the operator app's Widget tab. Null texts and colors mean the widget's own. */
export interface WidgetSettings {
  title: string | null;
  greeting: string | null;
  away: string | null;
  /** A full hex color, as `primary` in configure(). */
  primary: string | null;
  accent: string | null;
  position: "left" | "right";
  theme: "light" | "dark" | "auto";
  launcher: "boat" | "bubble" | "hidden";
  /** The boat in the open chat. */
  mascot: boolean;
  /** Pixels, for the chat's corners and the launcher's. */
  radius: number;
  emailAsk: "off" | "after_first" | "before_first";
  /** The "Powered by Dinghy" line. */
  branding: boolean;
}

/** A member the widget's header shows: a first name and a picture, never an email. */
export interface TeamFace {
  name: string;
  pictureUrl: string | null;
}

/** The saved settings, as the widget's appearance route answers them. */
export interface SavedAppearance extends WidgetSettings {
  logoUrl: string | null;
  /** Up to 3 members, the ones who sent the latest replies. */
  team: TeamFace[];
}

/** What the widget knows of the saved settings. Empty when the server could not answer. */
export type Saved = Partial<SavedAppearance>;

/**
 * Asks for the saved settings, once a page. Null means the workspace serves no widget. An answer
 * with an error, or none, leaves every value to the defaults.
 */
export const loadAppearance = (base: string, publicKey: string): Promise<Saved | null> =>
  fetch(`${base}../v1/widget/${publicKey}/appearance`)
    .then((response) => (response.status === 404 ? null : response.json()))
    .catch(() => ({}));

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
interface ChatHandlers {
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
  /** The saved settings, which the loader asked for. */
  appearance: Promise<Saved | null>;
  /** Reads the tag's data attributes by dataset name, such as `mascot`. They win over the saved settings. */
  attribute(name: string): string | undefined;
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
 * Clears this browser's token, and tells other tabs of this site to start again. A storage event
 * fires only in other tabs. The key goes at once, so nothing stays stored for a visitor who never
 * chatted.
 */
export function forgetVisitor(publicKey: string): void {
  try {
    localStorage.removeItem(TOKEN_PREFIX + publicKey);
    // The key is always gone before this, so each signal is a change that fires the event.
    localStorage.setItem(RESET_PREFIX + publicKey, "1");
    localStorage.removeItem(RESET_PREFIX + publicKey);
  } catch {
    // Other tabs keep their session until their next page load.
  }
}
