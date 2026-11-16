import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { chosenButton } from "../../../packages/widget/src/shared.ts";
import { takeOver } from "./bots.ts";
import { tally } from "./campaign-results.ts";
import { matchesContact } from "./conditions.ts";
import {
  type ChosenButton,
  conversation,
  type OutboundButton,
  outboundMessage,
  visitor,
} from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { toMs } from "./inputs.ts";
import {
  type Author,
  appendMessage,
  assignConversation,
  lockWorkspace,
  type StatusActor,
  visitorConversation,
} from "./messages.ts";
import {
  authorRef,
  change,
  decide,
  end,
  hasExpired,
  isMember,
  isOneOf,
  ofRow,
  SHOWN_STATUSES,
  situation,
  WAITING_STATUSES,
} from "./outbound-rules.ts";
import { DAY_MS, MINUTE_MS } from "./time.ts";

// How an outbound message reaches the visitor: the widget shows it, the visitor reads and answers
// it, and every way into a conversation goes through materializeOutbound.

type Row = typeof outboundMessage.$inferSelect;

/** How long a message waits for the visitor after it is sent, unless the send says. */
const EXPIRES_AFTER_MS = 30 * DAY_MS;
/** How soon the worker looks again at a message that waits for something that can change. */
const RECHECK_MS = MINUTE_MS;

/** Who the visitor sees on the message, when not its author. */
export const senderMark = (row: Pick<Row, "senderKind" | "senderOperatorId">) =>
  row.senderKind === "team"
    ? ("team" as const)
    : row.senderKind === "member" && row.senderOperatorId !== null
      ? { operatorId: row.senderOperatorId }
      : null;

async function findRow(tx: Transaction, workspaceId: string, id: string) {
  const [row] = await tx.select().from(outboundMessage).where(ofRow(workspaceId, id));
  return row;
}

/**
 * Puts an outbound message in the visitor's conversation, the one way any path does it: their open
 * one, the newest closed one reopened, or a new one, then the message with the stable client ID
 * `outbound:<id>`, so a second tab or a retry adds nothing. It reads the row again under the
 * workspace lock and checks that it may still go in and belongs to this visitor, as a stale widget
 * can name a cancelled message. `answer` is the visitor's answer, which needs a recorded read of an
 * `on_reply` message. A conversation it creates sends `conversation.created` with this message.
 * Null when it does not go in.
 */
export async function materializeOutbound(
  tx: Transaction,
  workspaceId: string,
  outboundMessageId: string,
  visitorId: string,
  { answer }: { answer: boolean },
): Promise<Awaited<ReturnType<typeof appendMessage>> | null> {
  await lockWorkspace(tx, workspaceId);
  const [row] = await tx
    .select()
    .from(outboundMessage)
    .where(ofRow(workspaceId, outboundMessageId))
    .for("update");
  if (row === undefined || row.visitorId !== visitorId || row.conversationId !== null) return null;
  if (!isOneOf(WAITING_STATUSES, row.status) || row.body === null) return null;
  if (answer && row.startConversation === "on_reply" && row.readAt === null) return null;
  if (hasExpired(row)) {
    await end(tx, workspaceId, row, { status: "expired" });
    return null;
  }
  const author = authorRef(row);
  const reopenedBy: StatusActor = answer ? { kind: "visitor", visitorId } : author;
  const target = await visitorConversation(tx, workspaceId, { kind: "visitor", visitorId }, null, {
    reopenedBy,
  });
  const appended = await appendMessage(
    tx,
    workspaceId,
    { ...author, conversationId: target.id },
    {
      clientId: `outbound:${row.id}`,
      body: row.body,
      conversationCreated: target.started === "created",
      source: {
        via: "outbound",
        outbound: {
          id: row.id,
          sendEmail: row.sendEmail,
          sender: senderMark(row),
          ...(row.buttons.length > 0 && { buttons: row.buttons }),
        },
        mcp: row.via === "mcp",
      },
    },
  );
  await change(tx, workspaceId, row, {
    conversationId: target.id,
    messageId: appended.message.id,
    statusReason: null,
    dueAt: null,
  });
  if (row.campaignId !== null && target.started === "created") {
    const { campaignId } = row;
    await tally(tx, workspaceId, { ...row, campaignId }, ["conversationsStarted"]);
  }
  return appended;
}

