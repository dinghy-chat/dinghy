import { z } from "@hono/zod-openapi";
import { type SQL, sql } from "drizzle-orm";
import { Duration } from "./inputs.ts";
import { containing } from "./messages.ts";

// One grammar for every condition on a contact: an outbound message's `unless` and the contacts
// filter. It compiles to one SQL expression over the `visitor` row, so a check for one visitor and
// a list of matching contacts run the same SQL, and there is no second evaluator to drift from it.

/** The most rules and groups one condition may hold, so its SQL stays small. */
const CONDITION_NODES_MAX = 50;
const ATTRIBUTE_KEY_MAX = 64;

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
} as const satisfies Record<string, { kind: string; sql: SQL }>;

type FieldName = keyof typeof FIELDS;
type FieldKind = (typeof FIELDS)[FieldName]["kind"] | "attribute";

const ATTRIBUTE_PREFIX = "attributes.";

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

const Rule = z.strictObject({
  field: z.string().max(ATTRIBUTE_PREFIX.length + ATTRIBUTE_KEY_MAX),
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

function kindOf(field: string): FieldKind | null {
  if (Object.hasOwn(FIELDS, field)) return FIELDS[field as FieldName].kind;
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
function ruleProblem({ field, op, value }: Rule): string | null {
  const kind = kindOf(field);
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

const CONDITION_REF = "#/components/schemas/Condition";

const Checked = Group.superRefine((condition, context) => {
  const { rules, nodes } = walk(condition);
  if (nodes > CONDITION_NODES_MAX) {
    context.addIssue(`At most ${CONDITION_NODES_MAX} rules and groups`);
  }
  for (const problem of rules.map(ruleProblem)) {
    if (problem !== null) context.addIssue(problem);
  }
});

/**
 * A condition on a contact's fields: rules, and `all`, `any` and `not`, which nest. The API
 * document's generator cannot walk a schema that names itself, so the checks run inside an
 * unknown value, and the document's schema is written out.
 */
export const ConditionSchema = z
  .unknown()
  .transform((value, context) => {
    const parsed = Checked.safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) {
      context.addIssue(issue.message);
    }
    return z.NEVER;
  })
  .openapi("Condition", {
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
    description: `A rule \`{ field, op, value }\`, or a group \`{ all: [...] }\`, \`{ any: [...] }\` or \`{ not: ... }\`, which nest. Fields: ${[...Object.keys(FIELDS), `${ATTRIBUTE_PREFIX}<key>`].join(", ")}. Ops: ${OPS.join(", ")}; older_than takes a duration such as 7d.`,
    example: {
      all: [
        { field: "attributes.plan", op: "in", value: ["trial", "pro"] },
        { field: "attributes.onboarded", op: "ne", value: true },
      ],
    },
  });

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

/** The condition as one SQL boolean over the `visitor` row. The schema checked every rule. */
export function toSql(condition: Condition): SQL {
  if ("all" in condition) return sql`(${sql.join(condition.all.map(toSql), sql` and `)})`;
  if ("any" in condition) return sql`(${sql.join(condition.any.map(toSql), sql` or `)})`;
  if ("not" in condition) return sql`(not ${toSql(condition.not)})`;
  const { field, op, value } = condition;
  if (field.startsWith(ATTRIBUTE_PREFIX)) {
    return attributeRule(field.slice(ATTRIBUTE_PREFIX.length), op, value);
  }
  const known = FIELDS[field as FieldName];
  return sql`coalesce(${columnRule(known.sql, known.kind, op, value)}, false)`;
}
