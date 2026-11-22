// What the Contacts and Visitors tabs show about pages and details. Plain string work, with no
// URL object: React Native's URL does not implement every part on every engine.

import { countryName as localizedCountry } from "../../operator/src/place.ts";
import regionNames from "./region-names.json";

/** Hermes can lack Intl.DisplayNames. Use the English region name in that case. */
export function countryName(country: string): string {
  const name = localizedCountry(country);
  const fallback: Record<string, string> = regionNames;
  return name === country ? (fallback[country] ?? country) : name;
}

/** A web address as its parts, or null when it is not an http or https address. */
function urlParts(value: string): { host: string; path: string } | null {
  const match = /^https?:\/\/([^/?#\s]+)([^\s]*)$/i.exec(value.trim());
  if (match === null) return null;
  const rest = match[2] ?? "";
  return { host: (match[1] ?? "").toLowerCase(), path: rest.startsWith("/") ? rest : `/${rest}` };
}

/** A web address that is safe to open: only http and https. */
export function webLink(value: unknown): string | null {
  return typeof value === "string" && urlParts(value) !== null ? value.trim() : null;
}

/** An address with no scheme, as in "acme.example/pricing". */
export const bare = (value: string) => value.replace(/^https?:\/\//i, "");

/** The path of a page on the customer's site, as in "/docs/pricing", or the address bare. */
export function pagePath(page: string): string {
  return urlParts(page)?.path ?? bare(page);
}

/** The separator before the site's name at the end of a title, as in "Pricing | Acme". */
const TITLE_SEPARATOR = /\s+[-|–—·•:]{1,2}\s+/g;
/** Second-level labels of country domains, as in "acme.com.au", where the name comes before. */
const SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

function siteName(page: string): string | null {
  const parts = urlParts(page);
  if (parts === null) return null;
  const labels = parts.host.replace(/:\d+$/, "").split(".");
  const name = SECOND_LEVEL.has(labels.at(-2) ?? "") ? labels.at(-3) : labels.at(-2);
  return name === undefined || name.length < 3 ? null : name.replaceAll("-", "");
}

/**
 * A page's title with no site name at its end, as the web app shows it: "Profile - Settings" for
 * "Profile - Settings - Shipmail" on shipmail.to. A page with no title shows its path.
 */
export function pageName(title: string | null, page: string): string {
  const trimmed = title?.trim();
  if (!trimmed) return pagePath(page);
  const site = siteName(page);
  const cut = [...trimmed.matchAll(TITLE_SEPARATOR)].at(-1);
  if (site === null || cut?.index === undefined || cut.index === 0) return trimmed;
  const end = trimmed
    .slice(cut.index + cut[0].length)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");
  return end.startsWith(site) ? trimmed.slice(0, cut.index) : trimmed;
}

export type PageView = { path: string; title: string | null; viewedAt: string };
/** One or more views of the same page in a row, newest first, as one line. */
export type PageRun = PageView & { views: number };

/** Joins views of the same page that follow each other, such as three reloads of /pricing. */
export function pageRuns(pages: PageView[]): PageRun[] {
  const runs: PageRun[] = [];
  for (const page of pages) {
    const last = runs.at(-1);
    if (last !== undefined && last.path === page.path) last.views += 1;
    else runs.push({ ...page, views: 1 });
  }
  return runs;
}

export type DetailRow = {
  key: string;
  value: string;
  link: string | null;
  /** False for what the page sent with setContext(): anyone can change it in a browser. */
  signed: boolean;
  /** The site's own ID for a signed-in visitor. */
  userId: boolean;
};

function rows(values: Record<string, unknown> | null, signed: boolean): DetailRow[] {
  return Object.entries(values ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return { key, value: text, link: signed ? webLink(value) : null, signed, userId: false };
    });
}

/** The site's user ID, then the signed attributes, then the page's unsigned context. */
export function detailRows(contact: {
  userId: string | null;
  attributes: Record<string, unknown> | null;
  pageContext: Record<string, unknown> | null;
}): DetailRow[] {
  const id: DetailRow[] =
    contact.userId === null
      ? []
      : [{ key: "userId", value: contact.userId, link: null, signed: true, userId: true }];
  return [...id, ...rows(contact.attributes, true), ...rows(contact.pageContext, false)];
}

/** A name such as "id", "orgId" or "account_id", whose value someone may paste elsewhere. */
export const isIdName = (name: string) => /(^|_)(id|ID)$|[a-z0-9](Id|ID)$/.test(name);
