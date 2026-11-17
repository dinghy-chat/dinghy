/** @jsxImportSource react */
import { type ReactNode, useEffect, useRef } from "react";
import { BUOY, CLOUD_B } from "./gull-sprites.ts";
import {
  animate,
  blit,
  clearCanvas,
  fillRun,
  isLessMotion,
  PALETTE as P,
  pixelCanvas,
} from "./pixel.ts";

/** The buoy's flag: green when all is done, blue while the first message is awaited, grey in fog. */
export type BuoyTone = "done" | "waiting" | "fog";

const MARK_W = 22;
const MARK_H = 20;
const MARK_SCALE = 3;
const FLAG: Record<BuoyTone, Record<string, string>> = {
  done: { y: P.G },
  waiting: { y: P.p },
  fog: { y: P.d, r: P.d, R: "#7c8b9b" },
};
const FOG = { 1: "#f4f6f8", 2: "#ffffff", 3: "#dfe5ea" };
const SPARKLE = "#d6eaff";
/** The little water under the buoy: [fromX, toX, y, color]. */
const WATER: [number, number, number, string][] = [
  [2, 19, 14, P.l],
  [0, 21, 15, P.b],
  [0, 21, 16, P.b],
  [1, 20, 17, P.B],
  [3, 18, 18, P.B],
];

function drawMark(ctx: CanvasRenderingContext2D, tone: BuoyTone, time: number) {
  clearCanvas(ctx);
  const bob = Math.round(Math.sin(time * 2));
  blit(ctx, BUOY, 6, 3 + bob, { swap: FLAG[tone] });
  for (const [from, to, y, color] of WATER) {
    fillRun(ctx, color, from + (y === 14 ? bob : 0), y, to - from + 1);
  }
  if (Math.sin(time * 2) > 0) fillRun(ctx, SPARKLE, 3, 16, 3);
  else fillRun(ctx, SPARKLE, 15, 15, 3);
  if (tone === "fog") {
    blit(ctx, CLOUD_B, 3 + Math.round(Math.sin(time * 0.8) * 2), 5, { swap: FOG });
  }
}

/** The list's own mark: a buoy on a little water, and fog over it when a search finds nothing. */
function BuoyMark({ tone }: { tone: BuoyTone }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const ctx = pixelCanvas(element, MARK_W, MARK_H, MARK_SCALE);
    let time = 0;
    return animate(element, (deltaS) => {
      if (!isLessMotion()) time += deltaS;
      drawMark(ctx, tone, time);
    });
  }, [tone]);
  // A picture with no words of its own: the title beside it says what it shows.
  return (
    <span className="list-mark" aria-hidden="true">
      <canvas ref={canvas} />
    </span>
  );
}

/** An empty list: the buoy, a title, one line and at most one action, in the column's middle. */
export function ListEmpty({
  tone,
  title,
  hint,
  action,
}: {
  tone: BuoyTone;
  title: string;
  hint: string | null;
  action?: ReactNode;
}) {
  return (
    <div className="list-empty">
      <BuoyMark tone={tone} />
      <b>{title}</b>
      {hint !== null && <span>{hint}</span>}
      {action}
    </div>
  );
}
