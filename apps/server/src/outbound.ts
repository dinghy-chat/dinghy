import { z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Actor } from "./api-keys.ts";
import { gateOf, takeOver } from "./bots.ts";
import { type Condition, ConditionSchema, toSql } from "./conditions.ts";
import { upsertContact } from "./contacts.ts";
import {
  apiKey,
  type ChosenButton,
  conversation,
  event,
  IF_OPEN,
  OUTBOUND_SHOWS,
  OUTBOUND_STATUS_REASONS,
  OUTBOUND_STATUSES,
  type OutboundButton,
  type OutboundEventKind,
  type OutboundPayload,
  type OutboundStatusReason,
  operator,
  outboundMessage,
  outboundOnce,
  START_CONVERSATION,
  visitor,
  workspaceMember,
} from "./db/schema.ts";
import {
  type Database,
  type Transaction,
  withWorkspace,
  workspaceAccess,
  writable,
} from "./db/tenant.ts";
import { failure, NOT_FOUND } from "./errors.ts";
import {
  Body,
  ClientId,
  type ContactFields,
  Duration,
  OnceKey,
  UserId,
  VisitorSelector,
} from "./inputs.ts";
import { lockVisitors } from "./journey.ts";
import { OPERATORS, type Signals, wakeConversation } from "./live.ts";
import {
  type Author,
  appendMessage,
  assignConversation,
  lockWorkspace,
  nextSeq,
  type StatusActor,
  type StoredMessage,
  visitorConversation,
  wantsWebhook,
} from "./messages.ts";
import { DAY_MS, MINUTE_MS } from "./time.ts";

// An outbound message is a message from the team to one visitor, which may exist before any
// conversation. The REST API, MCP, a member by hand and the worker all go through this module, and
// every way into a conversation goes through materializeOutbound.

/** Messages that wait for one visitor at once. */
const WAITING_PER_VISITOR = 5;
/** How long a message waits for the visitor after it becomes pending, unless the send says. */
const EXPIRES_AFTER_MS = 30 * DAY_MS;
/** How soon the worker looks again at a message that waits for something that can change. */
const RECHECK_MS = MINUTE_MS;
/** How long an ended message keeps its text. Its row stays, for `once`. */
const BODY_KEPT_MS = 30 * DAY_MS;
const BUTTONS_MAX = 4;
const PAGE_SIZE_MAX = 100;

/** The statuses in which a message still waits for the visitor. */
const WAITING_STATUSES = ["scheduled", "pending", "delivered", "read"] as const;
/** The statuses a cancel or an expiry may end: the visitor has not read it. */
const UNREAD_STATUSES = ["scheduled", "pending", "delivered"] as const;
/** The statuses in which the widget shows a message. */
const SHOWN_STATUSES = ["pending", "delivered", "read"] as const;

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

/** A chosen button, as the visitor's message and the events carry it. */
export const ChosenButtonSchema = z
  .object({ value: z.string().nullable(), label: z.string() })
  .openapi("ChosenButton");

const SenderSchema = z
  .union([
    z.literal("team"),
    z.strictObject({ operatorId: z.uuid() }),
    z.strictObject({ email: z.email() }),
  ])
  .openapi("OutboundSender", {
    description:
      "`\"team\"`: the workspace's name and logo. `{ operatorId }` or `{ email }`: a member, with their name and picture; a key needs the permission `send_as_member`. Left out: the key's name, or the member who sends it.",
  });

/** Who a cancel by `once` is for, by user ID or visitor ID. It creates nobody. */
export const VisitorRef = z
  .union([z.strictObject({ userId: UserId }), z.strictObject({ id: z.uuid() })])
  .openapi("VisitorRef");
type VisitorRef = z.infer<typeof VisitorRef>;

/** What a send takes, through REST and MCP. */
export const SendSchema = z
  .object({
    clientId: ClientId.openapi({
      description: "Your own ID for this send. A retry with the same one answers the first result",
    }),
    visitor: VisitorSelector,
    body: Body,
    buttons: z.array(ButtonSchema).max(BUTTONS_MAX).optional(),
    sender: SenderSchema.optional(),
    assign: z.boolean().optional().openapi({
      description:
        "Assign the conversation to the member sender when the visitor answers. True by default with a member sender",
    }),
    startConversation: z.enum(START_CONVERSATION).default("on_reply"),
    show: z.enum(OUTBOUND_SHOWS).default("badge"),
    ifOpen: z.enum(IF_OPEN).default("hold"),
    once: OnceKey.optional().openapi({
      description:
        "A dedupe key, unique per visitor. A repeat answers the first outbound message. A cancel frees it",
    }),
    sendAt: z.iso.datetime().optional(),
    delay: Duration.optional(),
    unless: ConditionSchema.optional(),
    expiresAt: z.iso.datetime().optional(),
    email: z.boolean().default(false),
  })
  .refine((input) => input.sendAt === undefined || input.delay === undefined, {
    message: "Give sendAt or delay, not both",
  });
export type SendInput = z.infer<typeof SendSchema>;

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
    ifOpen: z.enum(IF_OPEN),
    startConversation: z.enum(START_CONVERSATION),
    assign: z.boolean(),
    email: z.boolean(),
    conversationId: z.string().nullable(),
    messageId: z.string().nullable(),
    once: z.string().nullable(),
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
type OutboundView = z.infer<typeof OutboundMessageSchema>;

/** A list's filters and its page. */
export const ListQuery = z.object({
  visitorId: z.uuid().optional(),
  status: z.enum(OUTBOUND_STATUSES).optional(),
  apiKeyId: z.uuid().optional(),
  cursor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z,[0-9a-f-]{36}$/)
    .optional()
    .openapi({ description: "The `next` of the page before" }),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(50),
});
type ListFilter = z.infer<typeof ListQuery>;

type Row = typeof outboundMessage.$inferSelect;

/** A send that did not go, by the error code its answer carries. */
export type SendRefusal =
  | "send_mode_required"
  | "send_as_member_required"
  | "bots_paused"
  | "blocked"
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
  bots_paused: {
    status: 409,
    body: failure(
      "bots_paused",
      "An owner or admin paused every bot of this workspace. Only people send until they resume.",
    ),
  },
  blocked: { status: 403, body: failure("blocked", "The team blocked this visitor.") },
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

