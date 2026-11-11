/** @jsxImportSource react */
import { Fragment, type RefObject, useEffect, useRef, useState } from "react";
import type { Conversation, Member, WorkspaceApi } from "./api.ts";
import { Composer } from "./composer.tsx";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import { type InfoLine, MessageInfo, MessageMenu, QuoteBlock, QuoteChip } from "./message.tsx";
import { lineMenu, quoteOf, useMessageActions } from "./message-actions.tsx";
import { Confirm } from "./popup.tsx";
import { ReceiptLine, receiptOf } from "./receipts.tsx";
import { readStored, store } from "./stored.ts";
import { type TextId, t } from "./text.ts";
import { ThreadHead } from "./thread-head.tsx";
import {
  dayLabel,
  dayOf,
  groupMeta,
  StatusNote,
  sameSender,
  ThreadLine,
  TypingDraft,
} from "./thread-line.tsx";
import { type Line, useThreadLines } from "./thread-lines.ts";
import { toast } from "./toast.tsx";
import { ErrorNote, failureText, Loading, useModal } from "./ui.tsx";
import { replyAuthor, title } from "./visitor.ts";
import { VisitorPanel } from "./visitor-panel.tsx";

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
  const [problem, setProblem] = useState<TextId | null>(null);
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
  const {
    conversation,
    setConversation,
    online,
    pages,
    welcome,
    receipts,
    lines,
    loadFailure,
    reloadAll,
    refreshImages,
    retry,
    sendText,
    sendFiles,
    keep,
  } = useThreadLines({
    api,
    conversationId,
    meId,
    version,
    receiptsVersion,
    rewriteVersion,
    setProblem,
    onBack,
    onChanged,
    onLoaded,
  });
  const actions = useMessageActions({ api, conversationId, act, keep, reloadAll, onChanged });
  const { quoting, setQuoting, editing, setEditing, info, setInfo, deleting, setDeleting } =
    actions;
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
  // Here and not in the composer, which unmounts while the conversation is closed.
  const [draft, setDraftState] = useState(() => drafts.get(conversationId) ?? "");
  const setDraft = (next: string) => {
    setDraftState(next);
    if (next === "") drafts.delete(conversationId);
    else drafts.set(conversationId, next);
  };
  const [dropping, setDropping] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
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

  /** Who wrote a line, as this thread names them. */
  const authorOf = (line: Line) =>
    line.fromVisitor ? (conversation === null ? "" : title(conversation)) : replyAuthor(line, meId);

  const send = (body: string) => {
    sendText(
      body,
      quoting === null ? null : quoteOf(quoting, quoting.authorName ?? authorOf(quoting)),
    );
    setQuoting(null);
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

  const openQuote = (id: string) => {
    if (!jump(id)) toast("quoteMissing", false);
  };

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
            onConfirm={() => void actions.removeMessage(deleting)}
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
                      onView={() => setViewing(line.id)}
                      onImageError={refreshImages}
                      onRetry={() => retry(line)}
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
            onSend={send}
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
