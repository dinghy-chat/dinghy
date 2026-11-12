// Durations in milliseconds, the unit Date and timers use.

export const MINUTE_MS = 60_000;
/** A minute in seconds, the unit rate limits take. */
export const MINUTE_SECONDS = MINUTE_MS / 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const HOUR_SECONDS = HOUR_MS / 1000;
export const DAY_MS = 24 * HOUR_MS;
// How long a finished alert delivery, and so the record of what an email carried, is kept.
export const RETENTION_MS = 30 * DAY_MS;
