/** The signed-in user that a host token names. */
export interface HostUser {
  userId: string;
  name?: string;
  email?: string;
  attributes?: Record<string, unknown>;
  /** How long the token is valid. One hour by default, and at most 24 hours. */
  expiresInSeconds?: number;
}

const DEFAULT_LIFETIME_SECONDS = 60 * 60;
// The server refuses a token that lives longer.
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;

const base64url = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** An HS256 JWT for `Dinghy.identify`, signed with the workspace's signing secret. */
export async function signHostToken(
  user: HostUser,
  signingSecret: string,
  publicKey: string,
): Promise<string> {
  const lifetime = user.expiresInSeconds ?? DEFAULT_LIFETIME_SECONDS;
  if (lifetime <= 0 || lifetime > MAX_LIFETIME_SECONDS) {
    throw new RangeError("expiresInSeconds must be more than 0 and at most 86400 (24 hours).");
  }
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    sub: user.userId,
    aud: publicKey,
    iat,
    exp: iat + lifetime,
    name: user.name,
    email: user.email,
    attributes: user.attributes,
  };
  const unsigned = `${encodeJson({ alg: "HS256", typ: "JWT" })}.${encodeJson(claims)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}
