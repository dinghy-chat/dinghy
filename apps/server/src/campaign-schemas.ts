import { z } from "@hono/zod-openapi";
import { LOCALES, WEEKDAYS } from "../../../packages/widget/src/shared.ts";
import {
  ConditionSchema as AudienceCondition,
  CampaignConditionSchema as CampaignCondition,
  EVENT_NAME,
} from "./conditions.ts";
import {
  CAMPAIGN_STATUSES,
  IF_CONVERSATION_OPEN,
  OUTBOUND_SHOWS,
  START_CONVERSATION,
} from "./db/schema.ts";
import { failure } from "./errors.ts";
import { Body, ClientId, DurationText, VisitorSelector } from "./inputs.ts";
import { ButtonSchema, SEND_REFUSALS, SenderSchema } from "./outbound-schemas.ts";
import { templateProblems } from "./template.ts";
import { TimeZone } from "./time.ts";

// A campaign as one JSON object, which the API, MCP, the SDK and the editor share. It holds no
// status: only pause, resume and end change that, so an upsert from a deploy never resumes a
// campaign that support paused. Durations stay as written, so "Copy as code" gives them back.

const BUTTONS_MAX = 4;
const VARIANTS_MAX = 5;
const PAGE_SECONDS_MAX = 3600;
const URL_PATTERN_MAX = 500;
const DATA_KEYS_MAX = 20;
const DATA_VALUE_LENGTH_MAX = 500;

/** A campaign's ID, which a key may never look like, so a path can take either. */
export const CAMPAIGN_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export const CampaignKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
  .refine((key) => !CAMPAIGN_ID.test(key), "A key cannot look like a campaign's ID")
  .openapi({
    description: "Lowercase letters, digits, - and _, unique in the workspace",
    example: "dns-help",
  });

const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .openapi({ example: "09:00" });
const DateOnly = z.iso.date().openapi({ example: "2026-12-01" });

const TriggerSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("match"), delay: DurationText.optional() }),
    z.strictObject({
      type: z.literal("schedule"),
      repeat: z.enum(["once", "daily", "weekly", "monthly"]),
      time: TimeOfDay,
      days: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(),
      startDate: DateOnly,
      endDate: DateOnly.optional(),
      timeZone: TimeZone.default("UTC"),
    }),
    z.strictObject({
      type: z.literal("event"),
      name: z.string().regex(EVENT_NAME),
      delay: DurationText.optional(),
    }),
    z.strictObject({
      type: z.literal("page"),
      url: z.string().min(1).max(URL_PATTERN_MAX).openapi({
        description:
          "A path or a full URL, where `*` matches any text, such as `/pricing*`. A path matches on any allowed site",
      }),
      seconds: z.number().int().min(0).max(PAGE_SECONDS_MAX),
    }),
    z.strictObject({ type: z.literal("api") }),
  ])
  .openapi("CampaignTrigger", {
    description:
      "`match`: when a contact starts to match the audience, after `delay`. `schedule`: everyone in the audience at a time of day, once or again. `event`: when your server tracks the event `name`. `page`: in the widget, after `seconds` on a page that matches `url`. `api`: only when your code calls send",
  });
export type CampaignTrigger = z.infer<typeof TriggerSchema>;

/** Each button of a campaign has a value, so results count clicks in every language. */
const CampaignButtons = z
  .array(ButtonSchema)
  .max(BUTTONS_MAX)
  .refine((buttons) => buttons.every((button) => button.value !== undefined), {
    message: "Each button of a campaign has a value",
  });

const Translation = z.strictObject({ body: Body, buttons: CampaignButtons.optional() });

const MessageSchema = z
  .strictObject({
    sender: SenderSchema.optional(),
    body: Body,
    buttons: CampaignButtons.optional(),
    translations: z.partialRecord(z.enum(LOCALES), Translation).optional().openapi({
      description: "A body and buttons per language, by the visitor's language",
    }),
  })
  .openapi("CampaignMessage");
export type CampaignMessage = z.infer<typeof MessageSchema>;

const VariantSchema = z.union([
  z.strictObject({
    key: CampaignKey,
    weight: z.number().int().min(1).max(100),
    message: MessageSchema.optional().openapi({
      description: "This variant's message. Left out, the campaign's own",
    }),
  }),
  z.strictObject({
    key: CampaignKey,
    weight: z.number().int().min(1).max(100),
    control: z.literal(true).openapi({
      description: "The control group: no message, so the goal's results can compare",
    }),
  }),
]);

const GoalSchema = z
  .unknown()
  .pipe(z.looseObject({ within: DurationText }))
  .transform(({ within, ...condition }, context) => {
    const parsed = CampaignCondition.safeParse(condition);
    if (parsed.success) return { ...parsed.data, within };
    for (const issue of parsed.error.issues) context.addIssue(issue.message);
    return z.NEVER;
  })
  .openapi({
    description:
      "A condition, plus `within`: a contact who matches it within that time after a message reached the goal, which ends the campaign for them and counts in results",
    example: { field: "attributes.domainVerified", op: "eq", value: true, within: "7d" },
  });

