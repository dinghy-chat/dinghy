import { and, eq, gt, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { addCounts, type CampaignCount, type Counts, emptyCounts } from "./campaign-parts.ts";
import { campaignDay, type OutboundEventKind, type outboundMessage } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";

// A campaign's results per day and variant, in campaign_day, which outlives the pruning of message
// bodies. Each change of a campaign's message adds to it in the same transaction. Test visitors
// are left out.

type Row = typeof outboundMessage.$inferSelect;

/** The counts a message's first time in each of these columns adds. */
const TIMES: [keyof Row & `${string}At`, CampaignCount][] = [
  ["sentAt", "sent"],
  ["deliveredAt", "delivered"],
  ["readAt", "read"],
  ["repliedAt", "replied"],
  ["dismissedAt", "dismissed"],
  ["goalReachedAt", "goalReached"],
];

/** The events that carry the button the visitor chose, which counts as a click. */
const CLICK_KINDS: readonly OutboundEventKind[] = [
  "outbound_message.clicked",
  "outbound_message.replied",
  "outbound_message.dismissed",
];

interface Tally {
  campaignId: string;
  variant: string | null;
  /** The contact, whose test flag leaves them out. Null for a page campaign's card, which has none. */
  visitorId: string | null;
}

/** Adds one to each count, and to a button's clicks, on today's row in UTC. */
export async function tally(
  tx: Transaction,
  workspaceId: string,
  { campaignId, variant, visitorId }: Tally,
  counts: CampaignCount[],
  click?: string,
): Promise<void> {
  if (counts.length === 0 && click === undefined) return;
  const ones = counts.map(() => sql`1`);
  const clicks =
    click === undefined ? sql`'{}'::jsonb` : sql`jsonb_build_object(${click}::text, 1)`;
  const added = counts.map(
    (count) =>
      sql`${sql.identifier(campaignDay[count].name)} = campaign_day.${sql.identifier(campaignDay[count].name)} + 1`,
  );
  if (click !== undefined) {
    added.push(sql`clicks = jsonb_set(campaign_day.clicks, array[${click}::text],
      to_jsonb(coalesce((campaign_day.clicks ->> ${click}::text)::int, 0) + 1))`);
  }
  const columns = counts.map((count) => sql.identifier(campaignDay[count].name));
  const notTest: SQL =
    visitorId === null
      ? sql`true`
      : sql`not exists (select 1 from visitor where workspace_id = ${workspaceId}
          and id = ${visitorId} and is_test)`;
  await tx.execute(sql`
    INSERT INTO campaign_day (workspace_id, campaign_id, day, variant, clicks
      ${columns.length === 0 ? sql`` : sql`, ${sql.join(columns, sql`, `)}`})
    SELECT ${workspaceId}, ${campaignId}, (now() at time zone 'UTC')::date, ${variant ?? ""},
      ${clicks} ${ones.length === 0 ? sql`` : sql`, ${sql.join(ones, sql`, `)}`}
    WHERE ${notTest}
    ON CONFLICT (workspace_id, campaign_id, day, variant)
    DO UPDATE SET ${sql.join(added, sql`, `)}`);
}

/** What a change of a campaign's message adds to its results. */
export async function tallyChange(
  tx: Transaction,
  workspaceId: string,
  before: Row,
  after: Row,
  kind: OutboundEventKind | undefined,
): Promise<void> {
  if (after.campaignId === null) return;
  const counts = TIMES.filter(([time]) => before[time] === null && after[time] !== null).map(
    ([, count]) => count,
  );
  const value = after.chosenButton?.value;
  const click =
    kind !== undefined && CLICK_KINDS.includes(kind) && value != null ? value : undefined;
  await tally(tx, workspaceId, { ...after, campaignId: after.campaignId }, counts, click);
}

type DayRow = typeof campaignDay.$inferSelect;

const countsOf = (row: DayRow) => addCounts(emptyCounts(), row);
/** A day's variant as the API names it: null for a campaign with no variants. */
const variantKey = (row: Pick<DayRow, "variant">) => (row.variant === "" ? null : row.variant);

/** A campaign's results per day and variant, and per variant over the days, oldest first. */
export async function campaignResults(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  range: { from?: string | undefined; to?: string | undefined },
) {
  const rows = await tx
    .select()
    .from(campaignDay)
    .where(
      and(
        eq(campaignDay.workspaceId, workspaceId),
        eq(campaignDay.campaignId, campaignId),
        range.from === undefined ? undefined : gte(campaignDay.day, range.from),
        range.to === undefined ? undefined : lte(campaignDay.day, range.to),
      ),
    )
    .orderBy(campaignDay.day, campaignDay.variant);
  const variants = new Map<string, Counts>();
  for (const row of rows)
    variants.set(row.variant, addCounts(variants.get(row.variant) ?? emptyCounts(), row));
  return {
    days: rows.map((row) => ({ day: row.day, variant: variantKey(row), ...countsOf(row) })),
    variants: [...variants].map(([variant, counts]) => ({
      variant: variantKey({ variant }),
      ...counts,
    })),
  };
}

/** Each campaign's results since it started, all variants together, in one query. */
export async function campaignTotals(tx: Transaction, workspaceId: string, campaignIds: string[]) {
  const totals = new Map(campaignIds.map((id) => [id, emptyCounts()]));
  if (campaignIds.length === 0) return totals;
  const rows = await tx
    .select()
    .from(campaignDay)
    .where(
      and(eq(campaignDay.workspaceId, workspaceId), inArray(campaignDay.campaignId, campaignIds)),
    );
  for (const row of rows) addCounts(totals.get(row.campaignId) ?? emptyCounts(), row);
  return totals;
}

/** The days "last week" covers, today in UTC included. */
const WEEK_DAYS = 7;

/** The messages every campaign sent in the last 7 days, in one query. */
export async function sentLastWeek(tx: Transaction, workspaceId: string): Promise<number> {
  const [row] = await tx
    .select({ sent: sql<number>`coalesce(sum(${campaignDay.sent}), 0)::int` })
    .from(campaignDay)
    .where(
      and(
        eq(campaignDay.workspaceId, workspaceId),
        sql`${campaignDay.day} > (now() at time zone 'UTC')::date - ${WEEK_DAYS}::int`,
      ),
    );
  return row?.sent ?? 0;
}

/** Whether the campaign sent a message to anyone but a test visitor. */
export async function hasSent(tx: Transaction, workspaceId: string, campaignId: string) {
  const [row] = await tx
    .select({ one: sql`1` })
    .from(campaignDay)
    .where(
      and(
        eq(campaignDay.workspaceId, workspaceId),
        eq(campaignDay.campaignId, campaignId),
        gt(campaignDay.sent, 0),
      ),
    )
    .limit(1);
  return row !== undefined;
}
