/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import type { Conversation, Member, ReplyReceipts, WorkspaceApi } from "./api.ts";
import { Composer } from "./composer.tsx";
import { useConversationActions } from "./conversation-actions.ts";
import { Icon } from "./icons.tsx";
import { useTabVisible } from "./live.ts";
import { useLoad } from "./load.ts";
import { type InfoLine, MessageInfo, QuoteChip } from "./message.tsx";
import { type Act, quoteOf, useMessageActions } from "./message-actions.tsx";
import { Confirm } from "./popup.tsx";
import { receiptOf } from "./receipts.tsx";
import { type TextId, t } from "./text.ts";
import { ThreadHead } from "./thread-head.tsx";
import { type Line, useThreadLines } from "./thread-lines.ts";
import { ThreadLog } from "./thread-log.tsx";
import { ErrorNote, failureText, Loading } from "./ui.tsx";
import { replyAuthor, title } from "./visitor.ts";
import { usePanel, VisitorPanel } from "./visitor-panel.tsx";

/** The unsent reply. The inbox keeps a copy, for its list and for when the operator comes back. */
function useDraft(saved: string, onDraft: (text: string) => void) {
  // Here and not in the composer, which unmounts while the conversation is closed.
  const [draft, setDraftState] = useState(saved);
  const setDraft = (next: string) => {
    setDraftState(next);
    onDraft(next);
  };
  return [draft, setDraft] as const;
}

/**
 * Marks the conversation read up to its newest saved line while the operator can see it, and
 * again for each newer line. A failure is silent: the next line or visit tries again.
 */
function useMarkRead(
  api: WorkspaceApi,
  conversationId: string,
  lines: Line[],
  inView: boolean,
  onRead: (conversationId: string) => void,
) {
  const visible = useTabVisible();
  const newest = lines.reduce<bigint | null>(
    (max, line) => (line.seq !== null && (max === null || line.seq > max) ? line.seq : max),
    null,
  );
  const sent = useRef<bigint | null>(null);
  useEffect(() => {
    if (!visible || !inView || newest === null) return;
    if (sent.current !== null && sent.current >= newest) return;
    sent.current = newest;
    onRead(conversationId);
    // Again once saved, as a list load that left before the save may have brought the dot back.
    api.markRead(conversationId, newest.toString()).then(
      () => onRead(conversationId),
      () => {
        if (sent.current === newest) sent.current = null;
      },
    );
  }, [api, conversationId, newest, visible, inView, onRead]);
}

/** What the info dialog says about a line: its time, its author and, for a reply, its receipt. */
function infoOf(line: Line, author: string, receipts: ReplyReceipts | null): InfoLine | null {
  if (line.createdAt === undefined) return null;
  return {
    id: line.id,
    createdAt: line.createdAt,
    author,
    via: line.via,
    receipt:
      line.fromVisitor || receipts === null || line.seq === null
        ? null
        : { isRead: receiptOf(line.seq, receipts) === "read" },
  };
}

export function Thread({
  api,
  meId,
  conversationId,
  version,
  members,
  replying,
  mayDeleteAnyone,
  emailAvailable,
  readOnly,
  suspended,
  savedDraft,
  onDraft,
  receiptsVersion,
  rewriteVersion,
  typingDraft,
  onBack,
  onChanged,
  onLoaded,
  inView,
  onRead,
  onOpenContact,
  onOpenConversation,
}: {
  api: WorkspaceApi;
  meId: string;
  /** The reply the operator left unsent here, or "". */
  savedDraft: string;
  onDraft(text: string): void;
  members: Member[];
  replying: string | null;
  /** An admin of a writable workspace: deletes the conversation and anyone's message in it. */
  mayDeleteAnyone: boolean;
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
  /** The Inbox shows this thread, and not another page over it. */
  inView: boolean;
  /** The operator read this conversation. */
  onRead(conversationId: string): void;
  onOpenContact(visitorId: string): void;
  onOpenConversation(id: string, status: "open" | "closed"): void;
}) {
  const [problem, setProblem] = useState<TextId | null>(null);
  // A failure shows below the thread unless `report` puts it elsewhere.
  const act: Act = async (work, { fallback = "actionFailed", report = setProblem } = {}) => {
    setProblem(null);
    try {
      await work();
      return true;
    } catch (failure) {
      report(failureText(failure, {}, fallback));
      return false;
    }
  };
  const thread = useThreadLines({
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
  const { conversation, online, welcome, receipts, lines, sendFiles } = thread;
  useMarkRead(api, conversationId, lines, inView, onRead);
  const actions = useMessageActions({ api, conversationId, act, keep: thread.keep });
  const { quoting, setQuoting, info, setInfo, deleting, setDeleting } = actions;
  const change = useConversationActions({
    api,
    conversationId,
    act,
    setConversation: thread.setConversation,
    onChanged,
    onBack,
  });
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
  const [draft, setDraft] = useDraft(savedDraft, onDraft);
  const [dropping, setDropping] = useState(false);

  if (conversation === null) {
    return (
      <div className="thread">
        <Loading failure={thread.loadFailure} />
      </div>
    );
  }
  const closed = conversation.status === "closed";
  const visitorName = title(conversation);
  /** Who wrote a line, as this thread names them. */
  const authorOf = (line: Line) => (line.fromVisitor ? visitorName : replyAuthor(line, meId));
  const send = (body: string) => {
    thread.sendText(
      body,
      quoting === null ? null : quoteOf(quoting, quoting.authorName ?? authorOf(quoting)),
    );
    setQuoting(null);
  };
  const infoLine =
    info === null
      ? null
      : infoOf(
          info,
          info.fromVisitor ? visitorName : (info.authorName ?? authorOf(info)),
          receipts,
        );
  return (
    <div className="conversation-view">
      <section
        className={dropping && !closed ? "thread drop" : "thread"}
        aria-label={visitorName}
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
          mayDeleteAnyone={mayDeleteAnyone}
          onBack={onBack}
          onAssign={(operatorId) => void change.assign(operatorId)}
          onStatus={(status) => void change.setStatus(status)}
          onBlocked={(blocked) => void change.setBlocked(blocked)}
          onDelete={() => change.setConfirming(true)}
          onTranscript={() => void change.sendTranscript()}
          emailAvailable={emailAvailable}
          panel={welcome === null ? panel : null}
        />
        {change.confirming && (
          <Confirm
            title={t("deleteTitle")}
            text={t("deleteConfirm")}
            confirm={t("deleteYes")}
            onConfirm={() => void change.remove()}
            onCancel={() => change.setConfirming(false)}
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
        <ThreadLog
          conversation={conversation}
          lines={lines}
          receipts={receipts}
          who={{
            meId,
            mayDeleteAnyone,
            canWrite: repliesOffReason === null,
            canReply: repliesOffReason === null && !closed,
          }}
          actions={actions}
          typingDraft={typingDraft}
          onImageError={thread.refreshImages}
          onRetry={thread.retry}
        />
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
      {/* A welcome chat's visitor is another workspace, with no visit to show. */}
      {welcome === null && panel.shown && (
        <VisitorPanel
          conversation={conversation}
          contact={contact.data}
          online={online}
          pages={thread.pages}
          members={members}
          overlay={!panel.wide}
          motion={panel.motion}
          onMoved={panel.moved}
          onAssign={(operatorId) => void change.assign(operatorId)}
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
