import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { API_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { campaignRows, inAudience, triggerIs } from "./campaign-checks.ts";
import { enterCampaign } from "./campaign-entry.ts";
import { EVENT_NAME, eventFields } from "./conditions.ts";
import { contactChanged } from "./contact-checks.ts";
import { campaign, contactEvent } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import {
  errorAnswer,
  failure,
  jsonAnswer,
  jsonBody,
  KEY_LIMITED,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
} from "./errors.ts";
import { VisitorSelector } from "./inputs.ts";
import { lockVisitors } from "./journey.ts";
import type { Live } from "./live.ts";
import { WORKSPACE_PREFIX, workspaceParams } from "./member.ts";
import { lockWorkspace } from "./messages.ts";
import { sendTarget, tellOutbound } from "./outbound.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { MINUTE_SECONDS } from "./time.ts";

// Server events: a fact that the customer's server tells Dinghy about a contact on purpose, such
// as `export.finished`. Never the browser. Each contact keeps one row per name, with a count and
// its first and last time, and no log, so nothing grows with traffic. Conditions read
// `events.<name>.count` and `events.<name>.lastAt`, and an `event` campaign fires on the name with
// the properties in its text, which are never stored.

/** Tracks a minute for one API key, apart from its rate limit for every request. */
const TRACKS_PER_KEY_PER_MINUTE = 600;
/** The IDs a contact's row keeps per name, so a retry soon after counts once. */
const RECENT_IDS_KEPT = 20;
const PROPERTIES_MAX_BYTES = 4096;

const KEYS_ONLY = failure("forbidden", "Only your server tracks events, with an API key.");

export const TrackSchema = z.object({
  visitor: VisitorSelector,
  name: z.string().regex(EVENT_NAME).openapi({ example: "export.finished" }),
  properties: z
    .record(z.string(), z.unknown())
    .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= PROPERTIES_MAX_BYTES, {
      message: `At most ${PROPERTIES_MAX_BYTES} bytes of JSON`,
    })
    .optional()
    .openapi({
      description:
        "Values for `{{ event.properties.<key> }}` in an `event` campaign's text. Never stored",
    }),
  occurredAt: z.iso
    .datetime()
    .optional()
    .openapi({ description: "When it happened. Now if left out" }),
  id: z.string().min(1).max(100).optional().openapi({
    description: "Your own ID for this event, so a retry soon after counts once",
  }),
});
type TrackInput = z.infer<typeof TrackSchema>;

/** Counts the event on the contact's row, unless its ID was counted lately. True when it counted. */
async function countEvent(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  { name, occurredAt, id }: TrackInput,
): Promise<boolean> {
  const at = new Date(
    Math.min(Date.now(), occurredAt === undefined ? Date.now() : Date.parse(occurredAt)),
  );
  const ids = id === undefined ? [] : [id];
  const counted = await tx
    .insert(contactEvent)
    .values({ workspaceId, visitorId, name, count: 1, firstAt: at, lastAt: at, recentIds: ids })
    .onConflictDoUpdate({
      target: [contactEvent.workspaceId, contactEvent.visitorId, contactEvent.name],
      set: {
        count: sql`${contactEvent.count} + 1`,
        firstAt: sql`least(${contactEvent.firstAt}, excluded.first_at)`,
        lastAt: sql`greatest(${contactEvent.lastAt}, excluded.last_at)`,
        recentIds: sql`(excluded.recent_ids || ${contactEvent.recentIds})[1:${RECENT_IDS_KEPT}]`,
      },
      ...(id !== undefined && { setWhere: sql`not (${id} = any(${contactEvent.recentIds}))` }),
    })
    .returning({ count: contactEvent.count });
  return counted.length > 0;
}

export function createTracking({ db, live }: { db: Database; live: Live }) {
  return {
    /** Counts an event on a contact, made or updated by `visitor`, and runs its campaigns. */
    async track(workspaceId: string, input: TrackInput) {
      const outcome = await withWorkspace(db, workspaceId, async (tx) => {
        const visitorId = await sendTarget(tx, workspaceId, input.visitor);
        if (visitorId === null) return null;
        await lockVisitors(tx, workspaceId, [visitorId]);
        if (!(await countEvent(tx, workspaceId, visitorId, input))) {
          return { visitorId, counted: false };
        }
        await contactChanged(tx, workspaceId, visitorId, eventFields(input.name));
        const found = await campaignRows(
          tx,
          workspaceId,
          and(
            eq(campaign.status, "live"),
            triggerIs("event"),
            sql`${campaign.definition} #>> '{trigger,name}' = ${input.name}`,
          ),
        );
        if (found.length === 0) return { visitorId, counted: true };
        const { botsPaused } = await lockWorkspace(tx, workspaceId);
        for (const one of found) {
          const { trigger } = one.definition;
          if (trigger.type !== "event") continue;
          if (!(await inAudience(tx, workspaceId, visitorId, one.definition))) continue;
          await enterCampaign(tx, workspaceId, one, visitorId, {
            botsPaused,
            options: { delay: trigger.delay, event: { properties: input.properties ?? {} } },
          });
        }
        return { visitorId, counted: true };
      });
      if (outcome?.counted === true) tellOutbound(live, workspaceId, outcome.visitorId);
      return outcome;
    },
  };
}
export type Tracking = ReturnType<typeof createTracking>;

const trackRoute = createRoute({
  method: "post",
  path: `${WORKSPACE_PREFIX}/{workspaceId}/track`,
  security: API_KEY,
  summary: "Track an event about a contact, from your server. API keys only",
  description:
    'Counts the event `name` on the contact that `visitor` names, which it creates or updates. Each contact keeps, per name, how often it happened and when, first and last, and no log. Conditions read `events.<name>.count` and `events.<name>.lastAt`, and a live campaign with the trigger `{ type: "event", name }` runs for the contact, with `properties` in its text. Properties are never stored. A repeat of a recent `id` counts once.',
  request: { params: workspaceParams, body: jsonBody(TrackSchema) },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer(
      "Tracked. `counted` is false for a repeat of a recent `id`",
      z.object({ visitorId: z.string(), counted: z.boolean() }),
    ),
    ...MEMBER_WRITE_ERRORS,
    403: errorAnswer("forbidden: a member sent it. Only your server tracks events, with a key"),
    404: errorAnswer("not_found: no visitor has this `id`"),
  },
});

export function registerTrackRoute(
  app: App,
  { tracking, rateLimit }: { tracking: Tracking; rateLimit: RateLimit },
): void {
  app.openapi(trackRoute, async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "key") return c.json(KEYS_ONLY, 403);
    const wait = await rateLimit.hit(
      "track",
      actor.apiKeyId,
      TRACKS_PER_KEY_PER_MINUTE,
      MINUTE_SECONDS,
    );
    if (wait !== null) return tooManyRequests(c, wait);
    const outcome = await tracking.track(c.get("memberWorkspaceId"), c.req.valid("json"));
    return outcome === null ? c.json(NOT_FOUND, 404) : c.json(outcome, 200);
  });
}
