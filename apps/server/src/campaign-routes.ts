import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { SESSION, SESSION_OR_KEY, SESSION_OR_SETUP_KEY } from "./api-security.ts";
import type { App, AppEnv } from "./app.ts";
import {
  CAMPAIGN_ID,
  CAMPAIGN_REFUSALS,
  CAMPAIGN_SEND_REFUSALS,
  CampaignDefinitionSchema,
  CampaignKey,
  CampaignListQuery,
  CampaignPatchSchema,
  type CampaignRefusal,
  CampaignResultsSchema,
  CampaignSchema,
  CampaignSendSchema,
  CampaignSettingsSchema,
  CampaignSettingsViewSchema,
  EstimateSchema,
  ResultsQuery,
} from "./campaign-schemas.ts";
import type { CampaignRef, Campaigns } from "./campaigns.ts";
import {
  errorAnswer,
  FORBIDDEN,
  INVALID,
  jsonAnswer,
  jsonBody,
  KEY_LIMITED,
  MEMBER_ERRORS,
  MEMBER_WRITE_ERRORS,
  NOT_FOUND,
  ROLE_WRITE_ERRORS,
  zodFailure,
} from "./errors.ts";
import { WORKSPACE_PREFIX, workspaceParams } from "./member.ts";
import { OutboundMessageSchema } from "./outbound-schemas.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { maySetUp } from "./team.ts";
import { MINUTE_SECONDS } from "./time.ts";

// The campaigns API. A route that names one campaign takes its ID, or its key under `by-key/`, so a
// repository that keeps campaigns as code needs only their keys. Every key reads them, and owners,
// admins and Full access keys change them.

/** Sends a minute for one API key, as for outbound messages. */
const SENDS_PER_KEY_PER_MINUTE = 60;

const PATH = `${WORKSPACE_PREFIX}/{workspaceId}/campaigns`;
const Answer = z.object({ campaign: CampaignSchema });
const SendAnswer = z.object({ outboundMessage: OutboundMessageSchema });

const REFUSED_TEXT =
  "campaign_key_taken: another campaign has this key. campaign_ended: an ended campaign does not change";
const AUTHOR_TEXT =
  "send_mode_required, send_as_member_required, send_email_required: this key may not stand behind the campaign's messages";

/** The two spellings of one campaign's path: by ID, and by key. */
const refPaths = (tail: string) =>
  [
    {
      path: `${PATH}/{ref}${tail}`,
      params: workspaceParams.extend({
        ref: z.string().regex(CAMPAIGN_ID).openapi({ description: "The campaign's ID" }),
      }),
    },
    {
      path: `${PATH}/by-key/{ref}${tail}`,
      params: workspaceParams.extend({
        ref: CampaignKey.openapi({ description: "The campaign's key" }),
      }),
    },
  ] as const;

const parseRef = (ref: string): CampaignRef => (CAMPAIGN_ID.test(ref) ? { id: ref } : { key: ref });

const listRoute = createRoute({
  method: "get",
  path: PATH,
  security: SESSION_OR_KEY,
  summary: "List the campaigns, oldest first, with their results since they started",
  request: { params: workspaceParams, query: CampaignListQuery },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer(
      "The campaigns",
      z.object({
        campaigns: z.array(CampaignSchema),
        sentLastWeek: z.number().int().openapi({
          description: "The messages every campaign sent in the last 7 days, whatever the status",
        }),
      }),
    ),
    ...MEMBER_ERRORS,
    ...INVALID,
  },
});

const createCampaignRoute = createRoute({
  method: "post",
  path: PATH,
  security: SESSION_OR_SETUP_KEY,
  summary: "Create a campaign, as a draft. Owners, admins and Full access keys only",
  description:
    "The body is the whole definition. A new campaign is a draft until `/resume`. Its messages carry the member or key that saved it last, so a key needs the permissions its messages use.",
  request: { params: workspaceParams, body: jsonBody(CampaignDefinitionSchema) },
  responses: {
    ...KEY_LIMITED,
    201: jsonAnswer("The new campaign", Answer),
    ...ROLE_WRITE_ERRORS,
    403: errorAnswer(`forbidden: this role or key may not. ${AUTHOR_TEXT}`),
    409: errorAnswer(REFUSED_TEXT),
  },
});