async function hasEmail(tx: Transaction, workspaceId: string, visitorId: string) {
  const [who] = await tx
    .select({ email: visitor.email })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  return who?.email != null;
}

/** An unread `on_reply` message whose time to go by email came: it goes in a conversation now. */
const emailIsDue = (row: Row) =>
  row.emailIfUnreadAt !== null &&
  row.emailIfUnreadAt.getTime() <= Date.now() &&
  row.readAt === null &&
  (row.status === "sent" || row.status === "delivered");

/**
 * Moves a message on as far as it can go now: at its send time it is sent, and one with
 * `startConversation: now` goes in a conversation. One whose time ran out first expires. The caller
 * holds the workspace lock and the row.
 */
export async function advance(
  tx: Transaction,
  workspaceId: string,
  row: Row,
  botsPaused: boolean,
): Promise<Row> {
  if (hasExpired(row)) return end(tx, workspaceId, row, { status: "expired" });
  if (emailIsDue(row) && !(await hasEmail(tx, workspaceId, row.visitorId))) {
    return change(tx, workspaceId, row, { dueAt: null });
  }
  const scheduled = row.status === "scheduled";
  const state = await situation(tx, workspaceId, row, { botsPaused, atSendTime: scheduled });
  // An `on_reply` message waits for the widget, which decides about an open conversation when it
  // would show, unless its time to go by email came.
  const showsLater = row.startConversation === "on_reply" && !emailIsDue(row);
  const verdict = decide(row, showsLater ? { ...state, open: null } : state);
  if (verdict.kind === "cancel") {
    return end(tx, workspaceId, row, { status: "cancelled", reason: verdict.reason });
  }
  // A scheduled message that may not go yet, or a `now` message that waits: the worker looks again.
  if (verdict.kind === "wait" && (scheduled || !showsLater)) {
    const { until = new Date(Date.now() + RECHECK_MS) } = verdict;
    return change(tx, workspaceId, row, { statusReason: verdict.reason, dueAt: until });
  }
  const sent = scheduled
    ? await becomeSent(tx, workspaceId, row, state.campaign?.emailIfUnread ?? null)
    : row;
  // An `on_reply` message is sent now and waits for the widget, with the reason it would not
  // show yet, and the worker comes back when it would go by email. A read one never does.
  if (showsLater || verdict.kind === "wait") {
    const reason = verdict.kind === "wait" ? verdict.reason : null;
    const dueAt = sent.readAt === null ? sent.emailIfUnreadAt : null;
    return change(tx, workspaceId, sent, { statusReason: reason, dueAt });
  }
  // A `now` message that may go: in the visitor's conversation at once.
  await materializeOutbound(tx, workspaceId, row.id, row.visitorId, { answer: false });
  return (await findRow(tx, workspaceId, row.id)) ?? sent;
}

/** A message that may go now: sent, and when its campaign asks, set to go by email if unread. */
function becomeSent(tx: Transaction, workspaceId: string, row: Row, emailIfUnread: string | null) {
  const now = Date.now();
  return change(
    tx,
    workspaceId,
    row,
    {
      status: "sent",
      statusReason: null,
      dueAt: null,
      sentAt: new Date(now),
      expiresAt: row.expiresAt ?? new Date(now + EXPIRES_AFTER_MS),
      emailIfUnreadAt:
        emailIfUnread === null || row.startConversation !== "on_reply"
          ? null
          : new Date(now + toMs(emailIfUnread)),
    },
    "outbound_message.sent",
  );
}

/**
 * The rows a write will change, read again under the workspace lock when there are any, so a change
 * that committed while this waited for the lock is seen. A visitor with none takes no lock.
 */
export async function underLock(tx: Transaction, workspaceId: string, read: () => Promise<Row[]>) {
  if ((await read()).length === 0) return { rows: [], botsPaused: false };
  const { botsPaused } = await lockWorkspace(tx, workspaceId);
  return { rows: await read(), botsPaused };
}

/** A button of one of this visitor's messages, by its place in the message's buttons. */
export interface ButtonRef {
  outboundMessageId: string;
  index: number;
}

/** The button, when this visitor's message has one at that place. */
export async function buttonOf(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  { outboundMessageId, index }: ButtonRef,
): Promise<{ row: Row; button: OutboundButton } | null> {
  const row = await findRow(tx, workspaceId, outboundMessageId);
  const button = row?.buttons[index];
  if (row === undefined || row.visitorId !== visitorId || button === undefined) return null;
  return { row, button };
}

