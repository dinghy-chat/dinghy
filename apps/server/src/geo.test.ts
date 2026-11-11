import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { expect, test } from "vitest";
import { loadCountries } from "./geo.ts";

const logger = pino({ level: "silent" });

test("with no database, or one it cannot read, every country is unknown", async () => {
  expect(loadCountries(undefined, logger)("1.1.1.1")).toBeNull();
  expect(loadCountries(join(tmpdir(), "no-such.mmdb"), logger)("1.1.1.1")).toBeNull();
  const junk = join(tmpdir(), `junk-${process.pid}.mmdb`);
  await writeFile(junk, "not a database");
  expect(loadCountries(junk, logger)("1.1.1.1")).toBeNull();
});

// The image's database, when a developer points to a copy: GEOIP_COUNTRY_FILE=... bun run test.
test.skipIf(process.env.GEOIP_COUNTRY_FILE === undefined)(
  "the DB-IP database gives a country code, and nothing for a private or bad address",
  () => {
    const countryOf = loadCountries(process.env.GEOIP_COUNTRY_FILE, logger);
    expect(countryOf("81.2.69.160")).toBe("GB");
    expect(countryOf("2a00:1450:4007:80e::200e")).toMatch(/^[A-Z]{2}$/);
    expect(countryOf("127.0.0.1")).toBeNull();
    expect(countryOf("not an address")).toBeNull();
  },
);
