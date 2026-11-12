import { expect, test } from "vitest";
import { countryName, flag, localTime } from "./place.ts";

test("flag turns a country code into its emoji, and anything else into nothing", () => {
  expect(flag("PT")).toBe("🇵🇹");
  expect(flag("US")).toBe("🇺🇸");
  expect(flag("pt")).toBe("");
  expect(flag("USA")).toBe("");
});

test("countryName names a country, and keeps a code it cannot name", () => {
  expect(countryName("FR")).toMatch(/France|Frankreich|Francia/);
  expect(countryName("not a code")).toBe("not a code");
});

test("localTime gives the time there and the offset from UTC", () => {
  const winter = new Date("2026-01-15T18:52:00Z");
  expect(localTime("Europe/Paris", winter)).toMatch(/7:52.*UTC\+1$|19:52, UTC\+1$/);
  expect(localTime("UTC", winter)).toMatch(/UTC$/);
  expect(localTime("Mars/Olympus", winter)).toBeNull();
});
