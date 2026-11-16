import type { z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import { tally } from "./campaign-results.ts";
import { operator, outboundDedupe, outboundMessage, workspaceMember } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { advance } from "./outbound-delivery.ts";
import { endable, type KeyState, visitorFlags } from "./outbound-rules.ts";
import { type SEND_REFUSALS, type SendSchema, WAITING_PER_VISITOR } from "./outbound-schemas.ts";

// The one way a new outbound message comes to be, for a send from a key or a member and for a
// campaign: the checks on the visitor, the insert, and its first step when it is due now.

type Row = typeof outboundMessage.$inferSelect;
type SendInput = z.infer<typeof SendSchema>;
export type SendRefusal = keyof typeof SEND_REFUSALS;

/** What a new message holds, from a send's input or a campaign's definition. */
type Placed = Pick<
  SendInput,
  | "clientId"
  | "body"
  | "buttons"
  | "metadata"
  | "startConversation"
  | "show"
  | "ifConversationOpen"
  | "assignOnReply"
  | "sendEmail"
  | "dedupeKey"
  | "unless"
>;

/** Who the visitor sees: a member, the workspace, or the message's author. */
export interface SendsAs {
  senderKind: Row["senderKind"];
  senderOperatorId: string | null;
}

/** Who made a message: a key, or a member by hand. A campaign's is the one that saved it last. */
export type Author = { kind: "key"; apiKeyId: string } | { kind: "operator"; operatorId: string };

/**
 * The campaign a message comes from, the schedule's run that made it, and its A/B variant. A
 * contact in the control group gets a row with no text, so the goal's results still count them. A
 * page campaign's card that the visitor answers comes in read: the widget showed it and counted
 * the show and the read in the results.
 */
interface FromCampaign {
  id: string;
  runId: string | null;
  variant: string | null;
  kind: "message" | "control" | "page";
}

/** A send that passed the author's checks, with the visitor and the sender it resolved to. */
export interface NewSend {
  workspaceId: string;
  visitorId: string;
  actor: Author;
  via: "mcp" | null;
  as: SendsAs;
  input: Placed;
  times: { sendAt: Date; expiresAt: Date | null };
  campaign: FromCampaign | null;
}

/** Who the visitor sees on a send, after the key's permission to show a member. */
export async function sendsAs(
  tx: Transaction,
  workspaceId: string,
  actor: Author,
  key: KeyState | null,
  sender: SendInput["sender"],
): Promise<SendsAs | "send_as_member_required" | "unknown_member"> {
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

/** What the sending key may not do. A member by hand needs no permission for either. */
export function keyRefusal(
  key: KeyState | null,
  sendEmail: boolean,
): "send_mode_required" | "send_email_required" | null {
  if (key?.replyMode === "draft") return "send_mode_required";
  if (sendEmail && key !== null && !key.maySendEmail) return "send_email_required";
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

/**
 * Why this visitor may not get the message now, or null. The bots' pause holds a key's own send,
 * not a campaign's, and the visitor's opt-out holds every automatic one. The caller holds the locks.
 */
async function refusal(
  tx: Transaction,
  send: NewSend,
  { botsPaused, scheduled }: { botsPaused: boolean; scheduled: boolean },
): Promise<SendRefusal | null> {
  const { workspaceId, visitorId, actor, campaign } = send;
  const isKey = actor.kind === "key";
  if (isKey && campaign === null && botsPaused && !scheduled) return "bots_paused";
  const { blocked, optedOut } = await visitorFlags(tx, workspaceId, visitorId);
  if (blocked) return "blocked";
  if (optedOut && (isKey || campaign !== null)) return "opted_out";
  if ((await unreadCount(tx, workspaceId, visitorId)) >= WAITING_PER_VISITOR) {
    return "too_many_waiting";
  }
  return null;
}

/** How a campaign's row starts, beside the scheduled message that any send makes. */
const STARTS = {
  message: () => ({}),
  // It ends at once, with no text.
  control: () => ({
    body: null,
    status: "cancelled" as const,
    statusReason: "control_group" as const,
    cancelledAt: new Date(),
    dueAt: null,
  }),
  page: () => {
    const now = new Date();
    return { status: "read" as const, sentAt: now, deliveredAt: now, readAt: now, dueAt: null };
  },
};

/** Inserts a new scheduled message, and its `dedupeKey`, or a campaign's row as it starts. */
async function insertOutbound(tx: Transaction, send: NewSend): Promise<Row> {
  const { workspaceId, visitorId, actor, via, as, input, times, campaign } = send;
  const [row] = await tx
    .insert(outboundMessage)
    .values({
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
      campaignId: campaign?.id ?? null,
      campaignRunId: campaign?.runId ?? null,
      variant: campaign?.variant ?? null,
      ...(campaign !== null && STARTS[campaign.kind]()),
    })
    .returning();
  if (row === undefined) throw new Error("The outbound insert returned no row");
  if (row.dedupeKey !== null) {
    await tx.insert(outboundDedupe).values({
      workspaceId,
      visitorId,
      dedupeKey: row.dedupeKey,
      outboundMessageId: row.id,
    });
  }
  return row;
}

/**
 * Checks the visitor, inserts the message, and moves it on at once when it is due now. The caller
 * holds the visitor's lock, then the workspace's.
 */
export async function placeOutbound(
  tx: Transaction,
  send: NewSend,
  botsPaused: boolean,
): Promise<Row | SendRefusal> {
  const scheduled = send.times.sendAt.getTime() > Date.now();
  const refused = await refusal(tx, send, { botsPaused, scheduled });
  if (refused !== null) return refused;
  const row = await insertOutbound(tx, send);
  const kind = send.campaign?.kind ?? "message";
  if (send.campaign !== null && kind !== "page") {
    const { id: campaignId, variant } = send.campaign;
    await tally(tx, send.workspaceId, { campaignId, variant, visitorId: send.visitorId }, [
      "entered",
    ]);
  }
  if (scheduled || kind !== "message") return row;
  return advance(tx, send.workspaceId, row, botsPaused);
}
