import { type AnyColumn, and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { zonedDay, zonedTime } from "../../../packages/widget/src/hours.ts";
import { WEEKDAYS } from "../../../packages/widget/src/shared.ts";
import { type CampaignRow, campaignRow, triggerIs } from "./campaign-checks.ts";
import { enterCampaign } from "./campaign-entry.ts";
import type { CampaignTrigger } from "./campaign-schemas.ts";
import { toSql } from "./conditions.ts";
import { TIME_FIELD } from "./contact-checks.ts";
import { campaign, campaignRun, campaignTrigger, visitor } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { lockForSend } from "./journey.ts";
import type { Signals } from "./live.ts";
import { tellOutbound } from "./outbound.ts";
import { DAY_MS } from "./time.ts";

// A campaign's pass over its audience: each occurrence of a schedule, and once a day for a `match`
// campaign that emails and whose audience changes with time alone. A run goes in visitor ID order,
// and each batch commits its messages and its cursor together, while `(run, visitor)` is unique on
// outbound_message, so a crash resumes with no double and no gap.

type Schedule = Extract<CampaignTrigger, { type: "schedule" }>;

/** How far back the newest occurrence may be: a monthly schedule's longest month. */
const LOOK_BACK_DAYS = 31;
/** Contacts per batch, so one batch keeps the workspace lock briefly. */
const RUN_BATCH = 50;

/** Whether a schedule runs on this day of its zone's clock. */
function runsOn(trigger: Schedule, day: string): boolean {
  if (day < trigger.startDate || (trigger.endDate !== undefined && day > trigger.endDate)) {
    return false;
  }
  if (trigger.repeat === "daily") return true;
  if (trigger.repeat === "monthly") return day.slice(8) === trigger.startDate.slice(8);
  // `YYYY-MM-DD` at noon UTC names the same weekday as the date.
  const weekday = WEEKDAYS[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7];
  return weekday !== undefined && (trigger.days ?? []).includes(weekday);
}

/**
 * A workspace that has not paused every campaign, as the worker's role may ask: it may not read the
 * workspace rows of the others.
 */
const notPaused = (workspaceId: AnyColumn) =>
  sql`${workspaceId} not in (select workspace_id from workspaces_with_paused_campaigns())`;

/** The schedule's newest occurrence at or before `now`, or null. */
export function latestOccurrence(trigger: Schedule, now: number): Date | null {
  if (trigger.repeat === "once") {
    const at = zonedTime(trigger.startDate, trigger.time, trigger.timeZone);
    return at === null || at > now ? null : new Date(at);
  }
  for (let back = 0; back <= LOOK_BACK_DAYS; back += 1) {
    const day = zonedDay(now - back * DAY_MS, trigger.timeZone);
    const at = runsOn(trigger, day) ? zonedTime(day, trigger.time, trigger.timeZone) : null;
    if (at !== null && at <= now) return new Date(at);
  }
  return null;
}

/** The occurrence a live campaign should have a run for now, or null. */
function dueOccurrence(trigger: CampaignTrigger, liveAt: Date | null, now: number): Date | null {
  if (trigger.type === "match") return new Date(now - (now % DAY_MS));
  if (trigger.type !== "schedule") return null;
  const at = latestOccurrence(trigger, now);
  // An occurrence from before the campaign went live, or while it was paused, is skipped.
  return at === null || liveAt === null || at < liveAt ? null : at;
}

/**
 * Creates the run of each live schedule's newest occurrence, and today's run of each `match`
 * campaign that emails and whose audience changes with time alone. The worker's role finds them
 * across workspaces, and the app's role writes them. A run that exists already stays.
 */
export async function openRuns(finder: Database, writer: Database): Promise<void> {
  const readsTime = finder
    .select({ id: campaignTrigger.campaignId })
    .from(campaignTrigger)
    .where(
      and(
        eq(campaignTrigger.workspaceId, campaign.workspaceId),
        eq(campaignTrigger.campaignId, campaign.id),
        eq(campaignTrigger.field, TIME_FIELD),
      ),
    );
  const found = await finder
    .select({
      workspaceId: campaign.workspaceId,
      id: campaign.id,
      definition: campaign.definition,
      liveAt: campaign.liveAt,
    })
    .from(campaign)
    .where(
      and(
        eq(campaign.status, "live"),
        notPaused(campaign.workspaceId),
        or(
          triggerIs("schedule"),
          sql`${campaign.definition} #>> '{delivery,sendEmail}' = 'true' and exists ${readsTime}`,
        ),
      ),
    );
  const now = Date.now();
  for (const one of found) {
    const occurrence = dueOccurrence(one.definition.trigger, one.liveAt, now);
    if (occurrence === null) continue;
    await withWorkspace(writer, one.workspaceId, (tx) =>
      tx
        .insert(campaignRun)
        .values({ workspaceId: one.workspaceId, campaignId: one.id, occurrence })
        .onConflictDoNothing(),
    );
  }
}

/**
 * The next contacts of a run: in the audience, after the cursor, in ID order. A test visitor, a
 * blocked one and one who turned off automatic messages are left out, and a daily pass reaches
 * only those with an email address, as it is for them.
 */
function nextContacts(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  cursor: string | null,
) {
  const { audience, trigger } = found.definition;
  return tx
    .select({ id: visitor.id })
    .from(visitor)
    .where(
      and(
        eq(visitor.workspaceId, workspaceId),
        cursor === null ? undefined : gt(visitor.id, cursor),
        eq(visitor.isTest, false),
        isNull(visitor.blockedAt),
        isNull(visitor.optedOutAt),
        trigger.type === "match" ? isNotNull(visitor.email) : undefined,
        audience === undefined ? undefined : toSql(audience),
      ),
    )
    .orderBy(asc(visitor.id))
    .limit(RUN_BATCH);
}

/**
 * One batch of a run, in one transaction with its cursor. Answers the visitors it reached, or null
 * when another worker holds the run or its campaign is paused.
 */
async function runBatch(tx: Transaction, workspaceId: string, runId: string) {
  // The run's lock comes first and skips a run that another worker holds, so it never waits. No
  // transaction that holds the workspace's lock waits for a run's, which keeps this order safe.
  const [run] = await tx
    .select()
    .from(campaignRun)
    .where(
      and(
        eq(campaignRun.workspaceId, workspaceId),
        eq(campaignRun.id, runId),
        isNull(campaignRun.finishedAt),
      ),
    )
    .for("update", { skipLocked: true });
  if (run === undefined) return null;
  const found = await campaignRow(tx, workspaceId, eq(campaign.id, run.campaignId));
  const save = (cursor: string | null, finished: boolean) =>
    tx
      .update(campaignRun)
      .set({ cursor, ...(finished && { finishedAt: new Date() }) })
      .where(and(eq(campaignRun.workspaceId, workspaceId), eq(campaignRun.id, run.id)));
  // An end leaves its runs to this, so it never waits for a run's lock.
  if (found === undefined || found.status === "ended") {
    await save(run.cursor, true);
    return [];
  }
  // A paused campaign's run waits for the resume, where it left off.
  if (found.status !== "live" || found.allPaused) return null;
  const contacts = await nextContacts(tx, workspaceId, found, run.cursor);
  const ids = contacts.map((one) => one.id);
  const { botsPaused } = await lockForSend(tx, workspaceId, ids);
  const { trigger } = found.definition;
  const delay = trigger.type === "match" ? trigger.delay : undefined;
  for (const visitorId of ids) {
    await enterCampaign(tx, workspaceId, found, visitorId, {
      botsPaused,
      options: { runId: run.id, delay },
    });
  }
  await save(ids.at(-1) ?? run.cursor, ids.length < RUN_BATCH);
  return ids;
}

/**
 * Runs one batch of each unfinished run, at most `limit` runs, so alerts and webhooks keep their
 * pace. True when it found some.
 */
export async function runCampaignRuns(
  finder: Database,
  writer: Database,
  live: Signals,
  limit: number,
): Promise<boolean> {
  // A paused campaign's run, or one of a workspace that paused every campaign, is left out, so it
  // never holds back the others.
  const open = await finder
    .select({ workspaceId: campaignRun.workspaceId, id: campaignRun.id })
    .from(campaignRun)
    .innerJoin(
      campaign,
      and(
        eq(campaign.workspaceId, campaignRun.workspaceId),
        eq(campaign.id, campaignRun.campaignId),
      ),
    )
    .where(
      and(
        isNull(campaignRun.finishedAt),
        lte(campaignRun.occurrence, sql`now()`),
        or(
          eq(campaign.status, "ended"),
          and(eq(campaign.status, "live"), notPaused(campaignRun.workspaceId)),
        ),
      ),
    )
    .orderBy(asc(campaignRun.createdAt))
    .limit(limit);
  let busy = false;
  for (const { workspaceId, id } of open) {
    const reached = await withWorkspace(writer, workspaceId, (tx) => runBatch(tx, workspaceId, id));
    if (reached === null) continue;
    busy = true;
    for (const visitorId of reached) tellOutbound(live, workspaceId, visitorId);
  }
  return busy;
}
