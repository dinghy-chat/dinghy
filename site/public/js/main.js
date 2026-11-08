import "./nav.js";
import { startFooter } from "./footer.js";
import { startHero } from "./hero.js";
import { watchVisibility } from "./motion.js";
import { startScene } from "./scene.js";
import { startToys } from "./toys.js";
import { FAR, MIDDLE, NEAR } from "./water.js";

startHero();
startFooter();
startToys();
// The price line floats on the same three swells as the hero, over the band's deep water.
startScene(document.querySelector("[data-price-water]"), {
  layers: [
    { level: 0.26, swell: 2.5, ...FAR },
    { level: 0.6, swell: 2.5, ...MIDDLE },
    { level: 0.92, swell: 2.5, ...NEAR },
  ],
  frontFrom: 3,
  phase: 2,
});

// CSS animations in these sections also rest while they are off screen.
for (const section of document.querySelectorAll("[data-pause-offscreen]")) {
  watchVisibility(section, (visible) => section.classList.toggle("is-paused", !visible));
}
