/// <reference types="node" />
// Renders the Contacts and Visitors header scenes from the operator web app's pixel sprites, and
// the patches for the header movements in src/header-motion.ts.
// Run from the repository root: bun apps/mobile/scripts/render-header-scenes.ts
//
// Each scene is 160 × 50 art pixels. One art pixel is 3 pt, and the PNG holds 9 device pixels per
// art pixel, so the image is 480 × 150 pt at @3x, the size of the Analytics scene. The screen anchors
// it right and never scales it, so the pixels stay square on every phone width.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { MOVEMENTS, type Rect } from "../src/header-motion.ts";

// pixel.ts reads the reduced-motion setting when it loads. A script has no browser, so give it one.
Object.assign(globalThis, {
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
});
const { PALETTE, sprite } = await import("../../operator/src/pixel.ts");
const { CLOUD_A, CLOUD_B, GULL_STAND, NOTE, POST, SKIFF, TELESCOPE } = await import(
  "../../operator/src/gull-sprites.ts"
);
type Sprite = { w: number; h: number; rows: string[] };

const W = 160;
const H = 50;
const SCALE = 9;
const OUT = join(dirname(new URL(import.meta.url).pathname), "..", "assets");

// The same sun and moon as the Analytics scene.
const SUN = sprite(`
.....y.....
..yyyyyyy..
.yhhyyyyyy.
yhyyyyyyyyy
yyyyyyyyyyy
yyyyyyyyyyy
yyyyyyyyyyy
yyyyyyyyyyy
.yyyyyyyyy.
..yyyyyyy..
.....y.....`);
const MOON = sprite(`
.cc...
.c....
cc....
cc....
ccc...
.cc...
.ccccc
....c.`);

type Mode = {
  sky: string;
  shore: string;
  crest: string;
  body: string;
  deep: string;
  glint: string;
  /** Letters drawn as other letters, such as the clouds' pale cream on the day sky. */
  cloud: Record<string, string>;
};
const MODES: Record<"day" | "night", Mode> = {
  day: {
    sky: PALETTE.c,
    shore: "#fdfefd",
    crest: PALETTE.l,
    body: PALETTE.b,
    deep: PALETTE.B,
    glint: PALETTE.s,
    cloud: { "1": "4", "2": "5", "3": "6" },
  },
  // The night water is the Analytics scene's: crest, body and deep from the design review.
  night: {
    sky: "#17335c",
    shore: "#14232c",
    crest: "#3f75d9",
    body: "#0f47b4",
    deep: "#0b2a5e",
    glint: "#3f75d9",
    cloud: {},
  },
};

/** The water's top row at each column, the same swell as the Analytics scene. */
function surface(x: number): number {
  if (x < 16 || (x >= 90 && x < 105)) return 38;
  if ((x >= 45 && x < 61) || (x >= 135 && x < 146)) return 36;
  return 37;
}
const GLINTS: [number, number][] = [
  [11, 40],
  [114, 40],
  [122, 41],
  [77, 42],
  [85, 43],
  [40, 44],
  [48, 45],
  [153, 45],
  [3, 46],
];

function canvas(mode: Mode) {
  const cells: string[][] = Array.from({ length: H }, () => Array<string>(W).fill(mode.sky));
  const fill = (x: number, y: number, color: string) => {
    if (x >= 0 && x < W && y >= 0 && y < H) (cells[y] as string[])[x] = color;
  };
  const blit = (
    art: Sprite,
    left: number,
    top: number,
    swap: Record<string, string> = {},
    rows = art.h,
  ) => {
    art.rows.slice(0, rows).forEach((row, j) => {
      for (let i = 0; i < row.length; i += 1) {
        const letter = swap[row[i] ?? "."] ?? row[i] ?? ".";
        const color = PALETTE[letter as keyof typeof PALETTE];
        if (color !== undefined) fill(left + i, top + j, color);
      }
    });
  };
  const water = () => {
    for (let x = 0; x < W; x += 1) {
      const top = surface(x);
      for (let y = top; y < H; y += 1) {
        fill(x, y, y < top + 2 ? mode.crest : y < top + 7 ? mode.body : mode.deep);
      }
      // The shoreline in the page color closes the water, as on the other tabs.
      if ((x + 7) % 35 < 10) fill(x, 47, mode.shore);
      if ((x + 24) % 35 >= 10) fill(x, 48, mode.shore);
      fill(x, 49, mode.shore);
    }
    for (const [x, y] of GLINTS) for (let i = 0; i < 3; i += 1) fill(x + i, y, mode.glint);
  };
  /** Dashes along the waterline where something stands in the water. */
  const lapping = (from: number, to: number, y: number) => {
    for (let x = from; x <= to; x += 1) if (x % 4 < 2) fill(x, y, PALETTE.w);
  };
  return { cells, fill, blit, water, lapping };
}

function stars(scene: ReturnType<typeof canvas>, points: [number, number][]) {
  for (const [x, y] of points) scene.fill(x, y, PALETTE.c);
}

