import { z } from "@hono/zod-openapi";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { visitor } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { Duration } from "./inputs.ts";
import { containing } from "./messages.ts";

// One grammar for every condition on a contact: an outbound message's `unless`, the contacts filter
// and a campaign's audience, exit and goal. It compiles to one SQL expression over the `visitor`
// row, so a check for one visitor and a list of matching contacts run the same SQL, and there is no
// second evaluator to drift from it.

/** The most rules and groups one condition may hold, so its SQL stays small. */
const CONDITION_NODES_MAX = 50;

/** A visitor column, qualified by hand, because a subquery may name another table's `id`. */
const column = (name: string) => sql.raw(`"visitor"."${name}"`);

const conversationsOfVisitor = sql`from conversation as c
  where c.workspace_id = "visitor"."workspace_id" and c.visitor_id = "visitor"."id"`;

/** Whether the visitor has a conversation, as SQL over the `visitor` row. */
export const hasChatted = sql<boolean>`exists (select 1 ${conversationsOfVisitor})`;
/** How many conversations the visitor has, as SQL over the `visitor` row. */
export const conversationCount = sql<number>`(select count(*)::int ${conversationsOfVisitor})`;

/** Each field the grammar knows, by its kind of value, and its SQL. */
const FIELDS = {
  name: { kind: "text", sql: column("name") },
  // The first word of the name.
  firstName: {
    kind: "text",
    sql: sql`nullif(split_part(btrim(${column("name")}), ' ', 1), '')`,
  },
  email: { kind: "text", sql: column("email") },
  userId: { kind: "text", sql: column("user_id") },
  language: { kind: "text", sql: sql`${column("locale")}::text` },
  country: { kind: "text", sql: column("country") },
  timeZone: { kind: "text", sql: column("time_zone") },
  signedIn: { kind: "boolean", sql: sql`(${column("user_id")} is not null)` },
  firstSeenAt: { kind: "time", sql: column("created_at") },
  lastSeenAt: { kind: "time", sql: column("last_seen_at") },
  hasChatted: { kind: "boolean", sql: hasChatted },
  conversationCount: { kind: "number", sql: conversationCount },
  optedOut: { kind: "boolean", sql: sql`(${column("opted_out_at")} is not null)` },
} as const satisfies Record<string, { kind: string; sql: SQL }>;

type FieldName = keyof typeof FIELDS;
type FieldKind = (typeof FIELDS)[FieldName]["kind"] | "attribute";

const ATTRIBUTE_PREFIX = "attributes.";

/** A field that a campaign's own conditions read: the contact answered one of its messages. */
const REPLIED_TO_CAMPAIGN = "repliedToCampaign";

/** What a tracked event gives a condition: how often it happened, and when it last did. */
const EVENT_FIELDS = { count: "number", lastAt: "time" } as const;
type EventField = keyof typeof EVENT_FIELDS;
const EVENT_PREFIX = "events.";
/** An event's name, such as `export.finished`, as `track` takes it. */
export const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** `events.<name>.count` or `events.<name>.lastAt`, split, or null for another field. */
function eventField(field: string): { name: string; part: EventField } | null {
  if (!field.startsWith(EVENT_PREFIX)) return null;
  const dot = field.lastIndexOf(".");
  const name = field.slice(EVENT_PREFIX.length, dot);
  const part = field.slice(dot + 1);
  if (!EVENT_NAME.test(name) || !Object.hasOwn(EVENT_FIELDS, part)) return null;
  return { name, part: part as EventField };
}

/** The contact fields that an event's track changes, as conditions name them. */
export const eventFields = (name: string) =>
  Object.keys(EVENT_FIELDS).map((part) => `${EVENT_PREFIX}${name}.${part}`);

/** What a condition compiles against: a campaign's own conditions also read its ID. */
export interface ConditionScope {
  campaignId: string;
}

const OPS = [
  "eq",
  "ne",
  "in",
  "not_in",
  "exists",
  "missing",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "older_than",
] as const;
type Op = (typeof OPS)[number];

/** The operators each kind of field takes. */
const OPS_BY_KIND: Record<FieldKind, readonly Op[]> = {
  text: ["eq", "ne", "in", "not_in", "exists", "missing", "contains"],
  boolean: ["eq", "ne", "exists", "missing"],
  number: ["eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte"],
  time: ["exists", "missing", "gt", "gte", "lt", "lte", "older_than"],
  // An attribute may hold any JSON, but no time that `older_than` reads.
  attribute: OPS.filter((op) => op !== "older_than"),
};

const Scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
type Scalar = z.infer<typeof Scalar>;

/** The longest field: an attribute's key, or an event's name with its part. */
const FIELD_MAX = 80;

const Rule = z.strictObject({
  field: z.string().max(FIELD_MAX),
  op: z.enum(OPS),
  value: z.union([Scalar, z.array(Scalar).min(1).max(100)]).optional(),
});
type Rule = z.infer<typeof Rule>;

export type Condition = Rule | { all: Condition[] } | { any: Condition[] } | { not: Condition };

const Group: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    Rule,
    z.strictObject({ all: z.array(Group).min(1) }),
    z.strictObject({ any: z.array(Group).min(1) }),
    z.strictObject({ not: Group }),
  ]),
);

function kindOf(field: string, inCampaign: boolean): FieldKind | null {
  if (Object.hasOwn(FIELDS, field)) return FIELDS[field as FieldName].kind;
  if (field === REPLIED_TO_CAMPAIGN) return inCampaign ? "boolean" : null;
  const event = eventField(field);
  if (event !== null) return EVENT_FIELDS[event.part];
  const key = field.slice(ATTRIBUTE_PREFIX.length);
  return field.startsWith(ATTRIBUTE_PREFIX) && key.length > 0 ? "attribute" : null;
}

const isTime = (value: unknown) => z.iso.datetime().safeParse(value).success;

/** The JavaScript type a typed column's value has. An attribute takes any. */
const VALUE_TYPES: Record<Exclude<FieldKind, "attribute" | "time">, string> = {
  text: "string",
  boolean: "boolean",
  number: "number",
};

/** Why a value does not fit its field, or null when it does. */
function valueProblem(field: string, kind: FieldKind, value: Scalar): string | null {
  if (kind === "attribute") return null;
  if (kind === "time") return isTime(value) ? null : "A time, such as 2026-11-15T09:00:00Z";
  return typeof value === VALUE_TYPES[kind] ? null : `${field} takes a ${VALUE_TYPES[kind]}`;
}

/** Why a rule's value does not fit its field and operator, or null when it does. */
function ruleProblem({ field, op, value }: Rule, inCampaign: boolean): string | null {
  const kind = kindOf(field, inCampaign);
  if (kind === null) return `Unknown field ${field}`;
  if (!OPS_BY_KIND[kind].includes(op)) return `${field} does not take ${op}`;
  if (op === "exists" || op === "missing")
    return value === undefined ? null : `${op} takes no value`;
  if (op === "in" || op === "not_in") {
    if (!Array.isArray(value)) return `${op} takes a list`;
    return value.map((item) => valueProblem(field, kind, item)).find((one) => one !== null) ?? null;
  }
  if (Array.isArray(value) || value === undefined) return `${op} takes one value`;
  if (op === "older_than")
    return Duration.safeParse(value).success ? null : "A duration, such as 7d";
  if (op === "contains") return typeof value === "string" ? null : "contains takes text";
  return valueProblem(field, kind, value);
}

/** Every rule of a condition, at any depth, and how many nodes it has. */
function walk(condition: Condition): { rules: Rule[]; nodes: number } {
  if ("all" in condition || "any" in condition) {
    const parts = ("all" in condition ? condition.all : condition.any).map(walk);
    return {
      rules: parts.flatMap((part) => part.rules),
      nodes: 1 + parts.reduce((sum, part) => sum + part.nodes, 0),
    };
  }
  if ("not" in condition) {
    const inner = walk(condition.not);
    return { rules: inner.rules, nodes: inner.nodes + 1 };
  }
  return { rules: [condition], nodes: 1 };
}

/** The fields a condition reads, each once. */
export const fieldsOf = (condition: Condition) => [
  ...new Set(walk(condition).rules.map((rule) => rule.field)),
];

/** Whether a condition can change with time alone, with no change to the contact. */
export const readsTime = (condition: Condition) =>
  walk(condition).rules.some((rule) => rule.op === "older_than");

