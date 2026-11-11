// The chat button, which the loader draws on every page of the host site and the operator app's
// preview draws too. Plain strings, because the loader must stay small. The drawings need no
// aria-hidden: a button's label is its name, and its content is presentation.

/** The bubble is a circle. The boat takes the saved corner radius, as the panel does. */
export const LAUNCHER_CSS =
  ".launcher{all:initial;position:relative;display:grid;place-items:center;width:60px;height:60px;border-radius:50%;background:var(--d-accent,#e5352b);color:var(--d-accent-text,#fff);cursor:pointer;box-shadow:0 8px 24px #0d224042}.launcher:focus-visible{outline:3px solid var(--d-primary,#0b2239);outline-offset:2px}.boat{background:#fff;border-radius:var(--dinghy-launcher-radius,var(--d-radius,16px))}.s{fill:var(--d-accent,#e5352b)}.h{fill:var(--d-primary,#0b2239)}@media (prefers-reduced-motion:no-preference){.boat svg{animation:b 3.2s ease-in-out infinite}}@keyframes b{50%{translate:0 -2px}}";

/** Each launcher's drawing. The boat is drawn here and not imported from boat.ts, for the size. */
export const LAUNCHER_ICONS = {
  boat: '<svg width="38" height="38" viewBox="0 0 52 52"><path class="h" d="M25 2h1.9v38H25zM3 39H49C47.5 45 42 49 36 49H16C10 49 4.5 45 3 39z"/><path class="s" d="M28 6C37 14 43 25 45 36H28z"/><path fill="#ffc917" d="M24 12C18 20 12 28 8 36H24z"/></svg>',
  bubble:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 4h18v13H8l-5 4z"/></svg>',
};

/** The text color that reads on a full hex color: dark on a light one, white on a dark one. */
export function textOn(color: string): string {
  const rgb = Number(`0x${color.slice(1)}`);
  return 299 * (rgb >> 16) + 587 * ((rgb >> 8) & 255) + 114 * (rgb & 255) > 150_000
    ? "#0b2239"
    : "#fff";
}

/** A launcher the page or the saved settings can draw. `hidden` draws none. */
export type LauncherKind = keyof typeof LAUNCHER_ICONS;
