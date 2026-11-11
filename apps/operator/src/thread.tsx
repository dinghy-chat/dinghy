/** @jsxImportSource react */
import {
  createElement,
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  IMAGE_TYPES,
  imageProblem,
  inCommitOrder,
  isComposing,
  newClientId,
  REFRESH_LIMIT_MS,
  REFUSED,
} from "../../../packages/widget/src/compose.ts";
import { quoteExcerpt, renderMarkdown } from "../../../packages/widget/src/markdown.ts";
import {
  ApiError,
  type Conversation,
  type Member,
  type Message,
  type PageView,
  type Quote,
  type ReplyReceipts,
  type WelcomeChat,
  type WorkspaceApi,
} from "./api.ts";
import { code, type Edit, link, list, wrap } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { useLatestLoad, useLoad } from "./load.ts";
import { type InfoLine, MessageInfo, MessageMenu, QuoteBlock, QuoteChip } from "./message.tsx";
import { Confirm, Menu, type MenuItem, Select } from "./popup.tsx";
import { readStored, store } from "./stored.ts";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Avatar, EmojiButton, ErrorNote, failureText, Loading, useModal } from "./ui.tsx";
import { avatarLetters, presenceLine, replyAuthor, title } from "./visitor.ts";
import { VisitorPanel } from "./visitor-panel.tsx";

interface Line {
  id: string;
  /** Null until the server confirms it. Confirmed lines sort by this, and pending ones go last. */
  seq: bigint | null;
  body: string;
  image: Message["image"];
  /** The image was deleted after 12 months, and the line says so. */
  imageRemoved: boolean;
  /** Held until the server confirms it, so a retry can send it again. */
  file?: File;
  fromVisitor: boolean;
  /** When the server saved it. A pending line has none yet. */
  createdAt?: string;
  /** The operator who sent it. A pending line is this operator's own. */
  authorOperatorId: string | null;
  /** The API key that sent it, instead of an operator. */
  authorApiKeyId: string | null;
  authorName: string | null;
  status: "sent" | "sending" | "failed";
  /** A status line: someone closed or reopened the conversation. */
  note?: "closed" | "reopened";
  /** The message this one quotes. */
  replyTo: Quote | null;
  editedAt: string | null;
  deleted: boolean;
  via: Message["via"];
}

/** Adds a confirmed message in commit order, and replaces its pending line if it has one. */
function merge(lines: Line[], message: Message): Line[] {
  const { kind } = message;
  const line: Line = {
    ...((kind === "closed" || kind === "reopened") && { note: kind }),
    id: message.id,
    seq: BigInt(message.seq),
    body: message.body ?? "",
    image: message.image,
    imageRemoved: message.imageRemoved,
    fromVisitor: message.fromVisitor,
    createdAt: message.createdAt,
    authorOperatorId: message.authorOperatorId,
    authorApiKeyId: message.authorApiKeyId,
    authorName: message.authorName,
    status: "sent",
    replyTo: message.replyTo,
    editedAt: message.editedAt,
    deleted: message.deleted,
    via: message.via,
  };
  const others = lines.filter(
    (other) => other.id !== message.id && !(other.seq === null && other.id === message.clientId),
  );
  return inCommitOrder(others, line);
}

const ONLINE_EVERY_MS = 30_000;

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
function ThreadHead({
  conversation,
  welcome,
  online,
  members,
  canDelete,
  onBack,
  onAssign,
  onStatus,
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
  canDelete: boolean;
  onBack(): void;
  onAssign(operatorId: string | null): void;
  onStatus(status: "open" | "closed"): void;
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
      label: t("sendTranscript"),
      lead: <Icon name="download" size={18} />,
      ...(noEmail === undefined ? {} : { unavailable: noEmail }),
      onSelect: onTranscript,
    },
  ];
  if (canDelete) {
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

function ImageViewer({
  url,
  onClose,
  onError,
}: {
  url: string | undefined;
  onClose(): void;
  onError(): void;
}) {
  const viewer = useModal();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a dialog.
    <dialog
      ref={viewer}
      className="viewer"
      onClose={onClose}
      onClick={() => viewer.current?.close()}
    >
      <img src={url} alt={t("imageAlt")} onError={onError} />
    </dialog>
  );
}

/** Each formatting button: its text, its icon, its key with Cmd or Ctrl, and what it does. */
const FORMATS: {
  name: TextId;
  icon: IconName;
  key?: string;
  apply(value: string, start: number, end: number): Edit;
}[] = [
  { name: "formatBold", icon: "textBold", key: "b", apply: (v, s, e) => wrap(v, s, e, "**") },
  { name: "formatItalic", icon: "textItalic", key: "i", apply: (v, s, e) => wrap(v, s, e, "*") },
  { name: "formatCode", icon: "code", key: "e", apply: code },
  { name: "formatLink", icon: "link", key: "k", apply: (v, s, e) => link(v, s, e, t("linkWords")) },
  { name: "formatBulleted", icon: "listBullets", apply: (v, s, e) => list(v, s, e, false) },
  { name: "formatNumbered", icon: "listNumbers", apply: (v, s, e) => list(v, s, e, true) },
];