/** Checks every rule against its field and operator, inside a campaign or outside one. */
const checked = (inCampaign: boolean) =>
  Group.superRefine((condition, context) => {
    const { rules, nodes } = walk(condition);
    if (nodes > CONDITION_NODES_MAX) {
      context.addIssue(`At most ${CONDITION_NODES_MAX} rules and groups`);
    }
    for (const rule of rules) {
      const problem = ruleProblem(rule, inCampaign);
      if (problem !== null) context.addIssue(problem);
    }
  });

/** Parses a condition inside an unknown value, so the API document can describe it by hand. */
const parsedCondition = (inCampaign: boolean) => {
  const schema = checked(inCampaign);
  return z.unknown().transform((value, context) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) {
      context.addIssue(issue.message);
    }
    return z.NEVER;
  });
};

const CONDITION_REF = "#/components/schemas/Condition";
const EVENT_FIELD_NAMES = `${EVENT_PREFIX}<name>.count, ${EVENT_PREFIX}<name>.lastAt`;

/**
 * A condition on a contact's fields: rules, and `all`, `any` and `not`, which nest. The API
 * document's generator cannot walk a schema that names itself, so the checks run inside an
 * unknown value, and the document's schema is written out.
 */
/**
 * A condition as the API document describes it, which its generator cannot draw from a schema that
 * names itself. A campaign's exit and goal also read `repliedToCampaign`.
 */
const documentedCondition = (inCampaign: boolean) =>
  parsedCondition(inCampaign).openapi(inCampaign ? "CampaignCondition" : "Condition", {
    oneOf: [
      {
        type: "object",
        properties: {
          field: { type: "string" },
          op: { type: "string", enum: [...OPS] },
          value: {
            oneOf: [
              { type: ["string", "number", "boolean"] },
              { type: "array", items: { type: ["string", "number", "boolean"] } },
            ],
          },
        },
        required: ["field", "op"],
        additionalProperties: false,
      },
      ...(["all", "any"] as const).map((group) => ({
        type: "object" as const,
        properties: { [group]: { type: "array" as const, items: { $ref: CONDITION_REF } } },
        required: [group],
        additionalProperties: false,
      })),
      {
        type: "object",
        properties: { not: { $ref: CONDITION_REF } },
        required: ["not"],
        additionalProperties: false,
      },
    ],
    description: `${inCampaign ? `A campaign's exit or goal, which may also read ${REPLIED_TO_CAMPAIGN}: the contact answered one of this campaign's messages. ` : ""}A rule \`{ field, op, value }\`, or a group \`{ all: [...] }\`, \`{ any: [...] }\` or \`{ not: ... }\`, which nest. Fields: ${[...Object.keys(FIELDS), `${ATTRIBUTE_PREFIX}<key>`, EVENT_FIELD_NAMES].join(", ")}. Ops: ${OPS.join(", ")}; older_than takes a duration such as 7d.`,
    example: {
      all: [
        { field: "attributes.plan", op: "in", value: ["trial", "pro"] },
        { field: "attributes.onboarded", op: "ne", value: true },
      ],
    },
  });

export const ConditionSchema = documentedCondition(false);
export const CampaignConditionSchema = documentedCondition(true);

const COMPARE = { gt: sql`>`, gte: sql`>=`, lt: sql`<`, lte: sql`<=` } as const;
type Compare = keyof typeof COMPARE;
const isCompare = (op: Op): op is Compare => Object.hasOwn(COMPARE, op);

/** A rule on a typed column. `ne` and `not_in` match a missing value, as "is not true" reads. */
function columnRule(target: SQL, kind: Exclude<FieldKind, "attribute">, op: Op, value: unknown) {
  const cast = kind === "time" ? sql`::timestamptz` : sql``;
  const one = sql`${value}${cast}`;
  if (op === "exists") return sql`${target} is not null`;
  if (op === "missing") return sql`${target} is null`;
  if (op === "eq") return sql`${target} = ${one}`;
  if (op === "ne") return sql`${target} is distinct from ${one}`;
  if (op === "in" || op === "not_in") {
    const list = sql.join(
      (value as Scalar[]).map((item) => sql`${item}`),
      sql`, `,
    );
    return op === "in"
      ? sql`coalesce(${target} in (${list}), false)`
      : sql`coalesce(${target} not in (${list}), true)`;
  }
  if (op === "contains") return sql`${target} ilike ${containing(String(value))}`;
  if (op === "older_than") {
    return sql`${target} < now() - ${Duration.parse(value)}::float8 * interval '1 millisecond'`;
  }
  return sql`${target} ${COMPARE[op as Compare]} ${one}`;
}

