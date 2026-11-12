import type { TextId } from "./text.ts";

/** A snooze with a time ends at this hour, in the operator's own time zone. */
const SNOOZE_HOUR = 9;
const MONDAY = 1;
const DAYS_IN_WEEK = 7;

/** 9:00 on the day `days` after `now`, in this browser's time zone. */
function morningAfter(now: Date, days: number): string {
  const at = new Date(now);
  at.setDate(at.getDate() + days);
  at.setHours(SNOOZE_HOUR, 0, 0, 0);
  return at.toISOString();
}

/** The coming Monday, or a week on from a Monday. */
const daysToMonday = (now: Date) =>
  (MONDAY - now.getDay() + DAYS_IN_WEEK) % DAYS_IN_WEEK || DAYS_IN_WEEK;

/** The snooze menu's choices, each with when it ends from a moment, or null until a reply. */
export const SNOOZE_CHOICES: readonly { text: TextId; until(now: Date): string | null }[] = [
  { text: "snoozeUntilReply", until: () => null },
  { text: "snoozeUntilTomorrow", until: (now) => morningAfter(now, 1) },
  { text: "snoozeUntilNextWeek", until: (now) => morningAfter(now, daysToMonday(now)) },
];
