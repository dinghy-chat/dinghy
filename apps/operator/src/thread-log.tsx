/** @jsxImportSource react */
import { Fragment, type RefObject, useEffect, useRef, useState } from "react";
import type { Conversation, ReplyReceipts } from "./api.ts";
import { Composer } from "./composer.tsx";
import { MessageMenu, QuoteBlock } from "./message.tsx";
import { lineMenu, type MessageActions, type Rights } from "./message-actions.tsx";
import { ReceiptLine, receiptOf } from "./receipts.tsx";
import { t } from "./text.ts";
import {
  dayLabel,
  dayOf,
  groupMeta,
  StatusNote,
  sameSender,
  ThreadLine,
  TypingDraft,
} from "./thread-line.tsx";
import type { Line } from "./thread-lines.ts";
import { toast } from "./toast.tsx";
import { ErrorNote, useModal } from "./ui.tsx";
import { title } from "./visitor.ts";

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

/** Keeps the log at its newest line, and jumps to the message a copied link names once it loads. */
function useLogScroll(lines: Line[], typingDraft: string | null) {
  const log = useRef<HTMLDivElement>(null);
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
  return { log, flashId, jump };
}

/** The thread's messages, day by day, with each one's menu, its editor and the image viewer. */
export function ThreadLog({
  conversation,
  lines,
  receipts,
  who,
  actions,
  typingDraft,
  onImageError,
  onRetry,
}: {
  conversation: Conversation;
  lines: Line[];
  receipts: ReplyReceipts | null;
  who: Rights;
  actions: MessageActions;
  typingDraft: string | null;
  onImageError(): void;
  onRetry(line: Line): void;
}) {
  const { log, flashId, jump } = useLogScroll(lines, typingDraft);
  const [viewing, setViewing] = useState<string | null>(null);
  const { editing, setEditing } = actions;
  const visitorName = title(conversation);
  const face = conversation.visitor.pictureUrl;
  const lastReply = lines.reduce(
    (last, line, index) =>
      !line.fromVisitor && line.note === undefined && line.seq !== null ? index : last,
    -1,
  );
  const openQuote = (id: string) => {
    if (!jump(id)) toast("quoteMissing", false);
  };

  const renderLine = (line: Line, index: number) => {
    const meta = groupMeta(lines, index, who.meId);
    const receipt =
      line.fromVisitor || line.seq === null || receipts === null ? null : (
        <ReceiptLine receipt={receiptOf(line.seq, receipts)} later={index !== lastReply} />
      );
    return (
      <>
        {/* The welcome chat's founder has a face, as an operator does in the widget. */}
        {face !== null && line.fromVisitor && !sameSender(lines[index - 1], line) && (
          <div className="author-face">
            <img src={face} alt="" />
            {visitorName}
          </div>
        )}
        <ThreadLine
          line={line}
          quote={
            line.replyTo === null ? null : (
              <QuoteBlock quote={line.replyTo} visitorName={visitorName} onOpen={openQuote} />
            )
          }
          menu={
            <MessageMenu
              items={lineMenu(line, who, receipts, actions.actionsFor(line))}
              side={line.fromVisitor ? "start" : "end"}
            />
          }
          editor={
            editing?.id === line.id ? (
              <Composer
                editing
                draft={editing.draft}
                setDraft={(draft) => setEditing({ ...editing, draft })}
                onSend={(body) => void actions.saveEdit(line.id, body)}
                onFiles={undefined}
                onEscape={() => setEditing(null)}
                above={<ErrorNote text={editing.problem} />}
              />
            ) : null
          }
          flash={flashId === line.id}
          receipt={receipt}
          receiptOnHover={index !== lastReply}
          onView={() => setViewing(line.id)}
          onImageError={onImageError}
          onRetry={() => onRetry(line)}
        />
        {meta !== null && <div className={line.fromVisitor ? "meta visitor" : "meta"}>{meta}</div>}
      </>
    );
  };

  return (
    <>
      <div className="log" role="log" aria-live="polite" ref={log}>
        {lines.length === 0 && <p className="empty">{t("noMessages")}</p>}
        {lines.map((line, index) => (
          <Fragment key={line.id}>
            {line.createdAt !== undefined && dayOf(line) !== dayOf(lines[index - 1]) && (
              <div className="day">{dayLabel(line.createdAt)}</div>
            )}
            {line.note !== undefined ? (
              <StatusNote line={line} note={line.note} meId={who.meId} />
            ) : (
              renderLine(line, index)
            )}
          </Fragment>
        ))}
        {typingDraft !== null && <TypingDraft draft={typingDraft} />}
      </div>
      {viewing !== null && (
        <ImageViewer
          url={lines.find((line) => line.id === viewing)?.image?.url}
          onClose={() => setViewing(null)}
          onError={onImageError}
        />
      )}
    </>
  );
}