const ON_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** "Bold (⌘B)" on a Mac and "Bold (Ctrl+B)" elsewhere. */
const shortcutLabel = (name: TextId, key: string | undefined) =>
  key === undefined
    ? t(name)
    : t("withShortcut", {
        name: t(name),
        keys: ON_MAC ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`,
      });

function Composer({
  draft,
  setDraft,
  onSend,
  onFiles,
  onEscape,
  above,
  editing = false,
}: {
  draft: string;
  setDraft(draft: string): void;
  onSend(body: string): void;
  /** Undefined when only text can go, as in a read-only workspace's welcome chat. */
  onFiles: ((files: Iterable<File>) => void) | undefined;
  /** Escape in the box: cancels a quote or an edit. */
  onEscape?: (() => void) | undefined;
  /** Above the text, such as the quote a reply carries. */
  above?: ReactNode;
  /** It edits a sent reply, in place of its bubble. */
  editing?: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // The selection a format asked for, set once the new text is on screen.
  const selection = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const field = input.current;
    if (selection.current === null || field === null) return;
    field.focus();
    field.setSelectionRange(...selection.current);
    selection.current = null;
  });

  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const body = draft.trim();
    if (body === "") return;
    // An edit keeps its text until the server takes it, so a failed save loses nothing.
    if (!editing) setDraft("");
    onSend(body);
  };

  const format = (apply: (typeof FORMATS)[number]["apply"]) => {
    const field = input.current;
    if (field === null) return;
    const edit = apply(field.value, field.selectionStart, field.selectionEnd);
    selection.current = [edit.start, edit.end];
    setDraft(edit.value);
  };

  return (
    <form className={editing ? "compose editing" : "compose"} onSubmit={submit}>
      <div className="box">
        {above}
        <textarea
          ref={input}
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: the operator chose Edit, so the text is what they want.
          autoFocus={editing}
          onPaste={(event) => {
            // A copy from Word or Excel holds its text and a picture of it. The text is what is meant.
            const { clipboardData: data } = event;
            if (onFiles === undefined || data.files.length === 0) return;
            if (data.getData("text/plain") !== "") return;
            event.preventDefault();
            onFiles(data.files);
          }}
          aria-label={t(editing ? "editLabel" : "replyLabel")}
          placeholder={editing ? undefined : t("replyPlaceholder")}
          maxLength={10_000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isComposing(event.nativeEvent)) {
              submit(event);
              return;
            }
            if (event.key === "Escape" && onEscape !== undefined) {
              event.preventDefault();
              onEscape();
              return;
            }
            if (!(ON_MAC ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
            const found = FORMATS.find((one) => one.key === event.key.toLowerCase());
            if (found === undefined) return;
            event.preventDefault();
            format(found.apply);
          }}
        />
        <div className="compose-tools">
          {onFiles !== undefined && (
            <>
              <input
                ref={picker}
                className="file"
                type="file"
                multiple
                accept={IMAGE_TYPES.join(",")}
                aria-label={t("attach")}
                tabIndex={-1}
                onChange={(event) => {
                  onFiles(event.target.files ?? []);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={t("attach")}
                title={t("attach")}
                onClick={() => picker.current?.click()}
              >
                <Icon name="clip" size={18} />
              </button>
            </>
          )}
          <EmojiButton field={input} onPick={setDraft} />
          <span className="tools-divider" aria-hidden="true" />
          <fieldset className="format-tools" aria-label={t("formatTools")}>
            {FORMATS.map((one) => {
              const label = shortcutLabel(one.name, one.key);
              return (
                <button
                  key={one.name}
                  type="button"
                  className="icon-button"
                  aria-label={label}
                  title={label}
                  // The field keeps its selection while the button is pressed.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => format(one.apply)}
                >
                  <Icon name={one.icon} size={18} />
                </button>
              );
            })}
          </fieldset>
          {editing ? (
            <span className="edit-actions">
              <button type="button" className="pill" onClick={onEscape}>
                {t("cancel")}
              </button>
              <button type="submit" className="pill dark">
                {t("saveEdit")}
              </button>
            </span>
          ) : (
            <button type="submit" className="send" aria-label={t("send")} title={t("send")}>
              <Icon name="arrowUp" size={16} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

/** A message's bubble: its quote and text, its image, or what stands in for them. */
function Bubble({
  line,
  quote,
  onView,
  onImageError,
}: {
  line: Line;
  quote: ReactNode;
  onView(): void;
  onImageError(): void;
}) {
  const side = line.fromVisitor ? " visitor" : "";
  if (line.deleted) return <div className={`msg${side} removed`}>{t("messageDeleted")}</div>;
  if (line.image !== null) {
    return (
      <div className="shot-stack">
        {quote !== null && <div className={`msg${side} quote-only`}>{quote}</div>}
        <button
          type="button"
          className={`shot${side}`}
          aria-label={t("imageView")}
          onClick={onView}
        >
          <img
            src={line.image.url}
            width={line.image.width}
            height={line.image.height}
            alt={t("imageAlt")}
            loading="lazy"
            onError={onImageError}
          />
        </button>
      </div>
    );
  }
  if (line.imageRemoved) return <div className={`msg${side} removed`}>{t("imageRemoved")}</div>;
  if (line.file !== undefined) return <div className="msg">{t("imageSending")}</div>;
  return createElement(
    "div",
    { className: `msg${side}` },
    quote,
    ...renderMarkdown(line.body, createElement),
  );
}

/** One message in the log: its bubble and its "…", or the editor that replaces them. */
function ThreadLine({
  line,
  quote,
  menu,
  editor,
  flash,
  receipt,
  onView,
  onImageError,
  onRetry,
}: {
  line: Line;
  quote: ReactNode;
  menu: ReactNode;
  /** The inline editor while the operator edits this reply. */
  editor: ReactNode;
  /** Highlighted for a moment, after a click on a quote of it or a link to it. */
  flash: boolean;
  /** How far the visitor has seen this reply, under its bubble. */
  receipt: ReactNode;
  onView(): void;
  onImageError(): void;
  onRetry(): void;
}) {
  const row = ["bubble-row", line.fromVisitor && "visitor", flash && "flash"]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      {editor ?? (
        <div className={row} id={`message-${line.id}`}>
          <Bubble line={line} quote={quote} onView={onView} onImageError={onImageError} />
          {menu}
        </div>
      )}
      {receipt}
      {line.status === "sending" && <div className="state">{t("sending")}</div>}
      {line.status === "failed" && (
        <button type="button" className="retry" onClick={onRetry}>
          {t("failed")}
        </button>
      )}
    </>
  );
}

type Receipt = "sent" | "emailed" | "emailFailed" | "read";

const RECEIPTS: Record<Receipt, { text: TextId; icon: IconName }> = {
  sent: { text: "receiptSent", icon: "checkThin" },
  emailed: { text: "receiptEmailed", icon: "checks" },
  emailFailed: { text: "receiptEmailFailed", icon: "warningCircle" },
  read: { text: "receiptRead", icon: "checks" },
};

/** How far the visitor has seen a stored reply at this position. */
function receiptOf(seq: bigint, receipts: ReplyReceipts): Receipt {
  if (seq <= BigInt(receipts.readSeq)) return "read";
  const carried = receipts.emails.filter(
    (email) => BigInt(email.fromSeq) <= seq && seq <= BigInt(email.toSeq),
  );
  if (carried.some((email) => email.sent)) return "emailed";
  return carried.length > 0 ? "emailFailed" : "sent";
}

/**
 * The small line under a reply: a check and what happened to it. Under the last reply it always
 * shows. Under an earlier one it shows when the pointer is on its bubble, and screen readers
 * read it either way.
 */
function ReceiptLine({ receipt, later }: { receipt: Receipt; later: boolean }) {
  const { text, icon } = RECEIPTS[receipt];
  return (
    <div className={`receipt ${receipt}${later ? " later" : ""}`}>
      <Icon name={icon} size={14} />
      {t(text)}
    </div>
  );
}

/**
 * A centered line where someone closed or reopened the conversation: who, and when. A reopen with
 * no operator or key, as the cloud's welcome chat does, names nobody.
 */
function StatusNote({
  line,
  note,
  meId,
}: {
  line: Line;
  note: "closed" | "reopened";
  meId: string;
}) {
  const byPerson = line.authorOperatorId !== null || line.authorApiKeyId !== null;
  const text = !byPerson
    ? t(note === "closed" ? "closedPlain" : "reopenedPlain")
    : line.authorOperatorId === meId
      ? t(note === "closed" ? "closedByYou" : "reopenedByYou")
      : t(note === "closed" ? "closedBy" : "reopenedBy", { name: replyAuthor(line, meId) });
  const time =
    line.createdAt === undefined
      ? null
      : new Date(line.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <p className="status-note">
      {text}
      {time !== null && <time dateTime={line.createdAt}> · {time}</time>}
    </p>
  );
}

/** A visitor's unsent words, faded, with dots that move while they type. */
function TypingDraft({ draft }: { draft: string }) {
  return (
    <>
      <div className="msg draft" role="status" aria-label={t("visitorTypingLabel")}>
        {draft}
      </div>
      <div className="meta visitor typing">
        <span className="typing-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {t("visitorTyping")}
      </div>
    </>
  );
}

const sameSender = (one: Line | undefined, other: Line | undefined) =>
  one !== undefined &&
  other !== undefined &&
  one.note === undefined &&
  other.note === undefined &&
  one.fromVisitor === other.fromVisitor &&
  one.authorOperatorId === other.authorOperatorId &&
  one.authorApiKeyId === other.authorApiKeyId;

const dayOf = (line: Line | undefined) =>
  line?.createdAt === undefined ? null : new Date(line.createdAt).toDateString();

/** "Today", "Yesterday" or the date, for the line between days. */
function dayLabel(iso: string): string {
  const day = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return t("today");
  if (day.toDateString() === yesterday.toDateString()) return t("yesterday");
  return day.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(day.getFullYear() !== today.getFullYear() && { year: "numeric" }),
  });
}

/**
 * The quiet line under the last message of a run from one sender: the time, and for an operator's
 * run, who sent it ("You" for your own). A pending message has no time yet.
 */
function groupMeta(lines: Line[], index: number, meId: string): string | null {
  const line = lines[index];
  if (line === undefined || line.status !== "sent") return null;
  const after = lines[index + 1];
  // An edited reply always shows its time, with "edited" beside it.
  const edited = line.editedAt !== null && !line.deleted;
  const ends = !sameSender(line, after) || dayOf(after) !== dayOf(line) || after?.status !== "sent";
  if (!edited && !ends) return null;
  const at =
    line.createdAt === undefined
      ? null
      : new Date(line.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const time = edited ? [at, t("messageEdited")].filter(Boolean).join(" · ") : at;
  if (line.fromVisitor) return time;
  const who = replyAuthor(line, meId);
  return time === null ? who : `${who} · ${time}`;
}

const FLASH_MS = 1600;

/** Scrolls the log to a message and highlights it for a moment. False when it is not loaded. */
function useJump(log: RefObject<HTMLDivElement | null>) {
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (flashId === null) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);
  const jump = (id: string) => {
    const found = log.current?.querySelector(`#message-${CSS.escape(id)}`);
    if (found == null) return false;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    found.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    setFlashId(id);
    return true;
  };
  return { flashId, jump };
}

