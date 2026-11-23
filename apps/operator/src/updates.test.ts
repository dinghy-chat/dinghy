import { expect, test } from "vitest";
import { markUpdatesSeen, UPDATES, unseenCount } from "./updates.ts";

test("each update has its own ID, and the list goes newest first", () => {
  expect(new Set(UPDATES.map((update) => update.id)).size).toBe(UPDATES.length);
  const dates = UPDATES.map((update) => update.date);
  expect(dates).toEqual([...dates].sort().reverse());
  for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("the count of unseen updates follows the newest one seen", () => {
  const [newest, second] = UPDATES;
  expect(unseenCount(null)).toBe(UPDATES.length);
  expect(unseenCount(second?.id ?? null)).toBe(1);
  expect(unseenCount(newest?.id ?? null)).toBe(0);
  // A seen entry that left the list counts as all seen, not as none.
  expect(unseenCount("gone")).toBe(0);
});

test("opening the updates marks them all seen", () => {
  expect(unseenCount()).toBe(UPDATES.length);
  markUpdatesSeen();
  expect(unseenCount()).toBe(0);
});
