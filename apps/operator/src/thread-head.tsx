/** @jsxImportSource react */
import type { Conversation, Member, WelcomeChat } from "./api.ts";
import { HandlerSelect } from "./handler.tsx";
import { Icon } from "./icons.tsx";
import { Menu, type MenuItem } from "./popup.tsx";
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
export function ThreadHead({
  conversation,
  welcome,
  online,
  members,
  meId,
  mayDeleteAnyone,
  onBack,
  onAssign,
  onStatus,
  onBlocked,
  onDelete,
  onTranscript,
  canGiveBack,
  onGiveBack,
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
  meId: string;
  /** An admin of a writable workspace: deletes the conversation and anyone's message in it. */
  mayDeleteAnyone: boolean;
  onBack(): void;
  onAssign(operatorId: string | null): void;
  onStatus(status: "open" | "closed"): void;
  onBlocked(blocked: boolean): void;
  onDelete(): void;
  onTranscript(): void;
  /** A person handles it and a bot took part, so the ⋯ menu offers to give it back. */
  canGiveBack: boolean;
  /** Gives it back to the bot: nobody is assigned and the bot may answer again. */
  onGiveBack(): void;
  /** This server sends email, so a transcript can go. */
  emailAvailable: boolean;
}) {
  const closed = conversation.status === "closed";
  const { blocked } = conversation.visitor;
  const noEmail = !emailAvailable
    ? t("transcriptNoServer")
    : conversation.visitor.email === null
      ? t("transcriptNoEmail")
      : undefined;
  const more: MenuItem[] = [
    ...(canGiveBack
      ? [{ label: t("giveBack"), lead: <Icon name="robot" size={18} />, onSelect: onGiveBack }]
      : []),
    {
      label: blocked ? t("unblockVisitor") : t("blockVisitor"),
      lead: <Icon name="prohibit" size={18} />,
      onSelect: () => onBlocked(!blocked),
    },
    {
      label: t("sendTranscript"),
      lead: <Icon name="download" size={18} />,
      ...(noEmail === undefined ? {} : { unavailable: noEmail }),
      onSelect: onTranscript,
    },
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
          <HandlerSelect
            conversation={conversation}
            members={members}
            meId={meId}
            side="end"
            onAssign={onAssign}
            onGiveBack={onGiveBack}
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
