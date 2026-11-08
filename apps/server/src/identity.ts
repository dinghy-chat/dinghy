import { createHash, randomBytes } from "node:crypto";
import { errors, jwtVerify } from "jose";
import { z } from "zod";

const BROWSER_TOKEN_PREFIX = "dbt_";
// A token in a browser should be short-lived, and the widget can ask for a new one.
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_ATTRIBUTES_BYTES = 2048;
const MAX_NAME_LENGTH = 100;

const attributes = z
  .record(z.string(), z.unknown())
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_ATTRIBUTES_BYTES)
  .optional();

const hostTokenPayload = z.object({
  sub: z.string().min(1).max(255),
  exp: z.number(),
  iat: z.number(),
  // A bad email is dropped, not refused, because it must not decide whether a user can chat. It must
  // be one address: a mail server sends to every address in a list such as "a@x.com, b@y.com".
  email: z.email().max(320).optional().catch(undefined),
  // Dropped the same way: one line of text, so a name cannot add lines of its own.
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u)
    .optional()
    .catch(undefined),
  attributes,
  // The name in 0.5.0. `attributes` wins when a token has both.
  claims: attributes,
});

export interface HostIdentity {
  externalId: string;
  email: string | undefined;
  name: string | undefined;
  attributes: Record<string, unknown> | undefined;
  expiresAt: Date;
  issuedAt: number;
}

/** Returns the identity in a host token, or null for any token that is not valid. */
export async function verifyHostToken(
  token: string,
  signingSecret: string,
  audience: string,
  now: Date = new Date(),
): Promise<HostIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(signingSecret), {
      // Pinned, so a token cannot choose `none` or another algorithm.
      algorithms: ["HS256"],
      audience,
      requiredClaims: ["sub", "exp", "iat"],
      currentDate: now,
    });
    const parsed = hostTokenPayload.safeParse(payload);
    if (!parsed.success) return null;
    // Together these limit a token's remaining life to 24 hours, plus the clock tolerance.
    const { exp, iat } = parsed.data;
    if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS) return null;
    if (iat > now.getTime() / 1000 + CLOCK_TOLERANCE_SECONDS) return null;
    return {
      externalId: parsed.data.sub,
      email: parsed.data.email,
      name: parsed.data.name,
      attributes: parsed.data.attributes ?? parsed.data.claims,
      expiresAt: new Date(exp * 1000),
      issuedAt: iat,
    };
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}

export function newBrowserToken(): string {
  return `${BROWSER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isBrowserToken(token: string): boolean {
  return token.startsWith(BROWSER_TOKEN_PREFIX);
}

/** How tokens, emails and addresses are stored or keyed, so the raw value is never kept. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * An email address as a hash, the same however it is typed. The login limit, the audit lines and
 * the stop links use it, so all three agree about who someone is.
 */
export const emailAddressHash = (email: string) => sha256Hex(email.trim().toLowerCase());

/** Returns the exact origin of a URL, or null if it is not a plain http or https origin. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}
