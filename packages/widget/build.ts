import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build } from "esbuild";
import type { Locale } from "./src/shared.ts";
import type { Texts } from "./src/text.ts";
import { es } from "./src/texts/es.ts";
import { fr } from "./src/texts/fr.ts";

const source = (file: string) => fileURLToPath(new URL(`./src/${file}`, import.meta.url));

const options: BuildOptions = {
  bundle: true,
  minify: true,
  format: "iife",
  // The loader's floor: adoptedStyleSheets and a constructable CSSStyleSheet. Older browsers never
  // run the chat, so lowering syntax below these versions only adds bytes.
  target: ["chrome111", "safari16.4", "firefox111"],
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "silent",
};

// The chat bundles Preact, whose MIT license asks for its notice in every copy. Preact's files carry
// no legal comment for esbuild to keep. The loader bundles no library, and it has no bytes to spare.
const NOTICE =
  "/*! Dinghy widget, MIT. Includes Preact, MIT, (c) Jason Miller: https://github.com/preactjs/preact/blob/main/LICENSE */";

/** Each language but English, which the chat bundle holds, as the file the chat loads. */
const TEXTS: Record<Exclude<Locale, "en">, Texts> = { fr, es };

/**
 * Bundles the loader and the chat, and writes each language's texts as JSON. With no directory, it
 * returns the files in memory.
 */
export async function buildWidget(outdir?: string): Promise<Record<string, Uint8Array>> {
  const output = outdir === undefined ? { write: false, outdir: "out" } : { outdir };
  const results = await Promise.all([
    build({
      ...options,
      ...output,
      entryPoints: { loader: source("loader.ts"), page: source("page.ts") },
    }),
    build({
      ...options,
      ...output,
      entryPoints: { widget: source("chat.tsx") },
      banner: { js: NOTICE },
    }),
  ]);
  const texts = Object.entries(TEXTS).map(
    ([locale, words]) =>
      [`${locale}.json`, new TextEncoder().encode(JSON.stringify(words))] as const,
  );
  if (outdir !== undefined) {
    await mkdir(outdir, { recursive: true });
    await Promise.all(texts.map(([name, bytes]) => writeFile(join(outdir, name), bytes)));
  }
  return Object.fromEntries([
    ...results.flatMap((result) =>
      (result.outputFiles ?? []).map((file) => [file.path.split("/").at(-1) ?? "", file.contents]),
    ),
    ...texts,
  ]);
}
