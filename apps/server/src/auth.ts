import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { account, operator, session, verification } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { LINK_MINUTES } from "./letter.ts";

interface AuthOptions {
  db: Database;
  secret: string;
  /** The server's public URL. Only requests from this origin can sign in. */
  baseURL: string;
}

export { LINK_MINUTES };

/** Where a new link goes: an email, or a command's output. Every caller that makes one sets it. */
type Delivery = (link: { email: string; url: string }) => void | Promise<void>;
const delivery = new AsyncLocalStorage<Delivery>();

export function createAuth({ db, secret, baseURL }: AuthOptions) {
  return betterAuth({
    secret,
    baseURL,
    basePath: "/v1/auth",
    trustedOrigins: [new URL(baseURL).origin],
    database: drizzleAdapter(db, {
      provider: "pg",
      transaction: true,
      schema: { user: operator, session, account, verification },
    }),
    advanced: { database: { generateId: "uuid" } },
    // Its own logs would hold a failed query's parameters, such as tokens.
    // With this, an unexpected error reaches the app's error handler, which logs safe fields.
    logger: { disabled: true },
    onAPIError: { throw: true },
    // The limits in login-limit.ts count per account in Valkey, across instances.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    // Operators sign in with a link only. Nothing stores or checks a password.
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({
        expiresIn: LINK_MINUTES * 60,
        // A copy of the database must not hold links that still work.
        storeToken: "hashed",
        // Opening a link for an email with no account creates one, so only the server's own code
        // may deliver such a link: cloud signup, to the email that asked. The sign-in route sends
        // nothing to an unknown email.
        disableSignUp: false,
        sendMagicLink: async (link) => {
          const deliver = delivery.getStore();
          if (deliver === undefined) throw new Error("A sign-in link was made with nowhere to go");
          await deliver(link);
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Runs `work`, which makes links through BetterAuth's own route, with `deliver` receiving them. */
export const deliverLinks = <T>(deliver: Delivery, work: () => T): T => delivery.run(deliver, work);

/**
 * A one-time sign-in link for `email`, made without sending anything, for an email, a command's
 * output or a test. After it signs in, the browser goes to `callbackPath`.
 */
export async function signInLink(auth: Auth, email: string, callbackPath = "/"): Promise<string> {
  let made: string | undefined;
  await deliverLinks(
    ({ url }) => {
      made = url;
    },
    () =>
      auth.api.signInMagicLink({
        body: { email: email.toLowerCase(), callbackURL: callbackPath },
        headers: new Headers(),
      }),
  );
  if (made === undefined) throw new Error("BetterAuth made no sign-in link");
  return made;
}
