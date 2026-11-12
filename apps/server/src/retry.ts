import { MINUTE_MS } from "./time.ts";

const MAX_RETRY_DELAY_MS = 60 * MINUTE_MS;

/**
 * The wait before the next try of a job, such as a file deletion or an alert: retryMs, doubling
 * with each attempt, up to an hour. The exponent stops at 20 so a row that failed many times cannot
 * overflow to Infinity.
 */
export function retryDelayMs(retryMs: number, attempts: number): number {
  return Math.min(retryMs * 2 ** Math.min(attempts - 1, 20), MAX_RETRY_DELAY_MS);
}