// Events -------------------------------------------------------------------------------------------

/** Records a change of an outbound message. The worker sends its webhooks. */
async function record(
  tx: Transaction,
  workspaceId: string,
  row: Pick<Row, "id" | "visitorId">,
  kind: OutboundEventKind,
): Promise<void> {
  const seq = await nextSeq(tx, workspaceId);
  await tx.insert(event).values({
    workspaceId,
    seq,
    kind,
    payload: { outboundMessageId: row.id, visitorId: row.visitorId } satisfies OutboundPayload,
    needsWebhook: wantsWebhook(workspaceId),
  });
}

const ofRow = (workspaceId: string, id: string) =>
  and(eq(outboundMessage.workspaceId, workspaceId), eq(outboundMessage.id, id));

/**
 * Updates one row and answers it as it is now. It changes the row only while its status and its
 * conversation are still those the caller read, so a stale row never overwrites a cancel, a reply or
 * a conversation.
 */
async function change(
  tx: Transaction,
  workspaceId: string,
  row: Row,
  values: Partial<typeof outboundMessage.$inferInsert>,
  kind?: OutboundEventKind,
): Promise<Row> {
  const [changed] = await tx
    .update(outboundMessage)
    .set(values)
    .where(
      and(
        ofRow(workspaceId, row.id),
        eq(outboundMessage.status, row.status),
        row.conversationId === null
          ? isNull(outboundMessage.conversationId)
          : eq(outboundMessage.conversationId, row.conversationId),
      ),
    )
    .returning();
  if (changed === undefined) throw new Error("The outbound message changed since it was read");
  if (kind !== undefined) await record(tx, workspaceId, changed, kind);
  return changed;
}

/** Ends a message that waited: cancelled, and its `once` key free again, or expired. */
async function end(
  tx: Transaction,
  workspaceId: string,
  row: Row,
  outcome: { status: "cancelled"; reason: OutboundStatusReason } | { status: "expired" },
): Promise<Row> {
  if (outcome.status === "expired") {
    return change(
      tx,
      workspaceId,
      row,
      { status: "expired", dueAt: null },
      "outbound_message.expired",
    );
  }
  await tx
    .delete(outboundOnce)
    .where(
      and(eq(outboundOnce.workspaceId, workspaceId), eq(outboundOnce.outboundMessageId, row.id)),
    );
  return change(
    tx,
    workspaceId,
    row,
    { status: "cancelled", statusReason: outcome.reason, cancelledAt: new Date(), dueAt: null },
    "outbound_message.cancelled",
  );
}

/** A message whose time ran out before the visitor read it: it ends as expired, and goes nowhere. */
const hasExpired = (row: Row) =>
  row.conversationId === null &&
  UNREAD_STATUSES.some((status) => status === row.status) &&
  row.expiresAt !== null &&
  row.expiresAt.getTime() <= Date.now();

// The rule ---------------------------------------------------------------------------------------

/** What a message may do now, from everything that can stop it. */
export interface Situation {
  writable: boolean;
  blocked: boolean;
  botsPaused: boolean;
  /** The key that sent it, or null for a member's. */
  key: { revoked: boolean; replyMode: "send" | "draft"; mayActAsMember: boolean } | null;
  /** Whether the member it shows as is still on the team. True for any other sender. */
  senderActive: boolean;
  /** The visitor's open conversation, or null. */
  open: { id: string; humanSince: Date | null } | null;
  /** The `unless` condition matches the contact now. */
  unlessMatched: boolean;
}

export type Verdict =
  | { kind: "go" }
  | { kind: "join"; conversationId: string }
  | { kind: "wait"; reason: OutboundStatusReason }
  | { kind: "cancel"; reason: OutboundStatusReason };

/**
 * The one decision for a message about to show or go in a conversation. A check that can change,
 * such as paused bots, makes it wait. One that holds for good, such as `unless`, cancels it. A key's
 * message follows the reply gate: it never joins a conversation that a person handles.
 */
export function decide(
  message: Pick<Row, "authorApiKeyId" | "senderKind" | "ifOpen">,
  now: Situation,
): Verdict {
  if (now.blocked) return { kind: "cancel", reason: "blocked" };
  if (now.unlessMatched) return { kind: "cancel", reason: "unless_matched" };
  if (now.key?.revoked === true || !now.senderActive) {
    return { kind: "cancel", reason: "permission_revoked" };
  }
  if (!now.writable) return { kind: "wait", reason: "workspace_inactive" };
  if (message.senderKind === "member" && now.key !== null && !now.key.mayActAsMember) {
    return { kind: "wait", reason: "permission_revoked" };
  }
  if (now.open !== null && message.ifOpen === "skip") {
    return { kind: "cancel", reason: "open_conversation_skipped" };
  }
  if (now.open !== null && message.ifOpen === "hold") {
    return { kind: "wait", reason: "open_conversation" };
  }
  if (message.authorApiKeyId !== null) {
    const gate = gateOf({
      botsPaused: now.botsPaused,
      replyMode: now.key?.replyMode,
      humanSince: now.open?.humanSince ?? null,
    });
    if (gate === "draft") return { kind: "wait", reason: "permission_revoked" };
    if (gate !== "send") return { kind: "wait", reason: gate };
  }
  return now.open === null ? { kind: "go" } : { kind: "join", conversationId: now.open.id };
}

/** Whether a condition matches one contact now: the same SQL as the contacts filter. */
async function matches(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  condition: unknown,
) {
  const [row] = await tx
    .select({ matched: sql<boolean>`${toSql(condition as Condition)}` })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  return row?.matched === true;
}

/** Reads what decides a message now. The caller holds the workspace lock. */
async function situation(
  tx: Transaction,
  workspaceId: string,
  row: Row,
  botsPaused: boolean,
  checkUnless: boolean,
): Promise<Situation> {
  const [who] = await tx
    .select({ blockedAt: visitor.blockedAt })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, row.visitorId)));
  const [open] = await tx
    .select({ id: conversation.id, humanSince: conversation.humanSince })
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.visitorId, row.visitorId),
        eq(conversation.status, "open"),
      ),
    )
    .orderBy(desc(conversation.createdAt))
    .limit(1);
  return {
    writable: writable(await workspaceAccess(tx, workspaceId)),
    blocked: who === undefined || who.blockedAt !== null,
    botsPaused,
    key: row.authorApiKeyId === null ? null : await keyState(tx, workspaceId, row.authorApiKeyId),
    senderActive:
      row.senderOperatorId === null || (await isMember(tx, workspaceId, row.senderOperatorId)),
    open: open ?? null,
    unlessMatched:
      checkUnless &&
      row.unless !== null &&
      (await matches(tx, workspaceId, row.visitorId, row.unless)),
  };
}

