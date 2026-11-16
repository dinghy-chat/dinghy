import { and, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { campaignDay, type OutboundEventKind, type outboundMessage } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";

// A campaign's results per day and variant, in campaign_day, which outlives the pruning of message
// bodies. Each change of a campaign's message adds to it in the same transaction. Test visitors
// are left out.

type Row = typeof outboundMessage.$inferSelect;

/** Each count, by its column in campaign_day. */
const COUNTS = {
  entered: campaignDay.entered,
  sent: campaignDay.sent,
  delivered: campaignDay.delivered,
  read: campaignDay.read,
  replied: campaignDay.replied,
  dismissed: campaignDay.dismissed,
  goalReached: campaignDay.goalReached,
  conversationsStarted: campaignDay.conversationsStarted,
} as const;
export type Count = keyof typeof COUNTS;

/** The counts a message's first time in each of these columns adds. */
const TIMES: [keyof Row & `${string}At`, Count][] = [
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
  counts: Count[],
  click?: string,
): Promise<void> {
  if (counts.length === 0 && click === undefined) return;
  const ones = counts.map(() => sql`1`);
  const clicks =
    click === undefined ? sql`'{}'::jsonb` : sql`jsonb_build_object(${click}::text, 1)`;
  const added = counts.map(
    (count) =>
      sql`${sql.identifier(COUNTS[count].name)} = campaign_day.${sql.identifier(COUNTS[count].name)} + 1`,
  );
  if (click !== undefined) {
    added.push(sql`clicks = jsonb_set(campaign_day.clicks, array[${click}::text],
      to_jsonb(coalesce((campaign_day.clicks ->> ${click}::text)::int, 0) + 1))`);
  }
  const columns = counts.map((count) => sql.identifier(COUNTS[count].name));
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

export const emptyCounts = () => ({
  entered: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  dismissed: 0,
  goalReached: 0,
  conversationsStarted: 0,
  clicks: {} as Record<string, number>,
});
type Counts = ReturnType<typeof emptyCounts>;
type DayRow = typeof campaignDay.$inferSelect;

/** Adds one day's row to a running total. */
function addTo(total: Counts, row: DayRow): Counts {
  for (const count of Object.keys(COUNTS) as Count[]) total[count] += row[count];
  for (const [value, clicks] of Object.entries(row.clicks)) {
    total.clicks[value] = (total.clicks[value] ?? 0) + clicks;
  }
  return total;
}

const countsOf = (row: DayRow) => addTo(emptyCounts(), row);
const variantOf = (row: Pick<DayRow, "variant">) => (row.variant === "" ? null : row.variant);

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
    variants.set(row.variant, addTo(variants.get(row.variant) ?? emptyCounts(), row));
  return {
    days: rows.map((row) => ({ day: row.day, variant: variantOf(row), ...countsOf(row) })),
    variants: [...variants].map(([variant, counts]) => ({
      variant: variantOf({ variant }),
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
  for (const row of rows) addTo(totals.get(row.campaignId) ?? emptyCounts(), row);
  return totals;
}
