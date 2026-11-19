/** @jsxImportSource react */
// Outbound messages in the operator app: a contact's list with what became of each, and the
// Message button, which sends one by hand to someone who may have no conversation yet.
import { useState } from "react";
import { newClientId } from "../../../packages/widget/src/compose.ts";
import { MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import type { OutboundMessage, OutboundStatusReason, WorkspaceApi } from "./api.ts";
import { timeOrDate } from "./format.ts";
import { Icon } from "./icons.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { FormDialog, failureText } from "./ui.tsx";

const REASON_TEXT: Record<OutboundStatusReason, TextId> = {
  open_conversation: "outboundReasonOpenConversation",
  open_conversation_skipped: "outboundReasonSkipped",
  human_handling: "outboundReasonHumanHandling",
  bots_paused: "outboundReasonBotsPaused",
  blocked: "outboundReasonBlocked",
  permission_revoked: "outboundReasonPermission",
  workspace_inactive: "outboundReasonWorkspace",
  unless_matched: "outboundReasonUnless",
  cancelled_by_request: "outboundReasonCancelled",
  conversation_deleted: "outboundReasonConversationDeleted",
  audience_unmatched: "outboundReasonAudience",
  frequency_capped: "outboundReasonFrequency",
  goal_reached: "outboundReasonGoal",
  outside_business_hours: "outboundReasonBusinessHours",
  outside_send_window: "outboundReasonSendWindow",
  campaign_paused: "outboundReasonCampaignPaused",
  campaign_ended: "outboundReasonCampaignEnded",
  control_group: "outboundReasonControl",
};

/** Why a message waits or was cancelled, in a few words. */
export const reasonText = (reason: OutboundStatusReason) => t(REASON_TEXT[reason]);

const reasonOf = (one: OutboundMessage) =>
  one.statusReason === null ? "" : reasonText(one.statusReason);

/** What became of a message, in a few words: "Read 10:02, not answered", "Waiting: ...". */
function outboundState(one: OutboundMessage): string {
  const at = (time: string | null) => (time === null ? "" : timeOrDate(time));
  if (one.status === "cancelled") return t("outboundCancelled", { reason: reasonOf(one) });
  if (one.statusReason !== null) return t("outboundWaiting", { reason: reasonOf(one) });
  if (one.status === "scheduled") return t("outboundScheduled", { time: at(one.sendAt) });
  if (one.status === "read") return t("outboundRead", { time: at(one.readAt) });
  if (one.status === "replied") return t("outboundReplied", { time: at(one.repliedAt) });
  if (one.status === "dismissed") return t("outboundDismissed", { time: at(one.dismissedAt) });
  if (one.status === "delivered") return t("outboundDelivered");
  return t(one.status === "expired" ? "outboundExpired" : "outboundNextVisit");
}

/** Who the visitor saw, and who sent it when that differs: "Julien, via Welcome bot". */
function senderLine(one: OutboundMessage): string {
  const shown = one.sender === "team" ? t("outboundTeam") : (one.sender?.name ?? one.author.name);
  return shown === one.author.name
    ? shown
    : t("outboundVia", { name: shown, via: one.author.name });
}

/** The statuses in which the visitor has not read a message yet. */
const UNREAD_STATUSES = new Set(["scheduled", "sent", "delivered"]);

/** A message a cancel ends: unread, and outside a conversation, as the server decides. */
const isCancellable = (one: OutboundMessage) =>
  one.conversationId === null && UNREAD_STATUSES.has(one.status);

/** A contact's outbound messages, newest first, each with what became of it. */
export function OutboundList({
  messages,
  onCancel,
}: {
  messages: OutboundMessage[];
  onCancel(id: string): void;
}) {
  if (messages.length === 0) return <p className="quiet">{t("outboundNone")}</p>;
  return (
    <ol className="contact-conversations">
      {messages.map((one) => (
        <li key={one.id} className="outbound-card">
          <span className="conversation-top">
            <span className={one.statusReason === null ? "chip" : "chip warn"}>
              {t("outboundAutomatic")}
            </span>
            <b>{one.body ?? t("outboundBodyGone")}</b>
            <time dateTime={one.createdAt} title={new Date(one.createdAt).toLocaleString()}>
              {timeOrDate(one.createdAt)}
            </time>
          </span>
          <span className="conversation-facts">
            {senderLine(one)} · {outboundState(one)}
          </span>
          {isCancellable(one) && (
            <button type="button" className="text-button" onClick={() => onCancel(one.id)}>
              {t("outboundCancel")}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The Message button and its dialog: one message by hand, from the signed-in member. */
export function MessageButton({
  api,
  visitorId,
  name,
  small = false,
  onSent = () => {},
}: {
  api: WorkspaceApi;
  visitorId: string;
  name: string;
  /** In a row of small buttons, as in Visitors. */
  small?: boolean;
  onSent?: () => void;
}) {
  const [writing, setWriting] = useState(false);
  return (
    <>
      <button
        type="button"
        className={small ? "pill small" : "pill"}
        onClick={() => setWriting(true)}
      >
        <Icon name="envelope" size={18} />
        {t("outboundMessage")}
      </button>
      {writing && (
        <MessageDialog
          api={api}
          visitorId={visitorId}
          name={name}
          onSent={onSent}
          onClose={() => setWriting(false)}
        />
      )}
    </>
  );
}

function MessageDialog({
  api,
  visitorId,
  name,
  onSent,
  onClose,
}: {
  api: WorkspaceApi;
  visitorId: string;
  name: string;
  onSent(): void;
  onClose(): void;
}) {
  const [body, setBody] = useState("");
  // One ID for this message, so a retry after a lost answer sends it once.
  const [clientId] = useState(newClientId);
  const [failure, setFailure] = useState<TextId | null>(null);
  const send = async (close: () => void) => {
    setFailure(null);
    try {
      await api.sendOutbound(visitorId, clientId, body.trim());
      toast("outboundSent");
      onSent();
      close();
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
    }
  };
  return (
    <FormDialog
      title={t("outboundMessageTo", { name })}
      help={t("outboundMessageHelp")}
      failure={failure}
      submitLabel={t("outboundSend")}
      submitDisabled={body.trim() === ""}
      onSubmit={(close) => void send(close)}
      onClose={onClose}
    >
      <label className="identity-field">
        {t("outboundMessageLabel")}
        <textarea
          rows={4}
          value={body}
          maxLength={MESSAGE_MAX}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
    </FormDialog>
  );
}
