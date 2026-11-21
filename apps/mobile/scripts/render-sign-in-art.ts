/// <reference types="node" />
// Renders the sign-in backgrounds from the website hero: its boat, clouds, gulls, sun and water.
// Run from the repository root: bun apps/mobile/scripts/render-sign-in-art.ts
//
// Chromium loads the site's own modules from site/public, so the boat is boat.js, the water heights,
// colors and wavelets come from water.js, and the clouds and gulls are the hero's SVGs. The water is
// drawn on a grid of 3 pt cells, the step of the other mobile header scenes. Every image holds 3 px
// per pt. The frame is fixed at the still moment, so the output is the same on every run.
//
// The screen covers its window with the image. The portrait image is as wide as an iPad (3:4), and
// the landscape one as wide as the widest phone (2.17:1), so a crop only trims the sides and the
// scene keeps its height on every screen. Nothing is drawn above 40% of the height, where the copy
// sits, and the boat floats above 75%, clear of the Sign in button.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const SITE = join(ROOT, "site", "public");
const OUT = join(ROOT, "apps", "mobile", "assets");
const ORIGIN = "https://site.invalid";
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};

/**
 * One image. Sizes are in site pixels (pt), positions are shares of the width and height.
 * `levels` are the far, middle and near swells' heights, as in hero.js.
 */
type Scene = {
  file: string;
  cols: number;
  rows: number;
  levels: [number, number, number];
  sun: { x: number; size: number };
  boat: { x: number; size: number };
  far: { x: number; size: number };
  clouds: { x: number; y: number; width: number; opacity?: number }[];
  gulls: { x: number; y: number; width: number }[];
};

const SCENES: Scene[] = [
  {
    file: "sign-in-portrait.png",
    cols: 217,
    rows: 289,
    levels: [0.6, 0.7, 0.83],
    sun: { x: 0.68, size: 120 },
    boat: { x: 0.5, size: 150 },
    far: { x: 0.3, size: 48 },
    clouds: [
      { x: 0.22, y: 0.43, width: 128 },
      { x: 0.64, y: 0.405, width: 92 },
      { x: 0.08, y: 0.52, width: 64, opacity: 0.8 },
    ],
    gulls: [
      { x: 0.36, y: 0.5, width: 30 },
      { x: 0.43, y: 0.535, width: 22 },
    ],
  },
  {
    file: "sign-in-morning.png",
    cols: 312,
    rows: 144,
    levels: [0.5, 0.64, 0.82],
    sun: { x: 0.75, size: 84 },
    boat: { x: 0.5, size: 104 },
    far: { x: 0.27, size: 42 },
    clouds: [
      { x: 0.05, y: 0.4, width: 110 },
      { x: 0.86, y: 0.37, width: 80 },
    ],
    gulls: [
      { x: 0.58, y: 0.4, width: 30 },
      { x: 0.635, y: 0.44, width: 22 },
    ],
  },
];

