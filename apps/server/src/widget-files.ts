import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCALES } from "../../../packages/widget/src/shared.ts";
import type { App } from "./app.ts";

const BUNDLES = ["loader.js", "page.js", "widget.js"];
// English is in the chat bundle. The chat fetches another language's texts from the host page, so
// they answer every origin, as the appearance does.
const TEXTS = LOCALES.filter((locale) => locale !== "en").map((locale) => `${locale}.json`);

/** Serves the widget's files from a fixed list, so a request can never name another file. */
export function registerWidgetFiles(app: App, directory: string): void {
  app.get("/widget/:file", async (c) => {
    const file = c.req.param("file");
    const isTexts = TEXTS.includes(file);
    if (!isTexts && !BUNDLES.includes(file)) return c.notFound();
    const contents = await readFile(join(directory, file), "utf8").catch(() => null);
    if (contents === null) return c.notFound();
    return c.body(contents, 200, {
      "content-type": isTexts
        ? "application/json; charset=utf-8"
        : "text/javascript; charset=utf-8",
      ...(isTexts && { "access-control-allow-origin": "*" }),
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
    });
  });
}
