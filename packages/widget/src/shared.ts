/** A signed token from the host backend, or a function that fetches a new one. */
export type Identity = string | (() => Promise<string>);

/** Unsigned facts from the page, such as a plan or a cart total. Operators see them as unverified. */
export type PageContext = Record<string, string | number | boolean | null>;

export interface OpenOptions {
  /** Fills the message box. The visitor still sends it. */
  message?: string;
}

/**
 * The languages the widget speaks. English is in the chat bundle, and each other one is a file
 * beside it.
 */
export const LOCALES = ["en", "fr", "es"] as const;
export type Locale = (typeof LOCALES)[number];

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
  /** A language the widget speaks, such as `fr`, over the saved one. Set it before the chat opens. */
  locale?: string;
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
  launcher: "bubble" | "label" | "square" | "boat" | "hidden";
  /** The boat in the open chat. */
  mascot: boolean;
  /** Pixels, for the chat's corners and the launcher's. */
  radius: number;
  emailAsk: "off" | "after_first" | "before_first";
  /** The "Powered by Dinghy" line. */
  branding: boolean;
  /** A chime when a reply arrives and the visitor is not looking at the chat. */
  sound: boolean;
  /** The visitor gets the conversation by email when it closes. The widget does not use it. */
  transcript: boolean;
  /** Visitors may send files as well as images. */
  visitorFiles: boolean;
  /** Whose faces the header shows. `online` falls back to the latest repliers when nobody is. */
  headerFaces: "online" | "repliers" | "chosen" | "none";
  /** How many faces, 1 to HEADER_FACES_MAX. */
  headerFaceCount: number;
  /** A green dot on the face of each member who is online now. */
  headerDot: boolean;
  /** Under the title while someone is online: "Online", or the usual reply time. */
  headerStatus: "presence" | "reply_time";
  /**
   * The widget's own words in one language, or `visitor` for the first of the browser's languages
   * that the widget speaks. The team's own texts stay as written.
   */
  language: "visitor" | Locale;
}

/** A member the widget's header shows: a first name and a picture, never an email. */
export interface TeamFace {
  /** A hash of the operator's ID, the same as `authorId` on their replies. It tells two members
   * with one first name apart. */
  id: string;
  name: string;
  pictureUrl: string | null;
}

/** The days of the week, in the order the settings list them. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The most opening ranges one day holds. */
export const DAY_RANGES_MAX = 3;

/**
 * When the team answers: each day's ranges, such as `["09:00", "18:00"]`, in order and apart, in
 * the workspace's IANA time zone. A range may end at "24:00". A day with none is closed.
 */
export interface BusinessHours {
  timeZone: string;
  week: Record<Weekday, [string, string][]>;
}

/** The saved settings, as the widget's appearance route answers them. */
export interface SavedAppearance extends WidgetSettings {
  /** The chat sends the visitor's unsent words, so operators see them as they type. */
  typingPreview: boolean;
  logoUrl: string | null;
  /** Up to HEADER_FACES_MAX members, the ones who sent the latest replies, newest first. */
  team: TeamFace[];
  /**
   * The header's candidates, in order: every member for `online`, which the widget cuts to the
   * members online now, the latest repliers for `repliers`, the chosen members for `chosen`.
   */
  faces: TeamFace[];
  /** Null while business hours are off, so the widget follows presence alone. */
  hours: BusinessHours | null;
}

/** The longest title an owner can save. */
export const TITLE_MAX = 40;
/** The longest greeting or away text. */
export const TEXT_MAX = 200;
/** The most faces the header shows. */
export const HEADER_FACES_MAX = 5;
/** The roundest corners an owner can save. */
export const RADIUS_MAX_PX = 24;

/** The widget's own colors, which a null color in the settings keeps. */
export const DEFAULT_COLORS = { primary: "#0b2239", accent: "#e5352b" };

/** What a new workspace saves, and what the widget shows when the server cannot answer. */
export const WIDGET_DEFAULTS: SavedAppearance = {
  title: null,
  greeting: null,
  away: null,
  primary: null,
  accent: null,
  position: "right",
  theme: "auto",
  launcher: "bubble",
  mascot: true,
  radius: 16,
  emailAsk: "after_first",
  branding: true,
  sound: true,
  transcript: true,
  visitorFiles: true,
  headerFaces: "online",
  headerFaceCount: 3,
  headerDot: true,
  headerStatus: "presence",
  language: "visitor",
  typingPreview: true,
  logoUrl: null,
  team: [],
  faces: [],
  hours: null,
};

/**
 * The saved settings over the defaults. A tab that loaded before an upgrade, or the five-minute
 * cache, can hand over an answer without the fields that came later.
 */
