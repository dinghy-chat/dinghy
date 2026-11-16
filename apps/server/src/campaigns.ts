import type { z } from "@hono/zod-openapi";
import { and, eq, gt, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Actor } from "./api-keys.ts";
import { type CampaignRow, campaignRow, closedNow } from "./campaign-checks.ts";
import { campaignClientId, enterCampaign } from "./campaign-entry.ts";
import { emptyCounts, goalCondition, messagesOf, sendsEmail } from "./campaign-parts.ts";
import { campaignResults, campaignTotals, sentLastWeek } from "./campaign-results.ts";
import type {
  CampaignDefinition,
  CampaignPatchSchema,
  CampaignRefusal,
  CampaignSchema,
  CampaignSendSchema,
  EstimateSchema,
  ResultsQuery,
} from "./campaign-schemas.ts";
import { CampaignDefinitionSchema } from "./campaign-schemas.ts";
import { type Condition, fieldsOf, readsTime, toSql } from "./conditions.ts";
import { TIME_FIELD } from "./contact-checks.ts";
import {
  type CampaignPayload,
  type CampaignStatus,
  campaign,
  campaignTrigger,
  contactEvent,
  event,
  type OutboundStatusReason,
  outboundMessage,
  visitor,
  workspace,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { lockForSend } from "./journey.ts";
import { type Live, OPERATORS, type Signals } from "./live.ts";
import { lockWorkspace, nextSeq, wantsWebhook } from "./messages.ts";
import { outboundView, sendTarget, tellOutbound } from "./outbound.ts";
import { keyRefusal, sendsAs } from "./outbound-place.ts";
import { cancelWhere, keyState } from "./outbound-rules.ts";
import { insertTestVisitor } from "./test-visitors.ts";
import { DAY_MS } from "./time.ts";

// Campaigns: saved rules that make outbound messages. The REST routes, MCP and the operator app go
// through this service. A save never changes the status: only pause, resume and end do.

type View = z.infer<typeof CampaignSchema>;
type Patch = z.infer<typeof CampaignPatchSchema>;
type SendInput = z.infer<typeof CampaignSendSchema>;

/** A campaign by its ID, or by its key, as `/campaigns/{id}` and `/campaigns/by-key/{key}` name it. */
export type CampaignRef = { id: string } | { key: string };

/** The most contacts an audience count reads, and how long it may take. */
const COUNT_MAX = 10_000;
const COUNT_TIMEOUT_MS = 2000;
/** "Would have sent to N in the last 7 days". */
const LOOK_BACK_MS = 7 * DAY_MS;

type Row = typeof campaign.$inferSelect;

const whereRef = (ref: CampaignRef) =>
  "id" in ref ? eq(campaign.id, ref.id) : eq(campaign.key, ref.key);

const selectCampaign = (tx: Transaction, workspaceId: string, ref: CampaignRef) =>
  tx
    .select()
    .from(campaign)
    .where(and(eq(campaign.workspaceId, workspaceId), whereRef(ref)));

async function readCampaign(tx: Transaction, workspaceId: string, ref: CampaignRef) {
  const [found] = await selectCampaign(tx, workspaceId, ref);
  return found;
}

/**
 * Locks the workspace, then the campaign, for a change to it. Every campaign operation takes its
 * locks in one order: the visitors, then the workspace, then the campaign, then a run. So a status
 * read under the workspace's lock holds until commit, and a send needs no lock on the campaign.
 * The campaign's lock is FOR NO KEY UPDATE, as only its other columns change: a message's insert
 * takes KEY SHARE on it for its foreign key, and never waits for this one. An end leaves its runs to
 * the worker, which takes a run's lock first but only with SKIP LOCKED, so nothing waits for it.
 */
async function lockCampaign(tx: Transaction, workspaceId: string, ref: CampaignRef) {
  await lockWorkspace(tx, workspaceId);
  const [found] = await selectCampaign(tx, workspaceId, ref).for("no key update");
  return found;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

async function viewsOf(tx: Transaction, workspaceId: string, rows: Row[]): Promise<View[]> {
  const totals = await campaignTotals(
    tx,
    workspaceId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    version: row.version,
    definition: row.definition,
    totals: totals.get(row.id) ?? emptyCounts(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    liveAt: iso(row.liveAt),
    endedAt: iso(row.endedAt),
  }));
}

/** Views of campaigns by ID, for the webhooks, in one query. */
export async function campaignViews(tx: Transaction, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, View>();
  const rows = await tx
    .select()
    .from(campaign)
    .where(and(eq(campaign.workspaceId, workspaceId), inArray(campaign.id, ids)));
  return new Map((await viewsOf(tx, workspaceId, rows)).map((view) => [view.id, view]));
}

async function viewOf(tx: Transaction, workspaceId: string, row: Row): Promise<View> {
  const [view] = await viewsOf(tx, workspaceId, [row]);
  if (view === undefined) throw new Error("The campaign's view is missing");
  return view;
}

/** Records a change of a campaign, for the event stream and its webhook. */
async function recordCampaign(tx: Transaction, workspaceId: string, campaignId: string) {
  await tx.insert(event).values({
    workspaceId,
    seq: await nextSeq(tx, workspaceId),
    kind: "campaign.updated",
    payload: { campaignId } satisfies CampaignPayload,
    needsWebhook: wantsWebhook(workspaceId),
  });
}

/**
 * The contact fields the campaign reads, so a change to one checks it: a `match` audience, and the
 * exit and goal of any campaign. An audience that time alone changes also reads `TIME_FIELD`.
 */
function triggerFields(definition: CampaignDefinition): string[] {
  const { audience, trigger, rules } = definition;
  const conditions: Condition[] = [
    ...(trigger.type === "match" && audience !== undefined ? [audience] : []),
    ...(rules.exitWhen === undefined ? [] : [rules.exitWhen]),
    ...(rules.goal === undefined ? [] : [goalCondition(rules.goal)]),
  ];
  const timed = trigger.type === "match" && audience !== undefined && readsTime(audience);
  return [...new Set([...conditions.flatMap(fieldsOf), ...(timed ? [TIME_FIELD] : [])])];
}

/** Writes the contact fields a campaign reads again, after a save or an import. */
export async function saveTriggerFields(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  definition: CampaignDefinition,
) {
  await tx
    .delete(campaignTrigger)
    .where(
      and(eq(campaignTrigger.workspaceId, workspaceId), eq(campaignTrigger.campaignId, campaignId)),
    );
  const fields = triggerFields(definition);
  if (fields.length > 0) {
    await tx
      .insert(campaignTrigger)
      .values(fields.map((field) => ({ workspaceId, campaignId, field })));
  }
}

/** Why the saving member or key may not stand behind the campaign's messages, or null. */
async function authorRefusal(
  tx: Transaction,
  workspaceId: string,
  actor: Actor,
  definition: CampaignDefinition,
): Promise<CampaignRefusal | null> {
  const key = actor.kind === "key" ? await keyState(tx, workspaceId, actor.apiKeyId) : null;
  const refused = keyRefusal(key, sendsEmail(definition.delivery));
  if (refused !== null) return refused;
  for (const { sender } of messagesOf(definition)) {
    const as = await sendsAs(tx, workspaceId, actor, key, sender);
    if (typeof as === "string") return as;
  }
  return null;
}

/** Writes a definition on a new campaign or over one, with its trigger fields and its event. */
async function save(
  tx: Transaction,
  workspaceId: string,
  actor: Actor,
  existing: Row | undefined,
  definition: CampaignDefinition,
): Promise<Row | CampaignRefusal> {
  if (existing?.status === "ended") return "ended";
  const refused = await authorRefusal(tx, workspaceId, actor, definition);
  if (refused !== null) return refused;
  const values = {
    key: definition.key,
    name: definition.name,
    definition,
    authorOperatorId: actor.kind === "operator" ? actor.operatorId : null,
    authorApiKeyId: actor.kind === "key" ? actor.apiKeyId : null,
    updatedAt: new Date(),
  };
  const [taken] = await tx
    .select({ id: campaign.id })
    .from(campaign)
    .where(and(eq(campaign.workspaceId, workspaceId), eq(campaign.key, definition.key)));
  if (taken !== undefined && taken.id !== existing?.id) return "key_taken";
  const [row] =
    existing === undefined
      ? await tx
          .insert(campaign)
          .values({ workspaceId, ...values })
          .returning()
      : await tx
          .update(campaign)
          .set({ ...values, version: sql`${campaign.version} + 1` })
          .where(and(eq(campaign.workspaceId, workspaceId), eq(campaign.id, existing.id)))
          .returning();
  if (row === undefined) throw new Error("The campaign's write returned no row");
  await saveTriggerFields(tx, workspaceId, row.id, definition);
  await recordCampaign(tx, workspaceId, row.id);
  return row;
}

/** The waiting messages of a campaign that a pause held, due again now. */
const wakeHeld = (tx: Transaction, workspaceId: string, which: SQL | undefined) =>
  tx
    .update(outboundMessage)
    .set({ dueAt: new Date() })
    .where(
      and(
        eq(outboundMessage.workspaceId, workspaceId),
        eq(outboundMessage.status, "scheduled"),
        eq(outboundMessage.statusReason, "campaign_paused"),
        which,
      ),
    );

type Action = "pause" | "resume" | "end";

/** The status each action leads to, from the statuses it may start from. */
const ACTIONS: Record<Action, { from: CampaignStatus[]; to: CampaignStatus }> = {
  pause: { from: ["live"], to: "paused" },
  resume: { from: ["draft", "paused"], to: "live" },
  end: { from: ["draft", "live", "paused"], to: "ended" },
};

/**
 * Moves a campaign to its next status, with what that sets off. Null when it is already there. The
 * caller holds the campaign's lock.
 */
async function act(tx: Transaction, workspaceId: string, row: Row, action: Action) {
  const { from, to } = ACTIONS[action];
  if (row.status === "ended") return "ended" as const;
  if (!from.includes(row.status)) return null;
  const now = new Date();
  await tx
    .update(campaign)
    .set({
      status: to,
      ...(to === "live" && { liveAt: now }),
      ...(to === "ended" && { endedAt: now }),
    })
    .where(and(eq(campaign.workspaceId, workspaceId), eq(campaign.id, row.id)));
  await recordCampaign(tx, workspaceId, row.id);
  const theirs = eq(outboundMessage.campaignId, row.id);
  if (to === "live") await wakeHeld(tx, workspaceId, theirs);
  if (to !== "ended") return [];
  return cancelWhere(tx, workspaceId, sql`${theirs}`, "campaign_ended");
}

/** Runs `count` on at most COUNT_MAX contacts, within the time limit. Null when it ran out. */
async function boundedCount(tx: Transaction, workspaceId: string, which: SQL | undefined) {
  await tx.execute(sql`set local statement_timeout = ${sql.raw(String(COUNT_TIMEOUT_MS))}`);
  const limited = tx
    .select({ one: sql`1` })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.isTest, false), which))
    .limit(COUNT_MAX + 1)
    .as("limited");
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(limited);
  const count = row?.count ?? 0;
  return { count: Math.min(count, COUNT_MAX), more: count > COUNT_MAX };
}

