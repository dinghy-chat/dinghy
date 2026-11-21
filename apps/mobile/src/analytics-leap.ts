// The fish that leaps in the Analytics header: its path, the sprite frame at each moment, and the
// splashes where it comes out and goes back in. Units are art pixels of the 160 × 50 scene, and the
// screen draws one art pixel as 3 pt. scripts/render-analytics-leap.ts bakes the sprite sheet.

/** The fish frames in the sheet, left to right, by the angle of the nose above level. */
export const FISH_ANGLES = [90, 60, 45, 30, 0, -30, -45, -60, -90] as const;
/** Each fish frame is a square cell, with the fish's center on the cell's center. */
export const FISH_CELL = 13;
/** The splash cells sit under the fish row: an empty cell, then the splash as it spreads. */
export const SPLASH_W = 9;
export const SPLASH_H = 5;
export const SPLASH_FRAMES = 5;
export const SHEET_W = FISH_ANGLES.length * FISH_CELL;
export const SHEET_H = FISH_CELL + SPLASH_H;

/** The water's top row under the jump. The fish is hidden from this row down. */
export const SURFACE = 37;
/** Where the fish's center breaks the surface and where it goes back in, between sun and gull. */
const FROM = 108;
const TO = 120;
/** How far the center climbs above the surface. */
const RISE = 9;
/** The time from leaving the water to going back in. */
const AIR_MS = 800;
/** The path runs on under the water at both ends, so the fish comes out along it and goes in. */
const UNDER = 0.18;
const SPLASH_FRAME_MS = 80;

/** The path's parameter: 0 when the center leaves the water, 1 when it goes back in. */
const along = (ms: number) => -UNDER + ms / AIR_MS;
const centerX = (u: number) => FROM + (TO - FROM) * u;
const centerY = (u: number) => SURFACE - 4 * RISE * u * (1 - u);

/** Where on the path the center is `depth` rows under the surface, going up or coming down. */
function crossing(depth: number, down: boolean): number {
  const root = Math.sqrt(1 + depth / RISE);
  return down ? (1 + root) / 2 : (1 - root) / 2;
}

/** The splash comes up as the fish's head breaks the water, and as its body goes back in. */
const LAUNCH_U = crossing(3, false);
const ENTRY_U = crossing(-1, true);
const msAt = (u: number) => (u + UNDER) * AIR_MS;
/** The leap ends when the fish is under and the second splash has settled. */
export const LEAP_MS = Math.ceil(
  Math.max(msAt(1 + UNDER), msAt(ENTRY_U) + (SPLASH_FRAMES - 1) * SPLASH_FRAME_MS) + 1000 / 60,
);
/** Leap progress where a still scene holds the fish: climbing, over the last of its splash. */
export const LEAP_REST = 0.28;
/** The left column of each splash cell, which centers it on the fish. */
export const LAUNCH_X = Math.round(centerX(LAUNCH_U)) - (SPLASH_W - 1) / 2;
export const ENTRY_X = Math.round(centerX(ENTRY_U)) - (SPLASH_W - 1) / 2;

/** The sheet frame whose angle is nearest the direction the fish is moving. */
function fishFrame(u: number): number {
  const angle = (Math.atan2(4 * RISE * (1 - 2 * u), TO - FROM) * 180) / Math.PI;
  let best = 0;
  FISH_ANGLES.forEach((frame, index) => {
    if (Math.abs(frame - angle) < Math.abs((FISH_ANGLES[best] ?? 0) - angle)) best = index;
  });
  return best;
}

/** The splash cell for a splash that started at path parameter `start`: 0 is the empty cell. */
function splashFrame(ms: number, start: number): number {
  const since = ms - msAt(start);
  if (since < 0) return 0;
  const frame = 1 + Math.floor(since / SPLASH_FRAME_MS);
  return frame < SPLASH_FRAMES ? frame : 0;
}

export type LeapStep = {
  /** Leap progress, from 0 to 1, where this step starts. */
  at: number;
  /** The top left of the fish's cell, in whole art pixels. */
  x: number;
  y: number;
  frame: number;
  launch: number;
  entry: number;
};

/** The leap at 60 steps a second, with a step only where something on screen changes. */
export function leapSteps(): LeapStep[] {
  const count = Math.round((LEAP_MS / 1000) * 60);
  const steps: LeapStep[] = [];
  const half = (FISH_CELL - 1) / 2;
  for (let index = 0; index <= count; index += 1) {
    const at = index / count;
    const ms = at * LEAP_MS;
    const u = along(ms);
    const step = {
      at,
      x: Math.round(centerX(u)) - half,
      y: Math.round(centerY(u)) - half,
      frame: fishFrame(u),
      launch: splashFrame(ms, LAUNCH_U),
      entry: splashFrame(ms, ENTRY_U),
    };
    const last = steps.at(-1);
    if (
      last === undefined ||
      last.x !== step.x ||
      last.y !== step.y ||
      last.frame !== step.frame ||
      last.launch !== step.launch ||
      last.entry !== step.entry
    ) {
      steps.push(step);
    }
  }
  return steps;
}

/**
 * An Animated interpolation that holds each step's value until the next step, so the sprite moves
 * in whole art pixels and changes frame without blending two frames.
 */
export function held<T extends { at: number }>(steps: T[], value: (step: T) => number) {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  steps.forEach((step, index) => {
    const end = steps[index + 1]?.at ?? 1;
    inputRange.push(step.at, Math.max(step.at, end - 1e-6));
    outputRange.push(value(step), value(step));
  });
  return { inputRange, outputRange, extrapolate: "clamp" as const };
}
