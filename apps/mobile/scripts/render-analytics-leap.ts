/// <reference types="node" />
// Renders the sprite sheet of the fish that leaps in the Analytics header.
// Run from the repository root: bun apps/mobile/scripts/render-analytics-leap.ts
//
// The top row holds the fish at each angle of its arc, drawn by hand from the web app's FISH so a
// turn never smears the pixels. The row under it holds the splash. The sheet keeps 9 device pixels
// per art pixel, as the scenes do, and its background is transparent.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  FISH_ANGLES,
  FISH_CELL,
  SHEET_H,
  SHEET_W,
  SPLASH_FRAMES,
  SPLASH_H,
  SPLASH_W,
} from "../src/analytics-leap.ts";

// pixel.ts reads the reduced-motion setting when it loads. A script has no browser, so give it one.
Object.assign(globalThis, {
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
});
const { PALETTE, sprite } = await import("../../operator/src/pixel.ts");
type Sprite = { w: number; h: number; rows: string[] };

const SCALE = 9;
const OUT = join(dirname(new URL(import.meta.url).pathname), "..", "assets", "analytics-leap.png");

// The fish swims to the right, so its belly is on its right as it climbs and on its left as it
// dives. The belly takes the darker cream, which still shows on the cream day sky.
const LEVEL = sprite(`
o....oooo..
oo..oooooo.
oooooooooko
ooooooooooo
oo.ooeeeoo.
o....oooo..`);
const UP_30 = sprite(`
.....oooo..
....ooooko.
...oooooooo
oo.ooooooo.
ooooooeeoo.
oooooooo...
.ooo.......
.oo........
..o........`);
const UP_45 = sprite(`
.....oooo.
....oookoo
...ooooooo
...ooooooo
...ooooeoo
...oooeoo.
oo.oooo...
.oooo.....
..oo......
...o......`);
const UP_60 = sprite(`
....ooo.
...oooko
...ooooo
..oooooo
..ooooeo
..oooeeo
...oooo.
ooooo...
oooo....
..oo....`);
const DOWN_30 = sprite(`
..o........
.oo........
.ooo.......
oooooooo...
oooooooooo.
oo.ooooooo.
...oooookoo
....oeeooo.
.....oooo..`);
const DOWN_45 = sprite(`
...o......
..oo......
.oooo.....
oo.oooo...
...oooooo.
...ooooooo
...oeooooo
...ooeooko
....oooooo
.....oooo.`);
const DOWN_60 = sprite(`
..oo....
oooo....
ooooo...
...oooo.
..oeoooo
..oeoooo
..ooeooo
...oooko
...ooooo
....ooo.`);

/** The fish turned a quarter: nose up, or nose down with `down`, its belly kept underneath. */
function quarter(art: Sprite, down: boolean): Sprite {
  const rows: string[] = [];
  for (let y = 0; y < art.w; y += 1) {
    let row = "";
    for (let x = 0; x < art.h; x += 1) {
      row += down ? art.rows[art.h - 1 - x]?.[y] : art.rows[x]?.[art.w - 1 - y];
    }
    rows.push(row);
  }
  return { w: art.h, h: art.w, rows };
}

const FISH: Record<(typeof FISH_ANGLES)[number], Sprite> = {
  90: quarter(LEVEL, false),
  60: UP_60,
  45: UP_45,
  30: UP_30,
  0: LEVEL,
  [-30]: DOWN_30,
  [-45]: DOWN_45,
  [-60]: DOWN_60,
  [-90]: quarter(LEVEL, true),
};

// Water thrown up in the crest's light blue, with foam on the surface row, the bottom one.
const SPLASH = [
  sprite(`
...l.l...
..l...l..
.ww...ww.`),
  sprite(`
..l...l..
.........
.l.....l.
w.......w`),
  sprite(`
.l.....l.
.........
.........
l.......l`),
  sprite(`
l.......l
.........
.........`),
];

const cells: (string | null)[][] = Array.from({ length: SHEET_H }, () =>
  Array<string | null>(SHEET_W).fill(null),
);
function blit(art: Sprite, left: number, top: number) {
  art.rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i += 1) {
      const color = PALETTE[row[i] as keyof typeof PALETTE];
      const line = cells[top + j];
      if (color !== undefined && line !== undefined) line[left + i] = color;
    }
  });
}

/** Places a fish so the middle of its pixels sits on its cell's middle, the point the path follows. */
function center(art: Sprite): [number, number] {
  let x = 0;
  let y = 0;
  let count = 0;
  art.rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i += 1) {
      if (row[i] === ".") continue;
      x += i + 0.5;
      y += j + 0.5;
      count += 1;
    }
  });
  return [Math.round(FISH_CELL / 2 - x / count), Math.round(FISH_CELL / 2 - y / count)];
}

FISH_ANGLES.forEach((angle, index) => {
  const art = FISH[angle];
  const [left, top] = center(art);
  blit(art, index * FISH_CELL + left, top);
});
// Cell 0 of the splash row stays empty. The splash sits on the cell's bottom row.
if (SPLASH.length !== SPLASH_FRAMES - 1) throw new Error("The splash needs one sprite per frame.");
SPLASH.forEach((art, index) => {
  blit(art, (index + 1) * SPLASH_W, FISH_CELL + SPLASH_H - art.h);
});

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** An RGBA PNG, transparent where no color is set. */
function png(grid: (string | null)[][]): Buffer {
  const width = SHEET_W * SCALE;
  const height = SHEET_H * SCALE;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = grid[Math.floor(y / SCALE)] ?? [];
    const start = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const hex = row[Math.floor(x / SCALE)];
      if (!hex) continue;
      const at = start + 1 + x * 4;
      raw[at] = Number.parseInt(hex.slice(1, 3), 16);
      raw[at + 1] = Number.parseInt(hex.slice(3, 5), 16);
      raw[at + 2] = Number.parseInt(hex.slice(5, 7), 16);
      raw[at + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(OUT, png(cells));
console.log("Wrote assets/analytics-leap.png");
