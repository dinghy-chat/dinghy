// The gull: one character on a mooring post. It watches the pointer, sleeps, squawks, searches with
// a telescope, fishes, and stretches. Flights are in flight.ts: here it only stays home.
import {
  CLOUD_A,
  CLOUD_B,
  FISH,
  FISH_DOWN,
  FISH_UP,
  GLYPH,
  GULL_HALF,
  GULL_SLEEP,
  GULL_STAND,
  GULL_STRETCH,
  HAT,
  POST,
  SKIFF,
} from "./gull-sprites.ts";
import {
  animate,
  blit,
  clearCanvas,
  fillRun,
  isLessMotion,
  PALETTE as P,
  pixelCanvas,
  type Sprite,
} from "./pixel.ts";

/** What the gull does: watch, sleep, look through its telescope, or fly (and so is not home). */
export type PerchMode = "idle" | "sleep" | "search" | "away";
/** What else is on the pond: the skiff of a live chat, or the post that holds the board. */
export type PondExtra = "skiff" | "board" | null;

export interface Point {
  x: number;
  y: number;
}

/** The big scene in the empty pane, and the small one in the corner beside a list. */
const SIZES = {
  big: { w: 110, h: 78, pondScale: 1, clouds: true },
  small: { w: 62, h: 60, pondScale: 0.78, clouds: false },
} as const;
export type PerchSize = keyof typeof SIZES;
/** The big scene's size in art pixels, to fit it in the pane. */
export const BIG_SCENE = { w: SIZES.big.w, h: SIZES.big.h };

const POND_FROM_BOTTOM = 17;
const POST_ABOVE_POND = 21;
/** The board's short post stands right of the gull's, its top a little above the pond. */
const BOARD_POST = { right: 29, abovePond: 13 };
/** The top of the board's post in the big scene, in art pixels. The board's form sits on it. */
export const BOARD_POST_TOP = {
  x: Math.round(SIZES.big.w / 2) + BOARD_POST.right,
  y: SIZES.big.h - POND_FROM_BOTTOM - BOARD_POST.abovePond,
};
/** Half the pond's width on each of its rows, top to bottom. */
const POND_HALF_WIDTHS = [15, 23, 28, 31, 33, 34, 34, 33, 31, 28, 23, 15];
const CLOUD_SWAP = { 1: "#f1ecdb", 2: "#f6f2e6", 3: "#e7e1cf" };
const SPARKLE = "#d6eaff";

const SQUAWK_MS = 520;
/** The first part of a squawk lifts the gull off its feet. */
const HOP_MS = SQUAWK_MS - 260;
const HOP_PX = -2;
const STRETCH_MS = 1500;
const STRETCH_HALF_MS = 220;
const STRETCH_BEAK_MS = { from: 500, to: 1100 };
const GULP_MS = 900;
const WATCH_MS = 1500;
const POINTER_FRESH_MS = 2500;
const CLICKS_FOR_LOOP = 3;
const LOOP_CLICKS_MS = 1600;
const SECOND_LEAP_MS = 4000;
const BLINK_S = 0.13;
const BLINK_GAP_S = { least: 2, more: 3 };
const SKIFF_SPEED_PX_S = 5;
const SEARCH_TURN_S = 1.7;
const LEAP_S = 1.3;
const LEAP_AIR_S = 0.8;
const SPLASH_S = 0.45;

/** A brass telescope in three parts that widen toward the lens: [fromX, toX, row, color]. */
const SHINE = "#ffe07a";
const column = (x: number, from: number, to: number, color: string) =>
  Array.from({ length: to - from + 1 }, (_, at): Run => [x, x, from + at, color]);
type Run = [number, number, number, string];
// biome-ignore format: rows of pixel art read better as rows.
const TELESCOPE: Run[] = [
  [9, 12, 7, P.g], [8, 8, 7, P.k], [13, 13, 7, P.k],
  [11, 14, 6, P.g], [10, 10, 6, P.k], [15, 15, 6, P.k],
  [13, 16, 5, P.g], [12, 12, 5, P.k], [17, 17, 5, P.k],
  [11, 13, 1, P.k], [11, 13, 3, P.k], [11, 11, 2, P.k], [12, 13, 2, P.Y],
  ...column(14, 0, 4, P.k),
  [15, 18, 0, P.k], [15, 18, 4, P.k], [15, 18, 1, SHINE], [15, 18, 2, P.y], [15, 18, 3, P.Y],
  [16, 16, 2, SHINE], [17, 17, 3, P.y],
  ...column(19, -1, 5, P.k),
  [20, 23, -1, P.k], [20, 23, 5, P.k], [20, 22, 0, SHINE], [20, 22, 1, P.y], [20, 22, 2, P.y],
  [20, 22, 3, P.y], [20, 22, 4, P.Y], [21, 21, 1, SHINE], [20, 20, 3, P.Y], [22, 22, 3, P.Y],
  ...column(23, 0, 4, P.l),
  [23, 23, 1, P.w], [23, 23, 4, P.p],
  ...column(24, 0, 4, P.k),
];
/** The open beak of a squawk. */
const BEAK_OPEN: Run[] = [
  [16, 17, 5, P.o],
  [18, 18, 6, P.o],
];

