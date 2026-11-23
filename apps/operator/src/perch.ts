// The gull: one character on a mooring post. It watches the pointer, sleeps, squawks, searches with
// a telescope, fishes, and stretches. Flights are in flight.ts: here it only stays home.
import {
  BEAK_OPEN,
  BLINK,
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
  TELESCOPE,
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

/** What the gull does at home: watch, sleep, or look through its telescope. */
export type PerchMode = "idle" | "sleep" | "search";
/**
 * What else is on the pond: the skiff of a live chat, the post that holds the board, or pilings
 * that rise and fall like the bars of a chart, for Analytics before its first numbers.
 */
export type PondExtra = "skiff" | "board" | "chart" | null;

export type Point = { x: number; y: number };

type Cloud = { art: Sprite; x: number; y: number; speed: number };

/** The big scene in the empty pane, and the small one in the corner beside a list. */
const SIZES = {
  big: {
    w: 110,
    h: 78,
    pondScale: 1,
    clouds: [
      { art: CLOUD_B, x: 6, y: 6, speed: 1.2 },
      { art: CLOUD_A, x: 78, y: 16, speed: 0.8 },
    ],
  },
  small: { w: 62, h: 60, pondScale: 0.78, clouds: [] },
} satisfies Record<string, { w: number; h: number; pondScale: number; clouds: Cloud[] }>;
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
/** The chart's pilings, right of the gull: how far from the middle, and their usual height. */
const CHART_PILINGS = [
  { right: 11, abovePond: 5 },
  { right: 17, abovePond: 9 },
  { right: 23, abovePond: 7 },
  { right: 29, abovePond: 13 },
];
const CHART_PILING_WIDTH = 4;
/** Each piling rises and falls this far, a beat after the one before, as numbers would come in. */
const CHART_SWING = { px: 3, speed: 1.1, lag: 0.8 };
/** Half the pond's width on each of its rows, top to bottom. */
const POND_HALF_WIDTHS = [15, 23, 28, 31, 33, 34, 34, 33, 31, 28, 23, 15];
const CLOUD_SWAP = { 1: "4", 2: "5", 3: "6" } as const;
/** Where the skiff sails, from the scene's middle. */
const SKIFF_RANGE = { from: -28, to: 16 };
/** Where a click on the pond makes a fish leap, which stays inside the small scene's pond too. */
const LEAP_RANGE = { from: -26, to: 16 };
/** The gull, in art pixels from its post's top middle: where it is drawn, clicked and flies from. */
const GULL_BOX = { left: -9, halfWidth: 12, top: -18, bottom: 2, middleY: -9 };

const SQUAWK_MS = 520;
/** The first part of a squawk lifts the gull off its feet. */
const HOP_MS = SQUAWK_MS - 260;
const HOP_PX = -2;
const STRETCH_MS = 1500;
const STRETCH_HALF_MS = 220;
const STRETCH_BEAK_MS = { from: 500, to: 1100 };
/** Left alone this long, the gull stretches its wings. */
const IDLE_MS = 30_000;
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

type Leap = { x: number; waterY: number; start: number };

export type Perch = ReturnType<typeof createPerch>;

export function createPerch(canvas: HTMLCanvasElement, size: PerchSize, scale: number) {
  const { w: W, h: H, pondScale } = SIZES[size];
  let ctx = pixelCanvas(canvas, W, H, scale);
  let pixel = scale;
  const CX = Math.round(W / 2);
  const POND = H - POND_FROM_BOTTOM;
  const TOP = POND - POST_ABOVE_POND;
  const widths = POND_HALF_WIDTHS.map((half) => Math.round(half * pondScale));
  const clouds: Cloud[] = SIZES[size].clouds.map((cloud) => ({ ...cloud }));
  const leaps: Leap[] = [];
  const skiff = { x: CX + SKIFF_RANGE.from, way: 1 };
  const s = {
    mode: "idle" as PerchMode,
    /** Flying, so not on its post. */
    isAway: false,
    extra: null as PondExtra,
    flip: false,
    time: 0,
    blinkAt: 2,
    squawkUntil: 0,
    stretchUntil: 0,
    gulpUntil: 0,
    pointerX: null as number | null,
    pointerAt: 0,
    /** The last pointer move, click or key anywhere on the page, and the last idle stretch. */
    activeAt: performance.now(),
    stretchAt: 0,
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
      fillRun(ctx, P.s, x, POND + 1 + ((index * 2) % 9), 3);
    }
  }

  /** Blue dashes that move along a waterline: the water lapping at something. */
  function drawLapping(origin: number, from: number, to: number, y: number, speed: number) {
    for (let i = from; i <= to; i += 1) {
      if ((i + Math.floor(s.time * speed)) % 4 < 2) fillRun(ctx, P.b, origin + i, y, 1);
    }
  }

  function drawExtra() {
    if (s.extra === "skiff") {
      const bob = Math.round(Math.sin(s.time * 2.2));
      blit(ctx, SKIFF, skiff.x, POND - 5 + bob, { flip: skiff.way < 0 });
      drawLapping(Math.round(skiff.x), 1, 9, POND + 4, 5);
    }
    if (s.extra === "chart") drawChart();
    if (s.extra === "board") {
      const postX = CX + BOARD_POST.right;
      const postY = POND - BOARD_POST.abovePond;
      fillRun(ctx, P.t, postX - 3, postY + 1, 6, 20);
      fillRun(ctx, P.T, postX + 1, postY + 1, 2, 20);
      fillRun(ctx, P.t, postX - 4, postY, 8, 2);
    }
  }

  /** Wooden pilings as bars, the tallest with a yellow cap, each lapped by the water. */
  function drawChart() {
    const heights = CHART_PILINGS.map(
      ({ abovePond }, index) =>
        abovePond +
        Math.round(Math.sin(s.time * CHART_SWING.speed - index * CHART_SWING.lag) * CHART_SWING.px),
    );
    const tallest = Math.max(...heights);
    CHART_PILINGS.forEach(({ right }, index) => {
      const height = heights[index] ?? 0;
      const x = CX + right;
      const top = POND - height;
      fillRun(ctx, P.t, x, top, CHART_PILING_WIDTH, height + 4);
      fillRun(ctx, P.T, x + CHART_PILING_WIDTH - 1, top, 1, height + 4);
      fillRun(ctx, height === tallest ? P.y : P.e, x, top - 1, CHART_PILING_WIDTH, 1);
      drawLapping(x, -1, CHART_PILING_WIDTH, POND + 3, 4);
    });
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
    const x = CX + GULL_BOX.left;
    const y = TOP - art.h + hop + breathe;
    // The stretch pose's head sits lower in its sprite.
    const top = y + (isFull ? 4 : 0);
    blit(ctx, art, x, y, { flip: s.flip });
    /** Draws `part` at (dx, dy) on the gull's art, mirrored with the gull. */
    const overlay = (part: Sprite, dx: number, dy: number) =>
      blit(ctx, part, s.flip ? x + art.w - dx - part.w : x + dx, top + dy, { flip: s.flip });
    if (s.mode === "sleep") return drawSleep(y);
    if (s.time > s.blinkAt && s.time < s.blinkAt + BLINK_S) overlay(BLINK, 12, 2);
    if (s.hat) overlay(HAT, 6, -3);
    if (now < s.gulpUntil) overlay(FISH_DOWN, 15, 3);
    else if (isSquawking) {
      overlay(BEAK_OPEN, 16, 5);
      overlay(GLYPH.bang, 20, -5);
      overlay(GLYPH.bang, 23, -3);
    } else if (isFull && into > STRETCH_BEAK_MS.from && into < STRETCH_BEAK_MS.to) {
      overlay(BEAK_OPEN, 16, 5);
    }
    if (s.mode === "search" && art === GULL_STAND) {
      overlay(TELESCOPE, 8, -1);
      blit(ctx, GLYPH.question, CX - 1, top - 10 + Math.round(Math.sin(s.time * 3)));
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
    if (!s.isAway) drawGull(now);
    drawLeaps(now);
  }

  function move(deltaS: number) {
    s.time += deltaS;
    if (s.time > s.blinkAt + BLINK_S) {
      s.blinkAt = s.time + BLINK_GAP_S.least + Math.random() * BLINK_GAP_S.more;
    }
    for (const cloud of clouds) {
      cloud.x += cloud.speed * deltaS;
      if (cloud.x > W + 2) cloud.x = -cloud.art.w;
    }
    skiff.x += skiff.way * SKIFF_SPEED_PX_S * deltaS;
    if (skiff.x > CX + SKIFF_RANGE.to) skiff.way = -1;
    if (skiff.x < CX + SKIFF_RANGE.from) skiff.way = 1;
  }

  /** What falls due at a moment: the squawk after a gulp, and a stretch when left alone. */
  function due(now: number) {
    if (s.gulpUntil !== 0 && now >= s.gulpUntil) {
      s.gulpUntil = 0;
      perch.squawk();
    }
    if (now - Math.max(s.activeAt, s.stretchAt) > IDLE_MS) {
      s.stretchAt = now;
      if (s.mode === "idle" && !s.isAway && !isLessMotion()) s.stretchUntil = now + STRETCH_MS;
    }
  }

  /** Where the gull looks: around with the telescope, at the pointer, or after the skiff. */
  function look(now: number) {
    if (s.mode === "search") s.flip = Math.floor(s.time / SEARCH_TURN_S) % 2 === 0;
    if (s.mode !== "idle") return;
    if (now < s.watchUntil) s.flip = s.watchLeft;
    else if (s.pointerX !== null && now - s.pointerAt < POINTER_FRESH_MS) {
      s.flip = s.pointerX < canvas.getBoundingClientRect().left + CX * pixel;
    } else if (s.extra === "skiff") s.flip = skiff.x + 5 < CX;
    else if (s.extra === "chart") s.flip = false;
  }

  const loop = animate(canvas, (deltaS, now) => {
    if (!isLessMotion()) move(deltaS);
    due(now);
    look(now);
    draw(now);
  });

  const onActive = () => {
    s.activeAt = performance.now();
  };
  const onPointer = (event: PointerEvent) => {
    s.pointerX = event.clientX;
    s.pointerAt = performance.now();
    s.activeAt = s.pointerAt;
    loop.redraw();
  };
  addEventListener("pointermove", onPointer);
  addEventListener("pointerdown", onActive);
  addEventListener("keydown", onActive);

  function face(left: boolean) {
    s.flip = left;
    s.watchLeft = left;
    s.watchUntil = performance.now() + WATCH_MS;
    loop.redraw(WATCH_MS);
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
    const at = Math.round(Math.max(CX + LEAP_RANGE.from, Math.min(CX + LEAP_RANGE.to, x)));
    const now = performance.now();
    leaps.push({ x: at, waterY: POND + 4, start: now });
    face(x < CX);
    // The second fish in a row is one too many for the gull.
    if (now - s.lastLeap < SECOND_LEAP_MS && s.mode === "idle" && !s.isAway) {
      s.lastLeap = 0;
      perch.onSecondLeap?.(toScreen(at + 5, POND - 10), () => leaps.pop());
    } else s.lastLeap = now;
  }

  const onClick = (event: MouseEvent) => {
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) / pixel;
    const y = (event.clientY - box.top) / pixel;
    const isOnGull =
      Math.abs(x - CX) < GULL_BOX.halfWidth && y > TOP + GULL_BOX.top && y < TOP + GULL_BOX.bottom;
    if (!s.isAway && isOnGull) pokeGull();
    else if (y >= POND - 2) pokePond(x);
  };
  canvas.addEventListener("click", onClick);

  const perch = {
    get mode() {
      return s.mode;
    },
    setMode(next: PerchMode) {
      s.mode = next;
      loop.redraw();
    },
    setAway(isAway: boolean) {
      s.isAway = isAway;
      loop.redraw();
    },
    setExtra(next: PondExtra) {
      s.extra = next;
      loop.redraw();
    },
    setScale(next: number) {
      if (next === pixel) return;
      pixel = next;
      ctx = pixelCanvas(canvas, W, H, next);
      draw(performance.now());
    },
    toggleHat() {
      s.hat = !s.hat;
      perch.squawk();
    },
    squawk() {
      s.squawkUntil = performance.now() + SQUAWK_MS;
      loop.redraw(SQUAWK_MS);
    },
    /** Swallows the fish it caught, and squawks when it is down. */
    gulp() {
      s.gulpUntil = performance.now() + GULP_MS;
    },
    /** The middle of the gull on the screen. */
    at: () => toScreen(CX, TOP + GULL_BOX.middleY),
    stop() {
      loop.stop();
      removeEventListener("pointermove", onPointer);
      removeEventListener("pointerdown", onActive);
      removeEventListener("keydown", onActive);
      canvas.removeEventListener("click", onClick);
    },
    onLoop: null as (() => void) | null,
    onWake: null as (() => void) | null,
    onSecondLeap: null as ((fish: Point, take: () => void) => void) | null,
  };
  return perch;
}
