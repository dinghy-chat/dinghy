import { Boat } from "./boat.js";
import { drawShoreline, drawSunPath } from "./hero.js";
import { animateWhileVisible, onWidthChange, reducedMotion } from "./motion.js";
import { STILL_MOMENT, Water } from "./water.js";

const SMALL_WIDTH = 700;

/**
 * A water scene in the hero's style: layers of swell, boats, and the sun's path when the host
 * holds a `.sun`. Layers from `frontFrom` on are drawn in front of the boats. Each boat sets its
 * size as [phone, wide], its layer, where it starts as a share of the width, and its speed in
 * pixels a second, negative to sail west. With motion off, the scene is drawn once and still.
 */
export function startScene(host, { layers, frontFrom, boats = [], shore = false, phase = 0 }) {
  const water = new Water(host, { layers, phase });
  const parent = host.querySelector("[data-boats]");
  const sun = host.querySelector(".sun");
  const small = () => water.width < SMALL_WIDTH;
  const fleet = boats.map((spec) => ({
    spec,
    x: water.width * spec.at,
    boat: new Boat(parent, spec.size[1], spec.colors),
  }));
  let sunX = null;

  const measure = () => {
    if (sun) {
      const { left, width } = sun.getBoundingClientRect();
      const origin = host.getBoundingClientRect().left;
      sunX = left - origin + width / 2;
    }
    for (const ship of fleet) {
      ship.boat.setSize(ship.spec.size[small() ? 0 : 1]);
      ship.boat.turn(Math.sign(ship.spec.speed) || 1, false);
      if (reducedMotion) ship.x = water.width * ship.spec.at;
    }
  };

  const draw = (t, step) => {
    water.clear();
    water.driftWavelets(step);
    for (let i = 0; i < frontFrom; i++) {
      water.drawLayer(water.back, i, t);
      if (i === 0 && sunX !== null) drawSunPath(water, sunX, t);
    }
    for (const ship of fleet) {
      const { speed, layer } = ship.spec;
      const edge = ship.boat.size;
      ship.x += speed * (small() ? 0.6 : 1) * step;
      if (ship.x > water.width + edge) ship.x = -edge;
      if (ship.x < -edge) ship.x = water.width + edge;
      water.float(ship.boat, ship.x, layer, t);
    }
    for (let i = frontFrom; i < layers.length; i++) water.drawLayer(water.front, i, t);
    if (shore) drawShoreline(water, t);
  };

  measure();
  onWidthChange(() => {
    water.resize();
    measure();
    if (reducedMotion) draw(STILL_MOMENT, 0);
  });
  if (reducedMotion) draw(STILL_MOMENT, 0);
  else animateWhileVisible(host, draw);
}
