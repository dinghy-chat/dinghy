import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "./app.ts";

const FILES = ["loader.js", "widget.js"];

/** Serves the widget bundles from a fixed list, so a request can never name another file. */
export function registerWidgetFiles(app: App, directory: string): void {
  app.get("/widget/:file", async (c) => {
    const file = c.req.param("file");
    if (!FILES.includes(file)) return c.notFound();
    const contents = await readFile(join(directory, file), "utf8").catch(() => null);
    if (contents === null) return c.notFound();
    return c.body(contents, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
    });
  });
}
