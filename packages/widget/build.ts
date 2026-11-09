import { fileURLToPath } from "node:url";
import { type BuildOptions, build } from "esbuild";

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

/** Bundles the loader and the chat. With no directory, it returns the files in memory. */
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
  return Object.fromEntries(
    results.flatMap((result) =>
      (result.outputFiles ?? []).map((file) => [file.path.split("/").at(-1) ?? "", file.contents]),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildWidget(fileURLToPath(new URL("./dist", import.meta.url)));
}
