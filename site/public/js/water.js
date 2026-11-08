const MAX_PIXEL_RATIO = 2;
const SAMPLE_STEP = 8;
const OVERHANG = 8;
const WAVELET_SPACING = 36;
const TO_DEGREES = 180 / Math.PI;

/** The moment in the swell to draw when motion is off. */
export const STILL_MOMENT = 30;

/** The three shared water colors, from the far swell to the near one. */
export const FAR = { fill: "#8fc5ff", crest: "#c2e0ff" };
export const MIDDLE = { fill: "#2f7dff", crest: "#7fb2ff" };
export const NEAR = { fill: "#0f47b4", crest: "#3f75d9" };

/** The sun, its path on the water, and the far boats. */
export const CREAM = "#fff8df";

function seedWavelets(width) {
  return Array.from({ length: Math.round(width / WAVELET_SPACING) }, (_, i) => ({
    x: (i * 137.5) % width,
    layer: i % 3,
    depth: 0.18 + ((i * 7) % 10) / 14,
    length: 12 + (i * 13) % 30,
    speed: (0.1 + ((i * 3) % 5) / 18) * (i % 3 === 1 ? -1 : 1),
  }));
}

/**
 * Layers of slow swell on two canvases, one behind the boats and one in front of them.
 * Each layer sets its level (a share of the height), its swell in pixels and its colors.
 * `lift(x, layerIndex)` can add height to the swell, for ripples.
 */
export class Water {
  constructor(host, { layers, phase = 0, lift = () => 0 }) {
    this.host = host;
    this.layers = layers;
    this.phase = phase;
    this.lift = lift;
    this.backCanvas = host.querySelector("[data-water-back]");
    this.frontCanvas = host.querySelector("[data-water-front]");
    this.back = this.backCanvas.getContext("2d");
    this.front = this.frontCanvas.getContext("2d");
    this.resize();
  }

  resize() {
    this.width = this.host.clientWidth;
    this.height = this.host.clientHeight;
    this.ratio = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO);
    for (const canvas of [this.backCanvas, this.frontCanvas]) {
      canvas.width = this.width * this.ratio;
      canvas.height = this.height * this.ratio;
    }
    this.wavelets = seedWavelets(this.width);
  }

  clear() {
    for (const context of [this.back, this.front]) {
      context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      context.clearRect(0, 0, this.width, this.height);
    }
  }

  surfaceY(x, index, t) {
    const { level, swell } = this.layers[index];
    const a = Math.sin(x * 0.0105 + t * 0.7 + index * 1.7 + this.phase);
    const b = 0.55 * Math.sin(x * 0.023 - t * 0.95 + index * 0.6);
    const c = 0.25 * Math.sin(x * 0.052 + t * 1.6 + index * 2.2);
    return level * this.height + swell * (a + b + c) + this.lift(x, index);
  }

  traceSurface(context, index, t, offset = 0) {
    for (let x = -OVERHANG; x <= this.width + OVERHANG; x += SAMPLE_STEP) {
      context.lineTo(x, this.surfaceY(x, index, t) + offset);
    }
  }

  drawLayer(context, index, t) {
    const { fill, crest } = this.layers[index];
    context.beginPath();
    context.moveTo(-OVERHANG, this.height);
    this.traceSurface(context, index, t);
    context.lineTo(this.width + OVERHANG, this.height);
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    if (!crest) return;
    context.beginPath();
    this.traceSurface(context, index, t, 0.5);
    context.strokeStyle = crest;
    context.lineWidth = 2.5;
    context.lineJoin = "round";
    context.stroke();
    this.drawWavelets(context, index, t);
  }

  drawWavelets(context, index, t) {
    const nextLevel = this.layers[index + 1]?.level ?? 1;
    context.strokeStyle = this.layers[index].crest;
    context.lineWidth = 2;
    context.lineCap = "round";
    context.globalAlpha = 0.6;
    for (const wavelet of this.wavelets) {
      if (wavelet.layer !== index) continue;
      const top = this.surfaceY(wavelet.x, index, t);
      const y =
        top + (nextLevel * this.height - top) * wavelet.depth + Math.sin(t + wavelet.x * 0.02) * 1.5;
      if (y < top + 7) continue;
      context.beginPath();
      context.moveTo(wavelet.x, y);
      context.quadraticCurveTo(wavelet.x + wavelet.length / 2, y - 3, wavelet.x + wavelet.length, y);
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  driftWavelets(step) {
    for (const wavelet of this.wavelets) {
      wavelet.x += wavelet.speed * step * 60;
      if (wavelet.x > this.width + 40) wavelet.x = -40;
      if (wavelet.x < -40) wavelet.x = this.width + 40;
    }
  }

  /** Rests a boat on a layer with its shadow, and returns where its hull meets the water. */
  float(boat, x, index, t) {
    const { size, height } = boat;
    const surface = this.surfaceY(x, index, t);
    const slope = this.surfaceY(x + size * 0.4, index, t) - this.surfaceY(x - size * 0.4, index, t);
    const rock = Math.sin(t * 1.3 + size) * 1.4;
    const bob = Math.sin(t * 1.7 + size) * 1.2;
    boat.place(x, surface - height * 0.9 + bob, Math.atan2(slope, size * 0.8) * TO_DEGREES * 0.9 + rock);
    this.back.globalAlpha = 0.22;
    this.back.fillStyle = "#0b2239";
    this.back.beginPath();
    this.back.ellipse(x, surface + size * 0.07, size * 0.42, Math.max(2.5, size * 0.035), 0, 0, Math.PI * 2);
    this.back.fill();
    this.back.globalAlpha = 1;
    return { surface, bob };
  }
}