/** The contacts a trigger would have reached in the last 7 days, as SQL over `visitor`. */
function lastWeekOf(trigger: z.infer<typeof EstimateSchema>["trigger"], audience?: Condition) {
  const since = new Date(Date.now() - LOOK_BACK_MS);
  if (trigger?.type === "event") {
    return sql`exists (select 1 from ${contactEvent} as e where e.workspace_id = ${visitor.workspaceId}
      and e.visitor_id = ${visitor.id} and e.name = ${trigger.name} and e.last_at > ${since})`;
  }
  if (trigger?.type !== "match") return null;
  // A contact made in that time, or one whose field the audience reads was written in it.
  const written = (audience === undefined ? [] : fieldsOf(audience)).map(
    (field) => sql`(${visitor.fieldTimes} ->> ${field})::bigint > ${since.getTime()}`,
  );
  return or(gt(visitor.createdAt, since), ...written) ?? null;
}

export function createCampaigns({ db, live }: { db: Database; live: Live }) {
  const changed = (workspaceId: string) => live.wake(workspaceId, OPERATORS);

  /** Saves a definition by `ref`: over the campaign it names, or a new one with none. */
  async function upsertWhere(
    workspaceId: string,
    actor: Actor,
    ref: CampaignRef,
    build: (existing: Row | undefined) => CampaignDefinition | CampaignRefusal | z.ZodError,
  ) {
    const outcome = await withWorkspace(db, workspaceId, async (tx) => {
      const existing = await lockCampaign(tx, workspaceId, ref);
      const definition = build(existing);
      if (typeof definition === "string" || definition instanceof Error) return definition;
      const row = await save(tx, workspaceId, actor, existing, definition);
      if (typeof row === "string") return row;
      return { created: existing === undefined, view: await viewOf(tx, workspaceId, row) };
    });
    if (typeof outcome !== "string" && !(outcome instanceof Error)) changed(workspaceId);
    return outcome;
  }

  return {
    async list(workspaceId: string, status: CampaignStatus | undefined) {
      return withWorkspace(db, workspaceId, async (tx) => {
        const rows = await tx
          .select()
          .from(campaign)
          .where(
            and(
              eq(campaign.workspaceId, workspaceId),
              status === undefined ? undefined : eq(campaign.status, status),
            ),
          )
          .orderBy(campaign.createdAt);
        return viewsOf(tx, workspaceId, rows);
      });
    },

    sentLastWeek: (workspaceId: string) =>
      withWorkspace(db, workspaceId, (tx) => sentLastWeek(tx, workspaceId)),

    get: (workspaceId: string, ref: CampaignRef) =>
      withWorkspace(db, workspaceId, async (tx) => {
        const row = await readCampaign(tx, workspaceId, ref);
        return row === undefined ? null : viewOf(tx, workspaceId, row);
      }),

    /** A new campaign, as a draft. */
    create: (workspaceId: string, actor: Actor, definition: CampaignDefinition) =>
      upsertWhere(workspaceId, actor, { key: definition.key }, (existing) =>
        existing === undefined ? definition : "key_taken",
      ),

    /** Creates the campaign with this key as a draft, or replaces the one that has it. */
    upsert: (workspaceId: string, actor: Actor, definition: CampaignDefinition) =>
      upsertWhere(workspaceId, actor, { key: definition.key }, () => definition),

    /** Replaces the parts a patch gives, and checks the whole definition again. */
    patch: (workspaceId: string, actor: Actor, ref: CampaignRef, patch: Patch) =>
      upsertWhere(workspaceId, actor, ref, (existing) => {
        if (existing === undefined) return "not_found";
        const parsed = CampaignDefinitionSchema.safeParse({ ...existing.definition, ...patch });
        return parsed.success ? parsed.data : parsed.error;
      }),

    /** Pauses, resumes or ends a campaign. Answers it as it is now, or why not. */
    async setStatus(workspaceId: string, ref: CampaignRef, action: Action) {
      const outcome = await withWorkspace(db, workspaceId, async (tx) => {
        const row = await lockCampaign(tx, workspaceId, ref);
        if (row === undefined) return "not_found" as const;
        const done = await act(tx, workspaceId, row, action);
        if (done === "ended") return done;
        const now = await readCampaign(tx, workspaceId, ref);
        if (now === undefined) throw new Error("The campaign is missing");
        return { view: await viewOf(tx, workspaceId, now), visitors: done ?? [] };
      });
      if (typeof outcome === "string") return outcome;
      for (const visitorId of outcome.visitors) tellOutbound(live, workspaceId, visitorId);
      changed(workspaceId);
      return outcome.view;
    },

    async results(workspaceId: string, ref: CampaignRef, range: z.infer<typeof ResultsQuery>) {
      return withWorkspace(db, workspaceId, async (tx) => {
        const row = await readCampaign(tx, workspaceId, ref);
        return row === undefined ? null : campaignResults(tx, workspaceId, row.id, range);
      });
    },

    /**
     * Runs a campaign for one person from code: it skips the audience and the trigger, and keeps
     * the frequency and the opt-out. A retry with the same client ID, and a send the frequency
     * keeps out, answer the message that is there.
     */
    async send(workspaceId: string, ref: CampaignRef, input: SendInput) {
      const outcome = await withWorkspace(db, workspaceId, async (tx) => {
        // Read with no lock: the send's decision checks the status again under the workspace's.
        const found = await campaignRow(tx, workspaceId, whereRef(ref));
        if (found === undefined) return "not_found" as const;
        if (found.status !== "live") return "not_live" as const;
        const clientId = campaignClientId(found.id, input.clientId);
        const visitorId = await sendTarget(tx, workspaceId, input.visitor);
        if (visitorId === null) return "not_found" as const;
        const { botsPaused } = await lockForSend(tx, workspaceId, [visitorId]);
        const [retry] = await tx
          .select({ id: outboundMessage.id })
          .from(outboundMessage)
          .where(
            and(
              eq(outboundMessage.workspaceId, workspaceId),
              eq(outboundMessage.campaignId, found.id),
              eq(outboundMessage.clientId, clientId),
            ),
          );
        if (retry !== undefined) return { created: false, id: retry.id, visitorId };
        const entry = await enterCampaign(tx, workspaceId, found, visitorId, {
          botsPaused,
          options: { clientId: input.clientId, data: input.data },
        });
        if (entry.kind === "refused") return entry.refusal;
        if (entry.kind === "existing") return { created: false, id: entry.id, visitorId };
        return { created: true, id: entry.row.id, visitorId };
      });
      if (typeof outcome === "string") return outcome;
      tellOutbound(live, workspaceId, outcome.visitorId);
      const view = await withWorkspace(db, workspaceId, (tx) =>
        outboundView(tx, workspaceId, outcome.id),
      );
      if (view === null) throw new Error("The outbound message is missing");
      return { created: outcome.created, outboundMessage: view };
    },

    /**
     * Shows the campaign's message to a test visitor named after the member, in a conversation
     * they can open, whatever its rules say. `blockedBy` names the rule that would hold a real send
     * now, or null.
     */
    async test(workspaceId: string, actor: Extract<Actor, { kind: "operator" }>, ref: CampaignRef) {
      return withWorkspace(db, workspaceId, async (tx) => {
        const found = await campaignRow(tx, workspaceId, whereRef(ref));
        if (found === undefined) return "not_found" as const;
        const visitorId = await insertTestVisitor(tx, workspaceId, actor.name);
        const { botsPaused } = await lockWorkspace(tx, workspaceId);
        const now: CampaignRow = {
          ...found,
          authorOperatorId: actor.operatorId,
          authorApiKeyId: null,
          // The test shows the message in a conversation, so the member can open it.
          definition: {
            ...found.definition,
            presentation: { ...found.definition.presentation, startConversation: "now" },
            variants: undefined,
          },
        };
        const entry = await enterCampaign(tx, workspaceId, now, visitorId, {
          botsPaused,
          options: {},
        });
        if (entry.kind !== "entered") throw new Error("A test send did not go");
        return {
          outboundMessage: await outboundView(tx, workspaceId, entry.row.id),
          blockedBy: await blockingRule(tx, workspaceId, found),
        };
      });
    },

    /** How many contacts match an audience now, and how many a trigger would have reached lately. */
    async estimate(workspaceId: string, input: z.infer<typeof EstimateSchema>) {
      const audience = input.audience === undefined ? undefined : toSql(input.audience);
      const lastWeek = lastWeekOf(input.trigger, input.audience);
      return withWorkspace(db, workspaceId, async (tx) => ({
        matching: await boundedCount(tx, workspaceId, audience),
        lastWeek:
          lastWeek === null ? null : await boundedCount(tx, workspaceId, and(audience, lastWeek)),
      }));
    },

    readSettings: (workspaceId: string) =>
      withWorkspace(db, workspaceId, async (tx) => {
        const [row] = await tx
          .select({
            pausedAt: workspace.campaignsPausedAt,
            pausedBy: workspace.campaignsPausedBy,
            gapHours: workspace.campaignGapHours,
          })
          .from(workspace)
          .where(eq(workspace.id, workspaceId));
        if (row === undefined) throw new Error("The workspace is missing");
        return settingsView(row);
      }),

    /**
     * Pauses or resumes every campaign, and sets the gap between two of their messages. A pause
     * that is already on keeps who started it and when.
     */
    async saveSettings(
      workspaceId: string,
      actor: Actor,
      settings: { paused: boolean; gapHours: number },
    ) {
      const row = await withWorkspace(db, workspaceId, async (tx) => {
        const [saved] = await tx
          .update(workspace)
          .set({
            campaignsPausedAt: settings.paused
              ? sql`coalesce(${workspace.campaignsPausedAt}, now())`
              : null,
            campaignsPausedBy: settings.paused
              ? sql`case when ${workspace.campaignsPausedAt} is null then ${actor.name} else ${workspace.campaignsPausedBy} end`
              : null,
            campaignGapHours: settings.gapHours,
          })
          .where(eq(workspace.id, workspaceId))
          .returning({
            pausedAt: workspace.campaignsPausedAt,
            pausedBy: workspace.campaignsPausedBy,
            gapHours: workspace.campaignGapHours,
          });
        if (saved === undefined) throw new Error("The workspace is missing");
        if (!settings.paused) await wakeHeld(tx, workspaceId, undefined);
        return saved;
      });
      changed(workspaceId);
      return settingsView(row);
    },
  };
}
export type Campaigns = ReturnType<typeof createCampaigns>;

