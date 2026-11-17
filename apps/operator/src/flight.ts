// The gull in flight: a loop, a fish caught in the air, and a letter carried to the list. It flies
// on its own small canvas over the page, which never takes a click, so it covers no real control.
import { FISH_DOWN, GULL_FLY, NOTE } from "./gull-sprites.ts";
import type { Perch, Point } from "./perch.ts";
import { blit, clearCanvas, pixelCanvas } from "./pixel.ts";

const FLYER_W = 27;
const FLYER_H = 24;
const FLAP_MS = 95;
/** Wings up, level, down, level. */
const FLAP_ORDER = [0, 1, 2, 1] as const;
/** In flight the white is a pale blue, and a hard shadow sits under the bird, so it reads on the
 white list too. */
const AIR = { w: "#e6eef7" };
const SHADOW = "rgb(11 34 57 / 0.16)";

const LOOP_LEGS = [
  { by: { x: 190, y: -120 }, ms: 520, lift: 60 },
  { by: { x: -170, y: -150 }, ms: 620, lift: -40 },
  { by: { x: 0, y: 0 }, ms: 560, lift: 40 },
];
const SNATCH_WAIT_MS = 260;
const SNATCH_DIVE = { ms: 240, lift: -30 };
const SNATCH_BACK = { ms: 380, lift: 50 };
const ARRIVE_WAIT_MS = 380;
/** Where an arrival picks the letter up when it does not come from the board: off the pane. */
const PICKUP_OFF_PANE = { x: 80, y: -110 };
const BOARD_PICKUP = { x: 40, y: -30 };
const TO_PICKUP = { board: { ms: 380, lift: 50 }, away: { ms: 480, lift: 50 } };
const TO_LIST = { ms: 900, lift: 80 };
const HOME = { ms: 800, lift: 70 };
/** The letter lands a little right of and above the first row's face. */
const DROP = { x: 30, y: -26 };

type Carried = "note" | "fish" | null;
/** Where the letter waits: on the board's form, or beside the pane. */
export type Pickup = { from: "board" | "pane"; box: DOMRect };

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const ease = (part: number) => (part < 0.5 ? 2 * part * part : 1 - (-2 * part + 2) ** 2 / 2);

export interface Flights {
  loop(gull: Perch): void;
  snatch(gull: Perch, fish: Point, take: () => void): void;
  /**
   * Picks a letter up at the board, or just past the pane, carries it to the list's first row, at
   * `spot`, and flies home.
   */
  deliver(gull: Perch, pickup: Pickup, spot: Point): Promise<void>;
  stop(): void;
}

/** Flights at `scale` CSS pixels per art pixel, on a canvas of their own over the page. */
export function createFlights(scale: number): Flights {
  const flyer = document.createElement("canvas");
  flyer.className = "gull-flyer";
  flyer.hidden = true;
  flyer.setAttribute("aria-hidden", "true");
  document.body.append(flyer);
  const ctx = pixelCanvas(flyer, FLYER_W, FLYER_H, scale);
  flyer.style.filter = `drop-shadow(${scale}px ${scale}px 0 ${SHADOW})`;
  let carrying: Carried = null;
  let heading = 1;
  let isFlying = false;
  let isStopped = false;

  function drawBird() {
    clearCanvas(ctx);
    const frame = GULL_FLY[FLAP_ORDER[Math.floor(performance.now() / FLAP_MS) % 4] ?? 0];
    const isLeft = heading < 0;
    blit(ctx, frame, 2, 1, { flip: isLeft, swap: AIR });
    if (carrying === "note") blit(ctx, NOTE, isLeft ? 1 : 19, 10);
    if (carrying === "fish") blit(ctx, FISH_DOWN, isLeft ? 1 : 20, 8);
  }

  /** Moves the bird along an arc, in whole art pixels, so it never blurs between them. */
  function fly(from: Point, to: Point, ms: number, lift: number): Promise<void> {
    heading = to.x >= from.x ? 1 : -1;
    flyer.hidden = false;
    const start = performance.now();
    return new Promise((done) => {
      const step = (now: number) => {
        if (isStopped) return done();
        const eased = ease(Math.min(1, (now - start) / ms));
        const x = from.x + (to.x - from.x) * eased;
        const y = from.y + (to.y - from.y) * eased - Math.sin(eased * Math.PI) * lift;
        const left = Math.round((x - flyer.offsetWidth / 2) / scale) * scale;
        const top = Math.round((y - flyer.offsetHeight / 2) / scale) * scale;
        flyer.style.transform = `translate(${left}px, ${top}px)`;
        drawBird();
        if (now - start < ms) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
  }

  /** One flight from the post and back. The gull is away meanwhile, and only one flies at a time. */
  async function trip(
    gull: Perch,
    run: (home: Point) => Promise<void>,
    after: () => void = () => gull.squawk(),
  ) {
    if (isFlying || isStopped) return;
    isFlying = true;
    const home = gull.at();
    gull.setMode("away");
    await run(home);
    flyer.hidden = true;
    carrying = null;
    isFlying = false;
    if (isStopped) return;
    gull.setMode("idle");
    after();
  }

  const at = (home: Point, by: Point) => ({ x: home.x + by.x, y: home.y + by.y });

  return {
    loop(gull) {
      void trip(gull, async (home) => {
        let from = home;
        for (const leg of LOOP_LEGS) {
          const to = at(home, leg.by);
          await fly(from, to, leg.ms, leg.lift);
          from = to;
        }
      });
    },
    snatch(gull, fish, take) {
      void trip(
        gull,
        async (home) => {
          await wait(SNATCH_WAIT_MS);
          await fly(home, fish, SNATCH_DIVE.ms, SNATCH_DIVE.lift);
          take();
          carrying = "fish";
          await fly(fish, home, SNATCH_BACK.ms, SNATCH_BACK.lift);
        },
        () => gull.gulp(),
      );
    },
    async deliver(gull, pickup, spot) {
      if (gull.mode !== "idle") gull.setMode("idle");
      gull.squawk();
      await wait(ARRIVE_WAIT_MS);
      await trip(gull, async (home) => {
        const isBoard = pickup.from === "board";
        const from = isBoard
          ? { x: pickup.box.left + BOARD_PICKUP.x, y: pickup.box.top + BOARD_PICKUP.y }
          : { x: pickup.box.right + PICKUP_OFF_PANE.x, y: home.y + PICKUP_OFF_PANE.y };
        const leg = isBoard ? TO_PICKUP.board : TO_PICKUP.away;
        await fly(home, from, leg.ms, leg.lift);
        carrying = "note";
        const drop = at(spot, DROP);
        await fly(from, drop, TO_LIST.ms, TO_LIST.lift);
        carrying = null;
        await fly(drop, home, HOME.ms, HOME.lift);
      });
    },
    stop() {
      isStopped = true;
      flyer.remove();
    },
  };
}
