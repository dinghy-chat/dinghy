import { and, desc, eq, gt, isNotNull, ne, or, type SQL, sql } from "drizzle-orm";
import { type HoursState, hoursState } from "../../../packages/widget/src/hours.ts";
import { type BusinessHours, WEEKDAYS } from "../../../packages/widget/src/shared.ts";
import { readBusinessHours } from "./business-hours.ts";
import { goalCondition } from "./campaign-parts.ts";
import type { CampaignDefinition } from "./campaign-schemas.ts";
import { matchesContact, toSql } from "./conditions.ts";
import {
  type CampaignStatus,
  campaign,
  type OutboundStatusReason,
  outboundMessage,
  visitor,
  workspace,
} from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { HOUR_MS } from "./time.ts";

// What a campaign says about one of its messages when it is about to become sent: its status, the
// contact's audience, exit and goal, the hours it may go in, and the workspace's gap between two
// campaign messages. The decision in outbound-rules.ts reads it.

/**
 * A time window that keeps a message waiting, and when it opens. Undefined when that is not known,
 * such as a week with no open hours, so the worker looks again soon rather than never.
 */
interface Closed {
  reason: Extract<OutboundStatusReason, "outside_business_hours" | "outside_send_window">;
  until: Date | undefined;
}

export interface CampaignCheck {
  /** The campaign's status, or `paused` while the workspace paused every campaign. */
  status: CampaignStatus;
  exited: boolean;
  goalReached: boolean;
  audienceMatched: boolean;
  closed: Closed | null;
  /** Another campaign message reached the visitor within the workspace's gap. */
  capped: boolean;
  /** How long an `on_reply` message stays unread before it goes by email, as written. */
  emailIfUnread: string | null;
}

/** Campaigns' rows that match `which`, each with the workspace's settings for every campaign. */
export function campaignRows(tx: Transaction, workspaceId: string, which: SQL | undefined) {
  return tx
    .select({
      id: campaign.id,
      status: campaign.status,
      definition: campaign.definition,
      authorOperatorId: campaign.authorOperatorId,
      authorApiKeyId: campaign.authorApiKeyId,
      allPaused: sql<boolean>`${workspace.campaignsPausedAt} is not null`,
      gapHours: workspace.campaignGapHours,
    })
    .from(campaign)
    .innerJoin(workspace, eq(workspace.id, campaign.workspaceId))
    .where(and(eq(campaign.workspaceId, workspaceId), which))
    .orderBy(campaign.createdAt);
}
export type CampaignRow = Awaited<ReturnType<typeof campaignRows>>[number];

/** The one campaign that `which` names, with the workspace's settings. */
export const campaignRow = async (tx: Transaction, workspaceId: string, which: SQL) =>
  (await campaignRows(tx, workspaceId, which))[0];

/** The campaigns whose trigger is of this type. */
export const triggerIs = (type: CampaignDefinition["trigger"]["type"]) =>
  sql`${campaign.definition} #>> '{trigger,type}' = ${type}`;

/** A message that reached its contact for the campaign's sake: not cancelled, or a control's place. */
export const reachedContact = or(
  ne(outboundMessage.status, "cancelled"),
  eq(outboundMessage.statusReason, "control_group"),
);

/** A week open every day between two times, which may cross midnight. */
function everyDay(from: string, to: string, timeZone: string): BusinessHours {
  const ranges: [string, string][] =
    from < to
      ? [[from, to]]
      : [
          ["00:00", to],
          [from, "24:00"],
        ];
  return {
    timeZone,
    week: Object.fromEntries(WEEKDAYS.map((day) => [day, ranges])) as BusinessHours["week"],
  };
}

const closedUntil = (state: HoursState) =>
  state.open ? undefined : (state.reopensAt ?? undefined);

/**
 * The window that keeps a message to the visitor waiting now, or null when it may go. With no
 * visitor, the send window reads the team's clock.
 */
export async function closedNow(
  tx: Transaction,
  workspaceId: string,
  visitorId: string | null,
  rules: CampaignDefinition["rules"],
): Promise<Closed | null> {
  const now = Date.now();
  const hours = rules.businessHours ? await readBusinessHours(tx, workspaceId) : undefined;
  if (hours?.enabled === true) {
    const state = hoursState(hours, now);
    if (!state.open) return { reason: "outside_business_hours", until: closedUntil(state) };
  }
  if (rules.sendWindow === undefined) return null;
  const [who] =
    visitorId === null
      ? []
      : await tx
          .select({ timeZone: visitor.timeZone })
          .from(visitor)
          .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  // A visitor whose clock is not known yet goes by the team's, or by UTC.
  const zone = who?.timeZone ?? hours?.timeZone ?? "UTC";
  const state = hoursState(everyDay(rules.sendWindow.from, rules.sendWindow.to, zone), now);
  return state.open ? null : { reason: "outside_send_window", until: closedUntil(state) };
}