const RulesSchema = z.strictObject({
  frequency: z
    .union([z.literal("once"), z.strictObject({ every: DurationText })])
    .default("once")
    .openapi({ description: '`"once"` per contact, or `{ "every": "7d" }` at most' }),
  businessHours: z.boolean().default(false).openapi({
    description: "Send only during the workspace's business hours",
  }),
  sendWindow: z
    .strictObject({ from: TimeOfDay, to: TimeOfDay })
    .refine(({ from, to }) => from !== to, "The window starts and ends at different times")
    .optional()
    .openapi({ description: "Send only between these times on the visitor's own clock" }),
  endsAt: z.iso.datetime().nullable().default(null),
  exitWhen: CampaignCondition.optional().openapi({
    description:
      "A contact who matches it leaves the campaign, and their waiting messages from it are cancelled. `repliedToCampaign` stops it once they answer",
  }),
  goal: GoalSchema.optional(),
});

const DeliverySchema = z.strictObject({
  sendEmail: z.boolean().default(false),
  assignOnReply: z.boolean().optional(),
  expiresIn: DurationText.optional(),
  emailIfUnread: DurationText.optional().openapi({
    description:
      "An `on_reply` message still unread after this time goes in a conversation and out by email, to a visitor with an email address",
  }),
});

const PresentationSchema = z.strictObject({
  startConversation: z.enum(START_CONVERSATION),
  show: z.enum(OUTBOUND_SHOWS),
  ifConversationOpen: z.enum(IF_CONVERSATION_OPEN),
});

/** The variables a campaign's text may read, for its trigger. */
function knownVariable(trigger: CampaignTrigger["type"]) {
  const contact = new Set([
    "name",
    "firstName",
    "email",
    "userId",
    "language",
    "country",
    "timeZone",
  ]);
  return (path: string) =>
    contact.has(path) ||
    /^attributes\.\w/.test(path) ||
    (trigger === "api" && /^data\.\w/.test(path)) ||
    (trigger === "event" && /^event\.properties\.\w/.test(path));
}

type Definition = z.infer<typeof DefinitionShape>;

/** Every message of the campaign: its own, each variant's, and each one's translations. */
const messagesOf = (definition: Pick<Definition, "message" | "variants">) => [
  definition.message,
  ...(definition.variants ?? []).flatMap((one) =>
    "message" in one && one.message !== undefined ? [one.message] : [],
  ),
];

/** Why the parts of a definition do not fit together, one line each. */
function definitionProblems(definition: Definition): string[] {
  const { trigger, presentation, variants = [] } = definition;
  const problems: string[] = [];
  const knows = knownVariable(trigger.type);
  for (const message of messagesOf(definition)) {
    const bodies = [message.body, ...Object.values(message.translations ?? {}).map((t) => t.body)];
    problems.push(...bodies.flatMap((body) => templateProblems(body, knows)));
  }
  if (trigger.type === "page" && presentation.show === "chat") {
    problems.push("A page campaign shows as badge or preview, so a reload never opens the chat");
  }
  if (trigger.type === "page" && presentation.startConversation === "now") {
    problems.push("A page campaign starts a conversation on_reply");
  }
  if (
    trigger.type === "schedule" &&
    (trigger.repeat === "weekly") !== (trigger.days !== undefined)
  ) {
    problems.push("A weekly schedule takes days, and only a weekly one");
  }
  if (new Set(variants.map((one) => one.key)).size !== variants.length) {
    problems.push("Each variant has its own key");
  }
  if (variants.filter((one) => "control" in one).length > 1) {
    problems.push("At most one control group");
  }
  return problems;
}

const DefinitionShape = z.strictObject({
  key: CampaignKey,
  name: z.string().trim().min(1).max(100),
  audience: AudienceCondition.optional().openapi({
    description: "Who it is for: a condition on the contact. Left out, everyone",
  }),
  trigger: TriggerSchema,
  message: MessageSchema,
  presentation: PresentationSchema,
  delivery: DeliverySchema.default({ sendEmail: false }),
  rules: RulesSchema.default({
    frequency: "once",
    businessHours: false,
    endsAt: null,
  }),
  variants: z.array(VariantSchema).min(2).max(VARIANTS_MAX).optional().openapi({
    description:
      "A/B variants by weight, each with its own message or the campaign's, and at most one `control: true` group that gets nothing",
  }),
});

