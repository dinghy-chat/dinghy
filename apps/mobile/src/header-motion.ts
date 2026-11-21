// The small movements in the Inbox, Contacts, Visitors and Settings headers. Each one shows a patch
// of the scene redrawn for a moment, over the still art, and then hides it again. The patches are
// opaque crops of the scene with one thing moved, so the still art stays exactly as drawn.
// scripts/render-header-scenes.ts bakes the patch images from the geometry here.

/** A patch in art pixels of its scene, from the scene's top left. */
export type Rect = { x: number; y: number; w: number; h: number };

export type Movement = {
  /** The scene's size in art pixels. The patch is placed in percent of it. */
  grid: { w: number; h: number };
  rect: Rect;
  /** How many patch frames the image holds, side by side. Frame 0 is the still art. */
  frames: number;
  /** Each frame and how long it shows, in order. The still art comes back after the last. */
  beats: readonly (readonly [frame: number, ms: number])[];
  /** The first movement waits for the tab to settle. */
  firstMs: number;
  /** The quiet time between movements: at least `least`, plus up to `more`. */
  gap: { least: number; more: number };
};

export const MOVEMENTS = {
  /** The boat dips one art pixel into the swell twice, as a wave passes under it. */
  inbox: {
    grid: { w: 192, h: 72 },
    rect: { x: 132, y: 28, w: 36, h: 23 },
    frames: 1,
    beats: [
      [1, 600],
      [0, 450],
      [1, 800],
    ],
    firstMs: 2400,
    gap: { least: 7000, more: 5000 },
  },
  /** The gull on its post blinks once, the same 130 ms blink as the web app's perch. */
  contacts: {
    grid: { w: 160, h: 50 },
    rect: { x: 133, y: 8, w: 1, h: 1 },
    frames: 1,
    beats: [[1, 130]],
    firstMs: 1600,
    gap: { least: 4000, more: 4000 },
  },
  /** The red skiff drifts two art pixels away from the lookout and comes back. */
  visitors: {
    grid: { w: 160, h: 50 },
    rect: { x: 124, y: 30, w: 15, h: 11 },
    frames: 2,
    beats: [
      [1, 1100],
      [2, 3400],
      [1, 1100],
    ],
    firstMs: 2000,
    gap: { least: 9000, more: 6000 },
  },
  /** The sleeping gull's head drops one art pixel, jerks back up, then drops again. */
  settings: {
    grid: { w: 130, h: 66 },
    rect: { x: 106, y: 19, w: 13, h: 14 },
    frames: 1,
    beats: [
      [1, 1000],
      [0, 240],
      [1, 2000],
    ],
    firstMs: 2800,
    gap: { least: 8000, more: 5000 },
  },
} as const satisfies Record<string, Movement>;

export type MovementName = keyof typeof MOVEMENTS;

/** The Contacts blink is one pixel of the gull's white, so it needs no image. */
export const BLINK_COLOR = "#ffffff";

export type Beat = { at: number; frame: number };

/**
 * The beats as steps of progress from 0 to 1, for `held` in analytics-leap.ts. A last step at 1
 * shows the still art, so the scene is still when the movement ends.
 */
export function movementSteps(movement: Movement): { ms: number; steps: Beat[] } {
  const ms = movement.beats.reduce((sum, [, length]) => sum + length, 0);
  let elapsed = 0;
  const steps = movement.beats.map(([frame, length]) => {
    const step = { at: elapsed / ms, frame };
    elapsed += length;
    return step;
  });
  steps.push({ at: 1, frame: 0 });
  return { ms, steps };
}

/** Where a patch sits in its scene, in percent, so it follows the art when the art is scaled. */
export function patchBox(movement: Movement) {
  const { grid, rect } = movement;
  const percent = (value: number, whole: number) => `${(value / whole) * 100}%` as const;
  return {
    left: percent(rect.x, grid.w),
    top: percent(rect.y, grid.h),
    width: percent(rect.w, grid.w),
    height: percent(rect.h, grid.h),
  };
}
