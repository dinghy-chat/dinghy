import { goalCondition } from "../../server/src/campaign-parts.ts";
import type { CampaignDefinition, Condition } from "./api.ts";
import { dateTimeInput } from "./format.ts";

// The condition builder's model: a tree of groups and rules whose values are the text the operator
// typed, so a half-typed number or date stays as it is. It turns into the server's grammar on each
// change, and the server checks it.

/** The fields a rule reads, by the kind of value each holds. An attribute takes any value. */
const FIELD_KINDS = {
  name: "text",
  firstName: "text",
  email: "text",
  userId: "text",
  language: "text",
  country: "text",
  timeZone: "text",
  signedIn: "boolean",
  hasChatted: "boolean",
  conversationCount: "number",
  firstSeenAt: "time",
  lastSeenAt: "time",
  attribute: "attribute",
  eventCount: "number",
  eventLastAt: "time",
  repliedToCampaign: "boolean",
} as const;

export type FieldChoice = keyof typeof FIELD_KINDS;
export type FieldKind = (typeof FIELD_KINDS)[FieldChoice];
export const FIELD_CHOICES = Object.keys(FIELD_KINDS) as FieldChoice[];
export const kindOf = (field: FieldChoice): FieldKind => FIELD_KINDS[field];
/** The fields named by a key the operator types: an attribute's, or an event's name. */
export const takesKey = (field: FieldChoice) =>
  field === "attribute" || field === "eventCount" || field === "eventLastAt";

export type Op =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "exists"
  | "missing"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "older_than";

/** The operators the builder offers for each kind. The server takes a few more. */
const OPS_BY_KIND: Record<FieldKind, Op[]> = {
  text: ["eq", "ne", "in", "not_in", "contains", "exists", "missing"],
  boolean: ["eq", "ne"],
  number: ["eq", "ne", "gt", "gte", "lt", "lte"],
  time: ["older_than", "gt", "lt", "exists", "missing"],
  attribute: ["eq", "ne", "in", "not_in", "contains", "gt", "lt", "exists", "missing"],
};

/** The operators to offer for a rule: its kind's, and its own if code wrote another. */
export const opsFor = (rule: RuleDraft): Op[] => [
  ...new Set([...OPS_BY_KIND[kindOf(rule.field)], rule.op]),
];

export const takesValue = (op: Op) => op !== "exists" && op !== "missing";
export const takesList = (op: Op) => op === "in" || op === "not_in";

export interface RuleDraft {
  id: number;
  field: FieldChoice;
  /** The attribute's key or the event's name, for the fields that take one. */
  key: string;
  op: Op;
  /** The value as typed: a list is split by commas, and a yes or no is "true" or "false". */
  text: string;
}

export type GroupMatch = "all" | "any" | "none";

export interface GroupDraft {
  id: number;
  match: GroupMatch;
  items: (RuleDraft | GroupDraft)[];
}

export const isGroup = (item: RuleDraft | GroupDraft): item is GroupDraft => "items" in item;

let lastId = 0;
const nextId = () => {
  lastId += 1;
  return lastId;
};

export const newRule = (field: FieldChoice = "attribute"): RuleDraft => ({
  id: nextId(),
  field,
  key: "",
  op: OPS_BY_KIND[kindOf(field)][0] ?? "eq",
  text: kindOf(field) === "boolean" ? "true" : "",
});

export const newGroup = (items: GroupDraft["items"] = []): GroupDraft => ({
  id: nextId(),
  match: "all",
  items,
});

type Rule = Extract<Condition, { field: string }>;
type Scalar = string | number | boolean;

const EVENT_PARTS = { count: "eventCount", lastAt: "eventLastAt" } as const;

/** A rule's field as the builder's choice and key. */
function fieldOf(field: string): Pick<RuleDraft, "field" | "key"> {
  if (field.startsWith("attributes.")) return { field: "attribute", key: field.slice(11) };
  if (field.startsWith("events.")) {
    const dot = field.lastIndexOf(".");
    const part = field.slice(dot + 1);
    if (part === "count" || part === "lastAt") {
      return { field: EVENT_PARTS[part], key: field.slice(7, dot) };
    }
  }
  if (Object.hasOwn(FIELD_KINDS, field)) return { field: field as FieldChoice, key: "" };
  return { field: "attribute", key: field };
}

