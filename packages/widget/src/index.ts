// The npm entry: it adds the loader's script tag and hands back a typed `Dinghy`. Calls made before
// the loader runs wait in the same queue a page can write by hand, `Dinghy = { q: [...] }`.
import type {
  Appearance,
  DinghyApi,
  DinghyEvent,
  DinghyEvents,
  DinghyState,
  QueuedCall,
} from "./shared.ts";

export type {
  Appearance,
  DinghyApi,
  DinghyEvent,
  DinghyEvents,
  DinghyState,
  Identity,
  OpenOptions,
  PageContext,
} from "./shared.ts";

export interface InitOptions extends Appearance {
  /** Your Dinghy server, such as `https://chat.example.com`. */
  url: string;
  /** The workspace's public key, from Settings > Install. */
  key: string;
  /** Hides or shows the boat in the open chat, over the saved setting. Every state keeps its text. */
  mascot?: boolean;
  /** Hides or shows the "Powered by Dinghy" line, over the saved setting. */
  branding?: boolean;
  /** False hides the launcher, so your own button opens the chat. */
  launcher?: boolean;
}

type Slot = { Dinghy?: DinghyApi | { q?: QueuedCall[] } };
const slot = globalThis as Slot;

/** The loader's API once it has run. */
function loaded(): DinghyApi | undefined {
  const current = slot.Dinghy;
  return current !== undefined && "on" in current ? current : undefined;
}

function enqueue(call: QueuedCall): void {
  const queue = (slot.Dinghy ?? {}) as { q?: QueuedCall[] };
  queue.q = [...(queue.q ?? []), call];
  slot.Dinghy = queue;
}

/** Runs a method now, or queues it for the loader. */
function forward<M extends Exclude<keyof DinghyApi, "on" | "state">>(
  method: M,
  ...args: Parameters<DinghyApi[M]>
): void {
  const api = loaded();
  if (api === undefined) enqueue([method, ...args]);
  else (api[method] as (...values: unknown[]) => void)(...args);
}

const NOT_READY: DinghyState = { ready: false, open: false, unread: 0 };

/** The same `Dinghy` as the loader's, usable before the loader runs. */
export const Dinghy: DinghyApi = {
  open: (options) => forward("open", ...(options === undefined ? [] : [options])),
  close: () => forward("close"),
  toggle: () => forward("toggle"),
  show: () => forward("show"),
  hide: () => forward("hide"),
  identify: (identity) => forward("identify", identity),
  reset: () => forward("reset"),
  setContext: (data) => forward("setContext", data),
  configure: (options) => forward("configure", options),
  on<E extends DinghyEvent>(event: E, callback: (data: DinghyEvents[E]) => void) {
    // A call queued before the loader ran has no way back to its unsubscribe, so this flag stops it.
    let active = true;
    const listener = (data: DinghyEvents[E]) => {
      if (active) callback(data);
    };
    const api = loaded();
    let off: (() => void) | undefined;
    if (api === undefined) enqueue(["on", event, listener]);
    else off = api.on(event, listener);
    return () => {
      active = false;
      off?.();
    };
  },
  get state() {
    return loaded()?.state ?? { ...NOT_READY };
  },
};

let added = false;

/**
 * Adds the chat to the page once, and returns `Dinghy`. A second call returns the same object and
 * adds nothing. On a server, with no document, it only returns `Dinghy`.
 */
export function init(options: InitOptions): DinghyApi {
  if (added || typeof document === "undefined") return Dinghy;
  added = true;
  const base = options.url.endsWith("/") ? options.url : `${options.url}/`;
  const script = document.createElement("script");
  script.src = new URL("widget/loader.js", base).href;
  script.async = true;
  const attributes: [string, string | number | undefined][] = [
    ["key", options.key],
    ["primary", options.primary],
    ["accent", options.accent],
    ["position", options.position],
    ["offset-x", options.offsetX],
    ["offset-y", options.offsetY],
    ["mascot", options.mascot === undefined ? undefined : String(options.mascot)],
    ["branding", options.branding === undefined ? undefined : String(options.branding)],
    ["launcher", options.launcher === false ? "hidden" : undefined],
  ];
  for (const [name, value] of attributes) {
    if (value !== undefined) script.setAttribute(`data-${name}`, String(value));
  }
  // No attribute for this one, as a page rarely needs it.
  if (options.zIndex !== undefined) Dinghy.configure({ zIndex: options.zIndex });
  // A queue for the loader, as the page's own `Dinghy = { q: [] }` would be.
  slot.Dinghy ??= { q: [] };
  document.head.append(script);
  return Dinghy;
}