const upsertRoute = createRoute({
  method: "put",
  path: `${PATH}/by-key/{key}`,
  security: SESSION_OR_SETUP_KEY,
  summary: "Create or replace the campaign with this key. Owners, admins and Full access keys only",
  description:
    "The body is the whole definition, with this key or none. A new campaign is a draft. A save never changes the status, so a deploy never resumes a campaign that support paused. A live campaign keeps its changes for new messages only.",
  request: {
    params: workspaceParams.extend({ key: CampaignKey }),
    body: jsonBody(CampaignDefinitionSchema),
  },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer("The campaign, replaced", Answer),
    201: jsonAnswer("The new campaign", Answer),
    ...ROLE_WRITE_ERRORS,
    403: errorAnswer(`forbidden: this role or key may not. ${AUTHOR_TEXT}`),
    409: errorAnswer(REFUSED_TEXT),
  },
});

const estimateRoute = createRoute({
  method: "post",
  path: `${PATH}/estimate`,
  security: SESSION_OR_KEY,
  summary: "Count the contacts an audience matches now, and those a trigger reached lately",
  description: `\`matching\` counts the contacts who match \`audience\` now. \`lastWeek\` counts those a \`match\` or \`event\` trigger would have reached in the last 7 days, and is null for another trigger. Each count stops at 10,000 with \`more: true\`.`,
  request: { params: workspaceParams, body: jsonBody(EstimateSchema) },
  responses: {
    ...KEY_LIMITED,
    200: jsonAnswer(
      "The counts",
      z.object({
        matching: z.object({ count: z.number().int(), more: z.boolean() }),
        lastWeek: z.object({ count: z.number().int(), more: z.boolean() }).nullable(),
      }),
    ),
    ...MEMBER_WRITE_ERRORS,
  },
});

const SETTINGS_PATH = `${WORKSPACE_PREFIX}/{workspaceId}/campaign-settings`;
const settingsAnswer = jsonAnswer("The settings for every campaign", CampaignSettingsViewSchema);

const readSettingsRoute = createRoute({
  method: "get",
  path: SETTINGS_PATH,
  security: SESSION_OR_KEY,
  summary: "Read the settings for every campaign",
  request: { params: workspaceParams },
  responses: { ...KEY_LIMITED, 200: settingsAnswer, ...MEMBER_ERRORS },
});

const saveSettingsRoute = createRoute({
  method: "put",
  path: SETTINGS_PATH,
  security: SESSION_OR_SETUP_KEY,
  summary: "Pause every campaign, or set the gap between two campaign messages to one visitor",
  description:
    "`paused` holds every campaign's messages until it is false again. It is apart from pausing the bots. `gapHours` is checked when a campaign's message is about to go: one that comes sooner after another is cancelled with `frequency_capped`. Owners, admins and Full access keys only.",
  request: { params: workspaceParams, body: jsonBody(CampaignSettingsSchema) },
  responses: { ...KEY_LIMITED, 200: settingsAnswer, ...ROLE_WRITE_ERRORS },
});

const getRoutes = refPaths("").map(({ path, params }) =>
  createRoute({
    method: "get",
    path,
    security: SESSION_OR_KEY,
    summary: "Get one campaign",
    request: { params },
    responses: { ...KEY_LIMITED, 200: jsonAnswer("The campaign", Answer), ...MEMBER_ERRORS },
  }),
);

const patchRoutes = refPaths("").map(({ path, params }) =>
  createRoute({
    method: "patch",
    path,
    security: SESSION_OR_SETUP_KEY,
    summary: "Change parts of a campaign. Owners, admins and Full access keys only",
    description:
      "Each part the body gives, such as `message` or `rules`, replaces that part whole, and the whole definition is checked again.",
    request: { params, body: jsonBody(CampaignPatchSchema) },
    responses: {
      ...KEY_LIMITED,
      200: jsonAnswer("The campaign after the change", Answer),
      ...ROLE_WRITE_ERRORS,
      403: errorAnswer(`forbidden: this role or key may not. ${AUTHOR_TEXT}`),
      409: errorAnswer(REFUSED_TEXT),
    },
  }),
);

const ACTIONS = {
  pause: "Pause a live campaign: its waiting messages wait, and it makes no new ones",
  resume: "Start a draft, or resume a paused campaign",
  end: "End a campaign for good: its messages that wait are cancelled with `campaign_ended`",
} as const;

