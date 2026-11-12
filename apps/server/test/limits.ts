import type { Redis } from "iovalkey";

/**
 * Clears the rate limits, which live in the shared Valkey for up to an hour. A test run that
 * starts soon after another one would otherwise find them used up and get 429s.
 */
export async function clearLimits(valkey: Redis): Promise<void> {
  for (const pattern of ["dinghy:limit:*", "dinghy:sign-in-link*"]) {
    const keys = await valkey.keys(pattern);
    if (keys.length > 0) await valkey.del(...keys);
  }
}
