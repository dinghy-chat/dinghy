// The gull: one character on a mooring post. It watches the pointer, sleeps, squawks, searches with
// a telescope, fishes, and stretches. Flights are in flight.ts: here it only stays home.
import {
  BEAK_OPEN,
  BLINK,
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
import {
  BIG_CLOUDS,
  BIG_SCENE,
  type Cloud,
  drawClouds,
  drawLapping,
  drawPond,
  moveClouds,
  POND_FROM_BOTTOM,
  POND_HALF_WIDTHS,
} from "./pond.ts";

/** What the gull does at home: watch, sleep, or look through its telescope. */
export type PerchMode = "idle" | "sleep" | "search";
/**
 * What else is on the pond: the skiff of a live chat, or the post that holds the board.
 */
export type PondExtra = "skiff" | "board" | null;

export type Point = { x: number; y: number };

/** The big scene in the empty pane, and the small one in the corner beside a list. */
const SIZES = {
  big: { ...BIG_SCENE, pondScale: 1, clouds: BIG_CLOUDS },
  small: { w: 62, h: 60, pondScale: 0.78, clouds: [] },
} satisfies Record<string, { w: number; h: number; pondScale: number; clouds: Cloud[] }>;
export type PerchSize = keyof typeof SIZES;
const POST_ABOVE_POND = 21;
/** The board's short post stands right of the gull's, its top a little above the pond. */
const BOARD_POST = { right: 29, abovePond: 13 };
/** The top of the board's post in the big scene, in art pixels. The board's form sits on it. */
export const BOARD_POST_TOP = {
  x: Math.round(SIZES.big.w / 2) + BOARD_POST.right,
  y: SIZES.big.h - POND_FROM_BOTTOM - BOARD_POST.abovePond,
};
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

  function drawExtra() {
    if (s.extra === "skiff") {
      const bob = Math.round(Math.sin(s.time * 2.2));
      blit(ctx, SKIFF, skiff.x, POND - 5 + bob, { flip: skiff.way < 0 });
      drawLapping(ctx, Math.round(skiff.x), 1, 9, POND + 4, 5, s.time);
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
    drawClouds(ctx, clouds);
    drawPond(ctx, CX, POND, widths, s.time);
    drawExtra();
    blit(ctx, POST, CX - 4, TOP);
    drawLapping(ctx, CX, -6, 5, TOP + 28, 4, s.time);
    if (!s.isAway) drawGull(now);
    drawLeaps(now);
  }

  function move(deltaS: number) {
    s.time += deltaS;
    if (s.time > s.blinkAt + BLINK_S) {
      s.blinkAt = s.time + BLINK_GAP_S.least + Math.random() * BLINK_GAP_S.more;
    }
    moveClouds(clouds, W, deltaS);
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
