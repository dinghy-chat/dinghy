// A small sea in the landing page's style (site/public/js/water.js), for the widget and the
// operator app: layers of swell with crests and drifting wavelets, a boat that rides the swell
// with its shadow, and the sun's path when asked. It draws at most 30 frames a second, only while
// on screen, and stops when the visitor asks for less motion, even while the page is open. The
// host holds two canvases and the boat:
// <canvas class="sea-back">, <span class="float"> with the boat inside, <canvas class="sea-front">.

export interface Swell {
  /** The share of the height where this layer's surface rests. */
  level: number;
  /** The swell's size in pixels. */
  swell: number;
  fill: string;
  crest: string;
}

/** The landing page's three water colors, from the far swell to the near one. */
export const FAR = { fill: "#8fc5ff", crest: "#c2e0ff" };
export const MIDDLE = { fill: "#2f7dff", crest: "#7fb2ff" };
export const NEAR = { fill: "#0f47b4", crest: "#3f75d9" };

export interface SeaOptions {
  layers: Swell[];
  /** The boat rides this layer, and the layers after it are drawn in front of it. */
  boatLayer: number;
  /** Where the boat rests, as a share of the width. */
  boatAt: number;
  /** How far the boat drifts each way, in pixels. */
  drift?: number;
  /** Where the sun's path lies on the far layer, as a share of the width. */
  sunAt?: number | undefined;
}

const STILL_MOMENT = 30;
/** 30 frames a second is smooth for a slow swell, and half the work of a 60 Hz screen. */
const FRAME_MS = 1000 / 30;
const SAMPLE_STEP = 6;
const HEIGHT_PER_WIDTH = 120 / 140;
const TO_DEGREES = 180 / Math.PI;
const CREAM = "#fff8df";

/**
 * Starts the sea, and returns a function that stops it. The boat and the sun's path ease toward
 * `options.boatAt` and `options.sunAt` while the sea moves. With reduced motion nothing moves, so
 * the host starts the sea again to show a new place.
 */