// Runs in the page. It returns the PNG as a data URL.
const RENDER = `
const { Boat } = await import("/js/boat.js");
const { CREAM, FAR, MIDDLE, NEAR, STILL_MOMENT, Water } = await import("/js/water.js");
const scene = window.SCENE;
const CELL = 3;
const PX = 3;
const W = scene.cols * CELL;
const H = scene.rows * CELL;
const NAVY = "#0b2239";
const YELLOW = "#ffc917";
const SWELLS = [3, 4, 4.5];
const t = STILL_MOMENT;

const host = document.createElement("div");
host.style.cssText = "position:absolute;left:0;top:0;width:" + W + "px;height:" + H + "px";
host.innerHTML = "<canvas data-water-back></canvas><canvas data-water-front></canvas>";
document.body.append(host);
const layers = [FAR, MIDDLE, NEAR].map((colors, i) => ({ level: scene.levels[i], swell: SWELLS[i], ...colors }));
const water = new Water(host, { layers });

const out = document.createElement("canvas");
out.width = W * PX;
out.height = H * PX;
const g = out.getContext("2d");
g.scale(PX, PX);

const load = (src) => new Promise((done, fail) => {
  const image = new Image();
  image.onload = () => done(image);
  image.onerror = fail;
  image.src = src;
});
const svgImage = (markup) =>
  load("data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')));

// Sky, then the sun with its two glows, sitting low behind the far swell as on the site.
g.fillStyle = YELLOW;
g.fillRect(0, 0, W, H);
const sunX = scene.sun.x * W;
const sunY = water.surfaceY(sunX, 0, t) - scene.sun.size * 0.06;
const glow = (radius, color) => {
  g.fillStyle = color;
  g.beginPath();
  g.arc(sunX, sunY, radius, 0, Math.PI * 2);
  g.fill();
};
glow(scene.sun.size / 2 + scene.sun.size * 0.29, "rgb(255 248 223 / .2)");
glow(scene.sun.size / 2 + scene.sun.size * 0.13, "rgb(255 248 223 / .42)");
glow(scene.sun.size / 2, CREAM);

const cloud = await load("/img/cloud.svg");
for (const c of scene.clouds) {
  g.globalAlpha = c.opacity ?? 1;
  g.drawImage(cloud, c.x * W, c.y * H, c.width, (c.width * 56) / 120);
}
g.globalAlpha = 1;
const gullMarkup = document.querySelector(".gull").outerHTML.replace("currentColor", NAVY);
const gull = await svgImage(gullMarkup.replace("<svg ", '<svg width="30" height="14" '));
for (const b of scene.gulls) g.drawImage(gull, b.x * W, b.y * H, b.width, (b.width * 14) / 30);

// The water on a grid of cells. A cell takes the color of the layer whose surface is above it.
const cols = scene.cols;
const rows = scene.rows;
const grid = (fill) => Array.from({ length: rows }, () => Array(cols).fill(fill));
const back = grid(null);
const front = grid(null);
const mix = (a, b, share) => {
  const p = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * share).toString(16).padStart(2, "0")).join("");
};
const row = (y) => Math.round(y / CELL);
const top = (i, col) => row(water.surfaceY((col + 0.5) * CELL, i, t));
const set = (cells, r, c, color) => {
  if (r >= 0 && r < rows && c >= 0 && c < cols) cells[r][c] = color;
};
const under = (cells, r, c) => (r >= 0 && r < rows && c >= 0 && c < cols ? cells[r][c] : null);

function paintLayer(cells, i) {
  const { fill, crest } = layers[i];
  for (let c = 0; c < cols; c++) {
    const surface = top(i, c);
    for (let r = Math.max(0, surface); r < rows; r++) cells[r][c] = fill;
    set(cells, surface, c, crest);
  }
  // The wavelets, as in Water.drawWavelets: a dash with its middle third raised one cell.
  const nextLevel = layers[i + 1]?.level ?? 1;
  const dash = mix(fill, crest, 0.6);
  for (const w of water.wavelets) {
    if (w.layer !== i) continue;
    const surface = water.surfaceY(w.x, i, t);
    const y = surface + (nextLevel * H - surface) * w.depth + Math.sin(t + w.x * 0.02) * 1.5;
    if (y < surface + 7) continue;
    const from = Math.round(w.x / CELL);
    const length = Math.max(3, Math.round(w.length / CELL));
    for (let k = 0; k < length; k++) {
      const lift = k >= length / 3 && k < (2 * length) / 3 ? 1 : 0;
      if (under(cells, row(y) - lift, from + k) === fill) set(cells, row(y) - lift, from + k, dash);
    }
  }
}

// The sun's path, as in hero.js drawSunPath: seven fading bars under the sun.
function paintSunPath(cells) {
  for (let i = 0; i < 7; i++) {
    const y = water.surfaceY(sunX, 0, t) + 7 + i * 5.5;
    const width = (46 - i * 3) * (0.65 + 0.35 * Math.sin(t * 1.8 + i * 1.7)) * (scene.sun.size / 120);
    const left = sunX - width / 2 + Math.sin(t + i) * 8;
    for (let c = Math.round(left / CELL); c < Math.round((left + width) / CELL); c++) {
      const color = under(cells, row(y), c);
      if (color) set(cells, row(y), c, mix(color, CREAM, 0.75 - i * 0.08));
    }
  }
}

// Water.float places each boat. A stand-in records where, and its shadow is drawn in cells.
const floats = [];
function float(size, x, layer, colors) {
  const boat = { size, height: (size * 120) / 140, place: (px, py, angle) => floats.push({ size, px, py, angle, colors }) };
  const { surface } = water.float(boat, x, layer, t);
  const rx = size * 0.42;
  const ry = Math.max(2.5, size * 0.035);
  const cy = surface + size * 0.07;
  for (let r = row(cy - ry); r <= row(cy + ry); r++) {
    for (let c = Math.round((x - rx) / CELL); c <= Math.round((x + rx) / CELL); c++) {
      const dx = ((c + 0.5) * CELL - x) / rx;
      const dy = ((r + 0.5) * CELL - cy) / ry;
      const color = under(back, r, c);
      if (dx * dx + dy * dy <= 1 && color) set(back, r, c, mix(color, NAVY, 0.22));
    }
  }
}

paintLayer(back, 0);
paintSunPath(back);
float(scene.far.size, scene.far.x * W, 0, { main: CREAM, jib: CREAM });
paintLayer(back, 1);
float(scene.boat.size, scene.boat.x * W, 1, {});
paintLayer(front, 2);

const draw = (cells) => {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!cells[r][c]) continue;
      g.fillStyle = cells[r][c];
      g.fillRect(c * CELL, r * CELL, CELL, CELL);
    }
  }
};
draw(back);
// The far boat sits in the far layer, so the middle layer's cells cover its hull as on the site.
for (const f of floats) {
  const holder = document.createElement("div");
  new Boat(holder, f.size, f.colors);
  const art = await svgImage(holder.querySelector("svg").outerHTML.replace("<svg ", '<svg width="140" height="120" '));
  const h = (f.size * 120) / 140;
  g.save();
  g.translate(f.px - f.size / 2, f.py);
  g.translate(f.size * 0.5, h * 0.88);
  g.rotate((f.angle * Math.PI) / 180);
  g.translate(-f.size * 0.5, -h * 0.88);
  g.drawImage(art, 0, 0, f.size, h);
  g.restore();
}
draw(front);
window.RESULT = out.toDataURL("image/png");
`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = join(SITE, path === "/" ? "index.html" : path);
    return route.fulfill({
      body: readFileSync(file),
      contentType: TYPES[extname(file)] ?? "application/octet-stream",
    });
  });
  // The page holds the hero's gull markup. The site's own scripts are not run.
  const hero = readFileSync(join(SITE, "index.html"), "utf8").match(
    /<svg class="gull gull-a"[\s\S]*?<\/svg>/,
  );
  if (!hero) throw new Error("The gull is missing from site/public/index.html.");
  await page.route(`${ORIGIN}/render`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><body>${hero[0]}</body>` }),
  );
  await page.goto(`${ORIGIN}/render`);
  for (const scene of SCENES) {
    await page.evaluate((value) => {
      Object.assign(globalThis, { SCENE: value, RESULT: undefined });
    }, scene);
    await page.addScriptTag({ type: "module", content: RENDER });
    await page.waitForFunction(() => "RESULT" in globalThis && Reflect.get(globalThis, "RESULT"));
    const url = await page.evaluate(() => String(Reflect.get(globalThis, "RESULT")));
    const png = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    writeFileSync(join(OUT, scene.file), png);
    console.log(`${scene.file}: ${scene.cols * 9} x ${scene.rows * 9} px, ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
