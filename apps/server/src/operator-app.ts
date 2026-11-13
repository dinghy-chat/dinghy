import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "./app.ts";

const SHORT_CACHE = "public, max-age=300";
// A browser keeps a font for a year, so a changed font needs a new file name.
const LONG_CACHE = "public, max-age=31536000";

const ASSETS: Record<string, { type: string; cache: string }> = {
  "app.js": { type: "text/javascript; charset=utf-8", cache: SHORT_CACHE },
  "app.css": { type: "text/css; charset=utf-8", cache: SHORT_CACHE },
  "manifest.webmanifest": { type: "application/manifest+json", cache: SHORT_CACHE },
  "icon.svg": { type: "image/svg+xml", cache: SHORT_CACHE },
  // The Visitors page's map, drawn once from Natural Earth.
  "world.svg": { type: "image/svg+xml", cache: SHORT_CACHE },
  "icon-180.png": { type: "image/png", cache: SHORT_CACHE },
  "icon-192.png": { type: "image/png", cache: SHORT_CACHE },
  "icon-512.png": { type: "image/png", cache: SHORT_CACHE },
  "icon-maskable-512.png": { type: "image/png", cache: SHORT_CACHE },
  "fonts/gabarito-latin-wght-normal.woff2": { type: "font/woff2", cache: LONG_CACHE },
  "fonts/hanken-grotesk-latin-wght-normal.woff2": { type: "font/woff2", cache: LONG_CACHE },
};

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Serves the operator app from a fixed list, so a request can never name another file. */
export function registerOperatorApp(
  app: App,
  directory: string,
  {
    billing = false,
    signup = false,
    uploadsOrigin,
  }: { billing?: boolean; signup?: boolean; uploadsOrigin?: string | undefined } = {},
): void {
  const images = uploadsOrigin === undefined ? "" : ` ${uploadsOrigin}`;
  const page = async () => {
    const html = await readFile(join(directory, "index.html"), "utf8").catch(() => null);
    if (html === null) return null;
    return new Response(html, {
      headers: {
        ...SECURITY,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:${images}; connect-src 'self'${images}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    });
  };
  // Signup and the payment's return page exist only on the cloud plan.
  const paths = [
    "/",
    "/invite",
    // The consent page an OAuth client sends the operator to.
    "/oauth/authorize",
    // Every emailed link opens this page, whose button uses the link.
    "/link",
    // Settings and each of its pages. The app shows its first page for a name it does not know.
    "/settings",
    "/settings/:page",
    ...(signup ? ["/signup"] : []),
    ...(billing ? ["/billing/return"] : []),
  ];
  for (const path of paths) {
    app.get(path, async (c) => (await page()) ?? c.notFound());
  }
  // At the root, because a service worker controls only the paths below its own.
  app.get("/sw.js", async (c) => {
    const contents = await readFile(join(directory, "sw.js"), "utf8").catch(() => null);
    if (contents === null) return c.notFound();
    return c.body(contents, 200, {
      ...SECURITY,
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
  });
  app.get("/assets/*", async (c) => {
    const file = c.req.path.slice("/assets/".length);
    const asset = ASSETS[file];
    if (asset === undefined) return c.notFound();
    // As bytes, because a font is not text. Reading it as UTF-8 would corrupt it.
    const contents = await readFile(join(directory, file)).catch(() => null);
    if (contents === null) return c.notFound();
    return c.body(contents, 200, {
      ...SECURITY,
      "content-type": asset.type,
      "cache-control": asset.cache,
    });
  });
}