/** The gull at home: on its post, with a letter in the mailbox beside it. */
function contacts(name: "day" | "night") {
  const mode = MODES[name];
  const scene = canvas(mode);
  if (name === "day") {
    scene.blit(CLOUD_A, 92, 7, mode.cloud);
    scene.blit(SUN, 143, 3);
  } else {
    scene.blit(MOON, 146, 6);
    stars(scene, [
      [98, 9],
      [110, 4],
      [120, 13],
      [137, 3],
      [141, 20],
      [156, 15],
      [104, 18],
    ]);
  }
  scene.water();
  // The mailbox: the letter on a pole, standing in the water.
  for (let y = 26; y < 41; y += 1) scene.fill(110, y, PALETTE.k);
  scene.blit(NOTE, 107, 21);
  scene.lapping(108, 112, 37);
  // The post rises 15 art pixels above the water, and the gull stands on it.
  const postX = 126;
  const postTop = 22;
  scene.blit(POST, postX, postTop, {}, 21);
  scene.lapping(postX - 2, postX + 9, 37);
  scene.blit(GULL_STAND, postX - 5, postTop - GULL_STAND.h);
  return scene.cells;
}

/**
 * The lookout: the gull on its post with the telescope, turned toward two skiffs. `drift` moves the
 * near skiff left, for the Visitors movement.
 */
function visitors(name: "day" | "night", drift = 0) {
  const mode = MODES[name];
  const scene = canvas(mode);
  if (name === "day") {
    scene.blit(CLOUD_B, 122, 9, mode.cloud);
    scene.blit(SUN, 145, 2);
  } else {
    scene.blit(MOON, 137, 4);
    stars(scene, [
      [120, 4],
      [127, 12],
      [144, 6],
      [153, 17],
      [115, 15],
      [158, 3],
    ]);
  }
  scene.water();
  const postX = 104;
  const postTop = 24;
  scene.blit(POST, postX, postTop, {}, 19);
  scene.lapping(postX - 2, postX + 9, 37);
  const gullX = postX - 5;
  const gullY = postTop - GULL_STAND.h;
  scene.blit(GULL_STAND, gullX, gullY);
  scene.blit(TELESCOPE, gullX + 10, gullY - 1);
  // Two skiffs on the swell, the far one with a yellow sail.
  // By day the cream jib would vanish into the cream sky, so it takes the darker cream.
  const jib = name === "day" ? { c: "e" } : {};
  scene.blit(SKIFF, 127 - drift, surface(127) - 6, jib);
  scene.blit(SKIFF, 146, surface(146) - 6, { ...jib, r: "y" });
  return scene.cells;
}

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

function png(cells: string[][], scale = SCALE): Buffer {
  const width = (cells[0] as string[]).length * scale;
  const height = cells.length * scale;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = cells[Math.floor(y / scale)] as string[];
    const start = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const hex = row[Math.floor(x / scale)] as string;
      const at = start + 1 + x * 3;
      raw[at] = Number.parseInt(hex.slice(1, 3), 16);
      raw[at + 1] = Number.parseInt(hex.slice(3, 5), 16);
      raw[at + 2] = Number.parseInt(hex.slice(5, 7), 16);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Reads an 8-bit RGB or RGBA PNG, such as the Inbox and Settings art, as hex colors per pixel. */
function readPng(path: string): string[][] {
  const file = readFileSync(path);
  const parts: Buffer[] = [];
  let width = 0;
  let height = 0;
  let depth = 3;
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at);
    const type = file.toString("ascii", at + 4, at + 8);
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`${path}: not 8-bit, non-interlaced`);
      depth = data[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") parts.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * depth;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= depth ? (out[y * stride + x - depth] as number) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] as number) : 0;
      const corner = x >= depth && y > 0 ? (out[(y - 1) * stride + x - depth] as number) : 0;
      let value = raw[y * (stride + 1) + 1 + x] as number;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - corner;
        const [a, b, c] = [left, up, corner].map((v) => Math.abs(guess - v)) as [
          number,
          number,
          number,
        ];
        value += a <= b && a <= c ? left : b <= c ? up : corner;
      }
      out[y * stride + x] = value & 255;
    }
  }
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      const at = y * stride + x * depth;
      return `#${[0, 1, 2].map((k) => (out[at + k] as number).toString(16).padStart(2, "0")).join("")}`;
    }),
  );
}

/**
 * The art pixels of a raster scene, `scale` image pixels each. Only `area` is read, and every
 * image pixel in it must match its art pixel, so a patch of it lines up with the image.
 */
function artCells(pixels: string[][], scale: number, area: Rect): string[][] {
  const cells = Array.from({ length: pixels.length / scale }, () =>
    Array<string>(((pixels[0] as string[]).length / scale) | 0).fill(""),
  );
  for (let y = area.y; y < area.y + area.h; y += 1) {
    for (let x = area.x; x < area.x + area.w; x += 1) {
      const color = (pixels[y * scale] as string[])[x * scale] as string;
      for (let j = 0; j < scale; j += 1) {
        for (let i = 0; i < scale; i += 1) {
          if ((pixels[y * scale + j] as string[])[x * scale + i] !== color) {
            throw new Error(`art pixel ${x},${y} is not one color`);
          }
        }
      }
      (cells[y] as string[])[x] = color;
    }
  }
  return cells;
}

