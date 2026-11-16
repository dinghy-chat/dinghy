import { z } from "@hono/zod-openapi";
import { BUTTONS_MAX } from "../../../packages/widget/src/shared.ts";
import { ConditionSchema } from "./conditions.ts";
import {
  IF_CONVERSATION_OPEN,
  OUTBOUND_SHOWS,
  OUTBOUND_STATUS_REASONS,
  OUTBOUND_STATUSES,
  START_CONVERSATION,
} from "./db/schema.ts";
import { BOTS_PAUSED, failure, NOT_FOUND } from "./errors.ts";
import { Body, ClientId, DedupeKey, Duration, UserId, VisitorSelector } from "./inputs.ts";
import { TimeCursor } from "./pages.ts";

// What the outbound API takes and answers. The rules, the delivery and the service import these.

/** Messages that wait for one visitor at once. */
export const WAITING_PER_VISITOR = 5;
const PAGE_SIZE_MAX = 100;
const METADATA_KEYS_MAX = 20;
const METADATA_KEY_LENGTH_MAX = 40;
const METADATA_VALUE_LENGTH_MAX = 500;

/** The sender's own keys and values on a message. Dinghy never shows them to the visitor. */
export const OutboundMetadataSchema = z
  .record(z.string().min(1).max(METADATA_KEY_LENGTH_MAX), z.string().max(METADATA_VALUE_LENGTH_MAX))
  .refine((metadata) => Object.keys(metadata).length <= METADATA_KEYS_MAX, {
    message: `At most ${METADATA_KEYS_MAX} keys`,
  })
  .openapi("OutboundMetadata", {
    description: `Up to ${METADATA_KEYS_MAX} keys of up to ${METADATA_KEY_LENGTH_MAX} characters, each with text of up to ${METADATA_VALUE_LENGTH_MAX} characters, such as \`{ "orderId": "1042" }\`. It comes back on the outbound message, its webhooks and the event stream. The visitor never sees it`,
  });

const ButtonLabel = z.string().trim().min(1).max(40);
const ButtonValue = z.string().min(1).max(100);

export const ButtonSchema = z
  .union([
    z.strictObject({ label: ButtonLabel, value: ButtonValue }),
    z.strictObject({
      label: ButtonLabel,
      url: z.url({ protocol: /^https?$/ }),
      value: ButtonValue.optional(),
    }),
    z.strictObject({ label: ButtonLabel, dismiss: z.literal(true), value: ButtonValue.optional() }),
  ])
  .openapi("OutboundButton", {
    description:
      "`{ label, value }` answers with the label, and the visitor's message carries `button: { value, label }`. `{ label, url }` opens a page. `{ label, dismiss: true }` ends the message as `dismissed`.",
  });

/** A button by its place in a message's buttons, from 0. */
export const ButtonIndex = z
  .number()
  .int()
  .min(0)
  .max(BUTTONS_MAX - 1);

/** A chosen button, as the visitor's message and the events carry it. */
export const ChosenButtonSchema = z
  .object({ value: z.string().nullable(), label: z.string() })
  .openapi("ChosenButton");

export const SenderSchema = z
  .union([
    z.literal("team"),
    z.strictObject({ operatorId: z.uuid() }),
    z.strictObject({ email: z.email() }),
  ])
  .openapi("OutboundSender", {
    description:
      "`\"team\"`: the workspace's name and logo. `{ operatorId }` or `{ email }`: a member, with their name and picture; a key needs the permission `send_as_member`. Left out: the key's name, or the member who sends it.",
  });

/** Who a cancel by `dedupeKey` is for, by user ID or visitor ID. It creates nobody. */
export const VisitorRef = z
  .union([z.strictObject({ userId: UserId }), z.strictObject({ id: z.uuid() })])
  .openapi("VisitorRef");

/** What a send takes, through REST and MCP. */
export const SendSchema = z
  .object({
    clientId: ClientId.openapi({
      description:
        "Your own ID for this send, unique per author. It never expires: a retry with the same one answers the first result",
    }),
    visitor: VisitorSelector,
    body: Body,
    buttons: z.array(ButtonSchema).max(BUTTONS_MAX).optional(),
    sender: SenderSchema.optional(),
    assignOnReply: z.boolean().optional().openapi({
      description:
        "Assign the conversation to the member sender when the visitor answers. True by default with a member sender",
    }),
    startConversation: z.enum(START_CONVERSATION).default("on_reply"),
    show: z.enum(OUTBOUND_SHOWS).default("badge"),
    ifConversationOpen: z.enum(IF_CONVERSATION_OPEN).default("hold"),
    dedupeKey: DedupeKey.optional().openapi({
      description:
        "A key of your own, unique per visitor. A repeat answers the first outbound message. It also names the message for a cancel, which frees it",
    }),
    metadata: OutboundMetadataSchema.optional(),
    sendAt: z.iso.datetime().optional(),
    delay: Duration.optional(),
    unless: ConditionSchema.optional(),
    expiresAt: z.iso.datetime().optional(),
    expiresIn: Duration.optional().openapi({
      description:
        "How long after the send time it stops waiting, as `expiresAt` says it as a time",
    }),
    sendEmail: z.boolean().default(false),
  })
  .refine((input) => input.sendAt === undefined || input.delay === undefined, {
    message: "Give sendAt or delay, not both",
  })
  .refine((input) => input.expiresAt === undefined || input.expiresIn === undefined, {
    message: "Give expiresAt or expiresIn, not both",
  });

