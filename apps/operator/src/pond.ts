// The water and the sky that the pixel scenes share: the gull's, the lighthouse's.
import { CLOUD_A, CLOUD_B } from "./gull-sprites.ts";
import { blit, fillRun, PALETTE as P, type Sprite } from "./pixel.ts";

export type Cloud = { art: Sprite; x: number; y: number; speed: number };

/** A big scene in an empty pane, in art pixels. */
export const BIG_SCENE = { w: 110, h: 78 };
/** The pond's top row, from the scene's bottom. */
export const POND_FROM_BOTTOM = 17;
/** The big scene's clouds, where they start and how fast they drift. */
export const BIG_CLOUDS: Cloud[] = [
  { art: CLOUD_B, x: 6, y: 6, speed: 1.2 },
  { art: CLOUD_A, x: 78, y: 16, speed: 0.8 },
];
/** Half the pond's width on each of its rows, top to bottom. */
export const POND_HALF_WIDTHS = [15, 23, 28, 31, 33, 34, 34, 33, 31, 28, 23, 15];
const CLOUD_SWAP = { 1: "4", 2: "5", 3: "6" } as const;

export function drawClouds(ctx: CanvasRenderingContext2D, clouds: Cloud[]) {
  for (const cloud of clouds) blit(ctx, cloud.art, cloud.x, cloud.y, { swap: CLOUD_SWAP });
}

/** Drifts the clouds right, each back from the left once past the scene's edge. */
export function moveClouds(clouds: Cloud[], sceneW: number, deltaS: number) {
  for (const cloud of clouds) {
    cloud.x += cloud.speed * deltaS;
    if (cloud.x > sceneW + 2) cloud.x = -cloud.art.w;
  }
}

/** The pond, its edges breathing, with glints of light that come and go. */
export function drawPond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  top: number,
  widths: number[],
  time: number,
) {
  widths.forEach((half, row) => {
    const wide = half + Math.round(Math.sin(time * 1.6 + row * 0.9));
    const color = row < 3 ? P.l : row < 8 ? P.b : P.B;
    fillRun(ctx, color, cx - wide, top + row, wide * 2);
  });
  for (let index = 0; index < 5; index += 1) {
    if (Math.sin(time * 1.5 + index * 2.1) < 0) continue;
    const x = cx - 24 + ((index * 13 + Math.floor(time * 3)) % 46);
    fillRun(ctx, P.s, x, top + 1 + ((index * 2) % 9), 3);
  }
}

/** Blue dashes that move along a waterline: the water lapping at something. */
export function drawLapping(
  ctx: CanvasRenderingContext2D,
  origin: number,
  from: number,
  to: number,
  y: number,
  speed: number,
  time: number,
) {
  for (let i = from; i <= to; i += 1) {
    if ((i + Math.floor(time * speed)) % 4 < 2) fillRun(ctx, P.b, origin + i, y, 1);
  }
}