/** The settings for every campaign, as the API answers them. */
const settingsView = (row: {
  pausedAt: Date | null;
  pausedBy: string | null;
  gapHours: number;
}) => ({
  paused: row.pausedAt !== null,
  gapHours: row.gapHours,
  pausedBy: row.pausedBy,
  pausedAt: row.pausedAt?.toISOString() ?? null,
});

/** The rule that would hold one of the campaign's messages if it were sent now, or null. */
async function blockingRule(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
): Promise<OutboundStatusReason | null> {
  if (found.status === "ended") return "campaign_ended";
  if (found.status !== "live" || found.allPaused) return "campaign_paused";
  const closed = await closedNow(tx, workspaceId, null, found.definition.rules);
  return closed?.reason ?? null;
}

/** Ends every live campaign whose end date passed. The worker runs it once a minute. */
export async function endDueCampaigns(finder: Database, writer: Database, live: Signals) {
  const due = await finder
    .select({ workspaceId: campaign.workspaceId, id: campaign.id })
    .from(campaign)
    .where(
      and(
        inArray(campaign.status, ["live", "paused"]),
        sql`(${campaign.definition} #>> '{rules,endsAt}')::timestamptz <= now()`,
      ),
    );
  for (const { workspaceId, id } of due) {
    const visitors = await withWorkspace(writer, workspaceId, async (tx) => {
      const row = await lockCampaign(tx, workspaceId, { id });
      if (row === undefined) return [];
      const done = await act(tx, workspaceId, row, "end");
      return Array.isArray(done) ? done : [];
    });
    for (const visitorId of visitors) tellOutbound(live, workspaceId, visitorId);
    live.wake(workspaceId, OPERATORS);
  }
}
