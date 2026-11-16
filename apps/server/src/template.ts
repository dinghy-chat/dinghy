// Liquid-style variables in a campaign's text, such as `{{ firstName | default: "there" }}`. The
// server renders a message with it, and the operator app's preview imports this same file.

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

/** One `{{ ... }}`, or why it does not read. */
function parseTag(inner: string): Tag | string {
  const [path = "", ...rest] = inner.split("|");
  const variable = path.trim();
  if (!PATH.test(variable)) return `"{{${inner}}}" names no variable`;
  const filters: Tag["filters"] = [];
  for (const part of rest) {
    const [, name = "", double, single] = FILTER.exec(part) ?? [];
    if (!Object.hasOwn(FILTERS, name)) return `Unknown filter "${part.trim()}"`;
    const arg = double ?? single;
    const filter = name as FilterName;
    if (TAKES_ARGUMENT.includes(filter) !== (arg !== undefined)) {
      return `The filter ${filter} ${TAKES_ARGUMENT.includes(filter) ? "takes" : "takes no"} text in quotes`;
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
    if (typeof tag === "string") return whole;
    return tag.filters.reduce(
      (value, { name, arg }) => FILTERS[name](value, arg),
      asText(lookup(tag.path)),
    );
  });
}

/** Why the text's variables do not read, one line each, for the editor and the API. */
export function templateProblems(text: string, knows: (path: string) => boolean): string[] {
  const problems: string[] = [];
  for (const [, inner = ""] of text.matchAll(TAG)) {
    const tag = parseTag(inner);
    if (typeof tag === "string") problems.push(tag);
    else if (!knows(tag.path)) problems.push(`Unknown variable ${tag.path}`);
  }
  return problems;
}
