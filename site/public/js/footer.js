import { Boat } from "./boat.js";
import { animateWhileVisible, onWidthChange, reducedMotion } from "./motion.js";
import { FAR, MIDDLE, NEAR, STILL_MOMENT, Water } from "./water.js";

const LAYERS = [
  { level: 0.42, swell: 3, ...FAR },
  { level: 0.6, swell: 4, ...MIDDLE },
  { level: 0.78, swell: 4.5, ...NEAR },
  { level: 0.93, swell: 3, fill: "#0b2239" },
];
const BOAT_LAYER = 1;

function drawChain(water, boatX, top, chainX) {
  const { front } = water;
  front.save();
  front.strokeStyle = "#b8d9ff";
  front.lineWidth = 3;
  front.lineCap = "round";
  front.setLineDash([0.1, 6]);
  front.beginPath();
  front.moveTo(boatX, top);
  front.lineTo(chainX, water.height);
  front.stroke();
  front.restore();
}

export function startFooter() {
  const host = document.querySelector("[data-footer-water]");
  const chain = document.querySelector(".chain");
  const boatSize = () => (innerWidth <= 820 ? 84 : 104);
  const water = new Water(host, { layers: LAYERS, phase: 1 });
  const boat = new Boat(host.querySelector("[data-boats]"), boatSize());
  let chainX = null;

  const measure = () => {
    const { left, width } = chain.getBoundingClientRect();
    chainX = width ? left + width / 2 : null;
  };

  const draw = (t, step) => {
    water.clear();
    water.driftWavelets(step);
    water.drawLayer(water.back, 0, t);
    water.drawLayer(water.back, 1, t);
    const x = water.width * 0.95 - boat.size / 2 + Math.sin(t * 0.35) * 7;
    const { surface, bob } = water.float(boat, x, BOAT_LAYER, t);
    water.drawLayer(water.front, 2, t);
    water.drawLayer(water.front, 3, t);
    if (chainX !== null) drawChain(water, x, surface + boat.size * 0.05 + bob, chainX);
  };

  measure();
  onWidthChange(() => {
    water.resize();
    boat.setSize(boatSize());
    measure();
    if (reducedMotion) draw(STILL_MOMENT, 0);
  });

  if (reducedMotion) draw(STILL_MOMENT, 0);
  else animateWhileVisible(host, draw);
}