const actionRoutes = Object.entries(ACTIONS).flatMap(([action, summary]) =>
  refPaths(`/${action}`).map(({ path, params }) => ({
    action: action as keyof typeof ACTIONS,
    route: createRoute({
      method: "post",
      path,
      security: SESSION_OR_SETUP_KEY,
      summary: `${summary}. Owners, admins and Full access keys only`,
      request: { params },
      responses: {
        ...KEY_LIMITED,
        200: jsonAnswer("The campaign as it is now", Answer),
        ...ROLE_WRITE_ERRORS,
        409: errorAnswer("campaign_ended: an ended campaign does not change"),
      },
    }),
  })),
);

const resultsRoutes = refPaths("/results").map(({ path, params }) =>
  createRoute({
    method: "get",
    path,
    security: SESSION_OR_KEY,
    summary: "A campaign's results per day in UTC and per A/B variant",
    description:
      "Each day counts the contacts it reached (`entered`, the control group too), and its messages sent, delivered, read, replied and dismissed, the clicks by button value, the goals reached and the conversations started. Test visitors are left out. The days outlive the messages' text.",
    request: { params, query: ResultsQuery },
    responses: {
      ...KEY_LIMITED,
      200: jsonAnswer("The results", CampaignResultsSchema),
      ...MEMBER_ERRORS,
      ...INVALID,
    },
  }),
);

const sendRoutes = refPaths("/send").map(({ path, params }) =>
  createRoute({
    method: "post",
    path,
    security: SESSION_OR_KEY,
    summary: "Run a live campaign for one person, from your code",
    description:
      "It skips the audience and the trigger, because your code chose the person, and keeps the frequency and the visitor's opt-out. `data` fills `{{ data.<key> }}` in the text. A retry with the same `clientId`, and a send that the frequency keeps out, answer 200 with the message that is there.",
    request: { params, body: jsonBody(CampaignSendSchema) },
    responses: {
      ...KEY_LIMITED,
      200: jsonAnswer(
        "A retry, or a message the frequency keeps: the one that is there",
        SendAnswer,
      ),
      201: jsonAnswer("The new outbound message", SendAnswer),
      ...MEMBER_WRITE_ERRORS,
      403: errorAnswer("blocked: the team blocked this visitor"),
      404: errorAnswer("not_found: no such campaign, or no visitor has this `id`"),
      409: errorAnswer(
        "campaign_not_live: the campaign is a draft, paused or ended. opted_out: the visitor turned off automatic messages",
      ),
      429: errorAnswer(
        "too_many_requests: over the key's rate limit. too_many_waiting: the visitor has too many outbound messages waiting",
      ),
    },
  }),
);

const testRoutes = refPaths("/test").map(({ path, params }) =>
  createRoute({
    method: "post",
    path,
    security: SESSION,
    summary: "Send a test to me: the message to a test visitor named after you",
    description:
      "It goes in a test conversation that you can open, whatever the campaign's rules say. `blockedBy` names the rule that would hold a real message now, such as `campaign_paused` or `outside_business_hours`, or null.",
    request: { params },
    responses: {
      200: jsonAnswer(
        "The test message",
        z.object({
          outboundMessage: OutboundMessageSchema,
          blockedBy: z.string().nullable(),
        }),
      ),
      ...MEMBER_WRITE_ERRORS,
    },
  }),
);

/** What a refused change answers. */
function refused(c: Context<AppEnv>, refusal: CampaignRefusal | z.ZodError) {
  if (refusal instanceof z.ZodError) return c.json(zodFailure(refusal), 400);
  const { status, body } = CAMPAIGN_REFUSALS[refusal];
  return c.json(body, status);
}

const mayChange = (c: Context<AppEnv>) => maySetUp(c.get("actor"), c.get("memberRole"));

