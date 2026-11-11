import "./globals.ts";
import { loadAppearance, type WidgetContext } from "./shared.ts";

// The full-page chat that a reply email opens, on the Dinghy server's own origin. It sets up what
// the loader sets up on a host site, and widget.js, loaded after this, renders the same chat. The
// link's token is the last part of the address, and it is the visitor's only identity here.

const script = document.currentScript as HTMLScriptElement | null;
const publicKey = script?.getAttribute("data-key");
const token = location.pathname.split("/").pop() ?? "";
if (script !== null && publicKey !== null && publicKey !== undefined) {
  // The CSSOM, because the page's policy allows no inline style.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync("html,body{margin:0;height:100%;background:#f1f3f6}");
  document.adoptedStyleSheets = [sheet];
  const host = document.createElement("dinghy-chat");
  for (const [name, value] of [
    ["display", "block"],
    ["position", "fixed"],
    ["inset", "0"],
  ] as const) {
    host.style.setProperty(name, value);
  }
  const shadow = host.attachShadow({ mode: "open" });
  const base = new URL(".", script.src).href;
  const context: WidgetContext = {
    publicKey,
    base,
    shadow,
    appearance: loadAppearance(base, publicKey),
    // This page has no tag of the host site's, so only the saved settings count.
    attribute: () => undefined,
    page: true,
    identity: token,
    pageContext: null,
    // There is no launcher: the chat is open from the start.
    wanted: [undefined],
    state: { ready: false, open: false, unread: 0 },
    listeners: {},
  };
  globalThis.__dinghy = context;
  document.body.append(host);
}
