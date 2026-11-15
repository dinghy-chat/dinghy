import type { z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { chosenButton } from "../../../packages/widget/src/shared.ts";
import type { Actor } from "./api-keys.ts";
import {
  apiKey,
  operator,
  outboundDedupe,
  outboundMessage,
  visitor,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import type { VisitorSelector } from "./inputs.ts";
import { lockVisitors } from "./journey.ts";
import { OPERATORS, type Signals, wakeConversation } from "./live.ts";
import { lockWorkspace } from "./messages.ts";
import {
  advance,
  type ButtonRef,
  buttonOf,
  deliver,
  materializeOutbound,
  readOutbound,
  shownRows,
  underLock,
  upsertContactAndRecheck,
  type WidgetOutbound,
  widgetOutbound,
} from "./outbound-delivery.ts";
import {
  authorRef,
  change,
  decide,
  end,
  endable,
  hasExpired,
  isBlocked,
  isEndable,
  type KeyState,
  keyState,
  ofRow,
  situation,
  WAITING_STATUSES,
} from "./outbound-rules.ts";
import {
  type ListQuery,
  type OutboundMessageSchema,
  type SEND_REFUSALS,
  type SendSchema,
  type VisitorRef,
  WAITING_PER_VISITOR,
} from "./outbound-schemas.ts";
import { beforeCursor, cursorTime } from "./pages.ts";
import { DAY_MS } from "./time.ts";

// An outbound message is a message from the team to one visitor, which may exist before any
// conversation. The REST API, MCP, a member by hand and the worker all go through this service.

/** How long an ended message keeps its text. Its row stays, for `dedupeKey`. */
const BODY_KEPT_MS = 30 * DAY_MS;

type Row = typeof outboundMessage.$inferSelect;
type OutboundView = z.infer<typeof OutboundMessageSchema>;
type SendInput = z.infer<typeof SendSchema>;
type SendRefusal = keyof typeof SEND_REFUSALS;

/** Wakes the operators, and the visitor's widget so it fetches its waiting messages. */
function tellOutbound(live: Signals, workspaceId: string, visitorId: string) {
  wakeConversation(live, workspaceId, visitorId);
  live.tellVisitor(workspaceId, visitorId, { kind: "outbound" });
}

/** A dismissed message in a conversation keeps no buttons, so a reload does not show them again. */
const dropButtons = (tx: Transaction, workspaceId: string, messageId: string) =>
  tx.execute(sql`
    UPDATE message SET metadata = jsonb_set(metadata, '{outbound,buttons}', '[]'::jsonb)
    WHERE workspace_id = ${workspaceId} AND id = ${messageId} AND metadata ? 'outbound'`);

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
      cursorAt: cursorTime(outboundMessage.createdAt),
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

function authorView({ row, authorOperatorName, authorKeyName }: Named): OutboundView["author"] {
  const author = authorRef(row);
  return author.kind === "key"
    ? { kind: "key", id: author.apiKeyId, name: authorKeyName ?? "", via: row.via }
    : { kind: "operator", id: author.operatorId, name: authorOperatorName ?? "", via: null };
}

function viewOf(named: Named): OutboundView {
  const { row, senderName } = named;
  return {
    id: row.id,
    status: row.status,
    statusReason: row.statusReason,
    visitorId: row.visitorId,
    body: row.body,
    buttons: row.buttons,
    button: row.chosenButton,
    metadata: row.metadata,
    sender:
      row.senderKind === "team"
        ? "team"
        : row.senderOperatorId === null
          ? null
          : { operatorId: row.senderOperatorId, name: senderName ?? "" },
    author: authorView(named),
    show: row.show,
    ifConversationOpen: row.ifConversationOpen,
    startConversation: row.startConversation,
    assignOnReply: row.assignOnReply,
    sendEmail: row.sendEmail,
    conversationId: row.conversationId,
    messageId: row.messageId,
    dedupeKey: row.dedupeKey,
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
  return found === undefined ? null : viewOf(found);
}

/** Views of messages by ID, for the webhooks, in one query. */
export async function outboundViews(tx: Transaction, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, OutboundView>();
  const rows = await withNames(tx, workspaceId, inArray(outboundMessage.id, ids), ids.length);
  return new Map(rows.map((one) => [one.row.id, viewOf(one)]));
}

// Sends --------------------------------------------------------------------------------------------

type SendOutcome =
  | { kind: "sent"; created: boolean; outboundMessage: OutboundView }
  | { kind: "refused"; refusal: SendRefusal };

/** Who the visitor sees on a send, after the key's permission to show a member. */
async function sendsAs(
  tx: Transaction,
  workspaceId: string,
  actor: Actor,
  key: KeyState | null,
  sender: SendInput["sender"],
): Promise<{ senderKind: Row["senderKind"]; senderOperatorId: string | null } | SendRefusal> {
  if (sender === "team") return { senderKind: "team", senderOperatorId: null };
  if (sender === undefined) {
    return actor.kind === "key"
      ? { senderKind: "author", senderOperatorId: null }
      : { senderKind: "member", senderOperatorId: actor.operatorId };
  }
  if (key !== null && !key.mayActAsMember) return "send_as_member_required";
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

async function findByVisitorRef(
  tx: Transaction,
  workspaceId: string,
  ref: z.infer<typeof VisitorRef>,
) {
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

/** The visitor a send names: created or updated by user ID, or found by ID. */
async function sendTarget(tx: Transaction, workspaceId: string, selector: VisitorSelector) {
  if ("id" in selector) return findByVisitorRef(tx, workspaceId, selector);
  const { userId, ...fields } = selector;
  return (await upsertContactAndRecheck(tx, workspaceId, userId, fields, Date.now())).visitorId;
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

/** The message that holds this visitor's `dedupeKey`. */
async function dedupeMessageId(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  dedupeKey: string,
) {
  const [found] = await tx
    .select({ id: outboundDedupe.outboundMessageId })
    .from(outboundDedupe)
    .where(
      and(
        eq(outboundDedupe.workspaceId, workspaceId),
        eq(outboundDedupe.visitorId, visitorId),
        eq(outboundDedupe.dedupeKey, dedupeKey),
      ),
    );
  return found?.id;
}

/**
 * The message a send answers instead of a new one: a retry's, or the one that holds its `dedupeKey`.
 * The caller holds the locks, so a retry that raced the first send past the first check sees it.
 */
async function existingSend(
  tx: Transaction,
  workspaceId: string,
  actor: Actor,
  input: SendInput,
  visitorId: string,
) {
  const first = await retried(tx, workspaceId, actor, input.clientId);
  if (first !== undefined || input.dedupeKey === undefined) return first;
  return dedupeMessageId(tx, workspaceId, visitorId, input.dedupeKey);
}

/** What the sending key may not do. A member by hand needs no permission for either. */
function keyRefusal(key: KeyState | null, input: SendInput): SendRefusal | null {
  if (key?.replyMode === "draft") return "send_mode_required";
  if (input.sendEmail && key !== null && !key.maySendEmail) return "send_email_required";
  return null;
}

/** The visitor's messages that a cancel or an expiry can still end, for the limit per visitor. */
const unreadCount = (tx: Transaction, workspaceId: string, visitorId: string) =>
  tx.$count(
    outboundMessage,
    and(
      eq(outboundMessage.workspaceId, workspaceId),
      eq(outboundMessage.visitorId, visitorId),
      endable,
    ),
  );

/** Why this visitor may not get a message now, or null. The caller holds the locks. */
async function refusal(
  tx: Transaction,
  workspaceId: string,
  visitorId: string,
  { actor, botsPaused, scheduled }: { actor: Actor; botsPaused: boolean; scheduled: boolean },
): Promise<SendRefusal | null> {
  if (actor.kind === "key" && botsPaused && !scheduled) return "bots_paused";
  if (await isBlocked(tx, workspaceId, visitorId)) return "blocked";
  if ((await unreadCount(tx, workspaceId, visitorId)) >= WAITING_PER_VISITOR) {
    return "too_many_waiting";
  }
  return null;
}

/** Inserts a new scheduled message, and its `dedupeKey`. */
async function insertOutbound(
  tx: Transaction,
  values: typeof outboundMessage.$inferInsert,
): Promise<Row> {
  const [row] = await tx.insert(outboundMessage).values(values).returning();
  if (row === undefined) throw new Error("The outbound insert returned no row");
  if (row.dedupeKey !== null) {
    await tx.insert(outboundDedupe).values({
      workspaceId: row.workspaceId,
      visitorId: row.visitorId,
      dedupeKey: row.dedupeKey,
      outboundMessageId: row.id,
    });
  }
  return row;
}

/** When a send goes out and when it stops waiting, or null when it would expire first. */
function timesOf(input: SendInput): { sendAt: Date; expiresAt: Date | null } | null {
  const now = Date.now();
  const sendAt = new Date(
    input.delay !== undefined
      ? now + input.delay
      : Math.max(now, input.sendAt === undefined ? now : Date.parse(input.sendAt)),
  );
  const expiresAt =
    input.expiresIn !== undefined
      ? new Date(sendAt.getTime() + input.expiresIn)
      : input.expiresAt === undefined
        ? null
        : new Date(input.expiresAt);
  return expiresAt !== null && expiresAt <= sendAt ? null : { sendAt, expiresAt };
}

async function dedupeTarget(
  tx: Transaction,
  workspaceId: string,
  { visitor: ref, dedupeKey }: { visitor: z.infer<typeof VisitorRef>; dedupeKey: string },
) {
  const visitorId = await findByVisitorRef(tx, workspaceId, ref);
  if (visitorId === null) return null;
  return (await dedupeMessageId(tx, workspaceId, visitorId, dedupeKey)) ?? null;
}

/** Applies a filter only when the list was given its value. */
const given = <T>(value: T | undefined, condition: (value: T) => SQL) =>
  value === undefined ? undefined : condition(value);

/** A list's filters and its cursor, as one condition. */
function listFilter(tx: Transaction, workspaceId: string, filter: z.infer<typeof ListQuery>) {
  const ofUser = (userId: string) =>
    tx
      .select({ id: visitor.id })
      .from(visitor)
      .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.userId, userId)));
  return and(
    given(filter.visitorId, (id) => eq(outboundMessage.visitorId, id)),
    given(filter.userId, (userId) => inArray(outboundMessage.visitorId, ofUser(userId))),
    given(filter.dedupeKey, (key) => eq(outboundMessage.dedupeKey, key)),
    given(filter.status, (status) => eq(outboundMessage.status, status)),
    given(filter.apiKeyId, (id) => eq(outboundMessage.authorApiKeyId, id)),
    beforeCursor(filter.cursor, outboundMessage.createdAt, outboundMessage.id),
  );
}

// The service --------------------------------------------------------------------------------------

export function createOutbound({ db, live }: { db: Database; live: Signals }) {
  const view = (workspaceId: string, id: string) =>
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
        const key = actor.kind === "key" ? await keyState(tx, workspaceId, actor.apiKeyId) : null;
        const refusedKey = keyRefusal(key, input);
        if (refusedKey !== null) return refusedKey;
        const as = await sendsAs(tx, workspaceId, actor, key, input.sender);
        if (typeof as === "string") return as;
        const visitorId = await sendTarget(tx, workspaceId, input.visitor);
        if (visitorId === null) return "not_found" as const;
        // The visitor's lock before the workspace's, as every write takes them, so two sends with one
        // `dedupeKey` take turns.
        await lockVisitors(tx, workspaceId, [visitorId]);
        const { botsPaused } = await lockWorkspace(tx, workspaceId);
        const existing = await existingSend(tx, workspaceId, actor, input, visitorId);
        if (existing !== undefined) return { created: false, id: existing, visitorId: null };
        const scheduled = times.sendAt.getTime() > Date.now();
        const refused = await refusal(tx, workspaceId, visitorId, { actor, botsPaused, scheduled });
        if (refused !== null) return refused;
        const row = await insertOutbound(tx, {
          workspaceId,
          visitorId,
          ...(actor.kind === "key"
            ? { authorApiKeyId: actor.apiKeyId }
            : { authorOperatorId: actor.operatorId }),
          via,
          ...as,
          body: input.body,
          buttons: input.buttons ?? [],
          metadata: input.metadata ?? {},
          startConversation: input.startConversation,
          show: input.show,
          ifConversationOpen: input.ifConversationOpen,
          assignOnReply: input.assignOnReply ?? as.senderKind === "member",
          sendEmail: input.sendEmail,
          dedupeKey: input.dedupeKey ?? null,
          clientId: input.clientId,
          status: "scheduled",
          sendAt: times.sendAt,
          dueAt: times.sendAt,
          unless: input.unless ?? null,
          expiresAt: times.expiresAt,
        });
        if (!scheduled) await advance(tx, workspaceId, row, botsPaused);
        return { created: true, id: row.id, visitorId };
      });
      if (typeof outcome === "string") return { kind: "refused", refusal: outcome };
      if (outcome.visitorId !== null) tellOutbound(live, workspaceId, outcome.visitorId);
      const found = await view(workspaceId, outcome.id);
      if (found === null) throw new Error("The outbound message is missing");
      return { kind: "sent", created: outcome.created, outboundMessage: found };
    },

    /** Cancels a message that the visitor has not read. Answers it as it is, or null. */
    async cancel(
      workspaceId: string,
      target: { id: string } | { visitor: z.infer<typeof VisitorRef>; dedupeKey: string },
    ) {
      const ended = await withWorkspace(db, workspaceId, async (tx) => {
        const id = "id" in target ? target.id : await dedupeTarget(tx, workspaceId, target);
        if (id === null) return null;
        await lockWorkspace(tx, workspaceId);
        const [row] = await tx
          .select()
          .from(outboundMessage)
          .where(ofRow(workspaceId, id))
          .for("update");
        if (row === undefined) return null;
        if (!isEndable(row)) return { id, visitorId: null };
        await end(tx, workspaceId, row, { status: "cancelled", reason: "cancelled_by_request" });
        return { id, visitorId: row.visitorId };
      });
      if (ended === null) return null;
      if (ended.visitorId !== null) tellOutbound(live, workspaceId, ended.visitorId);
      return view(workspaceId, ended.id);
    },

    get: view,

    /** A page of messages, newest first. */
    async list(workspaceId: string, filter: z.infer<typeof ListQuery>) {
      const rows = await withWorkspace(db, workspaceId, (tx) =>
        withNames(tx, workspaceId, listFilter(tx, workspaceId, filter), filter.limit + 1),
      );
      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);
      return {
        outboundMessages: page.map(viewOf),
        next:
          rows.length > filter.limit && last !== undefined
            ? `${last.cursorAt},${last.row.id}`
            : null,
      };
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
            : decide(
                row,
                await situation(tx, workspaceId, row, { botsPaused, checkUnless: false }),
              );
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
    async shownCount(workspaceId: string, visitorId: string): Promise<number> {
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
      button: ButtonRef,
      kind: "dismiss" | "url",
    ): Promise<boolean> {
      const done = await withWorkspace(db, workspaceId, async (tx) => {
        const pressed = await buttonOf(tx, workspaceId, visitorId, button);
        if (pressed === null || !(kind in pressed.button)) return false;
        const row = await readOutbound(tx, workspaceId, visitorId, pressed.row.id);
        if (row === null) return false;
        const chosen = chosenButton(pressed.button);
        if ("dismiss" in pressed.button) {
          await change(
            tx,
            workspaceId,
            row,
            { status: "dismissed", dismissedAt: new Date(), chosenButton: chosen, dueAt: null },
            "outbound_message.dismissed",
          );
          if (row.messageId !== null) await dropButtons(tx, workspaceId, row.messageId);
        } else {
          await change(tx, workspaceId, row, { chosenButton: chosen }, "outbound_message.clicked");
        }
        return true;
      });
      if (done) live.wake(workspaceId, OPERATORS);
      return done;
    },
  };
}

