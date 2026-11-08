// A short line about the visitor's browser and system, such as "Chrome on macOS", for operators.
// Only this line is stored, never the User-Agent itself. Order matters: Edge, Opera and Samsung
// Internet also say Chrome, and Chrome also says Safari.

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|OPiOS\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\/|Chromium\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/CrOS/, "ChromeOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

const UNKNOWN = "Unknown";

const find = (list: [RegExp, string][], agent: string) =>
  list.find(([pattern]) => pattern.test(agent))?.[1];

/** "Chrome on macOS", "Safari on iPhone", or "Unknown" when neither part is known. */
export function deviceLine(agent: string | undefined): string {
  if (agent === undefined) return UNKNOWN;
  const browser = find(BROWSERS, agent);
  const system = find(SYSTEMS, agent);
  if (browser === undefined && system === undefined) return UNKNOWN;
  if (browser === undefined) return system ?? UNKNOWN;
  if (system === undefined) return browser;
  return `${browser} on ${system}`;
}