async function keyState(tx: Transaction, workspaceId: string, apiKeyId: string) {
  const [key] = await tx
    .select({
      revokedAt: apiKey.revokedAt,
      replyMode: apiKey.replyMode,
      permissions: apiKey.permissions,
    })
    .from(apiKey)
    .where(and(eq(apiKey.workspaceId, workspaceId), eq(apiKey.id, apiKeyId)));
  if (key === undefined)
    return { revoked: true, replyMode: "draft" as const, mayActAsMember: false };
  return {
    revoked: key.revokedAt !== null,
    replyMode: key.replyMode,
    mayActAsMember: key.permissions.includes("send_as_member"),
  };
}

async function isMember(tx: Transaction, workspaceId: string, operatorId: string) {
  const [member] = await tx
    .select({ id: workspaceMember.operatorId })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.operatorId, operatorId),
        isNull(workspaceMember.removedAt),
      ),
    );
  return member !== undefined;
}

// Into a conversation ----------------------------------------------------------------------------

/** The message author for an outbound message, in this conversation. */
const authorOf = (row: Row, conversationId: string): Author =>
  row.authorApiKeyId !== null
    ? { kind: "key", apiKeyId: row.authorApiKeyId, conversationId }
    : { kind: "operator", operatorId: row.authorOperatorId ?? "", conversationId };

/** Who reopens a closed conversation for an outbound message: its author. */
const opener = (row: Row): StatusActor =>
  row.authorApiKeyId !== null
    ? { kind: "key", apiKeyId: row.authorApiKeyId }
    : { kind: "operator", operatorId: row.authorOperatorId ?? "" };

/** Who the visitor sees on the message, when not its author. */
const senderMark = (row: Row) =>
  row.senderKind === "team"
    ? ("team" as const)
    : row.senderKind === "member" && row.senderOperatorId !== null
      ? { operatorId: row.senderOperatorId }
      : null;

/**
 * Puts an outbound message in the visitor's conversation, the one way any path does it: their open
 * one, the newest closed one reopened, or a new one, then the message with the stable client ID
 * `outbound:<id>`, so a second tab or a retry adds nothing. It reads the row again under the
 * workspace lock and checks that it may still go in and belongs to this visitor, as a stale widget
 * can name a cancelled message. `answer` is the visitor's answer, which needs a recorded read of an
 * `on_reply` message. Null when it does not go in.
 */
export async function materializeOutbound(
  tx: Transaction,
  workspaceId: string,
  outboundMessageId: string,
  visitorId: string,
  { answer }: { answer: boolean },
): Promise<StoredMessage | null> {
  await lockWorkspace(tx, workspaceId);
  const [row] = await tx
    .select()
    .from(outboundMessage)
    .where(ofRow(workspaceId, outboundMessageId))
    .for("update");
  if (row === undefined || row.visitorId !== visitorId || row.conversationId !== null) return null;
  if (!WAITING_STATUSES.some((status) => status === row.status) || row.body === null) return null;
  if (answer && row.startConversation === "on_reply" && row.readAt === null) return null;
  if (hasExpired(row)) {
    await end(tx, workspaceId, row, { status: "expired" });
    return null;
  }
  const reopenedBy: StatusActor = answer ? { kind: "visitor", visitorId } : opener(row);
  const target = await visitorConversation(tx, workspaceId, { kind: "visitor", visitorId }, null, {
    reopenedBy,
  });
  const appended = await appendMessage(tx, workspaceId, authorOf(row, target.id), {
    clientId: `outbound:${row.id}`,
    body: row.body,
    source: {
      via: "outbound",
      outbound: { id: row.id, email: row.email, sender: senderMark(row) },
      mcp: row.via === "mcp",
    },
  });
  await change(tx, workspaceId, row, {
    conversationId: target.id,
    messageId: appended.message.id,
    statusReason: null,
    dueAt: null,
  });
  return appended.message;
}

/**
 * Moves a message on as far as it can go now: at its send time it becomes pending, and one with
 * `startConversation: now` goes in a conversation. One whose time ran out first expires. The caller
 * holds the workspace lock and the row.
 */
async function advance(
  tx: Transaction,
  workspaceId: string,
  row: Row,
  botsPaused: boolean,
): Promise<Row> {
  if (hasExpired(row)) return end(tx, workspaceId, row, { status: "expired" });
  const scheduled = row.status === "scheduled";
  const now = await situation(tx, workspaceId, row, botsPaused, scheduled);
  // An `on_reply` message waits for the widget, which decides about an open conversation when it
  // would show.
  const showsLater = row.startConversation === "on_reply";
  const verdict = decide(row, showsLater ? { ...now, open: null } : now);
  if (verdict.kind === "cancel") {
    return end(tx, workspaceId, row, { status: "cancelled", reason: verdict.reason });
  }
  if (verdict.kind === "wait" && (scheduled || !showsLater)) {
    return change(tx, workspaceId, row, {
      statusReason: verdict.reason,
      dueAt: new Date(Date.now() + RECHECK_MS),
    });
  }
  const pending = scheduled ? await becomePending(tx, workspaceId, row) : row;
  if (showsLater || verdict.kind === "wait") {
    const reason = verdict.kind === "wait" ? verdict.reason : null;
    return change(tx, workspaceId, pending, { statusReason: reason, dueAt: null });
  }
  await materializeOutbound(tx, workspaceId, row.id, row.visitorId, { answer: false });
  return (await findRow(tx, workspaceId, row.id)) ?? pending;
}

const becomePending = (tx: Transaction, workspaceId: string, row: Row) =>
  change(
    tx,
    workspaceId,
    row,
    {
      status: "pending",
      statusReason: null,
      dueAt: null,
      expiresAt: row.expiresAt ?? new Date(Date.now() + EXPIRES_AFTER_MS),
    },
    "outbound_message.pending",
  );

