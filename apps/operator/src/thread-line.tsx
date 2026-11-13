/** @jsxImportSource react */
import { createElement, type ReactNode, useEffect, useRef } from "react";
import { fileSize, isImage, saveWithRefresh } from "../../../packages/widget/src/compose.ts";
import { type CreateElement, renderMarkdown } from "../../../packages/widget/src/markdown.ts";
import { clockTime, isToday } from "./format.ts";
import { Icon } from "./icons.tsx";
import { type Receipt, ReceiptLine } from "./receipts.tsx";
import { t } from "./text.ts";
import type { Line } from "./thread-lines.ts";
import { replyAuthor } from "./visitor.ts";

/**
 * Elements for a key's note: each link shows as plain text with its address, and nobody can click
 * it. A bot's note may carry a visitor's link, and the team's note would make it look trusted.
 */
export const plainLinks: CreateElement<ReactNode> = (tag, props, ...children) => {
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

/**
 * A file's link, which saves the file and never leaves the page. After an expired URL, the line's
 * next one comes with the new URLs that onExpired asks for.
 */
function FileLink({
  download,
  onExpired,
}: {
  download: NonNullable<Line["download"]>;
  onExpired(): void;
}) {
  // Waits for the line's next URL, after an expired one.
  const nextUrl = useRef<((url: string) => void) | null>(null);
  useEffect(() => {
    nextUrl.current?.(download.url);
    nextUrl.current = null;
  }, [download.url]);
  return (
    <a
      className="file-link"
      href={download.url}
      onClick={(event) => {
        event.preventDefault();
        nextUrl.current = null;
        void saveWithRefresh(download.url, download.name, () => {
          const next = new Promise<string>((resolve) => {
            nextUrl.current = resolve;
          });
          onExpired();
          return next;
        });
      }}
    >
      <Icon name="download" size={20} />
      <span className="file-name">{download.name}</span>
      <span className="file-size">{fileSize(download.size, [])}</span>
    </a>
  );
}

/** A message's bubble: its quote and text, its image or file, or what stands in for them. */
function Bubble({
  line,
  quote,
  noteBy,
  onView,
  onImageError,
}: {
  line: Line;
  quote: ReactNode;
  noteBy: string | null;
  onView(): void;
  onImageError(): void;
}) {
  const side = line.fromVisitor ? " visitor" : line.kind === "note" ? " note" : "";
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
  if (line.download !== null) {
    return (
      <div className={`msg${side}`}>
        {quote}
        <FileLink download={line.download} onExpired={onImageError} />
      </div>
    );
  }
  if (line.imageRemoved) return <div className={`msg${side} removed`}>{t("imageRemoved")}</div>;
  if (line.fileRemoved) return <div className={`msg${side} removed`}>{t("fileRemoved")}</div>;
  if (line.file !== undefined) {
    return <div className="msg">{t(isImage(line.file) ? "imageSending" : "fileSending")}</div>;
  }
  return createElement(
    "div",
    { className: `msg${side}` },
    noteBy !== null && <span className="note-label">{t("noteBy", { name: noteBy })}</span>,
    quote,
    ...renderMarkdown(
      line.body,
      line.kind === "note" && line.authorApiKeyId !== null ? plainLinks : createElement,
    ),
  );
}

/** One message in the log: its bubble and its "…", or the editor that replaces them. */
export function ThreadLine({
  line,
  quote,
  noteBy,
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
  /** A note's author, for its "Internal note" label. Null for any other line. */
  noteBy: string | null;
  menu: ReactNode;
  /** The inline editor while the operator edits this reply. */
  editor: ReactNode;
  /** Highlighted for a moment, after a click on a quote of it or a link to it. */
  flash: boolean;
  /** The receipt line under this reply, or null when it shows none. */
  receipt: Receipt | null;
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
          <Bubble
            line={line}
            quote={quote}
            noteBy={noteBy}
            onView={onView}
            onImageError={onImageError}
          />
          {menu}
        </div>
      )}
      {receipt !== null && <ReceiptLine receipt={receipt} />}
      {line.via === "email" && (
        <div className="meta visitor">
          {t(line.fromOtherAddress ? "repliedByEmailOtherAddress" : "repliedByEmail")}
        </div>
      )}
      {line.status === "sending" && <div className="state">{t("sending")}</div>}
      {line.status === "failed" && (
        <button type="button" className="retry" onClick={onRetry}>
          {t("failed")}
        </button>
      )}
    </>
  );
}

/** Someone closed or reopened the conversation. */
export const isStatusLine = (line: Line) => line.kind === "closed" || line.kind === "reopened";

/**
 * A centered line where someone closed or reopened the conversation: who, and when. A reopen with
 * no operator or key, by the visitor's message, names nobody.
 */
export function StatusNote({ line, meId }: { line: Line; meId: string }) {
  const byPerson = line.authorOperatorId !== null || line.authorApiKeyId !== null;
  const closed = line.kind === "closed";
  const text = !byPerson
    ? t(closed ? "closedPlain" : "reopenedPlain")
    : line.authorOperatorId === meId
      ? t(closed ? "closedByYou" : "reopenedByYou")
      : t(closed ? "closedBy" : "reopenedBy", { name: replyAuthor(line, meId) });
  const time = line.createdAt === undefined ? null : clockTime(line.createdAt);
  return (
    <p className="status-note">
      {text}
      {time !== null && <time dateTime={line.createdAt}> · {time}</time>}
    </p>
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
  !isStatusLine(one) &&
  !isStatusLine(other) &&
  (one.kind === "note") === (other.kind === "note") &&
  one.fromVisitor === other.fromVisitor &&
  one.authorOperatorId === other.authorOperatorId &&
  one.authorApiKeyId === other.authorApiKeyId;

export const dayOf = (line: Line | undefined) =>
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