interface Leap {
  x: number;
  waterY: number;
  start: number;
}

export interface Perch {
  readonly mode: PerchMode;
  hatOn: boolean;
  setMode(next: PerchMode): void;
  setExtra(next: PondExtra): void;
  setScale(scale: number): void;
  squawk(): void;
  stretch(): void;
  gulp(): void;
  /** The middle of the gull on the screen. */
  at(): Point;
  stop(): void;
  onLoop: (() => void) | null;
  onWake: (() => void) | null;
  onSecondLeap: ((fish: Point, take: () => void) => void) | null;
}

export function createPerch(canvas: HTMLCanvasElement, size: PerchSize, scale: number): Perch {
  const { w: W, h: H, pondScale, clouds: hasClouds } = SIZES[size];
  const isSmall = size === "small";
  let ctx = pixelCanvas(canvas, W, H, scale);
  let pixel = scale;
  const CX = Math.round(W / 2);
  const POND = H - POND_FROM_BOTTOM;
  const TOP = POND - POST_ABOVE_POND;
  const widths = POND_HALF_WIDTHS.map((half) => Math.round(half * pondScale));
  const clouds = hasClouds
    ? [
        { art: CLOUD_B, x: 6, y: 6, speed: 1.2 },
        { art: CLOUD_A, x: 78, y: 16, speed: 0.8 },
      ]
    : [];
  const leaps: Leap[] = [];
  const skiff = { x: CX - 28, way: 1 };
  const s = {
    mode: "idle" as PerchMode,
    extra: null as PondExtra,
    flip: false,
    time: 0,
    blinkAt: 2,
    squawkUntil: 0,
    stretchUntil: 0,
    gulpUntil: 0,
    pointerX: null as number | null,
    pointerAt: 0,
    watchUntil: 0,
    watchLeft: false,
    clicks: [] as number[],
    lastLeap: 0,
    hat: false,
  };

  const toScreen = (x: number, y: number): Point => {
    const box = canvas.getBoundingClientRect();
    return { x: box.left + x * pixel, y: box.top + y * pixel };
  };

  function drawPond() {
    widths.forEach((half, row) => {
      const wide = half + Math.round(Math.sin(s.time * 1.6 + row * 0.9));
      const color = row < 3 ? P.l : row < 8 ? P.b : P.B;
      fillRun(ctx, color, CX - wide, POND + row, wide * 2);
    });
    for (let index = 0; index < 5; index += 1) {
      if (Math.sin(s.time * 1.5 + index * 2.1) < 0) continue;
      const x = CX - 24 + ((index * 13 + Math.floor(s.time * 3)) % 46);
      fillRun(ctx, SPARKLE, x, POND + 1 + ((index * 2) % 9), 3);
    }
  }

  /** Blue dashes that move along a waterline: the water lapping at something. */
  function drawLapping(origin: number, from: number, to: number, y: number, speed: number) {
    for (let i = from; i <= to; i += 1) {
      if ((i + Math.floor(s.time * speed)) % 4 < 2) fillRun(ctx, P.b, origin + i, y, 1);
    }
  }

  function drawExtra() {
    if (isSmall) return;
    if (s.extra === "skiff") {
      const bob = Math.round(Math.sin(s.time * 2.2));
      blit(ctx, SKIFF, skiff.x, POND - 5 + bob, { flip: skiff.way < 0 });
      drawLapping(Math.round(skiff.x), 1, 9, POND + 4, 5);
    }
    if (s.extra === "board") {
      const postX = CX + BOARD_POST.right;
      const postY = POND - BOARD_POST.abovePond;
      fillRun(ctx, P.t, postX - 3, postY + 1, 6, 20);
      fillRun(ctx, P.T, postX + 1, postY + 1, 2, 20);
      fillRun(ctx, P.t, postX - 4, postY, 8, 2);
    }
  }

  function pose(now: number): { art: Sprite; isFull: boolean; into: number } {
    if (s.mode === "sleep") return { art: GULL_SLEEP, isFull: false, into: -1 };
    if (now >= s.stretchUntil) return { art: GULL_STAND, isFull: false, into: -1 };
    // A stretch: feet planted, the wing lifts, spreads up and out for a beat, then folds back.
    const into = STRETCH_MS - (s.stretchUntil - now);
    const isHalf = into < STRETCH_HALF_MS || into > STRETCH_MS - STRETCH_HALF_MS;
    return { art: isHalf ? GULL_HALF : GULL_STRETCH, isFull: !isHalf, into };
  }

  function drawGull(now: number) {
    const { art, isFull, into } = pose(now);
    const isSquawking = now < s.squawkUntil;
    const hop = isSquawking && s.squawkUntil - now > HOP_MS ? HOP_PX : 0;
    const breathe = s.mode === "sleep" ? Math.round(Math.sin(s.time * 1.4) * 0.6) : 0;
    const x = CX - 9;
    const y = TOP - art.h + hop + breathe;
    // The stretch pose's head sits lower in its sprite.
    const top = y + (isFull ? 4 : 0);
    blit(ctx, art, x, y, { flip: s.flip });
    const local = (i: number) => x + (s.flip ? art.w - 1 - i : i);
    const runs = (list: Run[]) => {
      for (const [from, to, row, color] of list) {
        fillRun(ctx, color, Math.min(local(from), local(to)), top + row, to - from + 1);
      }
    };
    if (s.mode === "sleep") return drawSleep(y);
    drawBlink(runs);
    if (s.hat) blit(ctx, HAT, s.flip ? x + art.w - 1 - 16 : x + 6, top - 3, { flip: s.flip });
    if (now < s.gulpUntil) blit(ctx, FISH_DOWN, s.flip ? local(18) - 1 : local(15), top + 3);
    else if (isSquawking) {
      runs(BEAK_OPEN);
      blit(ctx, GLYPH.bang, local(20), top - 5);
      blit(ctx, GLYPH.bang, local(23), top - 3);
    } else if (isFull && into > STRETCH_BEAK_MS.from && into < STRETCH_BEAK_MS.to) runs(BEAK_OPEN);
    if (s.mode === "search" && art === GULL_STAND) {
      runs(TELESCOPE);
      blit(ctx, GLYPH.question, CX - 1, top - 10 + Math.round(Math.sin(s.time * 3)));
    }
  }

  function drawBlink(runs: (list: Run[]) => void) {
    if (s.time > s.blinkAt && s.time < s.blinkAt + BLINK_S) runs([[12, 12, 2, P.w]]);
    if (s.time > s.blinkAt + BLINK_S) {
      s.blinkAt = s.time + BLINK_GAP_S.least + Math.random() * BLINK_GAP_S.more;
    }
  }

  /** Two z's rise from the sleeping gull, one after the other. */
  function drawSleep(y: number) {
    for (const offset of [0, 1.1]) {
      const rise = ((s.time * 0.6 + offset) % 2.2) / 2.2;
      if (rise < 0.9) {
        blit(ctx, GLYPH.z, CX + 8 + Math.round(rise * 9), y - 3 - Math.round(rise * 15));
      }
    }
  }

  /** A fish leaps from the water, with a splash where it goes in and one where it comes out. */
  function drawLeaps(now: number) {
    for (let index = leaps.length - 1; index >= 0; index -= 1) {
      const leap = leaps[index];
      if (leap === undefined) continue;
      const age = (now - leap.start) / 1000;
      if (age > LEAP_S) {
        leaps.splice(index, 1);
        continue;
      }
      const air = age / LEAP_AIR_S;
      if (air < 1) {
        const up = 4 * 14 * air * (1 - air);
        const art = air < 0.3 ? FISH_UP : air > 0.7 ? FISH_DOWN : FISH;
        const x = leap.x + air * 12 - art.w / 2;
        blit(ctx, art, x, leap.waterY - up - art.h / 2, { flip: true });
      }
      drawSplash(leap, age, 0, 0);
      drawSplash(leap, age, LEAP_AIR_S, 12);
    }
  }

  function drawSplash({ x, waterY }: Leap, age: number, at: number, side: number) {
    const since = age - at;
    if (since < 0 || since > SPLASH_S) return;
    const reach = Math.round(since * 14);
    const fall = since * since * 30;
    for (const sign of [-1, 1]) {
      fillRun(ctx, P.w, x + side + sign * (1 + reach), waterY - 2 - reach + fall, 1);
      fillRun(ctx, P.w, x + side + sign * (3 + reach), waterY - 1 - reach / 2 + fall, 1);
    }
  }

  function draw(now: number) {
    clearCanvas(ctx);
    for (const cloud of clouds) blit(ctx, cloud.art, cloud.x, cloud.y, { swap: CLOUD_SWAP });
    drawPond();
    drawExtra();
    blit(ctx, POST, CX - 4, TOP);
    drawLapping(CX, -6, 5, TOP + 28, 4);
    if (s.mode !== "away") drawGull(now);
    drawLeaps(now);
  }

  function move(deltaS: number) {
    s.time += deltaS;
    for (const cloud of clouds) {
      cloud.x += cloud.speed * deltaS;
      if (cloud.x > W + 2) cloud.x = -cloud.art.w;
    }
    skiff.x += skiff.way * SKIFF_SPEED_PX_S * deltaS;
    if (skiff.x > CX + 16) skiff.way = -1;
    if (skiff.x < CX - 28) skiff.way = 1;
  }

  /** Where the gull looks: around with the telescope, at the pointer, or after the skiff. */
  function look(now: number) {
    if (s.mode === "search") s.flip = Math.floor(s.time / SEARCH_TURN_S) % 2 === 0;
    if (s.mode !== "idle") return;
    if (now < s.watchUntil) s.flip = s.watchLeft;
    else if (s.pointerX !== null && now - s.pointerAt < POINTER_FRESH_MS) {
      s.flip = s.pointerX < canvas.getBoundingClientRect().left + CX * pixel;
    } else if (s.extra === "skiff" && !isSmall) s.flip = skiff.x + 5 < CX;
  }

  const stopLoop = animate(canvas, (deltaS, now) => {
    if (!isLessMotion()) move(deltaS);
    look(now);
    draw(now);
  });

  const onPointer = (event: PointerEvent) => {
    s.pointerX = event.clientX;
    s.pointerAt = performance.now();
  };
  addEventListener("pointermove", onPointer);

  function face(left: boolean) {
    s.flip = left;
    s.watchLeft = left;
    s.watchUntil = performance.now() + WATCH_MS;
  }

  function pokeGull() {
    if (s.mode === "sleep") return perch.onWake?.();
    perch.squawk();
    const now = performance.now();
    s.clicks = s.clicks.filter((at) => now - at < LOOP_CLICKS_MS);
    s.clicks.push(now);
    if (s.clicks.length < CLICKS_FOR_LOOP) return;
    s.clicks = [];
    perch.onLoop?.();
  }

  function pokePond(x: number) {
    const at = Math.round(Math.max(CX - 26, Math.min(CX + 16, x)));
    const now = performance.now();
    leaps.push({ x: at, waterY: POND + 4, start: now });
    face(x < CX);
    // The second fish in a row is one too many for the gull.
    if (now - s.lastLeap < SECOND_LEAP_MS && s.mode === "idle") {
      s.lastLeap = 0;
      perch.onSecondLeap?.(toScreen(at + 5, POND - 10), () => leaps.pop());
    } else s.lastLeap = now;
  }

  const onClick = (event: MouseEvent) => {
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) / pixel;
    const y = (event.clientY - box.top) / pixel;
    const isOnGull = Math.abs(x - CX) < 12 && y > TOP - 18 && y < TOP + 2;
    if (s.mode !== "away" && isOnGull) pokeGull();
    else if (y >= POND - 2) pokePond(x);
  };
  canvas.addEventListener("click", onClick);

  const perch: Perch = {
    get mode() {
      return s.mode;
    },
    get hatOn() {
      return s.hat;
    },
    set hatOn(on: boolean) {
      s.hat = on;
    },
    setMode(next) {
      s.mode = next;
    },
    setExtra(next) {
      s.extra = next;
    },
    setScale(next) {
      if (next === pixel) return;
      pixel = next;
      ctx = pixelCanvas(canvas, W, H, next);
      draw(performance.now());
    },
    squawk() {
      s.squawkUntil = performance.now() + SQUAWK_MS;
    },
    stretch() {
      if (s.mode === "idle") s.stretchUntil = performance.now() + (isLessMotion() ? 0 : STRETCH_MS);
    },
    gulp() {
      s.gulpUntil = performance.now() + GULP_MS;
      setTimeout(() => perch.squawk(), GULP_MS);
    },
    at: () => toScreen(CX, TOP - 9),
    stop() {
      stopLoop();
      removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("click", onClick);
    },
    onLoop: null,
    onWake: null,
    onSecondLeap: null,
  };
  return perch;
}