async function findRow(tx: Transaction, workspaceId: string, id: string) {
  const [row] = await tx.select().from(outboundMessage).where(ofRow(workspaceId, id));
  return row;
}

/**
 * The rows a write will change, read again under the workspace lock when there are any, so a change
 * that committed while this waited for the lock is seen. A visitor with none takes no lock.
 */
async function underLock(tx: Transaction, workspaceId: string, read: () => Promise<Row[]>) {
  if ((await read()).length === 0) return { rows: [], botsPaused: false };
  const { botsPaused } = await lockWorkspace(tx, workspaceId);
  return { rows: await read(), botsPaused };
}

/** A value button of one of this visitor's messages, which a visitor's answer carries. */
export interface ButtonAnswer {
  outboundMessageId: string;
  /** Its place in the message's buttons, from 0. */
  index: number;
}

/** The button, when this visitor's message has one at that place. */
async function buttonOf(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  { outboundMessageId, index }: ButtonAnswer,
): Promise<{ row: Row; button: OutboundButton } | null> {
  const row = await findRow(tx, workspaceId, outboundMessageId);
  const button = row?.metadata.buttons?.[index];
  if (row === undefined || row.visitorId !== visitorId || button === undefined) return null;
  return { row, button };
}

/** A button that answers with its label, rather than opening a page or dismissing. */
const answersWith = (button: OutboundButton) => !("url" in button) && !("dismiss" in button);

const chosen = (button: OutboundButton): ChosenButton => ({
  value: button.value ?? null,
  label: button.label,
});

/**
 * A visitor's message, the one way it goes in: first every outbound message the visitor read and
 * names, in the order they read them, then the message, then what it answered. A button answers
 * with its label, and the message carries the button. An answer to a message sent as a member
 * assigns the conversation to that member, so a person handles it from then.
 */
export async function appendVisitorMessage(
  tx: Transaction,
  workspaceId: string,
  author: Extract<Author, { kind: "visitor" }>,
  input: Parameters<typeof appendMessage>[3],
  answering: { outboundIds: string[]; button?: ButtonAnswer | undefined } = { outboundIds: [] },
  limits?: Parameters<typeof appendMessage>[4],
) {
  const { visitorId } = author;
  const pressed =
    answering.button === undefined
      ? null
      : await buttonOf(tx, workspaceId, visitorId, answering.button);
  if (pressed !== null) await readOutbound(tx, workspaceId, visitorId, pressed.row.id);
  const named = [
    ...new Set([...answering.outboundIds, ...(pressed === null ? [] : [pressed.row.id])]),
  ];
  const read =
    named.length === 0
      ? []
      : await tx
          .select({ id: outboundMessage.id })
          .from(outboundMessage)
          .where(
            and(
              eq(outboundMessage.workspaceId, workspaceId),
              eq(outboundMessage.visitorId, visitorId),
              inArray(outboundMessage.id, named),
            ),
          )
          .orderBy(asc(outboundMessage.readAt));
  for (const one of read) {
    await materializeOutbound(tx, workspaceId, one.id, visitorId, { answer: true });
  }
  const button =
    pressed !== null && answersWith(pressed.button) ? chosen(pressed.button) : undefined;
  const appended = await appendMessage(
    tx,
    workspaceId,
    author,
    { ...input, ...(button !== undefined && { body: button.label, button }) },
    limits,
  );
  if (appended.created) {
    await markAnswered(tx, workspaceId, appended.message.conversationId, pressed?.row.id, button);
  }
  return appended;
}

/** The visitor answered in this conversation: its outbound messages that waited are replied. */
async function markAnswered(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  pressedId: string | undefined,
  button: ChosenButton | undefined,
) {
  const answered = await tx
    .select()
    .from(outboundMessage)
    .where(
      and(
        eq(outboundMessage.workspaceId, workspaceId),
        eq(outboundMessage.conversationId, conversationId),
        inArray(outboundMessage.status, [...SHOWN_STATUSES]),
      ),
    )
    .orderBy(asc(outboundMessage.createdAt));
  for (const row of answered) {
    await change(
      tx,
      workspaceId,
      row,
      {
        status: "replied",
        repliedAt: new Date(),
        ...(row.id === pressedId &&
          button !== undefined && {
            metadata: { ...row.metadata, chosen: button },
          }),
      },
      "outbound_message.replied",
    );
  }
  const member = answered.findLast((row) => row.assign)?.senderOperatorId ?? null;
  if (member === null || !(await isMember(tx, workspaceId, member))) return;
  const [current] = await tx
    .select({ assignee: conversation.assigneeOperatorId })
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), eq(conversation.id, conversationId)));
  if (current?.assignee !== member) {
    await assignConversation(tx, workspaceId, conversationId, member);
  }
  await takeOver(tx, workspaceId, conversationId);
}

/**
 * Records the visitor's first read of a message that the widget showed, after checking that it is
 * theirs and still waits. A repeat changes nothing. Null when it is not theirs or ended.
 */
async function readOutbound(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  id: string,
): Promise<Row | null> {
  await lockWorkspace(tx, workspaceId);
  const [row] = await tx.select().from(outboundMessage).where(ofRow(workspaceId, id)).for("update");
  if (row === undefined || row.visitorId !== visitorId) return null;
  if (!SHOWN_STATUSES.some((status) => status === row.status)) return null;
  if (row.readAt !== null) return row;
  return change(
    tx,
    workspaceId,
    row,
    { status: "read", readAt: new Date(), deliveredAt: row.deliveredAt ?? new Date() },
    "outbound_message.read",
  );
}

/** The visitor's read position passed these replies: those that came from outbound are read. */
export async function readInConversation(
  tx: Transaction,
  workspaceId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  const { rows } = await underLock(tx, workspaceId, () =>
    tx
      .select()
      .from(outboundMessage)
      .where(
        and(
          eq(outboundMessage.workspaceId, workspaceId),
          inArray(outboundMessage.messageId, messageIds),
          isNull(outboundMessage.readAt),
        ),
      ),
  );
  for (const row of rows) {
    await change(
      tx,
      workspaceId,
      row,
      {
        readAt: new Date(),
        deliveredAt: row.deliveredAt ?? new Date(),
        ...(row.status === "pending" || row.status === "delivered" ? { status: "read" } : {}),
      },
      "outbound_message.read",
    );
  }
}