/** A campaign's whole definition, as an upsert takes it and a read answers it. */
export const CampaignDefinitionSchema = DefinitionShape.superRefine((definition, context) => {
  for (const problem of definitionProblems(definition)) context.addIssue(problem);
}).openapi("CampaignDefinition", {
  example: {
    key: "dns-help",
    name: "DNS help after signup",
    audience: { field: "attributes.domainVerified", op: "ne", value: true },
    trigger: { type: "match", delay: "1h" },
    message: {
      sender: { email: "julien@example.com" },
      body: 'Hi {{ firstName | default: "there" }}, want me to check your DNS with you?',
      buttons: [
        { label: "Yes, please", value: "yes" },
        { label: "I'm fine", dismiss: true, value: "no" },
      ],
    },
    presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
    delivery: { sendEmail: false },
    rules: { frequency: "once", businessHours: true, endsAt: null },
  },
});
export type CampaignDefinition = z.infer<typeof CampaignDefinitionSchema>;

/** A change to some parts of a definition. Each part given replaces that part whole. */
export const CampaignPatchSchema = DefinitionShape.partial().openapi("CampaignPatch");

const Counts = {
  entered: z.number().int(),
  sent: z.number().int(),
  delivered: z.number().int(),
  read: z.number().int(),
  replied: z.number().int(),
  dismissed: z.number().int(),
  goalReached: z.number().int(),
  conversationsStarted: z.number().int(),
};

const ResultCountsSchema = z.object({
  ...Counts,
  clicks: z.record(z.string(), z.number().int()),
});

export const CampaignSchema = z
  .object({
    id: z.string(),
    status: z.enum(CAMPAIGN_STATUSES),
    version: z.number().int(),
    definition: CampaignDefinitionSchema,
    // Every result since it started, all variants together.
    totals: ResultCountsSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    liveAt: z.string().nullable(),
    endedAt: z.string().nullable(),
  })
  .openapi("Campaign");

export const CampaignResultsSchema = z
  .object({
    days: z.array(
      ResultCountsSchema.extend({
        day: z.string(),
        // The A/B variant, or null without variants.
        variant: z.string().nullable(),
      }),
    ),
    variants: z.array(ResultCountsSchema.extend({ variant: z.string().nullable() })),
  })
  .openapi("CampaignResults");

export const ResultsQuery = z.object({
  from: z.iso.date().optional().openapi({ description: "The first day, in UTC" }),
  to: z.iso.date().optional().openapi({ description: "The last day, in UTC" }),
});

export const CampaignListQuery = z.object({ status: z.enum(CAMPAIGN_STATUSES).optional() });

const DataSchema = z
  .record(
    z.string().regex(/^\w{1,40}$/),
    z.union([z.string().max(DATA_VALUE_LENGTH_MAX), z.number(), z.boolean()]),
  )
  .refine((data) => Object.keys(data).length <= DATA_KEYS_MAX, `At most ${DATA_KEYS_MAX} keys`)
  .openapi({ description: "Values for `{{ data.<key> }}` in the text" });

export const CampaignSendSchema = z.object({
  clientId: ClientId.openapi({
    description: "Your own ID for this send. A retry with the same one answers the first result",
  }),
  visitor: VisitorSelector,
  data: DataSchema.optional(),
});

export const CampaignSettingsSchema = z
  .object({
    paused: z.boolean().openapi({ description: "Every campaign's messages wait while true" }),
    gapHours: z.number().int().min(0).max(720).openapi({
      description: "The fewest hours between two campaign messages to one visitor. 0 turns it off",
    }),
  })
  .openapi("CampaignSettings");

export const CampaignSettingsView = CampaignSettingsSchema.extend({
  pausedBy: z.string().nullable().openapi({
    description: "The member or key who paused every campaign, by its name then, or null",
  }),
  pausedAt: z.string().nullable().openapi({ description: "When, or null while they run" }),
}).openapi("CampaignSettingsView");

export const EstimateSchema = z.object({
  audience: AudienceCondition.optional(),
  trigger: TriggerSchema.optional(),
});

/** Why a change to a campaign did not happen, by the error code its answer carries. */
export const CAMPAIGN_REFUSALS = {
  not_found: SEND_REFUSALS.not_found,
  key_taken: {
    status: 409,
    body: failure("campaign_key_taken", "Another campaign has this key."),
  },
  not_live: {
    status: 409,
    body: failure("campaign_not_live", "This campaign is not live. Resume it first."),
  },
  ended: {
    status: 409,
    body: failure("campaign_ended", "This campaign ended. Make a new one with another key."),
  },
  send_as_member_required: SEND_REFUSALS.send_as_member_required,
  send_email_required: SEND_REFUSALS.send_email_required,
  send_mode_required: SEND_REFUSALS.send_mode_required,
  unknown_member: SEND_REFUSALS.unknown_member,
} as const;
export type CampaignRefusal = keyof typeof CAMPAIGN_REFUSALS;
