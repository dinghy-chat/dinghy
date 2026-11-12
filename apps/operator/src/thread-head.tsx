/** @jsxImportSource react */
import type { Conversation, Member, Snooze, WelcomeChat } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Menu, type MenuItem, Select } from "./popup.tsx";
import { SNOOZE_CHOICES } from "./snooze.ts";
import { type TextId, t } from "./text.ts";
import { Avatar } from "./ui.tsx";
import { avatarLetters, presenceLine, title } from "./visitor.ts";

type WelcomeAccess = Extract<WelcomeChat, { with: "workspace" }>["access"];

/** The other side's state when it is not open, and whether replies still reach it. */
const WELCOME_STATE: Partial<Record<WelcomeAccess, { text: TextId; delivered: boolean }>> = {
  // Replies wait in its inbox until the workspace opens.
  waiting_payment: { text: "welcomeUnpaid", delivered: true },
  read_only: { text: "welcomeReadOnly", delivered: true },
  suspended: { text: "welcomeSuspended", delivered: false },
  deleted: { text: "welcomeDeleted", delivered: false },
};

/** Who a welcome chat is with, and the other side's state, if it is not open. */
function welcomeLines(welcome: WelcomeChat): [string, { text: string; delivered: boolean } | null] {
  if (welcome.with === "founder") return [t("welcomeWithFounder"), null];
  if (welcome.with === "deleted") {
    return [t("welcomeChat"), { text: t("welcomeGone"), delivered: false }];
  }
  const values = { workspace: welcome.name };
  const state = WELCOME_STATE[welcome.access];
  const note = state === undefined ? null : { ...state, text: t(state.text, values) };
  return [t("welcomeWith", values), note];
}

/** A welcome chat on Dinghy Cloud: who it is with, in place of a visit it never has. */
function WelcomeNote({ welcome }: { welcome: WelcomeChat }) {
  const [label, note] = welcomeLines(welcome);
  return (
    <p>
      {note === null ? (
        label
      ) : (
        <span className={note.delivered ? undefined : "welcome-off"} title={label}>
          {note.text}
        </span>
      )}
    </p>
  );
}

/** What the operator can do with this conversation. */
/** Snooze choices for an open conversation, or Unsnooze for a snoozed one. None when closed. */
function snoozeItems(conversation: Conversation, onSnooze: (snooze: Snooze | null) => void) {
  if (conversation.status === "closed") return [];
  const lead = <Icon name="clock" size={18} />;
  if (conversation.snooze !== null) {
    return [{ label: t("unsnooze"), lead, onSelect: () => onSnooze(null) }];
  }
  return SNOOZE_CHOICES.map((choice) => ({
    label: t(choice.text),
    lead,
    onSelect: () => onSnooze({ until: choice.until(new Date()) }),
  }));
}

export function ThreadHead({
  conversation,
  welcome,
  online,
  members,
  mayDeleteAnyone,
  onBack,
  onAssign,
  onStatus,
  onSnooze,
  onBlocked,
  onDelete,
  onTranscript,
  emailAvailable,
  panel,
}: {
  conversation: Conversation;
  welcome: WelcomeChat | null;
  /** Whether the visitor's panel shows, and the button that shows or hides it. Null with none. */
  panel: { open: boolean; toggle(): void } | null;
  /** A widget stream of the visitor's is open, or null when unknown. */
  online: boolean | null;
  members: Member[];
  /** An admin of a writable workspace: deletes the conversation and anyone's message in it. */
  mayDeleteAnyone: boolean;
  onBack(): void;
  onAssign(operatorId: string | null): void;
  onStatus(status: "open" | "closed"): void;
  /** Snoozes the open conversation, or ends its snooze with null. */
  onSnooze(snooze: Snooze | null): void;
  onBlocked(blocked: boolean): void;
  onDelete(): void;
  onTranscript(): void;
  /** This server sends email, so a transcript can go. */
  emailAvailable: boolean;
}) {
  const closed = conversation.status === "closed";
  const { blocked } = conversation.visitor;
  const assignee = members.some((member) => member.id === conversation.assigneeOperatorId)
    ? (conversation.assigneeOperatorId ?? "")
    : "";
  const noEmail = !emailAvailable
    ? t("transcriptNoServer")
    : conversation.visitor.email === null
      ? t("transcriptNoEmail")
      : undefined;
  const more: MenuItem[] = [
    {
      label: blocked ? t("unblockVisitor") : t("blockVisitor"),
      lead: <Icon name="prohibit" size={18} />,
      onSelect: () => onBlocked(!blocked),
    },
    {
      label: t("emailTranscript"),
      lead: <Icon name="envelope" size={18} />,
      ...(noEmail === undefined ? {} : { unavailable: noEmail }),
      onSelect: onTranscript,
    },
    ...snoozeItems(conversation, onSnooze),
  ];
  if (mayDeleteAnyone) {
    more.push({
      label: t("deleteConversation"),
      lead: <Icon name="trash" size={18} />,
      danger: true,
      onSelect: onDelete,
    });
  }
  // The email, the user ID, the device and the pages live in the panel, so the header stays one row.
  const presence = presenceLine(conversation.visitor.lastSeenAt, online);
  return (
    <header className="thread-head">
      <div className="who-is">
        <button type="button" className="icon-button back" aria-label={t("back")} onClick={onBack}>
          <Icon name="back" />
        </button>
        <span className="avatar-wrap">
          <Avatar
            name={title(conversation)}
            letters={avatarLetters(conversation.visitor)}
            pictureUrl={conversation.visitor.pictureUrl}
          />
          {online === true && <i className="presence-dot" />}
        </span>
        <div className="who-text">
          <h2>{title(conversation)}</h2>
          {welcome !== null ? (
            <WelcomeNote welcome={welcome} />
          ) : (
            presence !== null && (
              <p className={online === true ? "visit live" : "visit"}>{presence}</p>
            )
          )}
        </div>
      </div>
      <div className="actions">
        {!(panel?.open ?? false) && (
          <Select
            label={t("assignTo")}
            className="assignee"
            side="end"
            value={assignee}
            choices={[
              { value: "", label: t("unassigned"), lead: <span className="avatar nobody" /> },
              ...members.map((member) => ({
                value: member.id,
                label: member.name,
                lead: <Avatar name={member.name} pictureUrl={member.pictureUrl} />,
              })),
            ]}
            onChange={(value) => onAssign(value === "" ? null : value)}
          />
        )}
        <button
          type="button"
          className={closed ? "pill" : "pill dark"}
          onClick={() => onStatus(closed ? "open" : "closed")}
        >
          <Icon name={closed ? "inbox" : "done"} size={16} />
          {closed ? t("reopen") : t("close")}
        </button>
        <Menu label={t("moreActions")} items={more} buttonClass="round">
          <Icon name="dots" />
        </Menu>
        {panel !== null && (
          <button
            type="button"
            className="round panel-toggle"
            aria-pressed={panel.open}
            aria-label={panel.open ? t("hidePanel") : t("showPanel")}
            title={panel.open ? t("hidePanel") : t("showPanel")}
            onClick={panel.toggle}
          >
            <Icon name="sidebar" />
          </button>
        )}
      </div>
    </header>
  );
}