/**
 * A contact's fields changed: each scheduled message whose `unless` matches now is cancelled. The
 * caller holds the visitor's lock, which comes before the workspace's.
 */
export async function contactChanged(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
): Promise<void> {
  const { rows } = await underLock(tx, workspaceId, () =>
    tx
      .select()
      .from(outboundMessage)
      .where(
        and(
          eq(outboundMessage.workspaceId, workspaceId),
          eq(outboundMessage.visitorId, visitorId),
          eq(outboundMessage.status, "scheduled"),
          sql`${outboundMessage.unless} is not null`,
        ),
      ),
  );
  for (const row of rows) {
    if (await matches(tx, workspaceId, visitorId, row.unless)) {
      await end(tx, workspaceId, row, { status: "cancelled", reason: "unless_matched" });
    }
  }
}

/**
 * Conversations are being deleted: their outbound messages lose their text, and those that waited
 * for the visitor end, so none shows again. The caller holds the workspace lock.
 */
export async function conversationsDeleted(
  tx: Transaction,
  workspaceId: string,
  conversationIds: string[],
): Promise<void> {
  const rows = await tx
    .select()
    .from(outboundMessage)
    .where(
      and(
        eq(outboundMessage.workspaceId, workspaceId),
        inArray(outboundMessage.conversationId, conversationIds),
      ),
    )
    .for("update");
  for (const row of rows) {
    const waits = WAITING_STATUSES.some((status) => status === row.status);
    await change(
      tx,
      workspaceId,
      row,
      {
        body: null,
        ...(waits && {
          status: "cancelled",
          statusReason: "conversation_deleted",
          cancelledAt: new Date(),
          dueAt: null,
        }),
      },
      waits ? "outbound_message.cancelled" : undefined,
    );
  }
}

/** A message was deleted: the outbound message it came from loses its text too. */
export async function messageDeleted(
  tx: Transaction,
  workspaceId: string,
  messageId: string,
): Promise<void> {
  await tx
    .update(outboundMessage)
    .set({ body: null })
    .where(
      and(eq(outboundMessage.workspaceId, workspaceId), eq(outboundMessage.messageId, messageId)),
    );
}

// Views ------------------------------------------------------------------------------------------

const authorOperator = alias(operator, "author_operator");
const senderOperator = alias(operator, "sender_operator");

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Rows with the names of their authors and senders, in one query. */
async function withNames(
  tx: Transaction,
  workspaceId: string,
  where: ReturnType<typeof and>,
  limit: number,
) {
  return tx
    .select({
      row: outboundMessage,
      authorOperatorName: authorOperator.name,
      authorKeyName: apiKey.name,
      senderName: senderOperator.name,
    })
    .from(outboundMessage)
    .leftJoin(authorOperator, eq(authorOperator.id, outboundMessage.authorOperatorId))
    .leftJoin(
      apiKey,
      and(
        eq(apiKey.workspaceId, outboundMessage.workspaceId),
        eq(apiKey.id, outboundMessage.authorApiKeyId),
      ),
    )
    .leftJoin(senderOperator, eq(senderOperator.id, outboundMessage.senderOperatorId))
    .where(and(eq(outboundMessage.workspaceId, workspaceId), where))
    .orderBy(desc(outboundMessage.createdAt), desc(outboundMessage.id))
    .limit(limit);
}

type Named = Awaited<ReturnType<typeof withNames>>[number];

function view({ row, authorOperatorName, authorKeyName, senderName }: Named): OutboundView {
  return {
    id: row.id,
    status: row.status,
    statusReason: row.statusReason,
    visitorId: row.visitorId,
    body: row.body,
    buttons: row.metadata.buttons ?? [],
    button: row.metadata.chosen ?? null,
    sender:
      row.senderKind === "team"
        ? "team"
        : row.senderOperatorId === null
          ? null
          : { operatorId: row.senderOperatorId, name: senderName ?? "" },
    author:
      row.authorApiKeyId === null
        ? {
            kind: "operator",
            id: row.authorOperatorId ?? "",
            name: authorOperatorName ?? "",
            via: null,
          }
        : { kind: "key", id: row.authorApiKeyId, name: authorKeyName ?? "", via: row.via },
    show: row.show,
    ifOpen: row.ifOpen,
    startConversation: row.startConversation,
    assign: row.assign,
    email: row.email,
    conversationId: row.conversationId,
    messageId: row.messageId,
    once: row.onceKey,
    sendAt: row.sendAt.toISOString(),
    expiresAt: iso(row.expiresAt),
    deliveredAt: iso(row.deliveredAt),
    readAt: iso(row.readAt),
    repliedAt: iso(row.repliedAt),
    dismissedAt: iso(row.dismissedAt),
    cancelledAt: iso(row.cancelledAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/** One message as the API shows it. */
async function outboundView(tx: Transaction, workspaceId: string, id: string) {
  const [found] = await withNames(tx, workspaceId, eq(outboundMessage.id, id), 1);
  return found === undefined ? null : view(found);
}

/** Views of messages by ID, for the webhooks, in one query. */
export async function outboundViews(tx: Transaction, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, OutboundView>();
  const rows = await withNames(tx, workspaceId, inArray(outboundMessage.id, ids), ids.length);
  return new Map(rows.map((one) => [one.row.id, view(one)]));
}

/** A message the widget shows before it is in a conversation. */
export type WidgetOutbound = Pick<
  Row,
  "id" | "body" | "show" | "authorOperatorId" | "authorApiKeyId" | "createdAt" | "readAt"
> & { buttons: OutboundButton[]; sender: ReturnType<typeof senderMark> };

// The service --------------------------------------------------------------------------------------

type SendOutcome =
  | { kind: "sent"; created: boolean; outboundMessage: OutboundView }
  | { kind: "refused"; refusal: SendRefusal };

/** Where a send stands before its transaction: the key's mode and its permission. */
async function sendsAs(
  tx: Transaction,
  workspaceId: string,
  actor: Actor,
  sender: SendInput["sender"],
): Promise<{ senderKind: Row["senderKind"]; senderOperatorId: string | null } | SendRefusal> {
  if (sender === "team") return { senderKind: "team", senderOperatorId: null };
  if (sender === undefined) {
    return actor.kind === "key"
      ? { senderKind: "author", senderOperatorId: null }
      : { senderKind: "member", senderOperatorId: actor.operatorId };
  }
  if (actor.kind === "key") {
    const key = await keyState(tx, workspaceId, actor.apiKeyId);
    if (!key.mayActAsMember) return "send_as_member_required";
  }
  const [member] = await tx
    .select({ id: workspaceMember.operatorId })
    .from(workspaceMember)
    .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.removedAt),
        "operatorId" in sender
          ? eq(workspaceMember.operatorId, sender.operatorId)
          : sql`lower(${operator.email}) = lower(${sender.email})`,
      ),
    );
  return member === undefined
    ? "unknown_member"
    : { senderKind: "member", senderOperatorId: member.id };
}