/** A button that answers with its label, rather than opening a page or dismissing. */
const answersWith = (button: OutboundButton) => !("url" in button) && !("dismiss" in button);

/** Records the read of each message the visitor names, in the order they read them. */
async function readEach(tx: Transaction, workspaceId: string, visitorId: string, ids: Set<string>) {
  const read: Row[] = [];
  for (const id of ids) {
    const row = await readOutbound(tx, workspaceId, visitorId, id);
    if (row !== null) read.push(row);
  }
  return read.sort((a, b) => (a.readAt?.getTime() ?? 0) - (b.readAt?.getTime() ?? 0));
}

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
  answering: { outboundIds: string[]; button?: ButtonRef | undefined } = { outboundIds: [] },
  limits?: Parameters<typeof appendMessage>[4],
) {
  const { visitorId } = author;
  const pressed =
    answering.button === undefined
      ? null
      : await buttonOf(tx, workspaceId, visitorId, answering.button);
  const named = new Set([...answering.outboundIds, ...(pressed === null ? [] : [pressed.row.id])]);
  // The widget names only the messages it showed, so each is read now, even when the widget's own
  // read request failed.
  const read = await readEach(tx, workspaceId, visitorId, named);
  let conversationStarted = false;
  for (const one of read) {
    const put = await materializeOutbound(tx, workspaceId, one.id, visitorId, { answer: true });
    conversationStarted ||= put?.conversationStarted === true;
  }
  const button =
    pressed !== null && answersWith(pressed.button) && read.some((one) => one.id === pressed.row.id)
      ? chosenButton(pressed.button)
      : undefined;
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
  return { ...appended, conversationStarted: appended.conversationStarted || conversationStarted };
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
        // The answer's own button, or none for a typed answer, even after a link was opened.
        chosenButton: row.id === pressedId ? (button ?? null) : null,
      },
      "outbound_message.replied",
    );
  }
  const member =
    answered.findLast((row) => row.assignOnReply && row.senderOperatorId !== null)
      ?.senderOperatorId ?? null;
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
export async function readOutbound(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  id: string,
): Promise<Row | null> {
  await lockWorkspace(tx, workspaceId);
  const [row] = await tx.select().from(outboundMessage).where(ofRow(workspaceId, id)).for("update");
  if (row === undefined || row.visitorId !== visitorId) return null;
  if (!isOneOf(SHOWN_STATUSES, row.status)) return null;
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
        ...(row.status === "sent" || row.status === "delivered" ? { status: "read" } : {}),
      },
      "outbound_message.read",
    );
  }
}

/**
 * A contact's fields changed: each scheduled message whose `unless` matches now is cancelled. The
 * caller holds the visitor's lock, which comes before the workspace's.
 */
export async function recheckUnless(tx: Transaction, workspaceId: string, visitorId: string) {
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
    if (row.unless !== null && (await matchesContact(tx, workspaceId, visitorId, row.unless))) {
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
    const textless = await change(tx, workspaceId, row, { body: null });
    if (isOneOf(WAITING_STATUSES, row.status)) {
      // Through `end`, so its `dedupeKey` is free again, as with any cancel.
      await end(tx, workspaceId, textless, { status: "cancelled", reason: "conversation_deleted" });
    }
  }
}

// The widget ---------------------------------------------------------------------------------------

/** A message the widget shows before it is in a conversation. */
export type WidgetOutbound = Pick<
  Row,
  | "id"
  | "body"
  | "show"
  | "authorOperatorId"
  | "authorApiKeyId"
  | "createdAt"
  | "readAt"
  | "campaignId"
> & { buttons: OutboundButton[]; outbound: { sender: ReturnType<typeof senderMark> } };

/** The visitor's `on_reply` messages that wait to show, oldest first. */
export const shownRows = (tx: Transaction, workspaceId: string, visitorId: string) =>
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
export async function deliver(tx: Transaction, workspaceId: string, row: Row): Promise<Row> {
  if (row.status !== "sent") {
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

export const widgetOutbound = (row: Row): WidgetOutbound => ({
  id: row.id,
  body: row.body,
  show: row.show,
  authorOperatorId: row.authorOperatorId,
  authorApiKeyId: row.authorApiKeyId,
  createdAt: row.createdAt,
  readAt: row.readAt,
  campaignId: row.campaignId,
  buttons: row.buttons,
  outbound: { sender: senderMark(row) },
});
