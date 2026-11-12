/** @jsxImportSource react */
import { Fragment, type RefObject, useEffect, useRef, useState } from "react";
import type { Conversation, ReplyReceipts } from "./api.ts";
import { Composer } from "./composer.tsx";
import { Icon } from "./icons.tsx";
import { MessageMenu, QuoteBlock } from "./message.tsx";
import { lineMenu, type MessageActions, type Rights } from "./message-actions.tsx";
import { hasReceipt, receiptOf } from "./receipts.tsx";
import { t } from "./text.ts";
import {
  dayLabel,
  dayOf,
  groupMeta,
  isStatusLine,
  StatusNote,
  sameSender,
  ThreadLine,
  TypingDraft,
} from "./thread-line.tsx";
import type { Line } from "./thread-lines.ts";
import { toast } from "./toast.tsx";
import { ErrorNote, useModal } from "./ui.tsx";
import { replyAuthor, title } from "./visitor.ts";

/**
 * The image as a file, read when the viewer opens: a phone shares only during the tap itself, and
 * a read after the tap could outlast it.
 */
function useImageFile(url: string | undefined): File | null {
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => {
    if (url === undefined) return;
    let current = true;
    fetch(url)
      .then((response) => (response.ok ? response.blob() : Promise.reject(response.status)))
      .then((blob) => {
        const kind = blob.type.split("/")[1] ?? "png";
        if (current) setFile(new File([blob], `image.${kind}`, { type: blob.type }));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [url]);
  return file;
}

/** A phone opens its share sheet, which has Save Image for the photos. A computer downloads it. */
function saveImage(file: File) {
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] }).catch((error: unknown) => {
      // The operator closed the share sheet.
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        toast("imageSaveFailed", false);
      }
    });
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href));
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
  const file = useImageFile(url);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a dialog.
    <dialog
      ref={viewer}
      className="viewer"
      onClose={onClose}
      onClick={() => viewer.current?.close()}
    >
      <img src={url} alt={t("imageAlt")} onError={onError} />
      {/* A phone has no Escape key and little backdrop around a wide image. */}
      <div className="viewer-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={t("imageSave")}
          disabled={file === null}
          onClick={(event) => {
            event.stopPropagation();
            if (file !== null) saveImage(file);
          }}
        >
          <Icon name="download" size={20} />
        </button>
        <button type="button" className="icon-button" aria-label={t("close")}>
          <Icon name="close" size={20} />
        </button>
      </div>
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
  const lastReply = lines.reduce((last, line, index) => (hasReceipt(line) ? index : last), -1);
  const openQuote = (id: string) => {
    if (!jump(id)) toast("quoteMissing", false);
  };

  const renderLine = (line: Line, index: number) => {
    const meta = groupMeta(lines, index, who.meId);
    const receipt = !hasReceipt(line) || receipts === null ? null : receiptOf(line.seq, receipts);
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
          noteBy={line.kind === "note" ? replyAuthor(line, who.meId) : null}
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
          isLastReply={index === lastReply}
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
            {isStatusLine(line) ? (
              <StatusNote line={line} meId={who.meId} />
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