/** The visitor a send names: created or updated by user ID, or found by ID. */
async function sendTarget(tx: Transaction, workspaceId: string, selector: VisitorSelector) {
  if ("id" in selector) {
    const [found] = await tx
      .select({ id: visitor.id })
      .from(visitor)
      .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, selector.id)));
    return found?.id ?? null;
  }
  const { userId, ...fields } = selector;
  const upserted = await upsertContact(tx, workspaceId, userId, fields, Date.now());
  if (upserted.changed) await contactChanged(tx, workspaceId, upserted.visitorId);
  return upserted.visitorId;
}

async function findByVisitorRef(tx: Transaction, workspaceId: string, ref: VisitorRef) {
  const [found] = await tx
    .select({ id: visitor.id })
    .from(visitor)
    .where(
      and(
        eq(visitor.workspaceId, workspaceId),
        "id" in ref ? eq(visitor.id, ref.id) : eq(visitor.userId, ref.userId),
      ),
    );
  return found?.id ?? null;
}

/** The existing message of this author and client ID, for a retry. */
async function retried(tx: Transaction, workspaceId: string, actor: Actor, clientId: string) {
  const [found] = await tx
    .select({ id: outboundMessage.id })
    .from(outboundMessage)
    .where(
      and(
        eq(outboundMessage.workspaceId, workspaceId),
        eq(outboundMessage.clientId, clientId),
        actor.kind === "key"
          ? eq(outboundMessage.authorApiKeyId, actor.apiKeyId)
          : eq(outboundMessage.authorOperatorId, actor.operatorId),
      ),
    );
  return found?.id;
}

async function waitingCount(tx: Transaction, workspaceId: string, visitorId: string) {
  return tx.$count(
    outboundMessage,
    and(
      eq(outboundMessage.workspaceId, workspaceId),
      eq(outboundMessage.visitorId, visitorId),
      inArray(outboundMessage.status, [...WAITING_STATUSES]),
      isNull(outboundMessage.conversationId),
    ),
  );
}

/** When a send goes out and when it stops waiting, or null when it would expire first. */
function timesOf(input: SendInput): { sendAt: Date; expiresAt: Date | null } | null {
  const now = Date.now();
  const sendAt = new Date(
    input.delay !== undefined
      ? now + input.delay
      : Math.max(now, input.sendAt === undefined ? now : Date.parse(input.sendAt)),
  );
  const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt);
  return expiresAt !== null && expiresAt <= sendAt ? null : { sendAt, expiresAt };
}

