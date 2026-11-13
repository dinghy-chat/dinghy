import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { asOperator, type Server } from "./requests.ts";

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

/**
 * Turns on two-step sign-in for a signed-in session, with the code of the step before now, so the
 * steps 0 and +1 are left for the test. Returns the key and the recovery codes.
 */
export async function turnOnTwoFactor(app: Server, cookie: string) {
  const setup = await asOperator(app, cookie, "POST", "/v1/operator/two-factor/setup");
  const { secret } = (await setup.json()) as { secret: string };
  const enabled = await asOperator(app, cookie, "POST", "/v1/operator/two-factor/enable", {
    code: await authenticatorCode(secret, -1),
  });
  if (enabled.status !== 200) throw new Error(`Turning it on failed with ${enabled.status}`);
  const { recoveryCodes } = (await enabled.json()) as { recoveryCodes: string[] };
  return { secret, recoveryCodes };
}
