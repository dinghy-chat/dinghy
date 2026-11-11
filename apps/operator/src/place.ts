// Where a visitor is, in the browser's own words: a country's flag and name, and their local time.

/** The flag emoji of an ISO 3166-1 alpha-2 code, made of two regional indicator letters. */
export function flag(country: string): string {
  if (!/^[A-Z]{2}$/.test(country)) return "";
  const REGIONAL_A = 0x1f1e6;
  return String.fromCodePoint(
    ...[...country].map((letter) => REGIONAL_A + letter.charCodeAt(0) - "A".charCodeAt(0)),
  );
}

/** "Portugal" for PT, in the operator's language, or the code when the browser does not know it. */
export function countryName(country: string): string {
  try {
    return new Intl.DisplayNames([], { type: "region" }).of(country) ?? country;
  } catch {
    return country;
  }
}

/**
 * The time where the visitor is, with its offset from UTC: "7:52 PM, UTC+1". Null for a time zone
 * the browser does not know.
 */
export function localTime(timeZone: string, now = new Date()): string | null {
  try {
    const time = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", timeZone });
    const offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value;
    const utc = (offset ?? "GMT").replace("GMT", "UTC").replace(/^UTC[+-]0$/, "UTC");
    return `${time.format(now)}, ${utc}`;
  } catch {
    return null;
  }
}