export function createOutbound({ db, live }: { db: Database; live: Signals }) {
  /** Wakes the operators, and the visitor's widget so it fetches its waiting messages. */
  const tell = (workspaceId: string, visitorId: string) => {
    wakeConversation(live, workspaceId, visitorId);
    live.tellVisitor(workspaceId, visitorId, { kind: "outbound" });
  };

  const read = (workspaceId: string, id: string) =>
    withWorkspace(db, workspaceId, (tx) => outboundView(tx, workspaceId, id));

  return {
    /** A send from a key or a member: one outbound message to one visitor. */
    async send(
      workspaceId: string,
      actor: Actor,
      input: SendInput,
      via: "mcp" | null = null,
    ): Promise<SendOutcome> {
      const times = timesOf(input);
      if (times === null) return { kind: "refused", refusal: "invalid_time" };
      const outcome = await withWorkspace(db, workspaceId, async (tx) => {
        const first = await retried(tx, workspaceId, actor, input.clientId);
        if (first !== undefined) return { created: false, id: first, visitorId: null };
        if (
          actor.kind === "key" &&
          (await keyState(tx, workspaceId, actor.apiKeyId)).replyMode === "draft"
        ) {
          return "send_mode_required" as const;
        }
        const as = await sendsAs(tx, workspaceId, actor, input.sender);
        if (typeof as === "string") return as;
        const visitorId = await sendTarget(tx, workspaceId, input.visitor);
        if (visitorId === null) return "not_found" as const;
        // The visitor's lock before the workspace's, as every write takes them, so two sends with one
        // `once` key take turns.
        await lockVisitors(tx, workspaceId, [visitorId]);
        const { botsPaused } = await lockWorkspace(tx, workspaceId);
        if (input.once !== undefined) {
          const [taken] = await tx
            .select({ id: outboundOnce.outboundMessageId })
            .from(outboundOnce)
            .where(
              and(
                eq(outboundOnce.workspaceId, workspaceId),
                eq(outboundOnce.visitorId, visitorId),
                eq(outboundOnce.onceKey, input.once),
              ),
            );
          if (taken !== undefined) return { created: false, id: taken.id, visitorId: null };
        }
        const scheduled = times.sendAt.getTime() > Date.now();
        if (actor.kind === "key" && botsPaused && !scheduled) return "bots_paused" as const;
        const [who] = await tx
          .select({ blockedAt: visitor.blockedAt })
          .from(visitor)
          .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
        if (who?.blockedAt != null) return "blocked" as const;
        if ((await waitingCount(tx, workspaceId, visitorId)) >= WAITING_PER_VISITOR) {
          return "too_many_waiting" as const;
        }
        const values: typeof outboundMessage.$inferInsert = {
          workspaceId,
          visitorId,
          ...(actor.kind === "key"
            ? { authorApiKeyId: actor.apiKeyId }
            : { authorOperatorId: actor.operatorId }),
          via,
          ...as,
          body: input.body,
          metadata: input.buttons === undefined ? {} : { buttons: input.buttons },
          startConversation: input.startConversation,
          show: input.show,
          ifOpen: input.ifOpen,
          assign: input.assign ?? as.senderKind === "member",
          email: input.email,
          onceKey: input.once ?? null,
          clientId: input.clientId,
          status: "scheduled",
          sendAt: times.sendAt,
          dueAt: times.sendAt,
          unless: input.unless ?? null,
          expiresAt: times.expiresAt,
        };
        const [row] = await tx.insert(outboundMessage).values(values).returning();
        if (row === undefined) throw new Error("The outbound insert returned no row");
        if (input.once !== undefined) {
          await tx
            .insert(outboundOnce)
            .values({ workspaceId, visitorId, onceKey: input.once, outboundMessageId: row.id });
        }
        if (!scheduled) await advance(tx, workspaceId, row, botsPaused);
        return { created: true, id: row.id, visitorId };
      });
      if (typeof outcome === "string") return { kind: "refused", refusal: outcome };
      if (outcome.visitorId !== null) tell(workspaceId, outcome.visitorId);
      const found = await read(workspaceId, outcome.id);
      if (found === null) throw new Error("The outbound message is missing");
      return { kind: "sent", created: outcome.created, outboundMessage: found };
    },

    /** Cancels a message that the visitor has not read. Answers it as it is, or null. */
    async cancel(
      workspaceId: string,
      target: { id: string } | { visitor: VisitorRef; once: string },
    ) {
      const ended = await withWorkspace(db, workspaceId, async (tx) => {
        const id = "id" in target ? target.id : await onceTarget(tx, workspaceId, target);
        if (id === null) return null;
        await lockWorkspace(tx, workspaceId);
        const [row] = await tx
          .select()
          .from(outboundMessage)
          .where(ofRow(workspaceId, id))
          .for("update");
        if (row === undefined) return null;
        const waits =
          row.conversationId === null && UNREAD_STATUSES.some((one) => one === row.status);
        if (waits)
          await end(tx, workspaceId, row, { status: "cancelled", reason: "cancelled_by_api" });
        return { id, visitorId: waits ? row.visitorId : null };
      });
      if (ended === null) return null;
      if (ended.visitorId !== null) tell(workspaceId, ended.visitorId);
      return read(workspaceId, ended.id);
    },

    get: read,

    /** A page of messages, newest first. */
    async list(workspaceId: string, filter: ListFilter) {
      const [time, id] = filter.cursor?.split(",") ?? [];
      const rows = await withWorkspace(db, workspaceId, (tx) =>
        withNames(
          tx,
          workspaceId,
          and(
            filter.visitorId === undefined
              ? undefined
              : eq(outboundMessage.visitorId, filter.visitorId),
            filter.status === undefined ? undefined : eq(outboundMessage.status, filter.status),
            filter.apiKeyId === undefined
              ? undefined
              : eq(outboundMessage.authorApiKeyId, filter.apiKeyId),
            time === undefined
              ? undefined
              : sql`(${outboundMessage.createdAt}, ${outboundMessage.id}) < (${time}::timestamptz, ${id}::uuid)`,
          ),
          filter.limit + 1,
        ),
      );
      const page = rows.slice(0, filter.limit).map(view);
      const last = page.at(-1);
      return {
        outboundMessages: page,
        next:
          rows.length > filter.limit && last !== undefined ? `${last.createdAt},${last.id}` : null,
      };
    },

    /** The contact upsert, which also checks the person's scheduled messages again. */
    async upsertContact(workspaceId: string, userId: string, fields: ContactFields) {
      return withWorkspace(db, workspaceId, async (tx) => {
        const upserted = await upsertContact(tx, workspaceId, userId, fields, Date.now());
        if (upserted.changed) await contactChanged(tx, workspaceId, upserted.visitorId);
        return upserted;
      });
    },

    /**
     * The messages the widget shows this visitor now, oldest first. Each is decided again: one that
     * may join the open conversation goes in it, one that waits stays hidden with its reason, and
     * one shown for the first time is delivered.
     */
    async waiting(workspaceId: string, visitorId: string): Promise<WidgetOutbound[]> {
      const result = await withWorkspace(db, workspaceId, async (tx) => {
        const { rows, botsPaused } = await underLock(tx, workspaceId, () =>
          shownRows(tx, workspaceId, visitorId),
        );
        const shown: WidgetOutbound[] = [];
        let joined = false;
        for (const row of rows) {
          const verdict = hasExpired(row)
            ? null
            : decide(row, await situation(tx, workspaceId, row, botsPaused, false));
          if (verdict === null) {
            await end(tx, workspaceId, row, { status: "expired" });
          } else if (verdict.kind === "cancel") {
            await end(tx, workspaceId, row, { status: "cancelled", reason: verdict.reason });
          } else if (verdict.kind === "wait") {
            if (row.statusReason !== verdict.reason)
              await change(tx, workspaceId, row, { statusReason: verdict.reason });
          } else if (verdict.kind === "join") {
            joined =
              (await materializeOutbound(tx, workspaceId, row.id, visitorId, { answer: false })) !==
                null || joined;
          } else {
            shown.push(widgetOutbound(await deliver(tx, workspaceId, row)));
          }
        }
        return { shown, joined };
      });
      if (result.joined) wakeConversation(live, workspaceId, visitorId);
      return result.shown;
    },

    /** How many messages wait to show, for the loader's beat. It reads only. */
    async waitingCount(workspaceId: string, visitorId: string): Promise<number> {
      return withWorkspace(
        db,
        workspaceId,
        async (tx) => (await shownRows(tx, workspaceId, visitorId)).length,
      );
    },

    /** The visitor read a message in the widget. False when it is not theirs or ended. */
    async read(workspaceId: string, visitorId: string, id: string): Promise<boolean> {
      const row = await withWorkspace(db, workspaceId, (tx) =>
        readOutbound(tx, workspaceId, visitorId, id),
      );
      if (row !== null) live.wake(workspaceId, OPERATORS);
      return row !== null;
    },

    /**
     * The visitor chose a button that opens a page or dismisses. A card shows its buttons, so this
     * records the read first. A dismiss ends the message. False when the button is not there.
     */
    async press(
      workspaceId: string,
      visitorId: string,
      answer: ButtonAnswer,
      kind: "dismiss" | "url",
    ): Promise<boolean> {
      const done = await withWorkspace(db, workspaceId, async (tx) => {
        const pressed = await buttonOf(tx, workspaceId, visitorId, answer);
        if (pressed === null || !(kind in pressed.button)) return false;
        const row = await readOutbound(tx, workspaceId, visitorId, pressed.row.id);
        if (row === null) return false;
        const metadata = { ...row.metadata, chosen: chosen(pressed.button) };
        if ("dismiss" in pressed.button) {
          await change(
            tx,
            workspaceId,
            row,
            { status: "dismissed", dismissedAt: new Date(), metadata, dueAt: null },
            "outbound_message.dismissed",
          );
        } else {
          await change(tx, workspaceId, row, { metadata });
        }
        return true;
      });
      if (done) live.wake(workspaceId, OPERATORS);
      return done;
    },
  };
}

