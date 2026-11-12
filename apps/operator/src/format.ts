// The times and dates the app shows.

export const MINUTE_MS = 60_000;

const CLOCK: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const SHORT_DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

/** "3:07 PM", in this browser's time zone or in the one given. */
export const clockTime = (at: string | Date, timeZone?: string) =>
  new Date(at).toLocaleTimeString([], timeZone === undefined ? CLOCK : { ...CLOCK, timeZone });

/** "Nov 11, 2026". */
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], SHORT_DATE);

/** "Mon 9:00 AM", for a moment in the coming days. */
export const dayTime = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: "short", ...CLOCK });

/** Whether a moment falls on today, in this browser's time zone. */
export const isToday = (at: Date) => at.toDateString() === new Date().toDateString();

/** The time today, and the date before today: "Nov 10". */
export function shortTime(iso: string): string {
  const at = new Date(iso);
  return isToday(at)
    ? clockTime(at)
    : at.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The time today, and the date with the time before today: "Nov 10, 2026, 3:07 PM". */
export function timeOrDate(iso: string): string {
  const at = new Date(iso);
  return isToday(at) ? clockTime(at) : at.toLocaleString([], { ...SHORT_DATE, ...CLOCK });
}

/** "45 sec", "4 min", "1.5 hr", in the browser's words. */
export function duration(seconds: number): string {
  const unit = (value: number, name: "second" | "minute" | "hour") =>
    new Intl.NumberFormat([], {
      style: "unit",
      unit: name,
      unitDisplay: "short",
      maximumFractionDigits: name === "hour" ? 1 : 0,
    }).format(value);
  if (seconds < 60) return unit(Math.round(seconds), "second");
  if (seconds < 3600) return unit(Math.round(seconds / 60), "minute");
  return unit(seconds / 3600, "hour");
}
