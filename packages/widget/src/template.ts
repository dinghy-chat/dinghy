import { type CampaignTriggerType, CONTACT_VARIABLES } from "./shared.ts";

// Liquid-style variables in a campaign's text, such as `{{ firstName | default: "there" }}`. The
// server renders a message with it and checks a saved one, and the operator app's editor checks
// and previews the text with this same file.

const TAG = /\{\{(.*?)\}\}/g;
const PATH = /^[A-Za-z_][\w.:-]*$/;
const FILTER = /^\s*([a-z]+)\s*(?::\s*(?:"([^"]*)"|'([^']*)'))?\s*$/;

/** What each filter does to a value, with its argument. Empty text stays empty for the last two. */
const FILTERS = {
  default: (value: string, arg: string) => (value === "" ? arg : value),
  upcase: (value: string) => value.toUpperCase(),
  downcase: (value: string) => value.toLowerCase(),
  prepend: (value: string, arg: string) => (value === "" ? "" : arg + value),
  append: (value: string, arg: string) => (value === "" ? "" : value + arg),
} as const satisfies Record<string, (value: string, arg: string) => string>;

type FilterName = keyof typeof FILTERS;
const TAKES_ARGUMENT: readonly FilterName[] = ["default", "prepend", "append"];

interface Tag {
  path: string;
  filters: { name: FilterName; arg: string }[];
}

/** Why a variable in the text does not read. */
export type TemplateProblem =
  | { kind: "noVariable"; tag: string }
  | { kind: "unknownFilter"; filter: string }
  | { kind: "filterArgument"; filter: string; takesArgument: boolean }
  | { kind: "unknownVariable"; path: string };

/** One `{{ ... }}`, or why it does not read. */
function parseTag(inner: string): Tag | TemplateProblem {
  const [path = "", ...rest] = inner.split("|");
  const variable = path.trim();
  if (!PATH.test(variable)) return { kind: "noVariable", tag: `{{${inner}}}` };
  const filters: Tag["filters"] = [];
  for (const part of rest) {
    const [, name = "", double, single] = FILTER.exec(part) ?? [];
    if (!Object.hasOwn(FILTERS, name)) return { kind: "unknownFilter", filter: part.trim() };
    const arg = double ?? single;
    const filter = name as FilterName;
    const takesArgument = TAKES_ARGUMENT.includes(filter);
    if (takesArgument !== (arg !== undefined)) {
      return { kind: "filterArgument", filter, takesArgument };
    }
    filters.push({ name: filter, arg: arg ?? "" });
  }
  return { path: variable, filters };
}

/** A value as text: a word, a number or a yes or no. Anything else, or nothing, is empty. */
const asText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";

/** The text with each variable filled from `lookup`. A tag that does not read stays as it is. */
export function renderTemplate(text: string, lookup: (path: string) => unknown): string {
  return text.replace(TAG, (whole, inner: string) => {
    const tag = parseTag(inner);
    if (!("filters" in tag)) return whole;
    return tag.filters.reduce(
      (value, { name, arg }) => FILTERS[name](value, arg),
      asText(lookup(tag.path)),
    );
  });
}

/** A part of a text: its words, or a tag with the variable it reads, null when it does not read. */
export type TemplatePart =
  | { kind: "text"; text: string }
  | { kind: "tag"; tag: string; path: string | null };

/** The text as its words and its tags, in order. */
export function templateParts(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let end = 0;
  for (const match of text.matchAll(TAG)) {
    if (match.index > end) parts.push({ kind: "text", text: text.slice(end, match.index) });
    const tag = parseTag(match[1] ?? "");
    parts.push({ kind: "tag", tag: match[0], path: "filters" in tag ? tag.path : null });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ kind: "text", text: text.slice(end) });
  return parts;
}

/** Why the text's variables do not read, one problem each. */
export function templateProblems(text: string, knows: (path: string) => boolean) {
  const problems: TemplateProblem[] = [];
  for (const [, inner = ""] of text.matchAll(TAG)) {
    const tag = parseTag(inner);
    if (!("filters" in tag)) problems.push(tag);
    else if (!knows(tag.path)) problems.push({ kind: "unknownVariable", path: tag.path });
  }
  return problems;
}

const CONTACT = new Set<string>(CONTACT_VARIABLES);

/** The prefixes of the variables that read a contact's attribute, a send's data or an event's. */
export const VARIABLE_PREFIXES = {
  attributes: "attributes.",
  data: "data.",
  eventProperties: "event.properties.",
} as const;

const scoped = (prefix: string, path: string) =>
  path.startsWith(prefix) && /^\w/.test(path.slice(prefix.length));

/**
 * Whether a campaign's text may read the variable, for its trigger: the contact's fields and
 * attributes, a send's `data` from code, and a tracked event's properties.
 */
export const knownVariable = (trigger: CampaignTriggerType) => (path: string) =>
  CONTACT.has(path) ||
  scoped(VARIABLE_PREFIXES.attributes, path) ||
  (trigger === "api" && scoped(VARIABLE_PREFIXES.data, path)) ||
  (trigger === "event" && scoped(VARIABLE_PREFIXES.eventProperties, path));