/** The quote a reply to this line carries, as the server will show it. */
const quoteOf = (line: Line, author: string): Quote => ({
  id: line.id,
  authorName: line.fromVisitor ? null : author,
  fromVisitor: line.fromVisitor,
  excerpt: quoteExcerpt(line.body),
  hasImage: line.image !== null,
});

/** Why the visitor may have seen this reply, so it can no longer change, or null. */
function seenReason(line: Line, receipts: ReplyReceipts | null): TextId | null {
  if (receipts === null || line.seq === null) return null;
  const receipt = receiptOf(line.seq, receipts);
  if (receipt === "read") return "messageAlreadyRead";
  return receipt === "emailed" ? "messageAlreadyEmailed" : null;
}

interface LineActions {
  reply(): void;
  copyText(): void;
  edit(): void;
  info(): void;
  copyLink(): void;
  remove(): void;
}

/** A line's menu, in its fixed order, without the items that do not apply. */
function lineMenu(
  line: Line,
  who: { meId: string; mayDeleteAny: boolean; canWrite: boolean; canReply: boolean },
  receipts: ReplyReceipts | null,
  act: LineActions,
): MenuItem[] {
  if (line.seq === null || line.note !== undefined) return [];
  const item = (label: TextId, icon: IconName, onSelect: () => void): MenuItem => ({
    label: t(label),
    lead: <Icon name={icon} size={18} />,
    onSelect,
  });
  const info = item("messageInfo", "info", act.info);
  if (line.deleted) return [info];
  const isText = line.image === null && !line.imageRemoved && line.body !== "";
  const isMine = line.authorOperatorId === who.meId;
  const items: MenuItem[] = [];
  if (who.canReply) items.push(item("messageReply", "reply", act.reply));
  if (isText) items.push(item("messageCopyText", "copy", act.copyText));
  if (isMine && isText && who.canWrite) {
    const seen = seenReason(line, receipts);
    items.push({
      ...item("messageEdit", "pencil", act.edit),
      ...(seen !== null && { unavailable: t(seen) }),
    });
  }
  items.push(info, item("messageCopyLink", "link", act.copyLink));
  if ((isMine || who.mayDeleteAny) && who.canWrite) {
    items.push({ ...item("messageDelete", "trash", act.remove), danger: true, divider: true });
  }
  return items;
}

