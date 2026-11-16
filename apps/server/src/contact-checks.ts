import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  type CampaignRow,
  campaignRows,
  hasExited,
  inAudience,
  reachedContact,
} from "./campaign-checks.ts";
import { enterCampaign } from "./campaign-entry.ts";
import { matchesContact } from "./conditions.ts";
import { upsertContact } from "./contact-fields.ts";
import { campaign, campaignTrigger, outboundMessage } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { type ContactFields, toMs } from "./inputs.ts";
import { lockVisitors } from "./journey.ts";
import { lockWorkspace } from "./messages.ts";
import { recheckUnless } from "./outbound-delivery.ts";
import { cancelWhere, change } from "./outbound-rules.ts";

// What a change to a contact sets off: scheduled messages whose `unless` now matches end, and each
// live campaign that reads a changed field checks the contact again for its exit, its goal and its
// `match` trigger. `campaign_trigger` holds the fields each campaign reads, so a change that no
// campaign reads costs one indexed read.

/** The field a campaign whose audience can change with time alone reads, beside its real ones. */
export const TIME_FIELD = "@time";

/** The fields a new conversation or a visitor's answer changes. */
export const CHAT_FIELDS = ["hasChatted", "conversationCount", "repliedToCampaign"];

/**
 * The fields the widget's beat may change, each minute while a page is open, with time itself, so
 * a campaign whose audience changes with time alone is checked when its message can show.
 */
export const BEAT_FIELDS = [TIME_FIELD, "country", "timeZone", "lastSeenAt"];

/** The live campaigns that read one of these fields, or every live one for a new contact. */
function campaignsReading(tx: Transaction, workspaceId: string, fields: string[] | "all") {
  const live = eq(campaign.status, "live");
  if (fields === "all") return campaignRows(tx, workspaceId, live);
  const reads = tx
    .select({ id: campaignTrigger.campaignId })
    .from(campaignTrigger)
    .where(
      and(eq(campaignTrigger.workspaceId, workspaceId), inArray(campaignTrigger.field, fields)),
    );
  return campaignRows(tx, workspaceId, and(live, inArray(campaign.id, reads)));
}

type Lock = () => Promise<{ botsPaused: boolean }>;

/**
 * Records the goal on the campaign's messages that reached the contact within the goal's time, when
 * the contact matches it now. True when it counted one.
 */
async function markGoal(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  visitorId: string,
  lock: Lock,
): Promise<boolean> {
  const { goal } = found.definition.rules;
  if (goal === undefined) return false;
  const counted = () =>
    tx
      .select()
      .from(outboundMessage)
      .where(
        and(
          eq(outboundMessage.workspaceId, workspaceId),
          eq(outboundMessage.campaignId, found.id),
          eq(outboundMessage.visitorId, visitorId),
          isNull(outboundMessage.goalReachedAt),
          gt(outboundMessage.createdAt, new Date(Date.now() - toMs(goal.within))),
          reachedContact,
        ),
      );
  const { within: _, ...condition } = goal;
  if ((await counted()).length === 0) return false;
  if (!(await matchesContact(tx, workspaceId, visitorId, condition, { campaignId: found.id }))) {
    return false;
  }
  await lock();
  // Read again under the lock, so a change that committed meanwhile is seen.
  for (const row of await counted()) {
    await change(tx, workspaceId, row, { goalReachedAt: new Date() });
  }
  return true;
}

/**
 * Checks the contact against one campaign: an exit or a goal ends their waiting messages from it,
 * and a `match` campaign takes them in when they match its audience. `lock` takes the visitor's and
 * the workspace's locks the first time a write needs them, so a check that changes nothing takes
 * none.
 */
async function recheckCampaign(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  visitorId: string,
  lock: Lock,
) {
  const theirs = sql`${outboundMessage.campaignId} = ${found.id} and ${outboundMessage.visitorId} = ${visitorId}`;
  if (await hasExited(tx, workspaceId, visitorId, found)) {
    await lock();
    await cancelWhere(tx, workspaceId, theirs, "unless_matched");
    return;
  }
  if (await markGoal(tx, workspaceId, found, visitorId, lock)) {
    await cancelWhere(tx, workspaceId, theirs, "goal_reached");
    return;
  }
  const { trigger } = found.definition;
  if (trigger.type !== "match" || !(await inAudience(tx, workspaceId, visitorId, found.definition)))
    return;
  const { botsPaused } = await lock();
  await enterCampaign(tx, workspaceId, found, visitorId, {
    botsPaused,
    input: { delay: trigger.delay },
  });
}

/** Checks the contact again against each live campaign that reads one of the fields. */
export async function recheckCampaigns(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  fields: string[] | "all",
): Promise<void> {
  const found = await campaignsReading(tx, workspaceId, fields);
  let locked: ReturnType<Lock> | undefined;
  // The visitor's lock before the workspace's, as every write takes them.
  const lock = () => {
    locked ??= lockVisitors(tx, workspaceId, [visitorId]).then(() =>
      lockWorkspace(tx, workspaceId),
    );
    return locked;
  };
  for (const one of found) await recheckCampaign(tx, workspaceId, one, visitorId, lock);
}

/** A contact's fields changed: its `unless` messages, then its campaigns. */
export async function contactChanged(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  fields: string[] | "all",
): Promise<void> {
  await recheckUnless(tx, workspaceId, visitorId);
  await recheckCampaigns(tx, workspaceId, visitorId, fields);
}

/**
 * The contact upsert, at `at` in milliseconds, which also checks the person again when a value
 * changed: a new contact against every live campaign.
 */
export async function upsertContactAndRecheck(
  tx: Transaction,
  workspaceId: string,
  userId: string,
  fields: ContactFields,
  at: number,
) {
  const upserted = await upsertContact(tx, workspaceId, userId, fields, at);
  const changed = upserted.created ? "all" : upserted.changed;
  if (changed.length > 0) await contactChanged(tx, workspaceId, upserted.visitorId, changed);
  return upserted;
}
