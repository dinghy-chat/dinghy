const HEX_COLOR = /^#?([0-9a-f]{6})$/i;

/** A pasted or typed color as the server stores it, such as `7B2723;` as `#7b2723`, or null. */
export function hexColor(text: string): string | null {
  const digits = HEX_COLOR.exec(text.replace(/[\s;]/g, ""))?.[1];
  return digits === undefined ? null : `#${digits.toLowerCase()}`;
}
