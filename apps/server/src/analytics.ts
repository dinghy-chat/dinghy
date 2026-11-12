import { createRoute, z } from "@hono/zod-openapi";
import { type SQL, sql } from "drizzle-orm";
import { SESSION_OR_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { failure, INVALID, KEY_LIMITED, MEMBER_ERRORS } from "./errors.ts";
import { WORKSPACE_PREFIX as PREFIX } from "./member.ts";
import { conversationHasTestVisitor, isChat, messageAuthors } from "./messages.ts";

// Support numbers from the conversations and messages already stored. Nothing here tracks anyone.

const PERIODS = [7, 30, 90] as const;
const FAST_REPLY_SECONDS = 5 * 60;
/** Postgres's code for a time zone it does not know. */
const PG_INVALID_PARAMETER = "22023";

/**
 * An IANA zone name that this Node knows. An offset such as "+01:00" is refused, because Postgres
 * reads its sign the other way round.
 */
export function isTimeZone(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

// Seconds from the start of a conversation to its first operator reply. Null with no reply.
const medianSeconds = z.number().nullable();
// Of the conversations started, the ones with a first reply within 5 minutes.
const fast = z.number().int();

const Analytics = z
  .object({
    days: z.number().int(),
    timeZone: z.string(),
    // Conversations that started in the period. The other numbers are about these.
    started: z.number().int(),
    // Of those, the ones closed now.
    closed: z.number().int(),
    // Of those, the ones with an operator's reply.
    answered: z.number().int(),
    firstReply: z.object({ medianSeconds, p90Seconds: z.number().nullable(), fast }),
    // The same numbers for a period of the same length just before, to compare with.
    previous: z.object({
      started: z.number().int(),
      firstReply: z.object({ medianSeconds, fast }),
    }),
    // One entry per day of the period, oldest first, in the given time zone.
    perDay: z.array(z.object({ date: z.string(), conversations: z.number().int() })),
    // By who sent the first reply, most first: an operator, an API key, or a deleted operator.
    repliers: z.array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("operator"),
          operatorId: z.string(),
          name: z.string(),
          conversations: z.number().int(),
        }),
        z.object({
          kind: z.literal("api_key"),
          apiKeyId: z.string(),
          name: z.string(),
          conversations: z.number().int(),
        }),
        z.object({ kind: z.literal("former"), conversations: z.number().int() }),
      ]),
    ),
    // Conversations started, by weekday (Monday first) and hour, in the given time zone.
    hours: z.array(z.array(z.number().int()).length(24)).length(7),
  })
  .openapi("Analytics");

export type AnalyticsResult = z.infer<typeof Analytics>;

/** The period and the time zone: the route's query, and MCP's `get_analytics` arguments. */
export const AnalyticsQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((days) => (PERIODS as readonly number[]).includes(days), "7, 30 or 90")
    .default(30),
  tz: z.string().refine(isTimeZone, "an IANA time zone, such as Europe/Paris").default("UTC"),
});

const analyticsRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/analytics`,
  security: SESSION_OR_KEY,
  summary: "Support numbers for the last 7, 30 or 90 days",
  description:
    "Computed from the stored conversations and messages, for any member. A period runs from the start of the day, `days - 1` days ago, in `tz`, to now. Every number is about the conversations that started in it: a conversation's first reply time runs from its start to its first reply from an operator or an API key, and `repliers` counts conversations by who sent that reply, and `fast` counts those whose first reply came within 5 minutes. `previous` gives `started` and the first reply numbers for a period of the same length just before, which ends `days` days ago. A welcome chat on Dinghy Cloud counts nowhere.",
  request: {
    params: z.object({ workspaceId: z.uuid() }),
    query: AnalyticsQuery,
  },
  responses: {
    ...KEY_LIMITED,
    200: {
      description: "The numbers",
      content: {
        "application/json": {
          schema: Analytics,
          example: {
            days: 7,
            timeZone: "Europe/Paris",
            started: 12,
            closed: 9,
            answered: 11,
            firstReply: { medianSeconds: 140, p90Seconds: 1260, fast: 8 },
            previous: { started: 9, firstReply: { medianSeconds: 180, fast: 5 } },
            perDay: [{ date: "2026-11-02", conversations: 3 }],
            repliers: [
              {
                kind: "operator",
                operatorId: "7a3e5b20-9c1d-4f6a-b8e2-4d0f1c9a6b53",
                name: "Sam",
                conversations: 11,
              },
            ],
            hours: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
          },
        },
      },
    },
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

/** How many started in a period, how many got a reply within 5 minutes, and the median wait. */
interface PeriodRow {
  started: number;
  fast: number;
  median: number | null;
}

const periodNumbers = (period: PeriodRow | null) => ({
  started: period?.started ?? 0,
  firstReply: { medianSeconds: period?.median ?? null, fast: period?.fast ?? 0 },
});

type Replier = AnalyticsResult["repliers"][number];
interface ReplierRow {
  operatorId: string | null;
  apiKeyId: string | null;
  conversations: number;
}

/** Names each replier. A deleted operator's conversations add up in one `former` entry. */
async function nameRepliers(
  tx: Transaction,
  workspaceId: string,
  rows: ReplierRow[],
): Promise<Replier[]> {
  const authors = await messageAuthors(
    tx,
    workspaceId,
    rows.map((one) => ({ authorOperatorId: one.operatorId, authorApiKeyId: one.apiKeyId })),
  );
  const named: Replier[] = [];
  let former = 0;
  for (const { operatorId, apiKeyId, conversations } of rows) {
    const author = authors.get(operatorId ?? apiKeyId ?? "");
    if (author === undefined || author.isDeleted) former += conversations;
    else if (operatorId !== null) {
      named.push({ kind: "operator", operatorId, name: author.name, conversations });
    } else if (apiKeyId !== null) {
      named.push({ kind: "api_key", apiKeyId, name: author.name, conversations });
    }
  }
  if (former > 0) named.push({ kind: "former", conversations: former });
  return named.sort((one, other) => other.conversations - one.conversations);
}

interface Row extends Record<string, unknown> {
  current: PeriodRow | null;
  previous: PeriodRow | null;
  closed: number;
  answered: number;
  p90: number | null;
  per_day: { date: string; conversations: number }[];
  repliers: ReplierRow[];
  hours: { dow: number; hour: number; conversations: number }[];
}

/**
 * Each conversation started since `since`, with its first reply: how long it waited, in seconds,
 * and who sent it. A conversation with no reply yet has a null wait. The welcome chat and a bot's
 * test visitor's chats are not ones.
 */
const firstReplies = (workspaceId: string, since: SQL) => sql`
  SELECT c.status, c.created_at,
         extract(epoch FROM reply.created_at - c.created_at) AS wait,
         reply.author_operator_id AS operator_id,
         reply.author_api_key_id AS api_key_id
  FROM conversation AS c
  LEFT JOIN LATERAL (
    SELECT m.created_at, m.author_operator_id, m.author_api_key_id FROM message AS m
    WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id
      AND m.author_visitor_id IS NULL AND ${isChat(sql`m.kind`)}
    ORDER BY m.seq LIMIT 1
  ) AS reply ON true
  WHERE c.workspace_id = ${workspaceId} AND c.created_at >= ${since} AND NOT c.welcome
    AND NOT ${conversationHasTestVisitor(sql`c`)}`;

/** The median first reply time over the last `days`, as Analytics shows it. Null with no reply. */
export async function medianFirstReplySeconds(
  tx: Transaction,
  workspaceId: string,
  days: number,
): Promise<number | null> {
  const result = await tx.execute<{ median: number | null }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY wait) AS median
    FROM (${firstReplies(workspaceId, sql`now() - make_interval(days => ${days}::int)`)}) AS f`);
  return result.rows[0]?.median ?? null;
}

