/** @jsxImportSource react */
import { useEffect, useId, useState } from "react";
import type { Quote, WorkspaceApi } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Menu, type MenuItem } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { useModal } from "./ui.tsx";

/** Who wrote a quoted message: the name the server gave, or the visitor's name in this thread. */
const quoteAuthor = (quote: Quote, visitorName: string) =>
  quote.authorName ?? (quote.fromVisitor ? visitorName : t("aTeammate"));

/** The quoted words, or what stands in for them. */
function quoteText(quote: Quote): string {
  if (quote.id === null) return t("quoteDeleted");
  return quote.excerpt === "" && quote.hasImage ? t("quoteImage") : quote.excerpt;
}

/**
 * The quote inside a reply's bubble: who wrote the original and its first words. A click scrolls to
 * the original, unless it was deleted.
 */
export function QuoteBlock({
  quote,
  visitorName,
  onOpen,
}: {
  quote: Quote;
  visitorName: string;
  onOpen(id: string): void;
}) {
  const name = quoteAuthor(quote, visitorName);
  const words = (
    <>
      <strong>{name}</strong>
      <span className={quote.id === null ? "quote-text gone" : "quote-text"}>
        {quoteText(quote)}
      </span>
    </>
  );
  const { id } = quote;
  if (id === null) return <span className="quote">{words}</span>;
  return (
    <button
      type="button"
      className="quote"
      aria-label={t("quoteLabel", { name })}
      onClick={() => onOpen(id)}
    >
      {words}
    </button>
  );
}

/** Above the message box while a reply quotes a message: who and what, and an X to cancel. */
export function QuoteChip({
  quote,
  visitorName,
  onCancel,
}: {
  quote: Quote;
  visitorName: string;
  onCancel(): void;
}) {
  const name = quoteAuthor(quote, visitorName);
  return (
    <div className="quote-chip">
      <Icon name="reply" size={16} />
      <span className="quote-chip-text">
        <strong>{t("replyingTo", { name })}</strong>
        <span>{quoteText(quote)}</span>
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label={t("cancelReply")}
        title={t("cancelReply")}
        onClick={onCancel}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/** The "…" beside a bubble, which shows on hover or focus, and its menu. */
export function MessageMenu({ items, side }: { items: MenuItem[]; side: "start" | "end" }) {
  if (items.length === 0) return null;
  return (
    <Menu label={t("messageActions")} items={items} buttonClass="msg-more" side={side}>
      <Icon name="dots" size={18} />
    </Menu>
  );
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** What a message's info says about its receipt, once the times arrive. */
function receiptLines(
  receipt: { readAt: string | null; emailedAt: string | null },
  isRead: boolean,
): string[] {
  const lines: string[] = [];
  if (receipt.emailedAt !== null)
    lines.push(t("infoEmailedAt", { time: timeOf(receipt.emailedAt) }));
  if (receipt.readAt !== null) lines.push(t("infoReadAt", { time: timeOf(receipt.readAt) }));
  else if (isRead) lines.push(t("infoRead"));
  return lines.length === 0 ? [t("infoNotSeen")] : lines;
}

export interface InfoLine {
  id: string;
  createdAt: string;
  /** Who wrote it, as the thread names them. */
  author: string;
  via: "api" | "mcp" | null;
  /** A reply, whose receipt the info shows. Null for a visitor's message. */
  receipt: { isRead: boolean } | null;
}

/** A small dialog with a message's full time, its author, and when the visitor saw it. */
export function MessageInfo({
  api,
  conversationId,
  line,
  onClose,
}: {
  api: WorkspaceApi;
  conversationId: string;
  line: InfoLine;
  onClose(): void;
}) {
  const dialog = useModal();
  const titleId = useId();
  const [receipt, setReceipt] = useState<string[] | null>(null);
  // Primitives, so the thread's own renders do not ask for the times again.
  const wantsReceipt = line.receipt !== null;
  const isRead = line.receipt?.isRead === true;
  useEffect(() => {
    if (!wantsReceipt) return;
    api
      .messageReceipt(conversationId, line.id)
      .then((found) => setReceipt(receiptLines(found, isRead)))
      .catch(() => setReceipt([t(isRead ? "infoRead" : "infoNotSeen")]));
  }, [api, conversationId, line.id, wantsReceipt, isRead]);
  const via: TextId | null =
    line.via === "api" ? "infoViaApi" : line.via === "mcp" ? "infoViaMcp" : null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a dialog.
    <dialog
      ref={dialog}
      className="dialog message-info"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className="dialog-body">
        <h2 id={titleId}>{t("infoTitle")}</h2>
        <dl>
          <dd>
            {new Date(line.createdAt).toLocaleString([], {
              dateStyle: "full",
              timeStyle: "short",
            })}
          </dd>
          <dd>{via === null ? line.author : t(via, { name: line.author })}</dd>
          {wantsReceipt && (receipt ?? [t("loading")]).map((text) => <dd key={text}>{text}</dd>)}
        </dl>
        <div className="dialog-actions">
          <button type="button" className="pill dark" onClick={() => dialog.current?.close()}>
            {t("infoDone")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
