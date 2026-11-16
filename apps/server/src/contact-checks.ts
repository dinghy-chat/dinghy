import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import {
  type CampaignRow,
  campaignRows,
  hasExited,
  inAudience,
  reachedContact,
} from "./campaign-checks.ts";
import { enterCampaign, frequencyBlocker } from "./campaign-entry.ts";
import { goalCondition } from "./campaign-schemas.ts";
import { matchesContact } from "./conditions.ts";
import { upsertContact } from "./contact-fields.ts";
import { campaign, campaignTrigger, outboundMessage } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { type ContactFields, toMs } from "./inputs.ts";
import { lockVisitors } from "./journey.ts";
import { lockWorkspace } from "./messages.ts";
import { appendVisitorMessage, recheckUnless } from "./outbound-delivery.ts";
import { cancelWhere, change, endable } from "./outbound-rules.ts";

// What a change to a contact sets off: scheduled messages whose `unless` now matches end, and each
// live campaign that reads a changed field checks the contact again for its exit, its goal and its
// `match` trigger. `campaign_trigger` holds the fields each campaign reads, so a change that no
// campaign reads costs one indexed read.

/** The field a campaign whose audience can change with time alone reads, beside its real ones. */
export const TIME_FIELD = "@time";

/** The fields a new conversation or a visitor's answer changes. */
const CHAT_FIELDS = ["hasChatted", "conversationCount", "repliedToCampaign"];

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
 * When a message reached the contact: when it became sent, or for a place in the control group,
 * when it would have.
 */
const reachedAt = sql`coalesce(${outboundMessage.sentAt}, case when ${outboundMessage.statusReason} = 'control_group' then ${outboundMessage.sendAt} end)`;

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
          reachedContact,
          sql`${reachedAt} > ${new Date(Date.now() - toMs(goal.within))}`,
          sql`${reachedAt} <= now()`,
        ),
      );
  if ((await counted()).length === 0) return false;
  const condition = goalCondition(goal);
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

/** Whether a cancel could end one of the messages that `which` names, read with no lock. */
async function hasEndable(tx: Transaction, workspaceId: string, which: SQL) {
  const found = await tx
    .select({ id: outboundMessage.id })
    .from(outboundMessage)
    .where(and(eq(outboundMessage.workspaceId, workspaceId), endable, which))
    .limit(1);
  return found.length > 0;
}

/** Whether the campaign takes the contact in now, read with no lock. */
async function entersNow(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  visitorId: string,
) {
  return (
    (await inAudience(tx, workspaceId, visitorId, found.definition)) &&
    (await frequencyBlocker(tx, workspaceId, found, visitorId)) === null
  );
}

/**
 * Checks the contact against one campaign: a goal, then an exit, ends their waiting messages from
 * it, and a `match` campaign takes them in when they match its audience. A goal counts even when
 * the same change makes them exit. `lock` takes the visitor's and the workspace's locks the first
 * time a write needs them, so a check that changes nothing, as most beats do, takes none.
 */
async function recheckCampaign(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  visitorId: string,
  lock: Lock,
) {
  const theirs = sql`${outboundMessage.campaignId} = ${found.id} and ${outboundMessage.visitorId} = ${visitorId}`;
  if (await markGoal(tx, workspaceId, found, visitorId, lock)) {
    await cancelWhere(tx, workspaceId, theirs, "goal_reached");
    return;
  }
  if (await hasExited(tx, workspaceId, visitorId, found)) {
    if (!(await hasEndable(tx, workspaceId, theirs))) return;
    await lock();
    await cancelWhere(tx, workspaceId, theirs, "unless_matched");
    return;
  }
  const { trigger } = found.definition;
  if (trigger.type !== "match" || !(await entersNow(tx, workspaceId, found, visitorId))) return;
  const { botsPaused } = await lock();
  await enterCampaign(tx, workspaceId, found, visitorId, {
    botsPaused,
    options: { delay: trigger.delay },
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

type Reply = Parameters<typeof appendVisitorMessage>;

/**
 * A visitor's message, from the widget, an upload or an email, with the checks of the campaigns
 * that read their chat, such as a goal of `repliedToCampaign`. Their lock comes first, as the
 * checks' writes take it before the workspace's.
 */
export async function appendVisitorReply(
  tx: Transaction,
  workspaceId: string,
  author: Reply[2],
  input: Reply[3],
  answering?: Reply[4],
  limits?: Reply[5],
) {
  await lockVisitors(tx, workspaceId, [author.visitorId]);
  const appended = await appendVisitorMessage(tx, workspaceId, author, input, answering, limits);
  if (appended.created) await recheckCampaigns(tx, workspaceId, author.visitorId, CHAT_FIELDS);
  return appended;
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
