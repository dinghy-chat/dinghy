import { expect, test } from "vitest";
import { SNOOZE_CHOICES } from "./snooze.ts";

const untilOf = (now: Date) => SNOOZE_CHOICES.map((choice) => choice.until(now));
const local = (year: number, month: number, day: number, hour: number) =>
  new Date(year, month - 1, day, hour).toISOString();

test("until they reply has no time, and the others end at 9:00 local time", () => {
  // Thursday 12 November 2026, 15:00.
  expect(untilOf(new Date(2026, 10, 12, 15))).toEqual([
    null,
    local(2026, 11, 13, 9),
    local(2026, 11, 16, 9),
  ]);
});

test("next week from a Monday is the Monday after, and from a Sunday the next day", () => {
  expect(untilOf(new Date(2026, 10, 16, 8))[2]).toBe(local(2026, 11, 23, 9));
  expect(untilOf(new Date(2026, 10, 15, 22))[2]).toBe(local(2026, 11, 16, 9));
});

test("tomorrow crosses the end of a month", () => {
  expect(untilOf(new Date(2026, 10, 30, 23))[1]).toBe(local(2026, 12, 1, 9));
});
