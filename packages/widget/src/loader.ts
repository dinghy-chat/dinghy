import "./globals.ts";
import { LAUNCHER_CSS, LAUNCHER_ICONS, type LauncherKind, textOn } from "./launcher.ts";
import {
  type Appearance,
  CONTEXT_VERSION,
  type DinghyApi,
  type DinghyEvents,
  forgetVisitor,
  type Listeners,
  loadAppearance,
  type QueuedCall,
  RESET_PREFIX,
  readToken,
  type WidgetContext,
  type WidgetSettings,
} from "./shared.ts";
import { DEFAULT_TITLE, LAUNCHER_LABEL } from "./text.ts";

// This file runs on every page of the host site, so it stays small. It asks once for the saved
// look, which the browser caches for 5 minutes, and sends a small beat a minute for the live view.
// The chat bundle loads when the visitor opens the chat, the page calls identify(), or the visitor
// already has a token. Everything else lives in the chat bundle.

// How often a tab that shows tells the live view it is still there.
const BEAT_EVERY_MS = 60_000;

type Color = "primary" | "accent";

const script = document.currentScript as HTMLScriptElement | null;
const publicKey = script?.dataset.key;
if (script && publicKey) {
  // By its dataset name: data-offset-x is offsetX.
  const attribute = (name: string) => script.dataset[name];
  const number = (name: string) => +(attribute(name) || NaN);
  const base = new URL(".", script.src).href;
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
  // The saved colors can be null, which keeps the widget's own.
  const paint = (options: Omit<Appearance, Color> & Partial<Pick<WidgetSettings, Color>>) => {
    // Only a full hex color, because this value goes into the page's CSS. A value that is not a
    // string turns into one, such as "null", which fails the test.
    for (const name of ["primary", "accent"] as const) {
      const value = options[name] as string;
      if (/^#[0-9a-f]{6}$/i.test(value)) {
        style(`--d-${name}`, value, "");
        style(`--d-${name}-text`, textOn(value), "");
      }
    }
    if (options.position === "left" || options.position === "right") side = options.position;
    x = whole(options.offsetX, x);
    y = whole(options.offsetY, y);
    z = whole(options.zIndex, z);
    // The chat's panel opens on the same side. --d-x and --d-y keep it inside the window.
    host.dataset.side = side;
    style("inset", side === "left" ? `auto auto ${y}px ${x}px` : `auto ${x}px ${y}px auto`);
    style("z-index", `${z}`);
    style("--d-x", `${x}px`, "");
    style("--d-y", `${y}px`, "");
  };
  // The page's own values, from the tag's attributes and configure(), which win over the saved ones.
  // paint() checks every value, so a missing attribute or another data attribute changes nothing.
  const own = {
    ...script.dataset,
    offsetX: number("offsetX"),
    offsetY: number("offsetY"),
  } as Appearance;
  const configure = (options: Appearance) => paint(Object.assign(own, options));
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(LAUNCHER_CSS);
  shadow.adoptedStyleSheets = [sheet];
  // No type: a shadow root holds no form, so the button submits nothing.
  const launcher = document.createElement("button");
  launcher.setAttribute("aria-label", LAUNCHER_LABEL);
  shadow.append(launcher);

  const appearance = loadAppearance(base, publicKey);
  const state = { ready: false, open: false, unread: 0, conversation: false };
  const listeners: Listeners = {};
  const context: WidgetContext = {
    version: CONTEXT_VERSION,
    publicKey,
    base,
    shadow,
    appearance,
    // configure() writes to `own` too, so its locale reaches the chat.
    attribute: (name) => (own as Record<string, string | undefined>)[name],
    identity: null,
    hostToken: null,
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
    // A script added this way is async already.
    bundle.src = `${base}widget.js`;
    // A brief network failure must not disable the launcher until a reload.
    bundle.onerror = () => {
      loading = false;
      bundle.remove();
    };
    document.head.append(bundle);
  };

  /**
   * reset() here or in another tab. The loader handles it, because the chat bundle may not be
   * loaded yet, and the next visitor in this browser must not inherit this one's data.
   */
  const endSession = () => {
    context.identity = context.pageContext = context.hostToken = null;
    context.wanted = undefined;
    context.chat?.session();
  };
  // The removal right after the signal fires an event too, with no new value.
  addEventListener("storage", (event) => {
    if (event.newValue && event.key === RESET_PREFIX + publicKey) endSession();
  });

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
      context.hostToken = null;
      context.chat?.session();
      load();
    },
    reset() {
      // Only the tab that called reset() clears the token. Another tab can handle this event late,
      // after a new chat has started, and it must not delete that chat's token.
      forgetVisitor(publicKey);
      endSession();
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
      if (event === "unread" || event === "conversation")
        queueMicrotask(() =>
          callback((state as Record<string, unknown>)[event] as DinghyEvents[typeof event]),
        );
      return () => set.delete(callback);
    },
    get state() {
      return { ...state };
    },
  };
  launcher.onclick = () => api.open();

  // The chat goes on the page once the saved look arrives, so the launcher never changes shape.
  appearance.then((saved) => {
    // The workspace serves no widget, so the page shows nothing.
    if (saved === null) return;
    if (saved) {
      paint(saved);
      // The CSS reads the page's own --dinghy-radius first, so that still wins.
      style("--d-radius", `${saved.radius}px`, "");
    }
    paint(own);
    const kind = attribute("launcher") ?? saved?.launcher;
    // A hidden launcher still has a drawing, for show(). hasOwn, so "toString" is no kind.
    const drawn = (Object.hasOwn(LAUNCHER_ICONS, kind as string) ? kind : "bubble") as LauncherKind;
    launcher.className = `launcher ${drawn}`;
    launcher.innerHTML = LAUNCHER_ICONS[drawn];
    // As text, never markup: the title is the workspace's own.
    if (drawn === "label")
      launcher.appendChild(document.createElement("b")).textContent = saved?.title ?? DEFAULT_TITLE;
    if (kind === "hidden") api.hide();
    (document.body ?? document.documentElement).append(host);

    // The operators' live view: a beat now and each minute while the tab shows. The tab's ID lives
    // only in this page's memory: no cookie and no storage.
    const tab = Math.random().toString(36).slice(2, 14);
    const url = `${base}../v1/widget/${publicKey}/`;
    let referrer: string | undefined = document.referrer;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      // A signed-in visitor's own token, once the chat has one, so the contact gets its country.
      const { identity } = context;
      const token =
        identity === null
          ? readToken(publicKey)
          : typeof identity === "string"
            ? identity
            : context.hostToken;
      fetch(`${url}beat`, {
        method: "POST",
        keepalive: true,
        headers: {
          "content-type": "application/json",
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({
          tab,
          page: location.origin + location.pathname,
          title: document.title,
          referrer,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      }).catch(() => {});
      referrer = undefined;
    };
    // At once, as on() calls back right away, and again when a chat starts, so the operators see
    // who is chatting without waiting a minute.
    api.on("conversation", beat);
    setInterval(beat, BEAT_EVERY_MS);
    addEventListener("visibilitychange", beat);
    addEventListener("pagehide", () => navigator.sendBeacon(`${url}leave?tab=${tab}`));
  });

  const queued = (globalThis.Dinghy as { q?: QueuedCall[] } | undefined)?.q;
  globalThis.Dinghy = api;
  for (const [method, ...args] of queued ?? []) {
    (api[method as keyof DinghyApi] as (...values: unknown[]) => void)(...args);
  }

  if (readToken(publicKey) !== null) load();
}