export type Outbound = ReturnType<typeof createOutbound>;

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
    if (moved !== null) tellOutbound(live, workspaceId, moved.visitorId);
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
    .where(and(lte(outboundMessage.expiresAt, sql`now()`), endable))
    .limit(limit);
  for (const { workspaceId, id } of due) {
    await withWorkspace(writer, workspaceId, async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const [row] = await tx
        .select()
        .from(outboundMessage)
        .where(and(ofRow(workspaceId, id), endable))
        .for("update", { skipLocked: true });
      if (row !== undefined) await end(tx, workspaceId, row, { status: "expired" });
    });
    live.wake(workspaceId, OPERATORS);
  }
  return due.length > 0;
}

/**
 * Removes the text of messages that ended, or went in a conversation that keeps it, 30 days ago.
 * Their rows stay, for `dedupeKey`. Answers how many it changed.
 */
export async function pruneOutboundBodies(db: Database, limit: number): Promise<number> {
  const waiting = sql.join(
    WAITING_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    UPDATE outbound_message SET body = NULL
    WHERE (workspace_id, id) IN (
      SELECT workspace_id, id FROM outbound_message
      WHERE body IS NOT NULL AND created_at < now() - ${BODY_KEPT_MS}::float8 * interval '1 millisecond'
        AND (conversation_id IS NOT NULL OR status NOT IN (${waiting}))
        AND coalesce(replied_at, dismissed_at, cancelled_at, expires_at, created_at)
          < now() - ${BODY_KEPT_MS}::float8 * interval '1 millisecond'
      LIMIT ${limit})`);
  return result.rowCount ?? 0;
}
