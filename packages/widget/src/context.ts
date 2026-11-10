import type { PageContext } from "./shared.ts";

// The same limits as the server's, so a page's mistake drops one value and not the whole report.
const MAX_KEYS = 20;
const MAX_KEY = 40;
const MAX_TEXT = 200;

/**
 * The valid part of what the page passed to setContext(): up to 20 keys of 1 to 40 characters, each
 * a string, a finite number, a boolean or null. A longer string is cut to 200 characters. Null
 * when the value is not an object.
 */
export function cleanContext(data: unknown): PageContext | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const clean: PageContext = {};
  let kept = 0;
  for (const [key, value] of Object.entries(data)) {
    if (kept === MAX_KEYS) break;
    if (key.length === 0 || key.length > MAX_KEY) continue;
    if (typeof value === "string") clean[key] = value.slice(0, MAX_TEXT);
    else if (value === null || typeof value === "boolean") clean[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    else continue;
    kept += 1;
  }
  return clean;
}
