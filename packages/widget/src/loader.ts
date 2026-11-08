import {
  broadcastReset,
  type DinghyApi,
  type Identity,
  RESET_PREFIX,
  readToken,
  type WidgetContext,
  writeToken,
} from "./shared.ts";
import { LAUNCHER_LABEL } from "./text.ts";

// This file runs on every page of the host site, so it stays small and makes no request until it
// has a reason to. The chat bundle loads when the visitor opens the chat, the page calls
// identify(), or the visitor already has a token.

const script = document.currentScript as HTMLScriptElement | null;
const publicKey = script?.getAttribute("data-key");
if (script !== null && publicKey !== null && publicKey !== undefined) {
  const base = new URL(".", script.src).href;
  const launcherAllowed = script.getAttribute("data-launcher") !== "hidden";
  const mascot = script.getAttribute("data-mascot") !== "false";
  const host = document.createElement("dinghy-chat");
  // Inline and important, because a rule on the host page beats :host. This uses the CSSOM,
  // because a strict style-src blocks a style attribute.
  for (const [name, value] of [
    ["all", "initial"],
    ["display", "block"],
    ["position", "fixed"],
    ["z-index", "2147483000"],
    ["right", "16px"],
    ["bottom", "16px"],
  ] as const) {
    host.style.setProperty(name, value, "important");
  }
  // Only a full hex color, because this value goes into the page's CSS.
  for (const [attribute, name] of [
    ["data-primary", "--d-primary"],
    ["data-accent", "--d-accent"],
  ] as const) {
    const value = script.getAttribute(attribute);
    if (value !== null && /^#[0-9a-f]{6}$/i.test(value)) {
      const rgb = Number.parseInt(value.slice(1), 16);
      const light = 299 * (rgb >> 16) + 587 * ((rgb >> 8) & 255) + 114 * (rgb & 255) > 150_000;
      host.style.setProperty(name, value);
      host.style.setProperty(`${name}-text`, light ? "#0b2239" : "#fff");
    }
  }
  // A modal's focus trap listens on the document, so it must not see focus move inside the chat.
  // The same goes for a site's keyboard shortcuts, which cannot see that the target is a textarea.
  for (const type of ["focusin", "focusout", "keydown", "keypress", "keyup"]) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    ".launcher{all:initial;position:relative;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:60px;height:60px;border-radius:30px;background:var(--d-accent,#e5352b);color:var(--d-accent-text,#fff);cursor:pointer;box-shadow:0 8px 24px rgb(13 34 64/.26)}.launcher:focus-visible{outline:3px solid var(--d-primary,#0b2239);outline-offset:2px}.badge{position:absolute;top:-3px;right:-3px;min-width:22px;height:22px;padding:0 4px;box-sizing:border-box;border-radius:11px;background:#e5352b;color:#fff;box-shadow:0 0 0 2px #fff;font:700 12px/22px system-ui,sans-serif;text-align:center}.boat{background:#fff}.s{fill:var(--d-accent,#e5352b)}.h{fill:var(--d-primary,#0b2239)}.boat svg{animation:b 3.2s ease-in-out infinite}@keyframes b{50%{transform:translateY(-2px)}}@media (prefers-reduced-motion:reduce){.boat svg{animation:none}}",
  );
  shadow.adoptedStyleSheets = [sheet];
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = mascot ? "launcher boat" : "launcher";
  launcher.setAttribute("aria-label", LAUNCHER_LABEL);
  // Drawn here and not imported from boat.ts, because this file runs on every page and must stay small.
  launcher.innerHTML = mascot
    ? '<svg width="38" height="38" viewBox="0 0 52 52" aria-hidden="true"><path class="h" d="M25 2h1.9v38H25zM3 39H49C47.5 45 42 49 36 49H16C10 49 4.5 45 3 39z"/><path class="s" d="M28 6C37 14 43 25 45 36H28z"/><path fill="#ffc917" d="M24 12C18 20 12 28 8 36H24z"/></svg>'
    : '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 4h18v13H8l-5 4z"/></svg>';
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.hidden = true;
  launcher.append(badge);
  if (!launcherAllowed) launcher.style.display = "none";
  shadow.append(launcher);

  let identity: Identity | null = null;
  let unread = 0;
  let sessionHandler: (() => void) | undefined;
  let openHandler: (() => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let openWhenLoaded = false;
  const unreadCallbacks = new Set<(count: number) => void>();

  const setUnread = (count: number) => {
    if (count === unread) return;
    unread = count;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    launcher.setAttribute(
      "aria-label",
      count === 0 ? LAUNCHER_LABEL : `${LAUNCHER_LABEL} (${count})`,
    );
    for (const callback of unreadCallbacks) callback(count);
  };

  const context: WidgetContext = {
    publicKey,
    base,
    shadow,
    mascot,
    getIdentity: () => identity,
    setSessionHandler(handler) {
      sessionHandler = handler;
    },
    setOpenHandlers(open, close) {
      openHandler = open;
      closeHandler = close;
      if (openWhenLoaded) open();
    },
    setLauncherHidden(hidden) {
      if (launcherAllowed) launcher.style.display = hidden ? "none" : "";
    },
    focusLauncher() {
      if (launcherAllowed) launcher.focus();
    },
    setUnread,
  };
  globalThis.__dinghy = context;

  let loading = false;
  const load = () => {
    if (loading) return;
    loading = true;
    const bundle = document.createElement("script");
    bundle.src = `${base}widget.js`;
    bundle.async = true;
    // A brief network failure must not disable the launcher until a reload.
    bundle.onerror = () => {
      loading = false;
      bundle.remove();
    };
    document.head.append(bundle);
  };

  const open = () => {
    if (openHandler === undefined) {
      openWhenLoaded = true;
      load();
    } else {
      openHandler();
    }
  };
  launcher.addEventListener("click", open);

  /** Ends the session in this tab. The chat bundle drops its state and closes its stream. */
  const endSession = () => {
    identity = null;
    setUnread(0);
    sessionHandler?.();
  };

  const api: DinghyApi = {
    open,
    close() {
      openWhenLoaded = false;
      closeHandler?.();
    },
    identify(next) {
      identity = next;
      setUnread(0);
      sessionHandler?.();
      load();
    },
    reset() {
      // Only the tab that called reset() clears the token. Another tab can handle this event late,
      // after a new chat has started, and it must not delete that chat's token.
      writeToken(publicKey, null);
      endSession();
      broadcastReset(publicKey);
    },
    onUnreadChange(callback) {
      unreadCallbacks.add(callback);
      callback(unread);
      return () => unreadCallbacks.delete(callback);
    },
  };

  addEventListener("storage", (event) => {
    if (event.key === RESET_PREFIX + publicKey) endSession();
  });

  const queued = (globalThis.Dinghy as { q?: [keyof DinghyApi, ...unknown[]][] } | undefined)?.q;
  globalThis.Dinghy = api;
  for (const [method, ...args] of queued ?? []) {
    (api[method] as (...values: unknown[]) => void)(...args);
  }

  (document.body ?? document.documentElement).append(host);
  if (readToken(publicKey) !== null) load();
}
