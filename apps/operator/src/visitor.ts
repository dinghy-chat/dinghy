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

/** The `name` claim the host site signed, when it is a string with text in it. */
export function claimedName(visitor: { claims?: Record<string, unknown> | null }): string | null {
  const name = visitor.claims?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

/** The name, email or user ID the host site gave, or the short code for a signed-out visitor. */
export function visitorName(visitor: {
  id: string;
  email: string | null;
  externalId: string | null;
  claims?: Record<string, unknown> | null;
}): string {
  return claimedName(visitor) ?? visitor.email ?? visitor.externalId ?? visitorLabel(visitor.id);
}

export function title(conversation: Conversation): string {
  return visitorName(conversation.visitor);
}

/** True when the newest message is the visitor's, in an open conversation. */
export function isWaiting(conversation: Conversation): boolean {
  return conversation.status === "open" && conversation.lastMessage?.fromVisitor === true;
}
