import "./nav.js";
import { startCopyButtons } from "./copy.js";
import { watchVisibility } from "./motion.js";
import { startScene } from "./scene.js";
import { CREAM, FAR, MIDDLE, NEAR } from "./water.js";

const LAYERS = [
  { level: 0.3, swell: 3, ...FAR },
  { level: 0.54, swell: 4, ...MIDDLE },
  { level: 0.8, swell: 4.5, ...NEAR },
];

/** The self-hosting hero has the sun and two boats. Other pages have a strip with one boat. */
const SCENES = {
  shore: {
    layers: LAYERS,
    frontFrom: 2,
    shore: true,
    boats: [
      { size: [38, 52], layer: 0, at: 0.62, speed: -9, colors: { main: CREAM, jib: CREAM } },
      { size: [78, 104], layer: 1, at: 0.18, speed: 22 },
    ],
  },
  band: {
    layers: LAYERS,
    frontFrom: 2,
    shore: true,
    boats: [{ size: [44, 58], layer: 1, at: 0.78, speed: -10 }],
  },
};

/** Marks the section the reader is in, in the "On this page" list. */
function followSections() {
  const links = new Map(
    [...document.querySelectorAll(".docs-toc a")].map((link) => [link.hash.slice(1), link]),
  );
  const headings = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  if (!headings.length) return;
  const mark = () => {
    const line = innerHeight * 0.3;
    let current = headings[0];
    for (const heading of headings) if (heading.getBoundingClientRect().top < line) current = heading;
    for (const [id, link] of links) link.classList.toggle("is-current", id === current.id);
  };
  addEventListener("scroll", mark, { passive: true });
  mark();
}

/** A heading's link puts its address in the bar, so a reader can copy it. */
document.addEventListener("click", (event) => {
  const link = event.target.closest?.(".heading-link, .docs-toc a");
  if (link) history.replaceState(null, "", link.hash);
});

startCopyButtons();
const scene = document.querySelector("[data-scene]");
startScene(scene, SCENES[scene.dataset.scene]);
followSections();

for (const section of document.querySelectorAll("[data-pause-offscreen]")) {
  watchVisibility(section, (visible) => section.classList.toggle("is-paused", !visible));
}