/** Whether another campaign message became sent to this visitor within the gap. */
async function withinGap(
  tx: Transaction,
  workspaceId: string,
  { id, visitorId }: { id: string | null; visitorId: string },
  gapHours: number,
) {
  if (gapHours === 0) return false;
  const found = await tx
    .select({ id: outboundMessage.id })
    .from(outboundMessage)
    .where(
      and(
        eq(outboundMessage.workspaceId, workspaceId),
        eq(outboundMessage.visitorId, visitorId),
        isNotNull(outboundMessage.campaignId),
        gt(outboundMessage.sentAt, new Date(Date.now() - gapHours * HOUR_MS)),
        id === null ? undefined : ne(outboundMessage.id, id),
      ),
    )
    .limit(1);
  return found.length > 0;
}

/** The ID of the campaign's newest message to the contact that `which` names, or null. */
export async function newestMessage(
  tx: Transaction,
  workspaceId: string,
  { campaignId, visitorId }: { campaignId: string; visitorId: string },
  which: SQL | undefined,
): Promise<string | null> {
  const [found] = await tx
    .select({ id: outboundMessage.id })
    .from(outboundMessage)
    .where(
      and(
        eq(outboundMessage.workspaceId, workspaceId),
        eq(outboundMessage.campaignId, campaignId),
        eq(outboundMessage.visitorId, visitorId),
        which,
      ),
    )
    .orderBy(desc(outboundMessage.createdAt))
    .limit(1);
  return found?.id ?? null;
}

/** Whether the contact reached the campaign's goal: it matches now, or one message counted it. */
async function reachedGoal(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  found: Pick<CampaignRow, "id" | "definition">,
) {
  const { goal } = found.definition.rules;
  if (goal === undefined) return false;
  const counted = await newestMessage(
    tx,
    workspaceId,
    { campaignId: found.id, visitorId },
    isNotNull(outboundMessage.goalReachedAt),
  );
  return (
    counted !== null ||
    (await matchesContact(tx, workspaceId, visitorId, goalCondition(goal), {
      campaignId: found.id,
    }))
  );
}

/** Whether the contact matches the campaign's audience. */
export async function inAudience(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  { audience }: CampaignDefinition,
) {
  return audience === undefined || matchesContact(tx, workspaceId, visitorId, audience);
}

/** Whether the contact matches each campaign's audience, in one read, as `inAudience` decides. */
export async function audiencesMatched(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  definitions: CampaignDefinition[],
): Promise<boolean[]> {
  if (definitions.length === 0) return [];
  const each = definitions.map(({ audience }) =>
    audience === undefined ? sql`true` : toSql(audience),
  );
  const [row] = await tx
    .select({ matched: sql<(boolean | null)[]>`array[${sql.join(each, sql`, `)}]` })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  return definitions.map((_, index) => row?.matched[index] === true);
}

/** Whether the contact matches the campaign's exit condition. */
export async function hasExited(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  found: Pick<CampaignRow, "id" | "definition">,
) {
  const { exitWhen } = found.definition.rules;
  return (
    exitWhen !== undefined &&
    matchesContact(tx, workspaceId, visitorId, exitWhen, { campaignId: found.id })
  );
}

/**
 * A campaign's message as its checks read it: a row, or a page campaign's card, which has none, for
 * a visitor who may not exist yet. A send from code skips the audience.
 */
export interface CampaignDraft {
  id: string | null;
  visitorId: string | null;
  campaignId: string;
  fromCode: boolean;
}

/**
 * What the message's campaign says now, read again unless the caller passes the row it read. The
 * caller holds the workspace lock.
 */
export async function campaignCheck(
  tx: Transaction,
  workspaceId: string,
  draft: CampaignDraft,
  read: CampaignRow | undefined,
): Promise<CampaignCheck> {
  const found = read ?? (await campaignRow(tx, workspaceId, eq(campaign.id, draft.campaignId)));
  if (found === undefined) throw new Error("The message's campaign is missing");
  const { definition, allPaused, gapHours } = found;
  const { id, visitorId } = draft;
  const status = allPaused && found.status === "live" ? "paused" : found.status;
  const closed = await closedNow(tx, workspaceId, visitorId, definition.rules);
  const emailIfUnread = definition.delivery.emailIfUnread ?? null;
  // A visitor who does not exist yet matches only an audience of everyone, and nothing else.
  if (visitorId === null) {
    const audienceMatched = draft.fromCode || definition.audience === undefined;
    return {
      status,
      exited: false,
      goalReached: false,
      audienceMatched,
      closed,
      capped: false,
      emailIfUnread,
    };
  }
  return {
    status,
    exited: await hasExited(tx, workspaceId, visitorId, found),
    goalReached: await reachedGoal(tx, workspaceId, visitorId, found),
    audienceMatched: draft.fromCode || (await inAudience(tx, workspaceId, visitorId, definition)),
    closed,
    capped: await withinGap(tx, workspaceId, { id, visitorId }, gapHours),
    emailIfUnread,
  };
}
