import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";

const PERIOD_SECONDS = 30;

/**
 * The code an authenticator app shows for this base32 key, `offset` steps of 30 seconds from now.
 * The server takes the steps -1, 0 and +1, each once, so a test that needs a few codes in a row
 * uses them in that order.
 */
export function authenticatorCode(key: string, offset = 0): Promise<string> {
  const step = Math.floor(Date.now() / 1000 / PERIOD_SECONDS) + offset;
  return createOTP(base32.decode(key), { digits: 6, period: PERIOD_SECONDS }).hotp(step);
}