function textOf(rule: Rule, kind: FieldKind): string {
  const { value } = rule;
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (kind === "time" && rule.op !== "older_than") return dateTimeInput(String(value));
  return String(value);
}

function ruleDraft(rule: Rule): RuleDraft {
  const field = fieldOf(rule.field);
  return { id: nextId(), ...field, op: rule.op, text: textOf(rule, kindOf(field.field)) };
}

function itemDraft(condition: Condition): RuleDraft | GroupDraft {
  if ("field" in condition) return ruleDraft(condition);
  if ("all" in condition) return { ...newGroup(condition.all.map(itemDraft)), match: "all" };
  if ("any" in condition) return { ...newGroup(condition.any.map(itemDraft)), match: "any" };
  // "None of these" is how the builder says `not`.
  const inner = condition.not;
  const items = "any" in inner ? inner.any.map(itemDraft) : [itemDraft(inner)];
  return { ...newGroup(items), match: "none" };
}

/** The builder's tree for a condition, always a group at the top. None is an empty group. */
export function groupOf(condition: Condition | undefined): GroupDraft {
  if (condition === undefined) return newGroup();
  const item = itemDraft(condition);
  return isGroup(item) ? item : newGroup([item]);
}

/** Text as a yes or no, a number, or itself, for an attribute, which may hold any of them. */
function guessScalar(text: string): Scalar {
  if (text === "true" || text === "false") return text === "true";
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

function scalarOf(text: string, rule: RuleDraft): Scalar {
  const kind = kindOf(rule.field);
  if (kind === "boolean") return text === "true";
  if (kind === "number")
    return text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
  if (kind === "time" && rule.op !== "older_than") {
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? text : at.toISOString();
  }
  return kind === "attribute" ? guessScalar(text.trim()) : text;
}

function fieldName({ field, key }: RuleDraft): string {
  if (field === "attribute") return `attributes.${key.trim()}`;
  if (field === "eventCount") return `events.${key.trim()}.count`;
  if (field === "eventLastAt") return `events.${key.trim()}.lastAt`;
  return field;
}

function ruleOf(rule: RuleDraft): Rule {
  const field = fieldName(rule);
  if (!takesValue(rule.op)) return { field, op: rule.op };
  if (!takesList(rule.op)) return { field, op: rule.op, value: scalarOf(rule.text, rule) };
  const parts = rule.text.split(",").map((part) => part.trim());
  return {
    field,
    op: rule.op,
    value: parts.filter((part) => part !== "").map((part) => scalarOf(part, rule)),
  };
}

/** The condition a group stands for, or undefined for an empty one. */
export function conditionOf(group: GroupDraft): Condition | undefined {
  const items = group.items.flatMap((item) => {
    const one = isGroup(item) ? conditionOf(item) : ruleOf(item);
    return one === undefined ? [] : [one];
  });
  const [only] = items;
  if (only === undefined) return undefined;
  if (group.match === "none") return { not: items.length === 1 ? only : { any: items } };
  if (items.length === 1) return only;
  return group.match === "all" ? { all: items } : { any: items };
}

/**
 * The attribute keys and event names a campaign reads: in its audience, its exit and its goal, and
 * the event that triggers it.
 */
export function namesRead({ audience, rules, trigger }: CampaignDefinition) {
  const attributes = new Set<string>();
  const events = new Set<string>();
  const visit = (item: RuleDraft | GroupDraft) => {
    if (isGroup(item)) for (const one of item.items) visit(one);
    else if (item.field === "attribute") attributes.add(item.key);
    else if (item.field === "eventCount" || item.field === "eventLastAt") events.add(item.key);
  };
  const goal = rules.goal === undefined ? undefined : goalCondition(rules.goal);
  for (const condition of [audience, rules.exitWhen, goal]) visit(groupOf(condition));
  if (trigger.type === "event") events.add(trigger.name);
  return { attributes, events };
}
