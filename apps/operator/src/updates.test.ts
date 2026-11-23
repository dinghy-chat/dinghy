import { expect, test } from "vitest";
import { markUpdatesSeen, UPDATES, unseenCount, updatesAfter } from "./updates.ts";

test("each update has its own ID, and the list goes newest first", () => {
  expect(new Set(UPDATES.map((update) => update.id)).size).toBe(UPDATES.length);
  const dates = UPDATES.map((update) => update.date);
  expect(dates).toEqual([...dates].sort().reverse());
  for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("the count of unseen updates follows the newest one seen", () => {
  const [newest, second] = UPDATES;
  expect(updatesAfter(null)).toBe(UPDATES.length);
  expect(updatesAfter(second?.id ?? null)).toBe(1);
  expect(updatesAfter(newest?.id ?? null)).toBe(0);
  // A seen entry that left the list counts as all seen, not as none.
  expect(updatesAfter("gone")).toBe(0);
});

test("opening the updates marks them seen for that operator only", () => {
  expect(unseenCount("alice")).toBe(UPDATES.length);
  markUpdatesSeen("alice");
  expect(unseenCount("alice")).toBe(0);
  expect(unseenCount("bob")).toBe(UPDATES.length);
});
