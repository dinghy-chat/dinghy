import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createEmailVerificationToken, isAPIError } from "better-auth/api";
import type { Logger } from "pino";
import { account, operator, session, verification } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { safeErrorFields } from "./errors.ts";

interface AuthOptions {
  db: Database;
  secret: string;
  /** The server's public URL. Only requests from this origin can sign in. */
  baseURL: string;
  logger: Logger;
  /** With no mail server, there is no email reset. `chat reset-password` works instead. */
  sendResetPassword?: ((email: string, url: string) => Promise<void>) | undefined;
  onPasswordReset?: ((email: string) => Promise<void>) | undefined;
  /**
   * With a mail server, an account made by signup or an invite must open the link this sends before
   * it can sign in. Without one, nothing is verified, and the person who hands out invites vouches.
   */
  sendVerificationEmail?: ((email: string, url: string) => Promise<void>) | undefined;
}

/** How long a verification link works. */
const VERIFICATION_SECONDS = 24 * 60 * 60;

export function createAuth({
  db,
  secret,
  baseURL,
  logger,
  sendResetPassword,
  onPasswordReset,
  sendVerificationEmail,
}: AuthOptions) {
  return betterAuth({
    secret,
    baseURL,
    basePath: "/v1/auth",
    trustedOrigins: [new URL(baseURL).origin],
    database: drizzleAdapter(db, {
      provider: "pg",
      // A password change and its session revocation succeed or fail together.
      transaction: true,
      schema: { user: operator, session, account, verification },
    }),
    advanced: {
      database: { generateId: "uuid" },
      // A reset request answers at once. Waiting for the mail server would reveal a known email.
      backgroundTasks: {
        handler: (task) => {
          void task;
        },
      },
    },
    // Its own logs would hold a failed query's parameters, such as tokens and password hashes.
    // With this, an unexpected error reaches the app's error handler, which logs safe fields.
    logger: { disabled: true },
    onAPIError: { throw: true },
    // The limits in login-limit.ts count per account in Valkey, across instances.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      // Operators join by invite or through setup, never by signing themselves up.
      disableSignUp: true,
      minPasswordLength: 10,
      revokeSessionsOnPasswordReset: true,
      requireEmailVerification: sendVerificationEmail !== undefined,
      ...(onPasswordReset === undefined
        ? {}
        : {
            onPasswordReset: ({ user }: { user: { email: string } }) => onPasswordReset(user.email),
          }),
      ...(sendResetPassword === undefined
        ? {}
        : {
            // BetterAuth swallows a failure here, and the owner needs to see a broken mail server.
            sendResetPassword: ({ user, url }: { user: { email: string }; url: string }) =>
              sendResetPassword(user.email, url).catch((err: unknown) => {
                logger.error(safeErrorFields(err), "could not send a password reset email");
              }),
          }),
    },
    ...(sendVerificationEmail === undefined
      ? {}
      : {
          emailVerification: {
            expiresIn: VERIFICATION_SECONDS,
            // A sign-in before the link was opened sends a new one, which also covers a lost email.
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            // Not awaited, so the answer takes as long whether or not an email went out.
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              sendVerificationEmail(user.email, url).catch((err: unknown) => {
                logger.error(safeErrorFields(err), "could not send a verification email");
              });
            },
          },
        }),
  });
}

/**
 * Sends an account the link that verifies its email, as BetterAuth's own route would, without that
 * route's fixed wait. It does nothing on a server that does not verify emails.
 */
export async function sendVerification(auth: Auth, user: { id: string; email: string }) {
  const send = auth.options.emailVerification?.sendVerificationEmail;
  if (send === undefined) return;
  const context = await auth.$context;
  const token = await createEmailVerificationToken(
    context.secret,
    user.email,
    undefined,
    VERIFICATION_SECONDS,
    { userId: user.id },
  );
  await send({ user, url: `${context.baseURL}/verify-email?token=${token}&callbackURL=%2F` });
}

/** Whether a sign-in failed only because the account has not verified its email. */
export const notVerified = (error: unknown): boolean =>
  isAPIError(error) && error.body?.code === "EMAIL_NOT_VERIFIED";

/** BetterAuth's refusal of a sign-in: a wrong password, or an email with no password set. */
export const isSignInRefused = (error: unknown): boolean =>
  isAPIError(error) && error.statusCode === 401;

/** Whether new accounts must verify their email, which needs a mail server. */
export const verifiesEmail = (auth: Auth): boolean =>
  auth.options.emailAndPassword?.requireEmailVerification === true;

export type Auth = ReturnType<typeof createAuth>;