export function registerCampaignRoutes(
  app: App,
  { campaigns, rateLimit }: { campaigns: Campaigns; rateLimit: RateLimit },
): void {
  app.openapi(listRoute, async (c) => {
    const { status } = c.req.valid("query");
    const workspaceId = c.get("memberWorkspaceId");
    const [list, sentLastWeek] = await Promise.all([
      campaigns.list(workspaceId, status),
      campaigns.sentLastWeek(workspaceId),
    ]);
    return c.json({ campaigns: list, sentLastWeek }, 200);
  });

  app.openapi(estimateRoute, async (c) =>
    c.json(await campaigns.estimate(c.get("memberWorkspaceId"), c.req.valid("json")), 200),
  );

  app.openapi(readSettingsRoute, async (c) =>
    c.json(await campaigns.readSettings(c.get("memberWorkspaceId")), 200),
  );

  app.openapi(saveSettingsRoute, async (c) => {
    if (!mayChange(c)) return c.json(FORBIDDEN, 403);
    return c.json(
      await campaigns.saveSettings(c.get("memberWorkspaceId"), c.get("actor"), c.req.valid("json")),
      200,
    );
  });

  app.openapi(createCampaignRoute, async (c) => {
    if (!mayChange(c)) return c.json(FORBIDDEN, 403);
    const outcome = await campaigns.create(
      c.get("memberWorkspaceId"),
      c.get("actor"),
      c.req.valid("json"),
    );
    if (typeof outcome === "string" || outcome instanceof z.ZodError) return refused(c, outcome);
    return c.json({ campaign: outcome.view }, 201);
  });

  // Before the routes by ID, so `by-key` never reads as an ID.
  app.openapi(upsertRoute, async (c) => {
    if (!mayChange(c)) return c.json(FORBIDDEN, 403);
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const outcome = await campaigns.upsert(c.get("memberWorkspaceId"), c.get("actor"), {
      ...body,
      key,
    });
    if (typeof outcome === "string" || outcome instanceof z.ZodError) return refused(c, outcome);
    return c.json({ campaign: outcome.view }, outcome.created ? 201 : 200);
  });

  for (const route of getRoutes) {
    app.openapi(route, async (c) => {
      const found = await campaigns.get(
        c.get("memberWorkspaceId"),
        parseRef(c.req.valid("param").ref),
      );
      return found === null ? c.json(NOT_FOUND, 404) : c.json({ campaign: found }, 200);
    });
  }

  for (const route of patchRoutes) {
    app.openapi(route, async (c) => {
      if (!mayChange(c)) return c.json(FORBIDDEN, 403);
      const outcome = await campaigns.patch(
        c.get("memberWorkspaceId"),
        c.get("actor"),
        parseRef(c.req.valid("param").ref),
        c.req.valid("json"),
      );
      if (typeof outcome === "string" || outcome instanceof z.ZodError) return refused(c, outcome);
      return c.json({ campaign: outcome.view }, 200);
    });
  }

  for (const { action, route } of actionRoutes) {
    app.openapi(route, async (c) => {
      if (!mayChange(c)) return c.json(FORBIDDEN, 403);
      const ref = parseRef(c.req.valid("param").ref);
      const outcome = await campaigns.setStatus(c.get("memberWorkspaceId"), ref, action);
      if (typeof outcome === "string") return refused(c, outcome);
      return c.json({ campaign: outcome }, 200);
    });
  }

  for (const route of resultsRoutes) {
    app.openapi(route, async (c) => {
      const ref = parseRef(c.req.valid("param").ref);
      const found = await campaigns.results(c.get("memberWorkspaceId"), ref, c.req.valid("query"));
      return found === null ? c.json(NOT_FOUND, 404) : c.json(found, 200);
    });
  }

  for (const route of sendRoutes) {
    app.openapi(route, async (c) => {
      const actor = c.get("actor");
      if (actor.kind === "key") {
        const wait = await rateLimit.hit(
          "outbound-send",
          actor.apiKeyId,
          SENDS_PER_KEY_PER_MINUTE,
          MINUTE_SECONDS,
        );
        if (wait !== null) return tooManyRequests(c, wait);
      }
      const ref = parseRef(c.req.valid("param").ref);
      const outcome = await campaigns.send(c.get("memberWorkspaceId"), ref, c.req.valid("json"));
      if (typeof outcome === "string") {
        const { status, body } = CAMPAIGN_SEND_REFUSALS[outcome];
        return c.json(body, status);
      }
      return c.json({ outboundMessage: outcome.outboundMessage }, outcome.created ? 201 : 200);
    });
  }

  for (const route of testRoutes) {
    app.openapi(route, async (c) => {
      const actor = c.get("actor");
      if (actor.kind !== "operator") return c.json(FORBIDDEN, 403);
      const ref = parseRef(c.req.valid("param").ref);
      const outcome = await campaigns.test(c.get("memberWorkspaceId"), actor, ref);
      if (outcome === "not_found" || outcome.outboundMessage === null) {
        return c.json(NOT_FOUND, 404);
      }
      return c.json(
        { outboundMessage: outcome.outboundMessage, blockedBy: outcome.blockedBy },
        200,
      );
    });
  }
}
