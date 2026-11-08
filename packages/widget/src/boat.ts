// The boat and the logo, as SVG strings, so the Preact widget and the React operator app share one
// drawing. The strings are fixed in this file, and hold no outside data. The boat is the one on
// the landing page (site/public/js/boat.js).

// Colors are classes, and not fill attributes. WebKit gave the sail's fill="var(...)" the hull's value.
// The sails fill and the pennant flutters, as on the landing page, unless the visitor asks for less motion.
export const BOAT_CSS =
  ".b-h{fill:var(--d-hull,#0b2239)}.b-s{fill:var(--d-accent,#e5352b)}.b-j{fill:#fff8df}.b-c{fill:#fff8df}.b-f{fill:#ffc917}.b-p{fill:#1f6bff}.b-k{fill:#ffd9b3}" +
  ".b-s,.b-j,.b-g{transform-box:fill-box;animation:b-sail 3.4s ease-in-out infinite alternate}.b-s{transform-origin:0 100%}.b-j{transform-origin:100% 100%;animation-duration:3s}.b-g{transform-origin:0 50%;animation:b-flag .42s ease-in-out infinite alternate}" +
  "@keyframes b-sail{to{transform:scaleX(1.05) skewY(-1deg)}}@keyframes b-flag{to{transform:skewY(13deg) scaleX(.9)}}@media (prefers-reduced-motion:reduce){.b-s,.b-j,.b-g{animation:none}}";

/** `flag` flies a yellow pennant, for a new reply. */
export type BoatKind = "sail" | "flag";

const HEIGHT_PER_WIDTH = 120 / 140;

const BOAT =
  '<path class="b-j" d="M65 22C52 37 36 56 24 74H65z"/>' +
  '<path d="M65 38C56 49 47 60 39 72M65 56C60 62 56 68 52 73" fill="none" stroke="#0b2239" stroke-opacity=".14" stroke-width="1.5"/>' +
  '<path class="b-s" d="M73 12C98 28 116 52 121 74H73z"/>' +
  '<path d="M73 32C88 42 100 56 106 73M73 52C82 58 88 66 92 73" fill="none" stroke="#fff" stroke-opacity=".32" stroke-width="1.5"/>' +
  '<rect class="b-h" x="67" y="4" width="5" height="84" rx="2"/>' +
  '<rect class="b-h" x="70" y="74" width="54" height="3.5" rx="1.7"/>' +
  '<circle class="b-k" cx="46" cy="76" r="5.5"/><path class="b-h" d="M40 75a6 6 0 0 1 12 0z"/>' +
  '<rect class="b-p" x="42" y="80" width="8" height="7" rx="2"/>' +
  '<path class="b-h" d="M8 85C40 90 100 90 132 80 127 101 110 114 88 114H50C30 114 15 103 8 85z"/>' +
  '<path class="b-c" d="M8 85C40 90 100 90 132 80L130.5 85C100 95 40 95 9.5 90z"/>' +
  '<circle class="b-c" cx="58" cy="100" r="3.5"/><circle class="b-c" cx="74" cy="100" r="3.5"/><circle class="b-c" cx="90" cy="99" r="3.5"/>';

const PENNANT: Record<BoatKind, string> = {
  sail: '<path class="b-p b-g" d="M72 5 90 10 72 15z"/>',
  flag: '<path class="b-f b-g" d="M72 5 96 11 72 18z"/>',
};

/** The boat, `width` pixels wide. */
export function boatSvg(kind: BoatKind, width: number): string {
  const height = Math.round(width * HEIGHT_PER_WIDTH);
  return `<svg width="${width}" height="${height}" viewBox="0 0 140 120" aria-hidden="true">${BOAT}${PENNANT[kind]}</svg>`;
}

/** The logo mark, as in site/public/favicon.svg. */
export function logoSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 52 52" aria-hidden="true"><rect class="b-h" x="25" y="2" width="1.9" height="38"/><path class="b-s" d="M28 6C37 14 43 25 45 36H28z"/><path class="b-j" d="M24 12C18 20 12 28 8 36H24z" stroke="#0b2239" stroke-width="1.6" stroke-linejoin="round"/><path class="b-h" d="M3 39H49C47.5 45 42 49 36 49H16C10 49 4.5 45 3 39z"/></svg>`;
}
