import { markdownText } from "../../../packages/widget/src/markdown.ts";
import type { ContactDetail, Conversation, VisitorIdentity } from "./api.ts";
import { MINUTE_MS } from "./format.ts";
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

/** Online now, or when the visitor was last seen, or nothing when unknown. */
export function presenceLine(lastSeenAt: string | null, online: boolean | null): string | null {
  if (online === true) return t("onlineNow");
  return lastSeenAt === null ? null : t("lastSeen", { time: ago(lastSeenAt) });
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

/** An address with no scheme, as in "acme.example/pricing". */
export const bare = (page: string) => page.replace(/^https?:\/\//, "");

/**
 * A page of the customer's own site, which the operator already knows: its path, as in
 * "/docs/pricing", or the address with no scheme when it is not a web address.
 */
export function pagePath(page: string): string {
  if (webLink(page) === null) return bare(page);
  const { pathname, search, hash } = new URL(page);
  return pathname + search + hash;
}

/** The separator before the site's name at the end of a title, as in "Pricing | Acme". */
const TITLE_SEPARATOR = /\s+[-|–—·•:]{1,2}\s+/g;

/** Second-level labels of country domains, as in "acme.com.au", where the name comes before. */
const SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

/** The site's name in its domain, as in "acme" for "app.acme.com" or "acme.co.uk". */
function siteName(page: string): string | null {
  if (webLink(page) === null) return null;
  const labels = new URL(page).hostname.split(".");
  const name = SECOND_LEVEL.has(labels.at(-2) ?? "") ? labels.at(-3) : labels.at(-2);
  return name === undefined || name.length < 3 ? null : name.replaceAll("-", "");
}

/**
 * A page's name with no site name at its end, as in "Profile - Settings" for "Profile - Settings -
 * Shipmail" on shipmail.to. The last part goes when it starts with the domain's name; a title that
 * is only the site's name stays. A page with no title shows its path.
 */
export function pageName(title: string | null, page: string): string {
  if (title === null) return pagePath(page);
  const site = siteName(page);
  const cut = [...title.matchAll(TITLE_SEPARATOR)].at(-1);
  if (site === null || cut?.index === undefined || cut.index === 0) return title;
  const end = title
    .slice(cut.index + cut[0].length)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");
  return end.startsWith(site) ? title.slice(0, cut.index) : title;
}

/** "5 minutes ago", "yesterday", in the browser's words. Narrow is "5m ago" in English. */
export function ago(iso: string, now = Date.now(), style: "long" | "narrow" = "long"): string {
  const words = new Intl.RelativeTimeFormat([], { numeric: "auto", style });
  const minutes = Math.round((new Date(iso).getTime() - now) / MINUTE_MS);
  if (minutes > -60) return words.format(Math.min(minutes, 0), "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return words.format(hours, "hour");
  return words.format(Math.round(hours / 24), "day");
}

/** A conversation's line in a list: its last message as text, an image's word, or none at all. */
export function conversationPreview(one: ContactDetail["conversations"][number]): string {
  if (one.messageCount === 0) return t("noMessages");
  return one.lastBody === null ? t("image") : markdownText(one.lastBody);
}
