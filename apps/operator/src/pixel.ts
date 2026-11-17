// A small pixel-art kit for the gull's empty states: a fixed palette, sprites from text, and
// whole-pixel drawing on a canvas that the browser scales up without smoothing.

/** One color per letter. A sprite's "." is a clear pixel. */
export const PALETTE = {
  k: "#0b2239",
  w: "#ffffff",
  c: "#fff8df",
  e: "#eadfb8",
  y: "#ffc81e",
  Y: "#d9a400",
  r: "#e5352b",
  R: "#b3261e",
  p: "#1f6bff",
  l: "#8fc5ff",
  b: "#2f7dff",
  B: "#0f47b4",
  g: "#c3ced9",
  d: "#93a1b0",
  o: "#f08a24",
  t: "#9a6a3a",
  T: "#6b4522",
  G: "#0f8a5f",
  "1": "#fff3c4",
  "2": "#fffbe8",
  "3": "#ffe59a",
} as const;
type PaletteKey = keyof typeof PALETTE;
/** Colors that replace some letters for one drawing, such as the pale white of a gull in flight. */
export type Swap = Partial<Record<string, string>>;

export interface Sprite {
  w: number;
  h: number;
  rows: string[];
}

const isPaletteKey = (letter: string): letter is PaletteKey => letter in PALETTE;

/** A sprite from rows of letters. The common indent and blank lines go. */
export function sprite(text: string): Sprite {
  const rows = text
    .split("\n")
    .filter((row) => row.trim().length > 0)
    .map((row) => row.replace(/\s+$/, ""));
  const indent = Math.min(...rows.map((row) => row.length - row.trimStart().length));
  const cut = rows.map((row) => row.slice(indent));
  return { w: Math.max(...cut.map((row) => row.length)), h: cut.length, rows: cut };
}

type SetRun = (fromX: number, toX: number, y: number, letter: string) => void;

/** A sprite drawn from runs, for shapes that are easier to count than to type. */
export function build(w: number, h: number, draw: (set: SetRun) => void): Sprite {
  const cells = Array.from({ length: h }, () => Array<string>(w).fill("."));
  draw((from, to, y, letter) => {
    const row = cells[y];
    if (row === undefined) return;
    for (let x = Math.max(0, from); x <= Math.min(w - 1, to); x += 1) row[x] = letter;
  });
  return { w, h, rows: cells.map((row) => row.join("")) };
}

export function blit(
  ctx: CanvasRenderingContext2D,
  art: Sprite,
  x: number,
  y: number,
  { flip = false, swap }: { flip?: boolean; swap?: Swap } = {},
): void {
  const left = Math.round(x);
  const top = Math.round(y);
  art.rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i += 1) {
      const letter = row[i] ?? ".";
      const color = swap?.[letter] ?? (isPaletteKey(letter) ? PALETTE[letter] : undefined);
      if (color === undefined) continue;
      ctx.fillStyle = color;
      ctx.fillRect(left + (flip ? art.w - 1 - i : i), top + j, 1, 1);
    }
  });
}

/** A sprite turned a quarter, nose up, or nose down with `down`. */
export function turned(art: Sprite, down: boolean): Sprite {
  const rows: string[] = [];
  for (let x = 0; x < art.w; x += 1) {
    let row = "";
    for (let y = 0; y < art.h; y += 1) {
      const source = art.rows[down ? y : art.h - 1 - y];
      row += source?.[down ? art.w - 1 - x : x] ?? ".";
    }
    rows.push(row);
  }
  return { w: art.h, h: art.w, rows };
}

/**
 * A canvas of `w` by `h` art pixels, each `scale` CSS pixels wide. The backing store holds a whole
 * number of device pixels per art pixel, so every art pixel is a sharp square on any screen.
 */
export function pixelCanvas(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  scale: number,
): CanvasRenderingContext2D {
  const device = Math.max(1, Math.round(scale * devicePixelRatio));
  canvas.width = w * device;
  canvas.height = h * device;
  canvas.style.width = `${w * scale}px`;
  canvas.style.height = `${h * scale}px`;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("This browser has no 2D canvas");
  ctx.setTransform(device, 0, 0, device, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Clears a canvas made by pixelCanvas, whatever its transform. */
export function clearCanvas(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

export function fillRun(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w: number,
  h = 1,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

const LESS_MOTION = "(prefers-reduced-motion: reduce)";

/** Read on each frame, so a change in the system setting stops the art at once. */
export const isLessMotion = () => matchMedia(LESS_MOTION).matches;

/** The most time one frame may move the art, so a frame after a pause does not jump. */
const MAX_FRAME_S = 0.05;

/**
 * Calls `frame` on each animation frame with the seconds since the last. It sleeps while the tab is
 * in the background or the canvas is hidden, so a pane nobody sees costs nothing.
 */
export function animate(
  canvas: HTMLCanvasElement,
  frame: (deltaS: number, now: number) => void,
): () => void {
  let raf = 0;
  let last = performance.now();
  let inView = true;
  const isAwake = () => inView && document.visibilityState === "visible";
  const step = (now: number) => {
    frame(Math.min(MAX_FRAME_S, (now - last) / 1000), now);
    last = now;
    raf = isAwake() ? requestAnimationFrame(step) : 0;
  };
  const wake = () => {
    if (raf !== 0 || !isAwake()) return;
    last = performance.now();
    raf = requestAnimationFrame(step);
  };
  const watcher = new IntersectionObserver((entries) => {
    inView = entries.some((entry) => entry.isIntersecting);
    wake();
  });
  watcher.observe(canvas);
  document.addEventListener("visibilitychange", wake);
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    watcher.disconnect();
    document.removeEventListener("visibilitychange", wake);
  };
}
