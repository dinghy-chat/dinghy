import { createRoute, z } from "@hono/zod-openapi";
import { type SQL, sql } from "drizzle-orm";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { failure, INVALID, MEMBER_ERRORS } from "./errors.ts";
import { WORKSPACE_PREFIX as PREFIX } from "./member.ts";
import { authorNames, isChat } from "./messages.ts";

/** A replier's operator or key, in the shape `authorNames` reads. */
const replierIds = (one: { operatorId: string | null; apiKeyId: string | null }) => ({
  authorOperatorId: one.operatorId,
  authorApiKeyId: one.apiKeyId,
});

// Support numbers from the conversations and messages already stored. Nothing here tracks anyone.

const PERIODS = [7, 30, 90] as const;
const FAST_REPLY_SECONDS = 5 * 60;

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
    firstReply: z.object({
      // Seconds from the start of a conversation to its first operator reply. Null with no reply.
      medianSeconds: z.number().nullable(),
      p90Seconds: z.number().nullable(),
      // The share of started conversations answered within 5 minutes, from 0 to 1. Null with none.
      within5Minutes: z.number().nullable(),
    }),
    // One entry per day of the period, oldest first, in the given time zone.
    perDay: z.array(z.object({ date: z.string(), conversations: z.number().int() })),
    // By who sent the first reply, most first: an operator, or an API key.
    operators: z.array(
      z.object({
        operatorId: z.string().nullable(),
        apiKeyId: z.string().nullable(),
        name: z.string().nullable(),
        conversations: z.number().int(),
      }),
    ),
    // Conversations started, by weekday (Monday first) and hour, in the given time zone.
    hours: z.array(z.array(z.number().int()).length(24)).length(7),
  })
  .openapi("Analytics");

export type AnalyticsResult = z.infer<typeof Analytics>;

const analyticsRoute = createRoute({
  method: "get",
  path: `${PREFIX}/{workspaceId}/analytics`,
  security: SESSION,
  summary: "Support numbers for the last 7, 30 or 90 days",
  description:
    "Computed from the stored conversations and messages, for any member. A period runs from the start of the day, `days - 1` days ago, in `tz`, to now. Every number is about the conversations that started in it: a conversation's first reply time runs from its start to its first reply from an operator or an API key, and `operators` counts conversations by who sent that reply. A welcome chat on Dinghy Cloud counts nowhere.",
  request: {
    params: z.object({ workspaceId: z.uuid() }),
    query: z.object({
      days: z.coerce
        .number()
        .int()
        .refine((days) => (PERIODS as readonly number[]).includes(days), "7, 30 or 90")
        .default(30),
      tz: z.string().refine(isTimeZone, "an IANA time zone, such as Europe/Paris").default("UTC"),
    }),
  },
  responses: {
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
            firstReply: { medianSeconds: 140, p90Seconds: 1260, within5Minutes: 0.67 },
            perDay: [{ date: "2026-11-02", conversations: 3 }],
            operators: [
              {
                operatorId: "7a3e5b20-9c1d-4f6a-b8e2-4d0f1c9a6b53",
                apiKeyId: null,
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

interface Row extends Record<string, unknown> {
  started: number;
  closed: number;
  answered: number;
  fast: number;
  median: number | null;
  p90: number | null;
  per_day: { date: string; conversations: number }[];
  repliers: { operatorId: string | null; apiKeyId: string | null; conversations: number }[];
  hours: { dow: number; hour: number; conversations: number }[];
}

/**
 * Each conversation started since `since`, with its first reply: how long it waited, in seconds,
 * and who sent it. A conversation with no reply yet has a null wait. The welcome chat is not one.
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
  WHERE c.workspace_id = ${workspaceId} AND c.created_at >= ${since} AND NOT c.welcome`;

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

/** One statement, so every number reads the same rows. */
async function readAnalytics(
  tx: Transaction,
  workspaceId: string,
  days: number,
  timeZone: string,
): Promise<AnalyticsResult> {
  const result = await tx.execute<Row>(sql`
    WITH local_today AS (
      SELECT (now() AT TIME ZONE ${timeZone})::date AS day
    ), bounds AS (
      SELECT day - ${days - 1}::int AS first_day,
             ((day - ${days - 1}::int)::timestamp AT TIME ZONE ${timeZone}) AS since
      FROM local_today
    ), started AS MATERIALIZED (
      SELECT f.*, (f.created_at AT TIME ZONE ${timeZone}) AS local_at
      FROM (${firstReplies(workspaceId, sql`(SELECT since FROM bounds)`)}) AS f
    )
    SELECT
      (SELECT count(*) FROM started)::int AS started,
      (SELECT count(*) FROM started WHERE status = 'closed')::int AS closed,
      (SELECT count(wait) FROM started)::int AS answered,
      (SELECT count(*) FROM started WHERE wait <= ${FAST_REPLY_SECONDS})::int AS fast,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY wait) FROM started) AS median,
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
  const names = await authorNames(tx, workspaceId, row.repliers.map(replierIds));
  const hours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const cell of row.hours) {
    const day = hours[cell.dow - 1];
    if (day !== undefined) day[cell.hour] = cell.conversations;
  }
  return {
    days,
    timeZone,
    started: row.started,
    closed: row.closed,
    answered: row.answered,
    firstReply: {
      medianSeconds: row.median,
      p90Seconds: row.p90,
      within5Minutes: row.started === 0 ? null : row.fast / row.started,
    },
    perDay: row.per_day,
    operators: row.repliers.map((one) => ({
      ...one,
      name: names.get(one.operatorId ?? one.apiKeyId ?? "") ?? null,
    })),
    hours,
  };
}

/** Postgres's code for a time zone it does not know, as its own tz database can lag Node's. */
function isUnknownZone(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === "22023") return true;
  }
  return false;
}

export function registerAnalyticsRoute(app: App, db: Database): void {
  app.openapi(analyticsRoute, async (c) => {
    const id = c.get("memberWorkspaceId");
    const { days, tz } = c.req.valid("query");
    try {
      const numbers = await withWorkspace(db, id, (tx) => readAnalytics(tx, id, days, tz), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
      return c.json(numbers, 200);
    } catch (error) {
      if (!isUnknownZone(error)) throw error;
      return c.json(failure("invalid_request", "This server does not know that time zone."), 400);
    }
  });
}
