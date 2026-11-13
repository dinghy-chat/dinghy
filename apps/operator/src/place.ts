// Where a visitor is, in the browser's own words: a country's flag and name, their local time, and
// the language their chat speaks.

import { clockTime } from "./format.ts";

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

/** "French" for fr, in the operator's language. */
export const languageName = (locale: string): string =>
  new Intl.DisplayNames([], { type: "language" }).of(locale) ?? locale;

/**
 * The time where the visitor is, and its offset from UTC: "7:52 PM" and "UTC+1". Null for a time
 * zone the browser does not know.
 */
export function zoneClock(
  timeZone: string,
  now = new Date(),
): { time: string; utc: string } | null {
  try {
    const time = clockTime(now, timeZone);
    const offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value;
    return { time, utc: (offset ?? "GMT").replace("GMT", "UTC").replace(/^UTC[+-]0$/, "UTC") };
  } catch {
    return null;
  }
}

/** The time where the visitor is, with its offset from UTC: "7:52 PM, UTC+1", or null. */
export function localTime(timeZone: string, now = new Date()): string | null {
  const clock = zoneClock(timeZone, now);
  return clock === null ? null : `${clock.time}, ${clock.utc}`;
}

/** The place an IANA zone is named after: "Sao Paulo" for America/Sao_Paulo. */
export const zoneCity = (timeZone: string) =>
  (timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ");
