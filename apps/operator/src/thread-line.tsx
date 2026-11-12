/** @jsxImportSource react */
import { createElement, type ReactNode } from "react";
import { type CreateElement, renderMarkdown } from "../../../packages/widget/src/markdown.ts";
import type { Note } from "./api.ts";
import { clockTime, isToday } from "./format.ts";
import { Icon } from "./icons.tsx";
import { type Receipt, ReceiptLine } from "./receipts.tsx";
import { t } from "./text.ts";
import type { Line } from "./thread-lines.ts";
import { replyAuthor } from "./visitor.ts";

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
export function ThreadLine({
  line,
  quote,
  menu,
  editor,
  flash,
  receipt,
  isLastReply,
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
  /** How far the visitor has seen this reply. Null for a visitor's message. */
  receipt: Receipt | null;
  /**
   * The last reply's receipt shows under its bubble. An earlier one shows beside its bubble while
   * the pointer is on it, over the empty side, so nothing in the thread moves.
   */
  isLastReply: boolean;
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
          {receipt !== null && !isLastReply && <ReceiptLine receipt={receipt} later />}
        </div>
      )}
      {receipt !== null && isLastReply && <ReceiptLine receipt={receipt} later={false} />}
      {line.status === "sending" && <div className="state">{t("sending")}</div>}
      {line.status === "failed" && (
        <button type="button" className="retry" onClick={onRetry}>
          {t("failed")}
        </button>
      )}
    </>
  );
}

/**
 * A centered line where someone closed or reopened the conversation: who, and when. A reopen with
 * no operator or key, as the cloud's welcome chat does, names nobody.
 */
export function StatusNote({
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
  const time = line.createdAt === undefined ? null : clockTime(line.createdAt);
  return (
    <p className="status-note">
      {text}
      {time !== null && <time dateTime={line.createdAt}> · {time}</time>}
    </p>
  );
}

/**
 * Elements for a key's note: each link shows as plain text with its address, and nobody can click
 * it. A bot's note may carry a visitor's link, and the team's card would make it look trusted.
 */
const plainLinks: CreateElement<ReactNode> = (tag, props, ...children) => {
  if (tag !== "a") return createElement(tag, props, ...children);
  const href = String(props?.href);
  const isBare = children.length === 1 && children[0] === href;
  return createElement(
    "span",
    { className: "plain-link" },
    ...(isBare ? [] : [...children, " ("]),
    href,
    isBare ? "" : ")",
  );
};

/** A note for the team, across the thread: who wrote it, when, and its text. */
export function NoteCard({ note, meId }: { note: Note; meId: string }) {
  const isKey = note.authorKind === "key";
  const author = note.authorOperatorId === meId ? t("you") : (note.authorName ?? t("aTeammate"));
  return (
    <article className="team-note" aria-label={t("noteLabel", { name: author })}>
      <header className="team-note-head">
        <Icon name="note" size={16} />
        <strong className="card-author">
          {isKey && <Icon name="robot" size={14} />}
          {author}
        </strong>
        <time dateTime={note.createdAt}>{clockTime(note.createdAt)}</time>
      </header>
      {createElement(
        "div",
        { className: "team-note-body" },
        ...renderMarkdown(note.body, isKey ? plainLinks : createElement),
      )}
    </article>
  );
}

/** A bot types a reply: its name, with dots that move. */
export function BotTyping({ name }: { name: string }) {
  return (
    <div className="meta typing" role="status">
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {t("botTyping", { name })}
    </div>
  );
}

/** A visitor's unsent words, faded, with dots that move while they type. */
export function TypingDraft({ draft }: { draft: string }) {
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

export const sameSender = (one: Line | undefined, other: Line | undefined) =>
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
export function dayLabel(iso: string): string {
  const day = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isToday(day)) return t("today");
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
export function groupMeta(lines: Line[], index: number, meId: string): string | null {
  const line = lines[index];
  if (line === undefined || line.status !== "sent") return null;
  const after = lines[index + 1];
  // An edited reply always shows its time, with "edited" beside it.
  const edited = line.editedAt !== null && !line.deleted;
  const ends = !sameSender(line, after) || dayOf(after) !== dayOf(line) || after?.status !== "sent";
  if (!edited && !ends) return null;
  const at = line.createdAt === undefined ? null : clockTime(line.createdAt);
  const time = edited ? [at, t("messageEdited")].filter(Boolean).join(" · ") : at;
  if (line.fromVisitor) return time;
  const who = replyAuthor(line, meId);
  return time === null ? who : `${who} · ${time}`;
}
