import type { Conversation } from "./api.ts";
import { t } from "./text.ts";

// Crockford's base32: no I, L, O or U, so a code read aloud is not mistaken for another.
const LETTERS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A short code from the visitor's ID, the same on every load, such as "Visitor 7F3K". */
export function visitorLabel(visitorId: string): string {
  const bits = Number.parseInt(visitorId.replaceAll("-", "").slice(0, 5), 16) || 0;
  let code = "";
  for (let shift = 15; shift >= 0; shift -= 5) code += LETTERS[(bits >> shift) & 31];
  return t("visitorLabel").replace("{code}", code);
}

/** The name, email or user ID the host site gave, or the short code for a signed-out visitor. */
export function visitorName(visitor: {
  id: string;
  email: string | null;
  externalId: string | null;
  name?: string | null;
}): string {
  return visitor.name ?? visitor.email ?? visitor.externalId ?? visitorLabel(visitor.id);
}

/** The email and user ID the title does not already show, so an operator can find the account. */
export function otherIdentity(visitor: {
  email: string | null;
  externalId: string | null;
  name?: string | null;
}): string[] {
  const shown = visitor.name ?? visitor.email ?? visitor.externalId;
  return [visitor.email, visitor.externalId].filter(
    (part): part is string => part !== null && part !== shown,
  );
}

export function title(conversation: Conversation): string {
  return visitorName(conversation.visitor);
}

/** True when the newest message is the visitor's, in an open conversation. */
export function isWaiting(conversation: Conversation): boolean {
  return conversation.status === "open" && conversation.lastMessage?.fromVisitor === true;
}

/** A web address that is safe to open: only http and https, which a link may point to. */
export function webLink(value: unknown): string | null {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || !URL.canParse(value)) {
    return null;
  }
  const { protocol, href } = new URL(value);
  return protocol === "https:" || protocol === "http:" ? href : null;
}
