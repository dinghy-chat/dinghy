import "./nav.js";
import { watchVisibility } from "./motion.js";
import { startScene } from "./scene.js";
import { CREAM, FAR, MIDDLE, NEAR } from "./water.js";

// A boat drifts west, away from home, while a far boat sails on.
startScene(document.querySelector("[data-scene]"), {
  layers: [
    { level: 0.34, swell: 3, ...FAR },
    { level: 0.56, swell: 4, ...MIDDLE },
    { level: 0.8, swell: 4.5, ...NEAR },
  ],
  frontFrom: 2,
  shore: false,
  boats: [
    { size: [40, 56], layer: 0, at: 0.2, speed: 8, colors: { main: CREAM, jib: CREAM } },
    { size: [92, 124], layer: 1, at: 0.58, speed: -12 },
  ],
});

const section = document.querySelector("[data-pause-offscreen]");
watchVisibility(section, (visible) => section.classList.toggle("is-paused", !visible));