/** Copies text, and says so. A browser that refuses says nothing, as the copy did not happen. */
const copy = (text: string, done: TextId) =>
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast(done))
    .catch(() => {});

export function Thread({
  api,
  meId,
  conversationId,
  version,
  members,
  replying,
  canDelete,
  emailAvailable,
  readOnly,
  suspended,
  drafts,
  receiptsVersion,
  rewriteVersion,
  typingDraft,
  onBack,
  onChanged,
  onLoaded,
  onOpenContact,
  onOpenConversation,
}: {
  api: WorkspaceApi;
  meId: string;
  /** Unsent replies by conversation, kept while the operator looks at another one. */
  drafts: Map<string, string>;
  members: Member[];
  replying: string | null;
  canDelete: boolean;
  /** This server sends email, so a transcript can go. */
  emailAvailable: boolean;
  /** The subscription ended: replies are off, except text in the welcome chat. */
  readOnly: boolean;
  suspended: boolean;
  conversationId: string;
  /** Goes up on every change, so this loads what it has not seen, in order, with no gaps. */
  version: number;
  /** Goes up when this visitor read replies or got a reply email. */
  receiptsVersion(visitorId: string): number;
  /** Goes up when someone edits or deletes a message here, so this loads every message again. */
  rewriteVersion: number;
  /** What the visitor is typing and has not sent, or null. */
  typingDraft: string | null;
  onBack(): void;
  onChanged(): void;
  /** The conversation as each load finds it. */
  onLoaded(conversation: Conversation): void;
  onOpenContact(visitorId: string): void;
  onOpenConversation(id: string, status: "open" | "closed"): void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [pages, setPages] = useState<PageView[]>([]);
  const [welcome, setWelcome] = useState<WelcomeChat | null>(null);
  const [receipts, setReceipts] = useState<ReplyReceipts | null>(null);
  const panel = usePanel();
  const visitorId = conversation?.visitor.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a load.
  const contact = useLoad(
    () => (visitorId === null ? null : api.contact(visitorId)),
    [api, visitorId, version],
  );
  // A read-only workspace can still answer in its welcome chat, in text: the server takes it there.
  const repliesOffReason: TextId | null = suspended
    ? "suspendedHelp"
    : readOnly && welcome === null
      ? "readOnlyHelp"
      : null;
  const imagesOn = !readOnly && !suspended;
  const [lines, setLines] = useState<Line[]>([]);
  // Here and not in the composer, which unmounts while the conversation is closed.
  const [draft, setDraftState] = useState(() => drafts.get(conversationId) ?? "");
  const setDraft = (next: string) => {
    setDraftState(next);
    if (next === "") drafts.delete(conversationId);
    else drafts.set(conversationId, next);
  };
  const [problem, setProblem] = useState<TextId | null>(null);
  // Why the last load failed, shown only while nothing has loaded yet.
  const [loadFailure, setLoadFailure] = useState<TextId | null>(null);
  const [dropping, setDropping] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The message the next reply quotes, the reply being edited, and the dialogs about one message.
  const [quoting, setQuoting] = useState<Line | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    draft: string;
    problem: TextId | null;
  } | null>(null);
  const [info, setInfo] = useState<Line | null>(null);
  const [deleting, setDeleting] = useState<Line | null>(null);
  const lastRefresh = useRef(0);
  const log = useRef<HTMLDivElement>(null);
  const position = useRef("0");

  const load = useLatestLoad(async () => {
    for (let more = true; more; ) {
      const page = await api.messages(conversationId, position.current).catch((failure) => {
        // Another operator deleted this conversation.
        if (failure instanceof ApiError && failure.status === 404) onBack();
        setLoadFailure(failureText(failure, {}, "actionFailed"));
        throw failure;
      });
      setLoadFailure(null);
      setConversation(page.conversation);
      onLoaded(page.conversation);
      setOnline(page.visitorOnline);
      setPages(page.visitorPages);
      setWelcome(page.welcome);
      setReceipts(page.receipts);
      setLines((current) => page.messages.reduce(merge, current));
      const last = page.messages.at(-1);
      if (last !== undefined) position.current = last.seq;
      more = page.hasMore;
    }
  });
  const receiptsSeen = conversation === null ? 0 : receiptsVersion(conversation.visitor.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each version asks for a load.
  useEffect(load, [load, version, receiptsSeen]);
  // An edit or a delete keeps the message's position, so only a load from the start finds it.
  useEffect(() => {
    if (rewriteVersion === 0) return;
    position.current = "0";
    load();
  }, [load, rewriteVersion]);
  // The visitor's online state changes with no event, so it is read again now and then.
  useEffect(() => {
    const timer = setInterval(load, ONLINE_EVERY_MS);
    return () => clearInterval(timer);
  }, [load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new line or draft scrolls down.
  useEffect(() => {
    if (log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [lines.length, typingDraft !== null]);

  const { flashId, jump } = useJump(log);
  // A copied link to a message ends with #message-<id>, and this scrolls to it once it is loaded.
  const linkedMessage = useRef(
    location.hash.startsWith("#message-") ? location.hash.slice("#message-".length) : null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line may be the linked one.
  useEffect(() => {
    const id = linkedMessage.current;
    if (id !== null && jump(id)) linkedMessage.current = null;
  }, [lines.length]);

  // An image's URL expires after 15 minutes. Loading from the start gives every line a new one.
  const refreshImages = () => {
    if (Date.now() - lastRefresh.current < REFRESH_LIMIT_MS) return;
    lastRefresh.current = Date.now();
    position.current = "0";
    load();
  };

  const deliver = async (id: string, body: string, file?: File, replyToId?: string) => {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, status: "sending" } : line)),
    );
    try {
      const sent =
        file === undefined
          ? await api.reply(conversationId, id, body, replyToId)
          : await api.replyImage(conversationId, id, file, replyToId);
      setLines((current) => merge(current, sent));
      onChanged();
    } catch (error) {
      if (file !== undefined && error instanceof ApiError && REFUSED.includes(error.status)) {
        setProblem(error.status === 507 ? "imageNoRoom" : "imageFailed");
        setLines((current) => current.filter((line) => line.id !== id));
        return;
      }
      if (error instanceof ApiError && error.code === "invalid_reply_to")
        setProblem("quoteInvalid");
      setLines((current) =>
        current.map((line) => (line.id === id ? { ...line, status: "failed" } : line)),
      );
    }
  };

  /** A line this operator is sending, before the server confirms it. */
  const pending = (id: string, body: string, replyTo: Quote | null): Line => ({
    id,
    seq: null,
    body,
    image: null,
    imageRemoved: false,
    fromVisitor: false,
    authorOperatorId: meId,
    authorApiKeyId: null,
    authorName: null,
    status: "sending",
    replyTo,
    editedAt: null,
    deleted: false,
    via: null,
  });

  /** Who wrote a line, as this thread names them. */
  const authorOf = (line: Line) =>
    line.fromVisitor ? (conversation === null ? "" : title(conversation)) : replyAuthor(line, meId);

  const sendText = (body: string) => {
    const id = newClientId();
    const quote =
      quoting === null ? null : quoteOf(quoting, quoting.authorName ?? authorOf(quoting));
    setQuoting(null);
    setLines((current) => [...current, pending(id, body, quote)]);
    void deliver(id, body, undefined, quote?.id ?? undefined);
  };

  const sendFiles = (files: Iterable<File>) => {
    // Once, before the loop, so a good file cannot erase the warning about the one before it.
    setProblem(null);
    for (const file of files) {
      const problem = imageProblem(file);
      if (problem !== null) {
        setProblem(problem);
        continue;
      }
      const id = newClientId();
      setLines((current) => [...current, { ...pending(id, "", null), file }]);
      void deliver(id, "", file);
    }
  };

  /**
   * Runs a change, and tells the operator when it fails, so a click never just does nothing. The
   * failure shows below the thread, or where `report` puts it.
   */
  const act = async (
    work: () => Promise<unknown>,
    fallback: TextId = "actionFailed",
    report: (text: TextId) => void = setProblem,
  ): Promise<boolean> => {
    setProblem(null);
    try {
      await work();
      return true;
    } catch (failure) {
      report(failureText(failure, {}, fallback));
      return false;
    }
  };

  const setBlocked = async (blocked: boolean) => {
    if (!(await act(() => (blocked ? api.block(conversationId) : api.unblock(conversationId))))) {
      return;
    }
    setConversation((current) =>
      current === null ? current : { ...current, visitor: { ...current.visitor, blocked } },
    );
    onChanged();
  };

  /** Saves an edit. The editor and its text stay until it is saved, and a failure shows in it. */
  const saveEdit = async (id: string, body: string) => {
    const report = (problem: TextId) =>
      setEditing((current) => (current?.id === id ? { ...current, problem } : current));
    const saved = await act(
      async () => {
        const edited = await api.editMessage(conversationId, id, body);
        setLines((current) => merge(current, edited));
      },
      "actionFailed",
      report,
    );
    if (saved) setEditing((current) => (current?.id === id ? null : current));
  };

  const removeMessage = async (line: Line) => {
    setDeleting(null);
    if (!(await act(() => api.deleteMessage(conversationId, line.id), "messageDeleteFailed"))) {
      return;
    }
    // Every quote of it changes too, so the whole thread loads again.
    position.current = "0";
    load();
    onChanged();
  };

  const openQuote = (id: string) => {
    if (!jump(id)) toast("quoteMissing", false);
  };

  const actionsFor = (line: Line): LineActions => ({
    reply: () => {
      setEditing(null);
      setQuoting(line);
    },
    copyText: () => void copy(line.body, "copied"),
    edit: () => {
      setQuoting(null);
      setEditing({ id: line.id, draft: line.body, problem: null });
    },
    info: () => setInfo(line),
    copyLink: () => {
      const url = new URL("/", location.origin);
      url.searchParams.set("workspace", api.workspaceId);
      url.searchParams.set("conversation", conversationId);
      url.hash = `message-${line.id}`;
      void copy(url.href, "linkCopied");
    },
    remove: () => setDeleting(line),
  });

  const remove = async () => {
    if (!(await act(() => api.remove(conversationId), "deleteFailed"))) {
      setConfirming(false);
      return;
    }
    onChanged();
    onBack();
  };

  const assign = async (operatorId: string | null) => {
    if (!(await act(() => api.assign(conversationId, operatorId)))) return;
    setConversation((current) =>
      current === null ? current : { ...current, assigneeOperatorId: operatorId },
    );
    onChanged();
  };

  const sendTranscript = async () => {
    if (await act(() => api.sendTranscript(conversationId))) toast("transcriptSent");
  };
  const setStatus = async (status: "open" | "closed") => {
    if (!(await act(() => api.setStatus(conversationId, status)))) return;
    setConversation((current) => (current === null ? current : { ...current, status }));
    onChanged();
  };

  if (conversation === null) {
    return (
      <div className="thread">
        <Loading failure={loadFailure} />
      </div>
    );
  }
  const closed = conversation.status === "closed";
  // A welcome chat's visitor is another workspace, with no visit to show.
  const showsPanel = welcome === null && panel.open;
  const face = conversation.visitor.pictureUrl;
  const lastReply = lines.reduce(
    (last, line, index) =>
      !line.fromVisitor && line.note === undefined && line.seq !== null ? index : last,
    -1,
  );
  const visitorName = title(conversation);
  const who = {
    meId,
    mayDeleteAny: canDelete,
    canWrite: repliesOffReason === null,
    canReply: repliesOffReason === null && !closed,
  };
  const infoLine: InfoLine | null =
    info === null || info.createdAt === undefined
      ? null
      : {
          id: info.id,
          createdAt: info.createdAt,
          author: info.fromVisitor ? visitorName : (info.authorName ?? authorOf(info)),
          via: info.via,
          receipt:
            info.fromVisitor || receipts === null || info.seq === null
              ? null
              : { isRead: receiptOf(info.seq, receipts) === "read" },
        };
  return (
    <div className="conversation-view">
      <section
        className={dropping && !closed ? "thread drop" : "thread"}
        aria-label={title(conversation)}
        onDragOver={(event) => {
          // A drag of selected text keeps its normal behavior.
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!closed && imagesOn) sendFiles(event.dataTransfer.files);
        }}
      >
        <ThreadHead
          conversation={conversation}
          welcome={welcome}
          online={online}
          members={members}
          canDelete={canDelete}
          onBack={onBack}
          onAssign={(operatorId) => void assign(operatorId)}
          onStatus={(status) => void setStatus(status)}
          onBlocked={(blocked) => void setBlocked(blocked)}
          onDelete={() => setConfirming(true)}
          onTranscript={() => void sendTranscript()}
          emailAvailable={emailAvailable}
          panel={welcome === null ? panel : null}
        />
        {confirming && (
          <Confirm
            title={t("deleteTitle")}
            text={t("deleteConfirm")}
            confirm={t("deleteYes")}
            onConfirm={() => void remove()}
            onCancel={() => setConfirming(false)}
          />
        )}
        {deleting !== null && (
          <Confirm
            title={t("messageDeleteTitle")}
            text={t("messageDeleteText")}
            confirm={t("messageDeleteYes")}
            onConfirm={() => void removeMessage(deleting)}
            onCancel={() => setDeleting(null)}
          />
        )}
        {infoLine !== null && (
          <MessageInfo
            api={api}
            conversationId={conversationId}
            line={infoLine}
            onClose={() => setInfo(null)}
          />
        )}
        {conversation.visitor.blocked && (
          <p className="replying blocked" role="status">
            {t("blockedNote")}
          </p>
        )}
        {replying !== null && (
          <p className="replying" role="status">
            {replying}
          </p>
        )}
        <div className="log" role="log" aria-live="polite" ref={log}>
          {lines.length === 0 && <p className="empty">{t("noMessages")}</p>}
          {lines.map((line, index) => {
            const day = dayOf(line);
            const meta = groupMeta(lines, index, meId);
            const receipt =
              line.fromVisitor || line.seq === null || receipts === null ? null : (
                <ReceiptLine receipt={receiptOf(line.seq, receipts)} later={index !== lastReply} />
              );
            return (
              <Fragment key={line.id}>
                {line.createdAt !== undefined && day !== dayOf(lines[index - 1]) && (
                  <div className="day">{dayLabel(line.createdAt)}</div>
                )}
                {line.note !== undefined ? (
                  <StatusNote line={line} note={line.note} meId={meId} />
                ) : (
                  <>
                    {/* The welcome chat's founder has a face, as an operator does in the widget. */}
                    {face !== null && line.fromVisitor && !sameSender(lines[index - 1], line) && (
                      <div className="author-face">
                        <img src={face} alt="" />
                        {title(conversation)}
                      </div>
                    )}
                    <ThreadLine
                      line={line}
                      quote={
                        line.replyTo === null ? null : (
                          <QuoteBlock
                            quote={line.replyTo}
                            visitorName={visitorName}
                            onOpen={openQuote}
                          />
                        )
                      }
                      menu={
                        <MessageMenu
                          items={lineMenu(line, who, receipts, actionsFor(line))}
                          side={line.fromVisitor ? "start" : "end"}
                        />
                      }
                      editor={
                        editing?.id === line.id ? (
                          <Composer
                            editing
                            draft={editing.draft}
                            setDraft={(draft) => setEditing({ ...editing, draft })}
                            onSend={(body) => void saveEdit(line.id, body)}
                            onFiles={undefined}
                            onEscape={() => setEditing(null)}
                            above={<ErrorNote text={editing.problem} />}
                          />
                        ) : null
                      }
                      flash={flashId === line.id}
                      receipt={receipt}
                      onView={() => setViewing(line.id)}
                      onImageError={refreshImages}
                      onRetry={() =>
                        void deliver(line.id, line.body, line.file, line.replyTo?.id ?? undefined)
                      }
                    />
                    {meta !== null && (
                      <div className={line.fromVisitor ? "meta visitor" : "meta"}>{meta}</div>
                    )}
                  </>
                )}
              </Fragment>
            );
          })}
          {typingDraft !== null && <TypingDraft draft={typingDraft} />}
        </div>
        {viewing !== null && (
          <ImageViewer
            url={lines.find((line) => line.id === viewing)?.image?.url}
            onClose={() => setViewing(null)}
            onError={refreshImages}
          />
        )}
        <ErrorNote text={problem} />
        {repliesOffReason !== null ? (
          <p className="closed">{t(repliesOffReason)}</p>
        ) : closed ? (
          <p className="closed">
            <Icon name="done" size={18} />
            {t("closedHelp")}
          </p>
        ) : (
          <Composer
            draft={draft}
            setDraft={setDraft}
            onSend={sendText}
            onFiles={imagesOn ? sendFiles : undefined}
            onEscape={quoting === null ? undefined : () => setQuoting(null)}
            above={
              quoting === null ? undefined : (
                <QuoteChip
                  quote={quoteOf(quoting, authorOf(quoting))}
                  visitorName={visitorName}
                  onCancel={() => setQuoting(null)}
                />
              )
            }
          />
        )}
      </section>
      {showsPanel && (
        <VisitorPanel
          conversation={conversation}
          contact={contact.data}
          online={online}
          pages={pages}
          members={members}
          overlay={!panel.wide}
          onAssign={(operatorId) => void assign(operatorId)}
          onOpenContact={() => onOpenContact(conversation.visitor.id)}
          onOpenConversation={onOpenConversation}
          onNote={async (note) => {
            contact.setData(await api.changeContact(conversation.visitor.id, { note }));
          }}
          onClose={panel.toggle}
        />
      )}
    </div>
  );
}

const PANEL_KEY = "dinghy.panel.open";
const WIDE = "(min-width: 1200px)";

/**
 * Whether the visitor's panel shows. On a wide screen it remembers this device's choice, and starts
 * open. On a narrower one it opens as a drawer over the thread, and starts closed each time.
 */
function usePanel() {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  const [open, setOpen] = useState(() => wide && readStored(PANEL_KEY) !== "closed");
  useEffect(() => {
    const query = matchMedia(WIDE);
    const changed = () => {
      setWide(query.matches);
      setOpen(query.matches && readStored(PANEL_KEY) !== "closed");
    };
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const toggle = () => {
    if (wide) store(PANEL_KEY, open ? "closed" : null);
    setOpen(!open);
  };
  return { open, wide, toggle };
}
