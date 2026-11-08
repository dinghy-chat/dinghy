import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { isAPIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { and, eq, ne } from "drizzle-orm";
import { account, operator, session, verification } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { sha256Hex } from "./identity.ts";
import { LINK_MINUTES } from "./letter.ts";

interface AuthOptions {
  db: Database;
  secret: string;
  /** The server's public URL. Only requests from this origin can sign in. */
  baseURL: string;
}

export { LINK_MINUTES };

/**
 * What a link is for. It picks the confirm page's button and where the browser goes after it.
 * `add-workspace` is a sign-in that lands on the workspace setup, for cloud signup with an account.
 */
export type LinkPurpose = "sign-in" | "signup" | "add-workspace" | "join";

/**
 * The link an email carries: a page of the operator app, whose button uses the token. Opening it
 * uses nothing, so a mail scanner that fetches every link cannot use one up.
 */
export const confirmUrl = (baseURL: string, purpose: LinkPurpose, token: string): string => {
  const url = new URL("/link", baseURL);
  url.searchParams.set("for", purpose);
  url.searchParams.set("token", token);
  return url.href;
};

/** Where a new token goes: an email, or a command's output. Every caller that makes one sets it. */
type Delivery = (link: { email: string; token: string }) => void | Promise<void>;
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
 * Marks a token that never went through email, such as one a command printed. Using it signs in,
 * but proves nothing about the mailbox, so it leaves `email_proven` as it is.
 */
const SHOWN_LINK = "shown-link:";

/** Whether a link reaches its owner by email, or another way, such as a command's output. */
export type LinkRoute = "email" | "shown";

/** A one-time sign-in token for `email`, made without sending anything. */
async function signInToken(auth: Auth, email: string, route: LinkRoute): Promise<string> {
  let made: string | undefined;
  await deliverLinks(
    ({ token }) => {
      made = token;
    },
    () =>
      auth.api.signInMagicLink({ body: { email: email.toLowerCase() }, headers: new Headers() }),
  );
  if (made === undefined) throw new Error("BetterAuth made no sign-in link");
  if (route === "shown") {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.createVerificationValue({
      identifier: `${SHOWN_LINK}${sha256Hex(made)}`,
      value: email.toLowerCase(),
      expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000),
    });
  }
  return made;
}

/** A one-time sign-in link for `email`, for an email, a command's output or a test. */
export const signInLink = async (
  auth: Auth,
  email: string,
  purpose: Exclude<LinkPurpose, "join"> = "sign-in",
  route: LinkRoute = "shown",
): Promise<string> =>
  confirmUrl(String(auth.options.baseURL), purpose, await signInToken(auth, email, route));

/**
 * Uses a sign-in token, once: it creates the account if needed and a session. Returns the cookies
 * that hold the session, or null when the token expired or was used.
 */
export async function redeemSignInToken(
  auth: Auth,
  db: Database,
  token: string,
  headers: Headers,
): Promise<string[] | null> {
  const { internalAdapter } = await auth.$context;
  // Read before the token is used, so the answer does not depend on another request's timing.
  const shown = await internalAdapter.findVerificationValue(`${SHOWN_LINK}${sha256Hex(token)}`);
  let answer: Awaited<ReturnType<typeof verifyMagicLink>>;
  try {
    answer = await verifyMagicLink(auth, token, headers);
  } catch (error) {
    // BetterAuth answers a bad token with a redirect to its error page, which the app has not.
    if (isAPIError(error) && error.statusCode === 302) return null;
    throw error;
  }
  // A link that went by email proves the mailbox. The first time, the other sessions end: someone
  // who joined under this address without email loses the access it gave them. One statement checks
  // and sets the flag, so two sign-ins at once cannot both act, and nothing sets it back.
  if (shown === null) {
    const { user, session: created } = answer.response;
    const proved = await db
      .update(operator)
      .set({ emailProven: true })
      .where(and(eq(operator.id, user.id), eq(operator.emailProven, false)))
      .returning({ id: operator.id });
    if (proved.length > 0) {
      await db
        .delete(session)
        .where(and(eq(session.userId, user.id), ne(session.token, created.token)));
    }
  }
  return answer.headers.getSetCookie();
}

const verifyMagicLink = (auth: Auth, token: string, headers: Headers) =>
  auth.api.magicLinkVerify({ query: { token }, headers, returnHeaders: true });

/**
 * Signs `email` in at once, for a link that the server already checked, such as a join link.
 * `route` is how that link reached its owner, which says whether it proved the email.
 */
export const signInNow = async (
  auth: Auth,
  db: Database,
  email: string,
  headers: Headers,
  route: LinkRoute,
) => redeemSignInToken(auth, db, await signInToken(auth, email, route), headers);