/** One statement, so every number reads the same rows. The periods end at `now`. */
export async function readAnalytics(
  tx: Transaction,
  workspaceId: string,
  { days, timeZone, now }: { days: number; timeZone: string; now: Date },
): Promise<AnalyticsResult> {
  const result = await tx.execute<Row>(sql`
    WITH clock AS (
      SELECT ${now.toISOString()}::timestamptz AS now
    ), local_today AS (
      SELECT (clock.now AT TIME ZONE ${timeZone})::date AS day FROM clock
    ), local_bounds AS (
      SELECT day - ${days - 1}::int AS first_day,
             ((day - ${days - 1}::int)::timestamp AT TIME ZONE ${timeZone}) AS since,
             ((day - ${2 * days - 1}::int)::timestamp AT TIME ZONE ${timeZone}) AS previous_since
      FROM local_today
    ), bounds AS (
      -- The previous period lasts as many real seconds as the current one, which ends now, so a
      -- change of clocks in either period does not make one longer. LEAST keeps them apart.
      SELECT b.*,
             LEAST(b.since, b.previous_since + make_interval(
               secs => extract(epoch FROM clock.now - b.since)::double precision)) AS previous_until
      FROM local_bounds AS b, clock
    ), replies AS MATERIALIZED (
      SELECT f.*, (f.created_at AT TIME ZONE ${timeZone}) AS local_at,
             f.created_at >= bounds.since AS is_current
      FROM (${firstReplies(workspaceId, sql`(SELECT previous_since FROM bounds)`)}) AS f, bounds
      WHERE f.created_at >= bounds.since OR f.created_at < bounds.previous_until
    ), started AS (
      SELECT * FROM replies WHERE is_current
    ), periods AS (
      SELECT is_current,
             json_build_object(
               'started', count(*)::int,
               'fast', count(*) FILTER (WHERE wait <= ${FAST_REPLY_SECONDS})::int,
               'median', percentile_cont(0.5) WITHIN GROUP (ORDER BY wait)) AS numbers
      FROM replies GROUP BY is_current
    )
    SELECT
      (SELECT numbers FROM periods WHERE is_current) AS current,
      (SELECT numbers FROM periods WHERE NOT is_current) AS previous,
      (SELECT count(*) FROM started WHERE status = 'closed')::int AS closed,
      (SELECT count(wait) FROM started)::int AS answered,
      (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY wait) FROM started) AS p90,
      (SELECT json_agg(json_build_object('date', to_char(g.day, 'YYYY-MM-DD'),
                                         'conversations', g.n) ORDER BY g.day)
         FROM (SELECT d.day, count(s.local_at)::int AS n
               FROM bounds, local_today,
                    generate_series(bounds.first_day, local_today.day, interval '1 day') AS d(day)
               LEFT JOIN started AS s ON s.local_at::date = d.day::date
               GROUP BY d.day) AS g) AS per_day,
      (SELECT coalesce(json_agg(json_build_object('operatorId', r.operator_id,
                                                  'apiKeyId', r.api_key_id,
                                                  'conversations', r.n)
                                ORDER BY r.n DESC, r.operator_id, r.api_key_id), '[]')
         FROM (SELECT operator_id, api_key_id, count(*)::int AS n FROM started
               WHERE wait IS NOT NULL GROUP BY operator_id, api_key_id) AS r) AS repliers,
      (SELECT coalesce(json_agg(json_build_object('dow', h.dow, 'hour', h.hour,
                                                  'conversations', h.n)), '[]')
         FROM (SELECT extract(isodow FROM local_at)::int AS dow,
                      extract(hour FROM local_at)::int AS hour, count(*)::int AS n
               FROM started GROUP BY 1, 2) AS h) AS hours`);
  const row = result.rows[0];
  if (row === undefined) throw new Error("The analytics query returned no row");
  const hours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const cell of row.hours) {
    const day = hours[cell.dow - 1];
    if (day !== undefined) day[cell.hour] = cell.conversations;
  }
  const current = periodNumbers(row.current);
  return {
    days,
    timeZone,
    started: current.started,
    closed: row.closed,
    answered: row.answered,
    firstReply: { ...current.firstReply, p90Seconds: row.p90 },
    previous: periodNumbers(row.previous),
    perDay: row.per_day,
    repliers: await nameRepliers(tx, workspaceId, row.repliers),
    hours,
  };
}

/** A time zone Postgres does not know, as its own tz database can lag Node's. */
function isUnknownZone(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === PG_INVALID_PARAMETER) return true;
  }
  return false;
}

export const UNKNOWN_ZONE = failure("invalid_request", "This server does not know that time zone.");

/** The numbers as the Analytics page shows them, or null when Postgres does not know the zone. */
export async function analyticsFor(
  db: Database,
  workspaceId: string,
  { days, tz }: z.output<typeof AnalyticsQuery>,
): Promise<AnalyticsResult | null> {
  try {
    return await withWorkspace(
      db,
      workspaceId,
      (tx) => readAnalytics(tx, workspaceId, { days, timeZone: tz, now: new Date() }),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  } catch (error) {
    if (!isUnknownZone(error)) throw error;
    return null;
  }
}

export function registerAnalyticsRoute(app: App, db: Database): void {
  app.openapi(analyticsRoute, async (c) => {
    const numbers = await analyticsFor(db, c.get("memberWorkspaceId"), c.req.valid("query"));
    if (numbers === null) return c.json(UNKNOWN_ZONE, 400);
    return c.json(numbers, 200);
  });
}