/** A rule on one attribute, which may hold any JSON. A comparison reads only a value of its type. */
function attributeRule(key: string, op: Op, value: unknown) {
  const target = sql`(${column("attributes")} -> ${key})`;
  const json = (item: unknown) => sql`${JSON.stringify(item)}::jsonb`;
  if (op === "exists") return sql`coalesce(jsonb_typeof(${target}) <> 'null', false)`;
  if (op === "missing") return sql`coalesce(jsonb_typeof(${target}) = 'null', true)`;
  if (op === "eq") return sql`coalesce(${target} = ${json(value)}, false)`;
  if (op === "ne") return sql`${target} is distinct from ${json(value)}`;
  if (op === "in") return sql`coalesce(${json(value)} @> jsonb_build_array(${target}), false)`;
  if (op === "not_in")
    return sql`not coalesce(${json(value)} @> jsonb_build_array(${target}), false)`;
  if (op === "contains") {
    // Text holds the value, or a list holds it as an item.
    return sql`case jsonb_typeof(${target})
      when 'string' then ${target} #>> '{}' ilike ${containing(String(value))}
      when 'array' then ${target} @> jsonb_build_array(${value}::text)
      else false end`;
  }
  if (!isCompare(op)) throw new Error(`An attribute does not take ${op}`);
  // A case, because SQL may evaluate both sides of an `and`, and a cast of text to a number fails.
  return typeof value === "number"
    ? sql`case when jsonb_typeof(${target}) = 'number' then (${target})::numeric ${COMPARE[op]} ${value} else false end`
    : sql`case when jsonb_typeof(${target}) = 'string' then ${target} #>> '{}' ${COMPARE[op]} ${String(value)} else false end`;
}

/** A tracked event's count or last time, as SQL over the `visitor` row. No row counts 0. */
function eventSql({ name, part }: { name: string; part: EventField }): SQL {
  const ofContact = sql`from contact_event as e where e.workspace_id = "visitor"."workspace_id"
    and e.visitor_id = "visitor"."id" and e.name = ${name}`;
  return part === "count"
    ? sql`coalesce((select e.count ${ofContact}), 0)`
    : sql`(select e.last_at ${ofContact})`;
}

/** Whether the contact answered one of the campaign's messages, as SQL over the `visitor` row. */
const repliedToCampaign = ({ campaignId }: ConditionScope) => sql`exists (select 1
  from outbound_message as o where o.workspace_id = "visitor"."workspace_id"
  and o.visitor_id = "visitor"."id" and o.campaign_id = ${campaignId} and o.replied_at is not null)`;

/** A typed field's SQL and kind. The schema checked that the field fits where it is used. */
function typedField(field: string, scope: ConditionScope | undefined) {
  if (field === REPLIED_TO_CAMPAIGN) {
    if (scope === undefined) throw new Error(`${field} needs a campaign`);
    return { sql: repliedToCampaign(scope), kind: "boolean" as const };
  }
  const event = eventField(field);
  if (event !== null) return { sql: eventSql(event), kind: EVENT_FIELDS[event.part] };
  return FIELDS[field as FieldName];
}

/**
 * The condition as one SQL boolean over the `visitor` row. The schema checked every rule. A
 * campaign's own conditions pass its ID, which `repliedToCampaign` reads.
 */
export function toSql(condition: Condition, scope?: ConditionScope): SQL {
  const each = (part: Condition) => toSql(part, scope);
  if ("all" in condition) return sql`(${sql.join(condition.all.map(each), sql` and `)})`;
  if ("any" in condition) return sql`(${sql.join(condition.any.map(each), sql` or `)})`;
  if ("not" in condition) return sql`(not ${each(condition.not)})`;
  const { field, op, value } = condition;
  if (field.startsWith(ATTRIBUTE_PREFIX)) {
    return attributeRule(field.slice(ATTRIBUTE_PREFIX.length), op, value);
  }
  const known = typedField(field, scope);
  return sql`coalesce(${columnRule(known.sql, known.kind, op, value)}, false)`;
}

/** Whether a condition matches one contact now: the same SQL as the contacts filter. */
export async function matchesContact(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  condition: Condition,
  scope?: ConditionScope,
) {
  const [row] = await tx
    .select({ matched: sql<boolean>`${toSql(condition, scope)}` })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  return row?.matched === true;
}