/** The patch frames side by side, after checking that each frame changes nothing outside `rect`. */
function strip(still: string[][], frames: string[][][], rect: Rect): string[][] {
  for (const frame of frames) {
    frame.forEach((row, y) => {
      row.forEach((color, x) => {
        const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
        if (!inside && color !== (still[y] as string[])[x]) {
          throw new Error(`a frame changes ${x},${y}, outside its patch`);
        }
      });
    });
  }
  return Array.from({ length: rect.h }, (_, j) =>
    frames.flatMap((frame) => (frame[rect.y + j] as string[]).slice(rect.x, rect.x + rect.w)),
  );
}

/**
 * Moves the cells of `moved` down one art pixel in a copy of `cells`. Each cell it leaves takes
 * the nearest unmoved cell in its row. A cell in `keep` stays on top of the moved ones.
 */
function lower(
  cells: string[][],
  moved: (x: number, y: number) => boolean,
  keep: (x: number, y: number) => boolean = () => false,
): string[][] {
  const next = cells.map((row) => [...row]);
  const fillRow = (x: number, y: number) => {
    const row = cells[y] as string[];
    for (let reach = 1; reach < row.length; reach += 1) {
      for (const side of [x - reach, x + reach]) {
        if (side >= 0 && side < row.length && !moved(side, y) && row[side] !== "") {
          return row[side] as string;
        }
      }
    }
    throw new Error(`no background for ${x},${y}`);
  };
  cells.forEach((row, y) => {
    row.forEach((_, x) => {
      if (moved(x, y)) (next[y] as string[])[x] = fillRow(x, y);
    });
  });
  cells.forEach((row, y) => {
    row.forEach((color, x) => {
      if (moved(x, y) && !keep(x, y + 1)) (next[y + 1] as string[])[x] = color;
    });
  });
  return next;
}

const inside = (rect: Rect, x: number, y: number) =>
  x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;

/** The boat's colors in the Inbox art: mast, flag, sail, sail shade and the two hull blues. */
const BOAT = {
  day: ["#7a4f2a", "#e4572e", "#fffaf0", "#e6dcc4", "#27455c", "#172d3e"],
  night: ["#c79a6b", "#ff7a52", "#f5efe0", "#c9bea6", "#7fb2cf", "#4f7f9c"],
};
/** The boat lies inside this box of the Inbox art, and the gull's head inside this one. */
const BOAT_BOX: Rect = { x: 133, y: 29, w: 34, h: 20 };
const HEAD_BOX: Rect = { x: 107, y: 24, w: 11, h: 7 };
/** The bottom row of the sleeping gull, which the lowered head stays behind. */
const GULL_BOTTOM = 31;

for (const name of ["day", "night"] as const) {
  writeFileSync(join(OUT, `contacts-${name}.png`), png(contacts(name)));
  writeFileSync(join(OUT, `visitors-${name}.png`), png(visitors(name)));

  // Contacts: the blink covers the gull's eye.
  const { rect: eye } = MOVEMENTS.contacts;
  if ((contacts(name)[eye.y] as string[])[eye.x] !== PALETTE.k) {
    throw new Error("the Contacts blink is not over the gull's eye");
  }

  // Visitors: the near skiff one and two art pixels to the left.
  const still = visitors(name);
  const drift = MOVEMENTS.visitors;
  const drifted = strip(still, [visitors(name, 1), visitors(name, 2)], drift.rect);
  writeFileSync(join(OUT, `visitors-skiff-${name}.png`), png(drifted));

  // Inbox: the boat one art pixel lower. The art is 5 image pixels per art pixel.
  const bob = MOVEMENTS.inbox;
  const harbor = artCells(readPng(join(OUT, `inbox-${name}.png`)), 5, bob.rect);
  const boat = (x: number, y: number) =>
    inside(BOAT_BOX, x, y) && BOAT[name].includes((harbor[y] as string[])[x] as string);
  writeFileSync(
    join(OUT, `inbox-boat-${name}.png`),
    png(strip(harbor, [lower(harbor, boat)], bob.rect), 5),
  );

  // Settings: the sleeping gull's head one art pixel lower. The art is 3 image pixels each.
  const nod = MOVEMENTS.settings;
  const perch = artCells(readPng(join(OUT, `settings-${name}.png`)), 3, nod.rect);
  const sky = (perch[nod.rect.y] as string[])[nod.rect.x] as string;
  const head = (x: number, y: number) =>
    inside(HEAD_BOX, x, y) && (perch[y] as string[])[x] !== sky;
  const bottom = (x: number, y: number) => y === GULL_BOTTOM && (perch[y] as string[])[x] !== sky;
  writeFileSync(
    join(OUT, `settings-nod-${name}.png`),
    png(strip(perch, [lower(perch, head, bottom)], nod.rect), 3),
  );
}
console.log(
  "Wrote the Contacts and Visitors scenes and the visitors-skiff, inbox-boat and settings-nod patches to assets/",
);
