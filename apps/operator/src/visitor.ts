import type { Conversation, VisitorIdentity } from "./api.ts";
import { t } from "./text.ts";

// Crockford's base32: no I, L, O or U, so a code read aloud is not mistaken for another.
const LETTERS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A short code from the visitor's ID, the same on every load, such as "7F3K". */
function visitorCode(visitorId: string): string {
  const bits = Number.parseInt(visitorId.replaceAll("-", "").slice(0, 5), 16) || 0;
  let code = "";
  for (let shift = 15; shift >= 0; shift -= 5) code += LETTERS[(bits >> shift) & 31];
  return code;
}

/** The label for a visitor with no name, such as "Visitor 7F3K". */
export function visitorLabel(visitorId: string): string {
  return t("visitorLabel", { code: visitorCode(visitorId) });
}

/** The avatar's letters: the code's first two for a visitor with no name, so they differ. */
export function avatarLetters(visitor: VisitorIdentity): string | undefined {
  return shownName(visitor) === null ? visitorCode(visitor.id).slice(0, 2) : undefined;
}

/** The name, email or user ID the host site gave, or the short code for a signed-out visitor. */
export function visitorName(visitor: VisitorIdentity): string {
  return shownName(visitor) ?? visitorLabel(visitor.id);
}

function shownName(visitor: Omit<VisitorIdentity, "id">): string | null {
  return visitor.name ?? visitor.email ?? visitor.externalId;
}

/** The email and user ID the title does not already show, so an operator can find the account. */
export function otherIdentity(visitor: Omit<VisitorIdentity, "id">): string[] {
  const shown = shownName(visitor);
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

/**
 * Name, shown value and safe link of each value in a record, such as the signed attributes or the
 * page's context. A web address becomes a link, and every other value stays text.
 */
export function detailRows(
  values: Record<string, unknown> | null,
): [name: string, value: string, link: string | null][] {
  return Object.entries(values ?? {}).map(([name, value]) => [
    name,
    typeof value === "string" ? value : JSON.stringify(value),
    webLink(value),
  ]);
}

/** Who wrote a reply: "You", the API key's name with a note, a teammate's name, or a teammate. */
export function replyAuthor(
  message: {
    authorOperatorId: string | null;
    authorApiKeyId: string | null;
    authorName: string | null;
  },
  meId: string,
): string {
  if (message.authorApiKeyId !== null) {
    return t("apiKeyAuthor", { name: message.authorName ?? t("apiKeyUnknown") });
  }
  if (message.authorOperatorId === meId) return t("you");
  return message.authorName ?? t("aTeammate");
}

/** A page as the header shows it: with no scheme, as in "acme.example/pricing". */
export const bare = (page: string) => page.replace(/^https?:\/\//, "");

const MINUTE_MS = 60_000;

/** "5 minutes ago", "yesterday", in the browser's words. Narrow is "5m ago" in English. */
export function ago(iso: string, now = Date.now(), style: "long" | "narrow" = "long"): string {
  const words = new Intl.RelativeTimeFormat([], { numeric: "auto", style });
  const minutes = Math.round((new Date(iso).getTime() - now) / MINUTE_MS);
  if (minutes > -60) return words.format(Math.min(minutes, 0), "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return words.format(hours, "hour");
  return words.format(Math.round(hours / 24), "day");
}
