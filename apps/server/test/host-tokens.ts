import { SignJWT } from "jose";
import type { NewWorkspace } from "../src/workspaces.ts";

/** A host token for one of the host site's users, as its backend signs it, valid for an hour. */
export function hostToken(
  space: NewWorkspace,
  userId: string,
  claims: Record<string, unknown> = {},
  issuedAt = Math.floor(Date.now() / 1000),
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(space.publicKey)
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(new TextEncoder().encode(space.signingSecret));
}