export const OutboundMessageSchema = z
  .object({
    id: z.string(),
    status: z.enum(OUTBOUND_STATUSES),
    // Why it waits, or why it was cancelled. Null otherwise.
    statusReason: z.enum(OUTBOUND_STATUS_REASONS).nullable(),
    visitorId: z.string(),
    // Its text. Null 30 days after it ended, or once its conversation or its message was deleted.
    body: z.string().nullable(),
    buttons: z.array(ButtonSchema),
    // The button the visitor chose, when they answered, dismissed or opened a page with one.
    button: ChosenButtonSchema.nullable(),
    metadata: OutboundMetadataSchema,
    sender: z
      .union([z.literal("team"), z.object({ operatorId: z.string(), name: z.string() })])
      .nullable(),
    // Who sent it: a member by hand, or an API key, with `via: "mcp"` through the MCP server.
    author: z.object({
      kind: z.enum(["operator", "key"]),
      id: z.string(),
      name: z.string(),
      via: z.enum(["mcp"]).nullable(),
    }),
    show: z.enum(OUTBOUND_SHOWS),
    ifConversationOpen: z.enum(IF_CONVERSATION_OPEN),
    startConversation: z.enum(START_CONVERSATION),
    assignOnReply: z.boolean(),
    sendEmail: z.boolean(),
    conversationId: z.string().nullable(),
    messageId: z.string().nullable(),
    // The campaign that made it, the schedule's run, and its A/B variant. Null otherwise.
    campaignId: z.string().nullable(),
    campaignRunId: z.string().nullable(),
    variant: z.string().nullable(),
    dedupeKey: z.string().nullable(),
    sendAt: z.string(),
    expiresAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    readAt: z.string().nullable(),
    repliedAt: z.string().nullable(),
    dismissedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("OutboundMessage");

/** A list's filters and its page. */
export const ListQuery = z.object({
  visitorId: z.uuid().optional(),
  userId: UserId.optional().openapi({
    description: "The messages of the contact with your user ID",
  }),
  dedupeKey: DedupeKey.optional(),
  status: z.enum(OUTBOUND_STATUSES).optional(),
  apiKeyId: z.uuid().optional(),
  campaignId: z.uuid().optional(),
  cursor: TimeCursor.optional().openapi({ description: "The `next` of the page before" }),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(50),
});

/** A send that did not go, by the error code its answer carries. */
type SendRefusal =
  | "send_mode_required"
  | "send_as_member_required"
  | "send_email_required"
  | "bots_paused"
  | "blocked"
  | "opted_out"
  | "too_many_waiting"
  | "not_found"
  | "unknown_member"
  | "invalid_time";

export const SEND_REFUSALS = {
  send_mode_required: {
    status: 403,
    body: failure(
      "send_mode_required",
      "This key drafts replies. Set it to Send directly in Settings > API & webhooks.",
    ),
  },
  send_as_member_required: {
    status: 403,
    body: failure(
      "send_as_member_required",
      "This key may not send as a member. Turn on May send as a member in Settings > API & webhooks.",
    ),
  },
  send_email_required: {
    status: 403,
    body: failure(
      "send_email_required",
      "This key may not send email. Turn on May email visitors in Settings > API & webhooks.",
    ),
  },
  bots_paused: { status: 409, body: BOTS_PAUSED },
  blocked: { status: 403, body: failure("blocked", "The team blocked this visitor.") },
  opted_out: {
    status: 409,
    body: failure(
      "opted_out",
      "This visitor turned off automatic messages in the chat's menu. A member can still write by hand.",
    ),
  },
  too_many_waiting: {
    status: 429,
    body: failure(
      "too_many_waiting",
      `This visitor has ${WAITING_PER_VISITOR} outbound messages waiting. Cancel one, or wait for them to end.`,
    ),
  },
  not_found: { status: 404, body: NOT_FOUND },
  unknown_member: {
    status: 400,
    body: failure("invalid_request", "The sender is not a member of this workspace."),
  },
  invalid_time: {
    status: 400,
    body: failure("invalid_request", "expiresAt must come after the send time."),
  },
} as const satisfies Record<SendRefusal, { status: number; body: ReturnType<typeof failure> }>;