export const withDefaults = (
  answer: Partial<SavedAppearance> | null | undefined,
): SavedAppearance => ({
  ...WIDGET_DEFAULTS,
  ...answer,
});

/**
 * The first word of a name, which is all a visitor learns of an operator. It stops at an @ too, so
 * a name typed as an email never shows one.
 */
export const firstName = (name: string) => name.trim().split(/[\s@]+/)[0] ?? "";

/**
 * Asks for the saved settings, once a page. Null means the workspace serves no widget, and
 * undefined that the server gave no answer, so WIDGET_DEFAULTS apply. The loader has no bytes for
 * that object, so it leaves those values to its CSS, which holds the same ones.
 */
export const loadAppearance = (
  base: string,
  publicKey: string,
): Promise<SavedAppearance | null | undefined> =>
  fetch(`${base}../v1/widget/${publicKey}/appearance`)
    .then((response) =>
      response.ok ? response.json() : response.status === 404 ? null : undefined,
    )
    .catch(() => undefined);

export interface DinghyState {
  /** The chat bundle has loaded. */
  ready: boolean;
  open: boolean;
  unread: number;
  /** The visitor has an open conversation. Known once the chat has asked the server, false before. */
  conversation: boolean;
}

/** Each event and what its callback receives. */
export interface DinghyEvents {
  ready: undefined;
  open: undefined;
  close: undefined;
  unread: number;
  /** Whether the visitor has an open conversation, once at once and on each change. */
  conversation: boolean;
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

/**
 * The shape of WidgetContext. Bump it in any change to what the loader or page.js hands the chat
 * bundle: a tab keeps the loader it started with for days, and the chat bundle replaces a loader
 * with another number instead of reading a context it does not know.
 */
export const CONTEXT_VERSION = 2;

/** What the loader hands to the chat bundle. */
export interface WidgetContext {
  /** CONTEXT_VERSION, as the loader knew it. Loaders before it set none. */
  version: number;
  publicKey: string;
  base: string;
  shadow: ShadowRoot;
  /** The saved settings, which the loader asked for. See loadAppearance. */
  appearance: Promise<SavedAppearance | null | undefined>;
  /**
   * Reads the tag's data attributes by dataset name, such as `mascot`, and the values configure()
   * set. They win over the saved settings.
   */
  attribute(name: string): string | undefined;
  /** The full-page chat that a reply email opens, on the Dinghy server's own origin. */
  page?: boolean;
  /** Set by identify() and cleared by reset(). */
  identity: Identity | null;
  /** The token the chat got from an identify() function, so the loader's beat can send it. */
  hostToken: string | null;
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

/** The longest message, in characters: the composers' limit, which the server checks too. */
export const MESSAGE_MAX = 10_000;

/** The most members one note mentions, which the operator app keeps to and the server checks. */
export const MENTIONS_MAX = 10;

/** The longest saved reply shortcut, in characters, where the form's field stops. */
export const SAVED_REPLY_SHORTCUT_MAX = 32;
/**
 * A saved reply's shortcut, what follows `/` in the composer. The form, the server and the database
 * check it.
 */
// Built in a call marked pure, so the widget's bundles, which never use it, drop it.
export const SAVED_REPLY_SHORTCUT = /* @__PURE__ */ (() =>
  new RegExp(`^[a-z0-9][a-z0-9-]{0,${SAVED_REPLY_SHORTCUT_MAX - 1}}$`))();

/**
 * The limits of saved replies, labels and bulk changes. The server and the database check them, and
 * the operator app keeps to them and names them in its texts.
 */
export const SAVED_REPLIES_MAX = 200;
export const SAVED_REPLY_BODY_MAX = 5000;
export const LABELS_MAX = 100;
export const LABEL_NAME_MAX = 40;
/** The most conversations one bulk change takes. */
export const BULK_MAX = 100;

/**
 * The longest two-step sign-in code the server takes once spaces are gone, well above a recovery
 * code's 19 characters with its dashes. The operator app's field stops there, so a code typed with
 * spaces always fits.
 */
export const TWO_FACTOR_CODE_MAX = 40;

/**
 * The rules of a request to remove two-step sign-in, which the server applies and the operator app
 * names: the wait before it completes, how long a cancel blocks a new request, and how recent the
 * email link of the session that asks must be.
 */
export const TWO_FACTOR_REMOVAL_WAIT_HOURS = 72;
export const TWO_FACTOR_REMOVAL_BLOCK_DAYS = 7;
export const TWO_FACTOR_REMOVAL_FRESH_MINUTES = 15;

/**
 * A bot repeats its typing notice while it writes, so one that stops repeating has stopped: the
 * chat and the operator app drop it after this long with no update.
 */
export const BOT_TYPING_MS = 6000;
