/** @jsxImportSource react */
import {
  createElement,
  Fragment,
  type ReactNode,
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
import { renderMarkdown } from "../../../packages/widget/src/markdown.ts";
import {
  ApiError,
  type Conversation,
  type Member,
  type Message,
  type PageView,
  type ReplyReceipts,
  type WelcomeChat,
  type WorkspaceApi,
} from "./api.ts";
import { code, type Edit, link, list, wrap } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { useLatestLoad, useLoad } from "./load.ts";
import { Confirm, Menu, type MenuItem, Select } from "./popup.tsx";
import { readStored, store } from "./stored.ts";
import { type TextId, t } from "./text.ts";
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
}) {
  const closed = conversation.status === "closed";
  const { blocked } = conversation.visitor;
  const assignee = members.some((member) => member.id === conversation.assigneeOperatorId)
    ? (conversation.assigneeOperatorId ?? "")
    : "";
  const more: MenuItem[] = [
    {
      label: blocked ? t("unblockVisitor") : t("blockVisitor"),
      lead: <Icon name="prohibit" size={18} />,
      onSelect: () => onBlocked(!blocked),
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
          <Avatar name={title(conversation)} letters={avatarLetters(conversation.visitor)} />
          {online === true && <i className="presence-dot" />}
        </span>
        <div className="who-text">
          <h2>{title(conversation)}</h2>
          {welcome !== null ? (
            <WelcomeNote welcome={welcome} />
          ) : (
            presence !== null && (
              <p className={online === true ? "visit online" : "visit"}>{presence}</p>
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
          <Icon name={closed ? "inbox" : "done"} size={18} />
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
}: {
  draft: string;
  setDraft(draft: string): void;
  onSend(body: string): void;
  /** Undefined when only text can go, as in a read-only workspace's welcome chat. */
  onFiles: ((files: Iterable<File>) => void) | undefined;
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
    setDraft("");
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
    <form className="compose" onSubmit={submit}>
      <div className="box">
        <textarea
          ref={input}
          rows={1}
          onPaste={(event) => {
            // A copy from Word or Excel holds its text and a picture of it. The text is what is meant.
            const { clipboardData: data } = event;
            if (onFiles === undefined || data.files.length === 0) return;
            if (data.getData("text/plain") !== "") return;
            event.preventDefault();
            onFiles(data.files);
          }}
          aria-label={t("replyLabel")}
          placeholder={t("replyPlaceholder")}
          maxLength={10_000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isComposing(event.nativeEvent)) {
              submit(event);
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
          <button type="submit" className="send" aria-label={t("send")} title={t("send")}>
            <Icon name="arrowUp" size={16} />
          </button>
        </div>
      </div>
    </form>
  );
}

/** One message in the log. */
function ThreadLine({
  line,
  receipt,
  onView,
  onImageError,
  onRetry,
}: {
  line: Line;
  /** How far the visitor has seen this reply, under its bubble. */
  receipt: ReactNode;
  onView(): void;
  onImageError(): void;
  onRetry(): void;
}) {
  return (
    <>
      {line.image !== null ? (
        <button
          type="button"
          className={line.fromVisitor ? "shot visitor" : "shot"}
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
      ) : line.imageRemoved ? (
        <div className={line.fromVisitor ? "msg visitor removed" : "msg removed"}>
          {t("imageRemoved")}
        </div>
      ) : line.file !== undefined ? (
        <div className="msg">{t("imageSending")}</div>
      ) : (
        createElement(
          "div",
          { className: line.fromVisitor ? "msg visitor" : "msg" },
          ...renderMarkdown(line.body, createElement),
        )
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
  if (receipts.emailedSeq !== null && seq <= BigInt(receipts.emailedSeq)) return "emailed";
  if (receipts.emailFailedSeq !== null && seq <= BigInt(receipts.emailFailedSeq)) {
    return "emailFailed";
  }
  return "sent";
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
  if (sameSender(line, after) && dayOf(after) === dayOf(line) && after?.status === "sent") {
    return null;
  }
  const time =
    line.createdAt === undefined
      ? null
      : new Date(line.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (line.fromVisitor) return time;
  const who = replyAuthor(line, meId);
  return time === null ? who : `${who} · ${time}`;
}

export function Thread({
  api,
  meId,
  conversationId,
  version,
  members,
  replying,
  canDelete,
  readOnly,
  suspended,
  drafts,
  receiptsVersion,
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
  /** The subscription ended: replies are off, except text in the welcome chat. */
  readOnly: boolean;
  suspended: boolean;
  conversationId: string;
  /** Goes up on every change, so this loads what it has not seen, in order, with no gaps. */
  version: number;
  /** Goes up when this visitor read replies or got a reply email. */
  receiptsVersion(visitorId: string): number;
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
  // The visitor's online state changes with no event, so it is read again now and then.
  useEffect(() => {
    const timer = setInterval(load, ONLINE_EVERY_MS);
    return () => clearInterval(timer);
  }, [load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new line or draft scrolls down.
  useEffect(() => {
    if (log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [lines.length, typingDraft !== null]);

  // An image's URL expires after 15 minutes. Loading from the start gives every line a new one.
  const refreshImages = () => {
    if (Date.now() - lastRefresh.current < REFRESH_LIMIT_MS) return;
    lastRefresh.current = Date.now();
    position.current = "0";
    load();
  };

  const deliver = async (id: string, body: string, file?: File) => {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, status: "sending" } : line)),
    );
    try {
      const sent =
        file === undefined
          ? await api.reply(conversationId, id, body)
          : await api.replyImage(conversationId, id, file);
      setLines((current) => merge(current, sent));
      onChanged();
    } catch (error) {
      if (file !== undefined && error instanceof ApiError && REFUSED.includes(error.status)) {
        setProblem(error.status === 507 ? "imageNoRoom" : "imageFailed");
        setLines((current) => current.filter((line) => line.id !== id));
        return;
      }
      setLines((current) =>
        current.map((line) => (line.id === id ? { ...line, status: "failed" } : line)),
      );
    }
  };

  const sendText = (body: string) => {
    const id = newClientId();
    setLines((current) => [
      ...current,
      {
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
      },
    ]);
    void deliver(id, body);
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
      setLines((current) => [
        ...current,
        {
          id,
          seq: null,
          body: "",
          image: null,
          imageRemoved: false,
          file,
          fromVisitor: false,
          authorOperatorId: meId,
          authorApiKeyId: null,
          authorName: null,
          status: "sending",
        },
      ]);
      void deliver(id, "", file);
    }
  };

  /** Runs a change, and tells the operator when it fails, so a click never just does nothing. */
  const act = async (work: () => Promise<unknown>): Promise<boolean> => {
    setProblem(null);
    try {
      await work();
      return true;
    } catch (failure) {
      setProblem(failureText(failure, {}, "actionFailed"));
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

  const remove = async () => {
    try {
      await api.remove(conversationId);
    } catch (failure) {
      setProblem(failureText(failure, {}, "deleteFailed"));
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
  const lastReply = lines.reduce(
    (last, line, index) =>
      !line.fromVisitor && line.note === undefined && line.seq !== null ? index : last,
    -1,
  );
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
                    <ThreadLine
                      line={line}
                      receipt={receipt}
                      onView={() => setViewing(line.id)}
                      onImageError={refreshImages}
                      onRetry={() => void deliver(line.id, line.body, line.file)}
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
