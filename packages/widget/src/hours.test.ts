import { describe, expect, test } from "vitest";
import { hoursState, knownHours } from "./hours.ts";
import type { BusinessHours } from "./shared.ts";

const NINE_TO_SIX: [string, string][] = [["09:00", "18:00"]];
const WEEKDAYS_IN = (timeZone: string): BusinessHours => ({
  timeZone,
  week: {
    mon: NINE_TO_SIX,
    tue: NINE_TO_SIX,
    wed: NINE_TO_SIX,
    thu: NINE_TO_SIX,
    fri: NINE_TO_SIX,
    sat: [],
    sun: [],
  },
});
const PARIS = WEEKDAYS_IN("Europe/Paris");

const at = (iso: string) => Date.parse(iso);
const reopens = (hours: BusinessHours, now: string) => {
  const state = hoursState(hours, at(now));
  return state.open ? "open" : state.reopensAt?.toISOString();
};

describe("business hours", () => {
  test("are open inside a range, on the workspace's clock", () => {
    // 11:00 in Paris on a Monday.
    expect(reopens(PARIS, "2026-11-16T10:00:00Z")).toBe("open");
    // 09:00 sharp opens, and 18:00 sharp closes.
    expect(reopens(PARIS, "2026-11-16T08:00:00Z")).toBe("open");
    expect(reopens(PARIS, "2026-11-16T17:00:00Z")).toBe("2026-11-17T08:00:00.000Z");
  });

  test("before the day's opening, reopen that morning", () => {
    expect(reopens(PARIS, "2026-11-16T06:00:00Z")).toBe("2026-11-16T08:00:00.000Z");
  });

  test("after Friday's closing, reopen on Monday", () => {
    expect(reopens(PARIS, "2026-11-20T20:00:00Z")).toBe("2026-11-23T08:00:00.000Z");
  });

  test("use the zone's weekday, not UTC's", () => {
    // Tuesday 02:00 in UTC is Monday 21:00 in New York.
    const evenings: BusinessHours = {
      timeZone: "America/New_York",
      week: { ...WEEKDAYS_IN("UTC").week, mon: [["20:00", "22:00"]], tue: [] },
    };
    expect(reopens(evenings, "2026-11-17T02:00:00Z")).toBe("open");
    expect(reopens(evenings, "2026-11-17T03:30:00Z")).toBe("2026-11-18T14:00:00.000Z");
  });

  test("reopen at the right moment across a change to summer time and back", () => {
    // Paris moves to summer time on Sunday 29 March 2026, and back on Sunday 25 October.
    expect(reopens(PARIS, "2026-03-27T20:00:00Z")).toBe("2026-03-30T07:00:00.000Z");
    expect(reopens(PARIS, "2026-10-23T20:00:00Z")).toBe("2026-10-26T08:00:00.000Z");
  });

  test("a time that summer time skips opens when the clocks go forward", () => {
    const early: BusinessHours = {
      timeZone: "Europe/Paris",
      week: { ...WEEKDAYS_IN("UTC").week, sun: [["02:30", "05:00"]] },
    };
    // 02:30 does not exist in Paris that night, so the team opens at 03:00 summer time.
    expect(reopens(early, "2026-03-28T20:00:00Z")).toBe("2026-03-29T01:00:00.000Z");
  });

  test("a skipped time never reopens before now", () => {
    const early: BusinessHours = {
      timeZone: "America/New_York",
      week: { ...WEEKDAYS_IN("UTC").week, sun: [["02:30", "05:00"]] },
    };
    // 01:45 in New York, 15 minutes before the clocks jump from 02:00 to 03:00.
    expect(reopens(early, "2026-03-08T06:45:00Z")).toBe("2026-03-08T07:00:00.000Z");
  });

  test("a time that the change back to winter time repeats opens at its next reading", () => {
    const early: BusinessHours = {
      timeZone: "America/New_York",
      week: { ...WEEKDAYS_IN("UTC").week, sun: [["01:45", "05:00"]] },
    };
    // 01:00 summer time: the first 01:45 is ahead.
    expect(reopens(early, "2026-11-01T05:00:00Z")).toBe("2026-11-01T05:45:00.000Z");
    // 01:15 winter time, after the first 01:45 has passed: the second one is ahead.
    expect(reopens(early, "2026-11-01T06:15:00Z")).toBe("2026-11-01T06:45:00.000Z");
  });

  test("follow a zone with a half-hour offset", () => {
    expect(reopens(WEEKDAYS_IN("Asia/Kolkata"), "2026-11-16T13:00:00Z")).toBe(
      "2026-11-17T03:30:00.000Z",
    );
  });

  test("a range that ends at 24:00 stays open until midnight", () => {
    const late: BusinessHours = {
      timeZone: "UTC",
      week: { ...WEEKDAYS_IN("UTC").week, mon: [["14:00", "24:00"]] },
    };
    expect(reopens(late, "2026-11-16T23:59:00Z")).toBe("open");
    expect(reopens(late, "2026-11-17T00:00:00Z")).toBe("2026-11-17T09:00:00.000Z");
  });

  test("a gap between two ranges is closed until the second one", () => {
    const split: BusinessHours = {
      timeZone: "UTC",
      week: {
        ...WEEKDAYS_IN("UTC").week,
        mon: [
          ["09:00", "12:00"],
          ["14:00", "18:00"],
        ],
      },
    };
    expect(reopens(split, "2026-11-16T13:00:00Z")).toBe("2026-11-16T14:00:00.000Z");
    expect(reopens(split, "2026-11-16T15:00:00Z")).toBe("open");
  });

  test("a week with no hours is closed with no time to reopen", () => {
    const none: BusinessHours = {
      timeZone: "UTC",
      week: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    };
    expect(hoursState(none, at("2026-11-16T10:00:00Z"))).toEqual({ open: false, reopensAt: null });
  });

  test("hours in a zone the browser does not know are off", () => {
    expect(knownHours({ ...PARIS, timeZone: "Mars/Olympus_Mons" })).toBeNull();
    expect(knownHours(PARIS)).toBe(PARIS);
    expect(knownHours(null)).toBeNull();
  });
});
