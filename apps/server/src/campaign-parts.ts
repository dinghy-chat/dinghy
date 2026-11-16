import type { CampaignDefinition } from "./campaign-schemas.ts";

// The parts of a campaign's definition and results that the server and the operator app both
// read. Nothing here imports a value, so the operator app's bundle stays free of the server's.

type Variant = NonNullable<CampaignDefinition["variants"]>[number];
type Goal = NonNullable<CampaignDefinition["rules"]["goal"]>;

/** A variant's own message, or undefined for one that uses the campaign's or gets none. */
export const variantMessage = (variant: Variant | null) =>
  variant !== null && "message" in variant ? variant.message : undefined;

/** Every message of the campaign: its own, then each variant's own. */
export const messagesOf = (definition: Pick<CampaignDefinition, "message" | "variants">) => [
  definition.message,
  ...(definition.variants ?? []).flatMap((one) => variantMessage(one) ?? []),
];

/** A goal's condition, without the time it has. */
export const goalCondition = ({ within: _, ...condition }: Goal) => condition;

/** Whether the campaign's messages may go by email: always, or once unread for a time. */
export const sendsEmail = (delivery: CampaignDefinition["delivery"]) =>
  delivery.sendEmail || delivery.emailIfUnread !== undefined;

/** A campaign's counts, in the order a message goes through them. */
export const CAMPAIGN_COUNTS = [
  "entered",
  "sent",
  "delivered",
  "read",
  "replied",
  "dismissed",
  "goalReached",
  "conversationsStarted",
] as const;
export type CampaignCount = (typeof CAMPAIGN_COUNTS)[number];
/** Each count, and the clicks by the button's value. */
export type Counts = Record<CampaignCount, number> & { clicks: Record<string, number> };

export const emptyCounts = (): Counts => ({
  ...(Object.fromEntries(CAMPAIGN_COUNTS.map((count) => [count, 0])) as Record<
    CampaignCount,
    number
  >),
  clicks: {},
});

/** Adds a row's counts to a running total, clicks by value too. */
export function addCounts(total: Counts, row: Counts): Counts {
  for (const count of CAMPAIGN_COUNTS) total[count] += row[count];
  for (const [value, clicks] of Object.entries(row.clicks)) {
    total.clicks[value] = (total.clicks[value] ?? 0) + clicks;
  }
  return total;
}