export type Outbound = ReturnType<typeof createOutbound>;

/** The visitor's `on_reply` messages that wait to show, oldest first. */
const shownRows = (tx: Transaction, workspaceId: string, visitorId: string) =>
  tx
    .select()
    .from(outboundMessage)
    .where(
      and(
        eq(outboundMessage.workspaceId, workspaceId),
        eq(outboundMessage.visitorId, visitorId),
        inArray(outboundMessage.status, [...SHOWN_STATUSES]),
        isNull(outboundMessage.conversationId),
        eq(outboundMessage.startConversation, "on_reply"),
      ),
    )
    .orderBy(asc(outboundMessage.createdAt));

/** A message the widget fetched: delivered the first time, with its reason cleared. */
async function deliver(tx: Transaction, workspaceId: string, row: Row): Promise<Row> {
  if (row.status !== "pending") {
    return row.statusReason === null ? row : change(tx, workspaceId, row, { statusReason: null });
  }
  return change(
    tx,
    workspaceId,
    row,
    { status: "delivered", deliveredAt: new Date(), statusReason: null },
    "outbound_message.delivered",
  );
}

const widgetOutbound = (row: Row): WidgetOutbound => ({
  id: row.id,
  body: row.body,
  show: row.show,
  authorOperatorId: row.authorOperatorId,
  authorApiKeyId: row.authorApiKeyId,
  createdAt: row.createdAt,
  readAt: row.readAt,
  buttons: row.metadata.buttons ?? [],
  sender: senderMark(row),
});

async function onceTarget(
  tx: Transaction,
  workspaceId: string,
  { visitor: ref, once }: { visitor: VisitorRef; once: string },
) {
  const visitorId = await findByVisitorRef(tx, workspaceId, ref);
  if (visitorId === null) return null;
  const [found] = await tx
    .select({ id: outboundOnce.outboundMessageId })
    .from(outboundOnce)
    .where(
      and(
        eq(outboundOnce.workspaceId, workspaceId),
        eq(outboundOnce.visitorId, visitorId),
        eq(outboundOnce.onceKey, once),
      ),
    );
  return found?.id ?? null;
}

// The worker ---------------------------------------------------------------------------------------

/**
 * Moves on the messages whose time came: a send time, or a check again of one that waits. The
 * worker's role finds them across workspaces, and the app's role writes them, as they write
 * messages. Each row is claimed with SKIP LOCKED, so several workers share the work. True when it
 * did some.
 */
export async function runDueOutbound(
  finder: Database,
  writer: Database,
  live: Signals,
  limit: number,
): Promise<boolean> {
  const due = await finder
    .select({ workspaceId: outboundMessage.workspaceId, id: outboundMessage.id })
    .from(outboundMessage)
    .where(lte(outboundMessage.dueAt, sql`now()`))
    .orderBy(asc(outboundMessage.dueAt))
    .limit(limit);
  for (const { workspaceId, id } of due) {
    const moved = await withWorkspace(writer, workspaceId, async (tx) => {
      const { botsPaused } = await lockWorkspace(tx, workspaceId);
      const [row] = await tx
        .select()
        .from(outboundMessage)
        .where(and(ofRow(workspaceId, id), lte(outboundMessage.dueAt, sql`now()`)))
        .for("update", { skipLocked: true });
      return row === undefined ? null : advance(tx, workspaceId, row, botsPaused);
    });
    if (moved !== null) {
      wakeConversation(live, workspaceId, moved.visitorId);
      live.tellVisitor(workspaceId, moved.visitorId, { kind: "outbound" });
    }
  }
  return due.length > 0;
}

/** Ends the messages whose time ran out before the visitor read them. True when it ended some. */
export async function expireOutbound(
  finder: Database,
  writer: Database,
  live: Signals,
  limit: number,
): Promise<boolean> {
  const due = await finder
    .select({ workspaceId: outboundMessage.workspaceId, id: outboundMessage.id })
    .from(outboundMessage)
    .where(
      and(
        lte(outboundMessage.expiresAt, sql`now()`),
        inArray(outboundMessage.status, [...UNREAD_STATUSES]),
        isNull(outboundMessage.conversationId),
      ),
    )
    .limit(limit);
  for (const { workspaceId, id } of due) {
    await withWorkspace(writer, workspaceId, async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const [row] = await tx
        .select()
        .from(outboundMessage)
        .where(
          and(
            ofRow(workspaceId, id),
            inArray(outboundMessage.status, [...UNREAD_STATUSES]),
            isNull(outboundMessage.conversationId),
          ),
        )
        .for("update", { skipLocked: true });
      if (row !== undefined) await end(tx, workspaceId, row, { status: "expired" });
    });
    live.wake(workspaceId, OPERATORS);
  }
  return due.length > 0;
}

/**
 * Removes the text of messages that ended, or went in a conversation that keeps it, 30 days ago.
 * Their rows stay, for `once`. Answers how many it changed.
 */
export async function pruneOutboundBodies(db: Database, limit: number): Promise<number> {
  const result = await db.execute(sql`
    UPDATE outbound_message SET body = NULL
    WHERE (workspace_id, id) IN (
      SELECT workspace_id, id FROM outbound_message
      WHERE body IS NOT NULL AND created_at < now() - ${BODY_KEPT_MS}::float8 * interval '1 millisecond'
        AND (conversation_id IS NOT NULL OR status NOT IN ('scheduled', 'pending', 'delivered', 'read'))
        AND coalesce(replied_at, dismissed_at, cancelled_at, expires_at, created_at)
          < now() - ${BODY_KEPT_MS}::float8 * interval '1 millisecond'
      LIMIT ${limit})`);
  return result.rowCount ?? 0;
}