export function startSea(host: HTMLElement, options: SeaOptions): () => void {
  const back = host.querySelector<HTMLCanvasElement>(".sea-back");
  const front = host.querySelector<HTMLCanvasElement>(".sea-front");
  const float = host.querySelector<HTMLElement>(".float");
  const backContext = back?.getContext("2d");
  const frontContext = front?.getContext("2d");
  if (!back || !front || !float || !backContext || !frontContext) return () => {};
  const { layers, boatLayer, drift = 0 } = options;
  // Read each frame, so a host that changes them sees the boat and the sun's path glide there.
  let { boatAt, sunAt } = options;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0;
  let height = 0;
  let boatWidth = 0;
  let request = 0;
  let visible = false;
  let seconds = STILL_MOMENT;
  let last = 0;

  const surfaceY = (x: number, index: number, t: number) => {
    const { level, swell } = layers[index] ?? { level: 1, swell: 0 };
    const a = Math.sin(x * 0.021 + t * 0.7 + index * 1.7);
    const b = 0.55 * Math.sin(x * 0.046 - t * 0.95 + index * 0.6);
    const c = 0.25 * Math.sin(x * 0.1 + t * 1.6 + index * 2.2);
    return level * height + swell * (a + b + c);
  };

  const trace = (context: CanvasRenderingContext2D, index: number, t: number) => {
    for (let x = -SAMPLE_STEP; x <= width + SAMPLE_STEP; x += SAMPLE_STEP) {
      context.lineTo(x, surfaceY(x, index, t));
    }
  };

  const drawLayer = (context: CanvasRenderingContext2D, index: number, t: number) => {
    const layer = layers[index];
    if (!layer) return;
    context.beginPath();
    context.moveTo(-SAMPLE_STEP, height);
    trace(context, index, t);
    context.lineTo(width + SAMPLE_STEP, height);
    context.closePath();
    context.fillStyle = layer.fill;
    context.fill();
    context.beginPath();
    trace(context, index, t);
    context.strokeStyle = layer.crest;
    context.lineWidth = Math.min(2.5, Math.max(1.2, height / 60));
    context.lineJoin = "round";
    context.stroke();
    // Short wavelets drift across the layer, each at its own speed and depth.
    const below = (layers[index + 1]?.level ?? 1) * height;
    const count = Math.max(2, Math.round(width / 46));
    context.lineWidth = Math.max(1, context.lineWidth * 0.8);
    context.lineCap = "round";
    context.globalAlpha = 0.6;
    for (let i = 0; i < count; i++) {
      const speed = (4 + ((i * 3) % 5) * 2) * (i % 2 ? -1 : 1);
      const x =
        ((((i * 137.5 + index * 53 + speed * t) % (width + 40)) + width + 40) % (width + 40)) - 20;
      const top = surfaceY(x, index, t);
      const y = top + (below - top) * (0.3 + ((i * 7) % 10) / 22) + Math.sin(t + i) * 1;
      if (y < top + 5 || y > height - 2) continue;
      const length = Math.min(18, width / 14) + (i % 3) * 3;
      context.beginPath();
      context.moveTo(x, y);
      context.quadraticCurveTo(x + length / 2, y - 2.5, x + length, y);
      context.stroke();
    }
    context.globalAlpha = 1;
  };

  const drawSunPath = (t: number) => {
    if (sunAt === undefined) return;
    const x = width * sunAt;
    backContext.fillStyle = CREAM;
    for (let i = 0; i < 4; i++) {
      const y = surfaceY(x, 0, t) + 5 + i * 4;
      const length = (width / 9 - i * 3) * (0.65 + 0.35 * Math.sin(t * 1.8 + i * 1.7));
      backContext.globalAlpha = 0.75 - i * 0.12;
      backContext.beginPath();
      backContext.roundRect(x - length / 2 + Math.sin(t + i) * 4, y, Math.max(4, length), 2, 1);
      backContext.fill();
    }
    backContext.globalAlpha = 1;
  };

  const placeBoat = (t: number) => {
    const boatHeight = boatWidth * HEIGHT_PER_WIDTH;
    // Clear of the edges, so a narrow screen never cuts the bow or the stern.
    const edge = boatWidth / 2 + 12;
    const x = Math.min(width - edge, Math.max(edge, width * boatAt + Math.sin(t * 0.35) * drift));
    const surface = surfaceY(x, boatLayer, t);
    const slope =
      surfaceY(x + boatWidth * 0.4, boatLayer, t) - surfaceY(x - boatWidth * 0.4, boatLayer, t);
    const angle = Math.atan2(slope, boatWidth * 0.8) * TO_DEGREES * 0.9 + Math.sin(t * 1.3) * 1.4;
    const bob = Math.sin(t * 1.7) * Math.min(1.2, boatWidth / 60);
    float.style.transform = `translate(${(x - boatWidth / 2).toFixed(1)}px,${(surface - boatHeight * 0.9 + bob).toFixed(1)}px) rotate(${angle.toFixed(2)}deg)`;
    backContext.globalAlpha = 0.22;
    backContext.fillStyle = "#0b2239";
    backContext.beginPath();
    backContext.ellipse(
      x,
      surface + boatWidth * 0.07,
      boatWidth * 0.42,
      Math.max(1.5, boatWidth * 0.035),
      0,
      0,
      Math.PI * 2,
    );
    backContext.fill();
    backContext.globalAlpha = 1;
  };

  const draw = (t: number) => {
    for (const context of [backContext, frontContext]) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, back.width, back.height);
      const ratio = back.width / Math.max(1, width);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    for (let i = 0; i <= boatLayer; i++) {
      drawLayer(backContext, i, t);
      if (i === 0) drawSunPath(t);
    }
    placeBoat(t);
    for (let i = boatLayer + 1; i < layers.length; i++) drawLayer(frontContext, i, t);
  };

  const resize = () => {
    width = host.clientWidth;
    height = host.clientHeight;
    boatWidth = float.offsetWidth;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    for (const canvas of [back, front]) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    draw(seconds);
  };

  const tick = (now: number) => {
    request = requestAnimationFrame(tick);
    if (now - last < FRAME_MS) return;
    const step = Math.min(Math.max(now - last, 0) / 1000, 0.1);
    seconds += step;
    last = now;
    // About half a second to settle on a new place.
    const share = Math.min(1, step * 7);
    boatAt += (options.boatAt - boatAt) * share;
    sunAt =
      sunAt === undefined || options.sunAt === undefined
        ? options.sunAt
        : sunAt + (options.sunAt - sunAt) * share;
    draw(seconds);
  };

  const run = () => {
    cancelAnimationFrame(request);
    if (motion.matches || !visible || document.hidden) return;
    last = performance.now();
    request = requestAnimationFrame(tick);
  };

  const sizes = new ResizeObserver(resize);
  sizes.observe(host);
  const sight = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    run();
  });
  sight.observe(host);
  document.addEventListener("visibilitychange", run);
  motion.addEventListener("change", run);
  resize();

  return () => {
    cancelAnimationFrame(request);
    sizes.disconnect();
    sight.disconnect();
    document.removeEventListener("visibilitychange", run);
    motion.removeEventListener("change", run);
  };
}
