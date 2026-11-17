/** @jsxImportSource react */
import { type ReactNode, useEffect, useRef } from "react";
import { BUOY, CLOUD_B, WATER } from "./gull-sprites.ts";
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
type BuoyTone = "done" | "waiting" | "fog";

const MARK_W = 22;
const MARK_H = 20;
const MARK_SCALE = 3;
const FLAG = {
  done: { y: "G" },
  waiting: { y: "p" },
  fog: { y: "d", r: "d", R: "D" },
} as const satisfies Record<BuoyTone, object>;
const FOG = { 1: "7", 2: "w", 3: "8" } as const;

function drawMark(ctx: CanvasRenderingContext2D, tone: BuoyTone, time: number) {
  clearCanvas(ctx);
  const bob = Math.round(Math.sin(time * 2));
  blit(ctx, BUOY, 6, 3 + bob, { swap: FLAG[tone] });
  fillRun(ctx, P.l, 2 + bob, 14, 18);
  blit(ctx, WATER, 0, 15);
  if (Math.sin(time * 2) > 0) fillRun(ctx, P.s, 3, 16, 3);
  else fillRun(ctx, P.s, 15, 15, 3);
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
    }).stop;
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
