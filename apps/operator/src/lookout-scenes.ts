// Two pixel scenes without the gull, on the same grid as its big scene: a lighthouse whose light
// sweeps the sea, for Analytics before its first numbers, and a sonar that finds nobody, for
// Visitors while nobody is on the site.
import { animate, clearCanvas, fillRun, isLessMotion, PALETTE as P, pixelCanvas } from "./pixel.ts";
import {
  BIG_CLOUDS,
  BIG_SCENE,
  drawClouds,
  drawLapping,
  drawPond,
  moveClouds,
  POND_FROM_BOTTOM,
  POND_HALF_WIDTHS,
} from "./pond.ts";

export type LookoutKind = "lighthouse" | "sonar";

const { w: W, h: H } = BIG_SCENE;
const CX = Math.round(W / 2);
const POND = H - POND_FROM_BOTTOM;

/** The tower stands on a rock a few rows into the pond, where the water holds it. */
const TOWER = { height: 30, inPond: 2, stripe: 5 };
/** The light turns once in this many seconds and reaches this far, in art pixels, each way. */
const BEAM = { turnS: 6, reach: 46, spreadEvery: 7, farFrom: 0.55 };
/** The light faces the viewer, and the lamp flashes, while it points this close to them. */
const FACING = 0.25;

/** The sonar's middle and radius, its sweep's speed and trail, and how often it pings. */
const SONAR = { cy: 38, r: 30, turnPerS: 1.6, trail: 0.9, glow: 0.12, beam: 0.45, pingS: 2.5 };

function drawLighthouse(ctx: CanvasRenderingContext2D, time: number) {
  const base = POND + TOWER.inPond;
  const top = base - TOWER.height;
  const lampY = top - 5;
  // Seen from the side, the turning light is a cone that grows to one side, shrinks as it faces
  // the viewer, and grows to the other.
  const way = Math.cos((time / BEAM.turnS) * Math.PI * 2);
  const reach = Math.round(Math.abs(way) * BEAM.reach);
  for (let d = 2; d <= reach; d += 1) {
    const half = 1 + Math.floor(d / BEAM.spreadEvery);
    const isFar = d > reach * BEAM.farFrom;
    for (let y = -half; y <= half; y += 1) {
      if (isFar && (d + y) % 2 !== 0) continue;
      const color = isFar || Math.abs(y) === half ? P["3"] : P.h;
      fillRun(ctx, color, CX + Math.sign(way) * d, lampY + y, 1);
    }
  }
  for (let row = 0; row < TOWER.height; row += 1) {
    const half = 3 + Math.floor((row / TOWER.height) * 3);
    const isRed = Math.floor(row / TOWER.stripe) % 2 === 0;
    fillRun(ctx, P.k, CX - half - 1, top + row, half * 2 + 2);
    fillRun(ctx, isRed ? P.r : P.c, CX - half, top + row, half * 2);
    fillRun(ctx, isRed ? P.R : P.e, CX + half - 1, top + row, 1);
  }
  // A lit window, the gallery and its rail, the lamp, and the red cap.
  fillRun(ctx, P.k, CX - 4, top + 10, 2, 3);
  fillRun(ctx, P.y, CX - 3, top + 11, 1, 1);
  fillRun(ctx, P.k, CX - 6, top - 1, 12, 1);
  fillRun(ctx, P.k, CX - 6, top - 2, 1, 1);
  fillRun(ctx, P.k, CX + 5, top - 2, 1, 1);
  fillRun(ctx, P.k, CX - 3, lampY - 2, 6, 4);
  fillRun(ctx, Math.abs(way) < FACING ? P.w : P.y, CX - 2, lampY - 1, 4, 3);
  fillRun(ctx, P.k, CX - 4, lampY - 4, 8, 2);
  fillRun(ctx, P.r, CX - 3, lampY - 4, 6, 1);
  fillRun(ctx, P.k, CX - 1, lampY - 6, 2, 2);
  // The rock, with the water lapping at it.
  fillRun(ctx, P.d, CX - 9, base, 18, 2);
  fillRun(ctx, P.g, CX - 8, base, 12, 1);
  fillRun(ctx, P.d, CX - 6, base - 1, 6, 1);
  drawLapping(ctx, CX, -10, 10, base + 2, 4, time);
}

/** A navy scope with rings and a cross, the sweep and its trail turning, and a ring that pings out. */
function drawSonar(ctx: CanvasRenderingContext2D, time: number) {
  const { cy, r } = SONAR;
  const sweep = (time * SONAR.turnPerS) % (Math.PI * 2);
  const ping = ((time % SONAR.pingS) / SONAR.pingS) * r;
  for (let y = -r - 1; y <= r + 1; y += 1) {
    for (let x = -r - 1; x <= r + 1; x += 1) {
      const d = Math.hypot(x, y);
      if (d > r + 1) continue;
      let color: string = d > r ? P.k : d < r * 0.55 ? P["9"] : P.k;
      if (d <= r) {
        const isGrid =
          Math.abs(d - r / 3) < 0.5 || Math.abs(d - (2 * r) / 3) < 0.5 || x === 0 || y === 0;
        if (isGrid) color = P["0"];
        const angle = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
        const behind = (sweep - angle + Math.PI * 2) % (Math.PI * 2);
        if (behind < SONAR.trail) {
          color = behind < SONAR.glow ? P.l : behind < SONAR.beam ? P.p : P.b;
        }
        if (ping > 3 && Math.abs(d - ping) < 0.6) color = P.s;
      }
      fillRun(ctx, color, CX + x, cy + y, 1);
    }
  }
  fillRun(ctx, P.y, CX - 1, cy - 1, 2, 2);
  // Brass bolts round the bezel, and the wooden stand.
  for (const [x, y] of [
    [0, -r - 3],
    [0, r + 2],
    [-r - 3, 0],
    [r + 2, 0],
  ] as const) {
    fillRun(ctx, P.Y, CX + x - 1, cy + y, 2, 2);
  }
  fillRun(ctx, P.t, CX - 16, cy + r + 4, 32, 3);
  fillRun(ctx, P.T, CX - 16, cy + r + 6, 32, 1);
}

/** Draws a scene on the canvas and keeps it moving, unless the phone asks for less motion. */
export function createLookout(canvas: HTMLCanvasElement, kind: LookoutKind, scale: number) {
  let ctx = pixelCanvas(canvas, W, H, scale);
  let pixel = scale;
  const clouds = BIG_CLOUDS.map((cloud) => ({ ...cloud }));
  const widths = [...POND_HALF_WIDTHS];
  let time = 0;
  const draw = () => {
    clearCanvas(ctx);
    if (kind === "sonar") {
      drawSonar(ctx, time);
      return;
    }
    drawClouds(ctx, clouds);
    drawPond(ctx, CX, POND, widths, time);
    drawLighthouse(ctx, time);
  };
  const loop = animate(canvas, (deltaS) => {
    if (!isLessMotion()) {
      time += deltaS;
      moveClouds(clouds, W, deltaS);
    }
    draw();
  });
  return {
    setScale(next: number) {
      if (next === pixel) return;
      pixel = next;
      ctx = pixelCanvas(canvas, W, H, next);
      draw();
    },
    stop: () => loop.stop(),
  };
}
