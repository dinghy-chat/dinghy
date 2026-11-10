import "./globals.ts";
import {
  type Appearance,
  broadcastReset,
  type DinghyApi,
  type DinghyEvents,
  type Listeners,
  type QueuedCall,
  readToken,
  type WidgetContext,
  writeToken,
} from "./shared.ts";
import { LAUNCHER_LABEL } from "./text.ts";

// This file runs on every page of the host site, so it stays small and makes no request until it
// has a reason to. The chat bundle loads when the visitor opens the chat, the page calls
// identify(), or the visitor already has a token. Everything else lives in the chat bundle.

const script = document.currentScript as HTMLScriptElement | null;
const publicKey = script?.getAttribute("data-key");
if (script && publicKey) {
  const attribute = (name: string) => script.getAttribute(`data-${name}`);
  const number = (name: string) => Number(attribute(name) || Number.NaN);
  const base = new URL(".", script.src).href;
  const mascot = attribute("mascot") !== "false";
  const host = document.createElement("dinghy-chat");
  // Inline and important, because a rule on the host page beats :host. This uses the CSSOM,
  // because a strict style-src blocks a style attribute.
  const style = (name: string, value: string, priority = "important") =>
    host.style.setProperty(name, value, priority);
  style("all", "initial");
  style("display", "block");
  style("position", "fixed");
  let side = "right";
  let x = 16;
  let y = 16;
  let z = 2147483000;
  // A whole number of pixels, or a z-index, from 0 up. Anything else keeps the current value.
  const whole = (value: unknown, current: number) =>
    Number.isInteger(value) && (value as number) >= 0 ? (value as number) : current;
  const configure = (options: Appearance) => {
    // Only a full hex color, because this value goes into the page's CSS.
    for (const name of ["primary", "accent"] as const) {
      const value = options[name];
      if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
        const rgb = Number.parseInt(value.slice(1), 16);
        const light = 299 * (rgb >> 16) + 587 * ((rgb >> 8) & 255) + 114 * (rgb & 255) > 150_000;
        style(`--d-${name}`, value, "");
        style(`--d-${name}-text`, light ? "#0b2239" : "#fff", "");
      }
    }
    if (options.position === "left" || options.position === "right") side = options.position;
    x = whole(options.offsetX, x);
    y = whole(options.offsetY, y);
    z = whole(options.zIndex, z);
    // The chat's panel opens on the same side. --d-x and --d-y keep it inside the window.
    host.setAttribute("data-side", side);
    style("inset", side === "left" ? `auto auto ${y}px ${x}px` : `auto ${x}px ${y}px auto`);
    style("z-index", `${z}`);
    style("--d-x", `${x}px`, "");
    style("--d-y", `${y}px`, "");
  };
  // configure() checks every value, so a missing attribute's null changes nothing.
  configure({
    primary: attribute("primary"),
    accent: attribute("accent"),
    position: attribute("position"),
    offsetX: number("offset-x"),
    offsetY: number("offset-y"),
  } as Appearance);
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    ".launcher{all:initial;position:relative;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:60px;height:60px;border-radius:var(--dinghy-launcher-radius,30px);background:var(--d-accent,#e5352b);color:var(--d-accent-text,#fff);cursor:pointer;box-shadow:0 8px 24px rgb(13 34 64/.26)}.launcher:focus-visible{outline:3px solid var(--d-primary,#0b2239);outline-offset:2px}.boat{background:#fff}.s{fill:var(--d-accent,#e5352b)}.h{fill:var(--d-primary,#0b2239)}.boat svg{animation:b 3.2s ease-in-out infinite}@keyframes b{50%{transform:translateY(-2px)}}@media (prefers-reduced-motion:reduce){.boat svg{animation:none}}",
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
  if (attribute("launcher") === "hidden") launcher.style.display = "none";
  shadow.append(launcher);

  const state = { ready: false, open: false, unread: 0 };
  const listeners: Listeners = {};
  const context: WidgetContext = {
    publicKey,
    base,
    shadow,
    mascot,
    identity: null,
    pageContext: null,
    state,
    listeners,
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

  const api: DinghyApi = {
    open(options) {
      if (context.chat) return context.chat.open(options?.message);
      context.wanted = [options?.message];
      load();
    },
    close() {
      context.wanted = undefined;
      context.chat?.close();
    },
    toggle() {
      if (state.open) api.close();
      else api.open();
    },
    // The chat bundle hides the launcher while the chat is open, with a class of its own.
    show() {
      launcher.style.display = "";
    },
    hide() {
      launcher.style.display = "none";
    },
    identify(next) {
      context.identity = next;
      context.chat?.session();
      load();
    },
    reset() {
      // Only the tab that called reset() clears the token. Another tab can handle this event late,
      // after a new chat has started, and it must not delete that chat's token.
      writeToken(publicKey, null);
      context.identity = null;
      context.chat?.session();
      broadcastReset(publicKey);
    },
    setContext(data) {
      context.pageContext = data;
      context.chat?.context();
    },
    configure,
    on(event, callback) {
      // biome-ignore lint/suspicious/noAssignInExpressions: the shortest form, and this file has no bytes to spare.
      const set = ((listeners as Record<string, Set<typeof callback>>)[event] ??= new Set());
      set.add(callback);
      // Right away, as a badge needs the count now. In a microtask, so a throw cannot stop the
      // queue below.
      if (event === "unread")
        queueMicrotask(() => callback(state.unread as DinghyEvents[typeof event]));
      return () => set.delete(callback);
    },
    get state() {
      return { ...state };
    },
  };
  launcher.onclick = () => api.open();

  const queued = (globalThis.Dinghy as { q?: QueuedCall[] } | undefined)?.q;
  globalThis.Dinghy = api;
  for (const [method, ...args] of queued ?? []) {
    (api[method as keyof DinghyApi] as (...values: unknown[]) => void)(...args);
  }

  (document.body ?? document.documentElement).append(host);
  if (readToken(publicKey) !== null) load();
}
