import { readFileSync } from "node:fs";
import { type CountryResponse, Reader } from "mmdb-lib";
import type { Logger } from "pino";

/** The country of an address, as ISO 3166-1 alpha-2, or null when unknown. */
export type CountryOf = (ip: string) => string | null;

export const NO_COUNTRIES: CountryOf = () => null;

/**
 * Reads DB-IP's IP to Country Lite database, which the image downloads when it is built. Without
 * the file, as in development and tests, every country is unknown and everything else works. The
 * address is only looked up here, never stored.
 */
export function loadCountries(path: string | undefined, logger: Logger): CountryOf {
  if (path === undefined) return NO_COUNTRIES;
  let reader: Reader<CountryResponse>;
  try {
    reader = new Reader<CountryResponse>(readFileSync(path));
  } catch (err) {
    logger.warn({ err, path }, "the country database could not be read, so countries are unknown");
    return NO_COUNTRIES;
  }
  return (ip) => {
    try {
      const code = reader.get(ip)?.country?.iso_code;
      return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : null;
    } catch {
      // Not an address the database can read, such as an empty one.
      return null;
    }
  };
}
