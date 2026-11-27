/**
 * Renders a 1200x630 share image for each content page into site/public/img/og, with Chromium and
 * the site's own styles, fonts and water. The images are committed, because the Site workflow does
 * not run Chromium. Run `bun run og:build` after a page's title, illustration or logo changes.
 * It needs uv, which runs Pillow to cut each image to a palette of 256 colors, a third of its size.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";
import { CONTENT_PAGES, escape, headingOf, OG_SIZE, ogImageFor, PUBLIC } from "./build-docs.ts";

/** A made-up origin, so the card loads the site's files by their root-relative paths. */
const ORIGIN = "http://og.dinghy.test";

const STYLE = `
body { width: 1200px; height: 630px; margin: 0; overflow: hidden; background: var(--yellow); }
.og-top { position: absolute; inset: 44px 64px auto; display: flex; justify-content: space-between; align-items: center; }
.og-site { color: var(--navy); font: 600 24px/1 var(--body); }
.og-main { position: absolute; inset: 120px 64px 150px; display: flex; align-items: center; gap: 56px; }
.og-text { flex: 1; min-width: 0; }
.og-kicker { margin: 0 0 14px; color: var(--navy-light); font: 700 24px/1 var(--body); }
.og-text h1 { margin: 0; font-size: 72px; line-height: 1.06; }
.og-text:only-child h1 { font-size: 88px; }
.og-art { flex: none; width: 420px; height: 280px; border-radius: 28px; }
.og-logo { flex: none; display: grid; place-items: center; width: 220px; height: 220px; margin-right: 60px; border-radius: 48px; background: #fff; }
.og-logo img { width: 128px; height: 128px; }
.og-water { position: absolute; inset: auto 0 0; height: 150px; }
`;

/** Draws the docs band's water with its boat, still, then shrinks the title until it fits in three lines. */
const SCRIPT = `
import { startScene } from "/js/scene.js";
import { FAR, MIDDLE, NEAR } from "/js/water.js";
startScene(document.querySelector(".og-water"), {
  layers: [{ level: 0.3, swell: 3, ...FAR }, { level: 0.54, swell: 4, ...MIDDLE }, { level: 0.8, swell: 4.5, ...NEAR }],
  frontFrom: 2,
  boats: [{ size: [58, 76], layer: 1, at: 0.5, speed: 10 }],
});
await document.fonts.ready;
await Promise.all([...document.images].map((image) => image.decode()));
const title = document.querySelector("h1");
let size = parseFloat(getComputedStyle(title).fontSize);
while (title.offsetHeight > size * 1.06 * 3 + 1 && size > 40) title.style.fontSize = (size -= 2) + "px";
document.body.dataset.ready = "";
`;

function card(page: (typeof CONTENT_PAGES)[number]): string {
  const art = page.image
    ? `<img class="og-art" src="/img/illustrations/cards/${page.image}.webp" alt="">`
    : page.logo
      ? `<span class="og-logo"><img src="/img/logos/${page.logo}.svg" alt=""></span>`
      : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><link rel="stylesheet" href="/css/site.css"><style>${STYLE}</style></head>
<body>
  <div class="og-top"><span class="logo"><img src="/favicon.svg" width="40" height="40" alt="">dinghy</span><span class="og-site">dinghy.chat</span></div>
  <div class="og-main"><div class="og-text"><p class="og-kicker">${escape(page.group)}</p><h1>${escape(headingOf(page))}</h1></div>${art}</div>
  <div class="water og-water"><canvas data-water-back></canvas><div class="water-boats" data-boats></div><canvas data-water-front></canvas></div>
  <script type="module">${SCRIPT}</script>
</body>
</html>`;
}

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: OG_SIZE[0], height: OG_SIZE[1] }, reducedMotion: "reduce" });
let html = "";
await tab.route(`${ORIGIN}/**`, (route) => {
  const { pathname } = new URL(route.request().url());
  return pathname === "/"
    ? route.fulfill({ body: html, contentType: "text/html" })
    : route.fulfill({ path: join(PUBLIC, pathname) });
});
for (const page of CONTENT_PAGES) {
  html = card(page);
  await tab.goto(`${ORIGIN}/`);
  await tab.waitForSelector("body[data-ready]");
  const file = join(PUBLIC, ogImageFor(page));
  mkdirSync(dirname(file), { recursive: true });
  await tab.screenshot({ path: file, type: "png" });
}
await browser.close();

const QUANTIZE = `
import sys
from PIL import Image
for file in sys.argv[1:]:
    Image.open(file).convert("RGB").quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(file, optimize=True)
`;
const files = CONTENT_PAGES.map((page) => join(PUBLIC, ogImageFor(page)));
const quantized = spawnSync("uvx", ["--with", "pillow", "python", "-I", "-c", QUANTIZE, ...files], { stdio: "inherit" });
if (quantized.status !== 0) throw new Error("uvx could not cut the share images to 256 colors.");
console.log(`Wrote ${CONTENT_PAGES.length} share images.`);
