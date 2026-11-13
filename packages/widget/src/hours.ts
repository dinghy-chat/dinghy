import { type BusinessHours, WEEKDAYS, type Weekday } from "./shared.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;

/** Open now, or closed until a time, which is null for a week with no hours. */
type HoursState = { open: true } | { open: false; reopensAt: Date | null };

/** "09:30" as milliseconds after midnight. */
const sinceMidnight = (time: string) => (+time.slice(0, 2) * 60 + +time.slice(3)) * MINUTE_MS;

/**
 * The time zone's clock at a moment, as that day and time would read in UTC, which makes its
 * arithmetic plain. Also its weekday.
 */
function wallClock(at: number, timeZone: string): { wall: number; day: Weekday } {
  const parts: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(at)) {
    parts[type] = value;
  }
  const part = (type: string) => Number(parts[type]);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return { wall, day: (parts.weekday ?? "").toLowerCase() as Weekday };
}

/**
 * The first moment at or after `now` when the time zone's clock reads `wall`. Near a daylight
 * saving change the clock reads a time with the offset before the change or the one after, so this
 * starts from the earlier reading. It moves past a repeated time that is already over, and past a
 * skipped time to the first minute after the gap.
 */
function moment(wall: number, timeZone: string, now: number): Date {
  const read = (at: number) => wallClock(at, timeZone).wall;
  const offset = (at: number) => read(at) - (at - (at % MINUTE_MS));
  const rough = wall - offset(wall);
  let at = Math.min(wall - offset(rough - DAY_MS), wall - offset(rough + DAY_MS));
  while (at < now || read(at) < wall) at += MINUTE_MS;
  return new Date(at);
}

/**
 * The hours, when this browser knows their time zone. An older browser may not know a newer zone,
 * and then the widget follows presence alone.
 */
export function knownHours(hours: BusinessHours | null): BusinessHours | null {
  try {
    if (hours !== null) new Intl.DateTimeFormat("en-US", { timeZone: hours.timeZone });
    return hours;
  } catch {
    return null;
  }
}

/**
 * Whether the team is open at `now`, and when it opens next if not. The ranges of each day are in
 * order and apart, as the server saves them. The next opening is found on the clock's readings, so
 * a range that lies wholly inside the hour a daylight saving change skips or repeats can be
 * announced a week off. Open or closed is always right; a fix would weigh more than it is worth.
 */
export function hoursState({ timeZone, week }: BusinessHours, now: number): HoursState {
  const { wall, day } = wallClock(now, timeZone);
  const midnight = wall - (wall % DAY_MS);
  const today = WEEKDAYS.indexOf(day);
  for (let ahead = 0; ahead <= WEEKDAYS.length; ahead += 1) {
    const ranges = week[WEEKDAYS[(today + ahead) % WEEKDAYS.length] as Weekday];
    for (const [start, end] of ranges) {
      const opens = midnight + ahead * DAY_MS + sinceMidnight(start);
      if (opens > wall) return { open: false, reopensAt: moment(opens, timeZone, now) };
      if (midnight + sinceMidnight(end) > wall) return { open: true };
    }
  }
  return { open: false, reopensAt: null };
}
