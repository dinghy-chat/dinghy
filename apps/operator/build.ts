import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Bundles the operator app into a directory. */
export async function buildOperator(outdir: string): Promise<void> {
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: { app: here("./src/main.tsx") },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "react",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    outdir,
  });
  await mkdir(`${outdir}/fonts`, { recursive: true });
  for (const file of [
    "index.html",
    "app.css",
    "manifest.webmanifest",
    "icon.svg",
    "world.svg",
    "icon-180.png",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
    "sw.js",
    "fonts/gabarito-latin-wght-normal.woff2",
    "fonts/hanken-grotesk-latin-wght-normal.woff2",
    "fonts/OFL.txt",
  ]) {
    await copyFile(here(`./public/${file}`), `${outdir}/${file}`);
  }
}
