import { type BusinessHours, WEEKDAYS, type Weekday } from "./shared.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
// Two weeks: a clock change can skip a range that comes once a week, and then it opens a week later.
const SEARCH_DAYS = 14;

/** Open now, or closed until a time, which is null for a week with no hours. */
type HoursState = { open: true } | { open: false; reopensAt: Date | null };

/** "09:30" as milliseconds after midnight. */
const sinceMidnight = (time: string) => (+time.slice(0, 2) * 60 + +time.slice(3)) * MINUTE_MS;

const formats = new Map<string, Intl.DateTimeFormat>();

/**
 * The time zone's clock at a moment, to the minute, as that day and time would read in UTC, which
 * makes its arithmetic plain. Also its weekday.
 */
function wallClock(at: number, timeZone: string): { wall: number; day: Weekday } {
  let format = formats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formats.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const { type, value } of format.formatToParts(at)) parts[type] = value;
  const part = (type: string) => Number(parts[type]);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return { wall, day: (parts.weekday ?? "").toLowerCase() as Weekday };
}

/** How far the zone's clock is ahead of UTC at a moment. */
const offsetAt = (at: number, timeZone: string) =>
  wallClock(at, timeZone).wall - (at - (at % MINUTE_MS));

/** Whether the clock at a moment reads a time inside one of that weekday's ranges. */
function isOpenAt({ timeZone, week }: BusinessHours, at: number): boolean {
  const { wall, day } = wallClock(at, timeZone);
  const time = wall % DAY_MS;
  return week[day].some(
    ([start, end]) => sinceMidnight(start) <= time && time < sinceMidnight(end),
  );
}

/**
 * The moments of the next two weeks when the clock changes for daylight saving, to the minute.
 * There, the clock can jump into a range without ever reading its start.
 */
function clockChanges(timeZone: string, now: number): number[] {
  const changes: number[] = [];
  for (let day = 0; day <= SEARCH_DAYS; day += 1) {
    let before = now - (now % MINUTE_MS) + day * DAY_MS;
    let after = before + DAY_MS;
    const offset = offsetAt(before, timeZone);
    if (offset === offsetAt(after, timeZone)) continue;
    while (after - before > MINUTE_MS) {
      const middle = before + Math.floor((after - before) / 2 / MINUTE_MS) * MINUTE_MS;
      if (offsetAt(middle, timeZone) === offset) before = middle;
      else after = middle;
    }
    changes.push(after);
  }
  return changes;
}

/**
 * The moments when the clock reads `wall`: none in a skipped hour, two in a repeated one. Each
 * offset the zone has around that day gives one guess, and a guess counts if the clock agrees.
 */
function readings(wall: number, timeZone: string): number[] {
  const rough = wall - offsetAt(wall, timeZone);
  return [rough - DAY_MS, rough + DAY_MS]
    .map((near) => wall - offsetAt(near, timeZone))
    .filter((at) => wallClock(at, timeZone).wall === wall);
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
 * Whether the team is open at `now`, and when it opens next if not. It opens either when the clock
 * reads a range's start, or when a daylight saving change makes the clock jump into a range, so the
 * next opening is the first of those moments at which the team is open.
 */
export function hoursState(hours: BusinessHours, now: number): HoursState {
  if (isOpenAt(hours, now)) return { open: true };
  const { timeZone, week } = hours;
  const { wall, day } = wallClock(now, timeZone);
  const midnight = wall - (wall % DAY_MS);
  const today = WEEKDAYS.indexOf(day);
  const moments = clockChanges(timeZone, now);
  for (let ahead = 0; ahead <= SEARCH_DAYS; ahead += 1) {
    for (const [start] of week[WEEKDAYS[(today + ahead) % WEEKDAYS.length] as Weekday]) {
      moments.push(...readings(midnight + ahead * DAY_MS + sinceMidnight(start), timeZone));
    }
  }
  const opens = moments.filter((at) => at > now && isOpenAt(hours, at));
  return { open: false, reopensAt: opens.length === 0 ? null : new Date(Math.min(...opens)) };
}
