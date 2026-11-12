/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import type { Conversation, Member, ReplyReceipts, SuggestedReply, WorkspaceApi } from "./api.ts";
import { type ComposeMode, Composer } from "./composer.tsx";
import { useConversationActions } from "./conversation-actions.ts";
import type { Draft } from "./drafts.ts";
import { Icon } from "./icons.tsx";
import { useTabVisible } from "./live.ts";
import { useLoad } from "./load.ts";
import { type InfoLine, MessageInfo, QuoteChip } from "./message.tsx";
import { type Act, quoteOf, useMessageActions } from "./message-actions.tsx";
import { Confirm } from "./popup.tsx";
import { hasReceipt, receiptOf } from "./receipts.tsx";
import { type TextId, t } from "./text.ts";
import {
  DraftCards,
  DraftChip,
  OlderDrafts,
  staleBefore,
  useSuggestedReplies,
} from "./thread-drafts.tsx";
import { ThreadHead } from "./thread-head.tsx";
import { type Line, useThreadLines } from "./thread-lines.ts";
import { ThreadLog } from "./thread-log.tsx";
import { ErrorNote, failureText, Loading } from "./ui.tsx";
import { replyAuthor, title } from "./visitor.ts";
import { usePanel, VisitorPanel } from "./visitor-panel.tsx";

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
      !hasReceipt(line) || receipts === null
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
  draft,
  setDraft,
  receiptsVersion,
  rewriteVersion,
  draftsVersion,
  typingDraft,
  botTyping,
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
  /** The operator's unsent reply or note here. The inbox keeps it, so it outlives this thread. */
  draft: Draft;
  setDraft(draft: Draft): void;
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
  /** Goes up when a bot's suggested reply here changed. */
  draftsVersion: number;
  /** What the visitor is typing and has not sent, or null. */
  typingDraft: string | null;
  /** The name of the bot that types a reply now, or null. */
  botTyping: string | null;
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
  const suggestions = useSuggestedReplies({
    api,
    conversationId,
    version: draftsVersion,
    act,
    keep: thread.keep,
  });
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
  // A closed conversation takes notes only. The choice lives with the draft, so a note typed
  // here never comes back as a reply after a reload or a visit to another conversation.
  const closed = conversation?.status === "closed";
  const mode: ComposeMode = closed || draft.isNote ? "note" : "reply";
  const imagesOn = !readOnly && !suspended && mode === "reply";
  const [dropping, setDropping] = useState(false);
  // The bot's draft whose text is in the composer: sending it sends the draft.
  const [editingDraft, setEditingDraft] = useState<SuggestedReply | null>(null);

  if (conversation === null) {
    return (
      <div className="thread">
        <Loading failure={thread.loadFailure} />
      </div>
    );
  }
  const visitorName = title(conversation);
  /** Who wrote a line, as this thread names them. */
  const authorOf = (line: Line) => (line.fromVisitor ? visitorName : replyAuthor(line, meId));
  const send = (body: string) => {
    if (editingDraft !== null) {
      // The composer emptied itself, so a failure puts the text back.
      return void suggestions.send(editingDraft, body).then((done) => {
        if (done) setEditingDraft(null);
        else setDraft({ text: body, isNote: false });
      });
    }
    thread.sendText(
      body,
      quoting === null ? null : quoteOf(quoting, quoting.authorName ?? authorOf(quoting)),
      mode === "note",
    );
    setQuoting(null);
  };
  const editDraft = (chosen: SuggestedReply) => {
    setQuoting(null);
    setEditingDraft(chosen);
    setDraft({ text: chosen.body, isNote: false });
  };
  const canReply = repliesOffReason === null && !closed;
  const draftHandlers = {
    // A suggestion says who can't see it yet: the visitor's first name, as a reply would greet them.
    visitor: conversation.visitor.name?.split(" ")[0] ?? visitorName,
    canSend: canReply,
    onSend: (chosen: SuggestedReply) => suggestions.send(chosen),
    onEdit: editDraft,
    onDiscard: (chosen: SuggestedReply) => {
      if (editingDraft?.id === chosen.id) setEditingDraft(null);
      return suggestions.discard(chosen);
    },
  };
  const assign = (operatorId: string | null) =>
    void change.assign(
      operatorId,
      members.find((member) => member.id === operatorId)?.name ?? null,
    );
  // A person handles it and a bot took part, so the bot can have it back.
  const canGiveBack =
    repliesOffReason === null &&
    conversation.bot !== null &&
    conversation.handler !== null &&
    conversation.handler.kind !== "bot";
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
        className={dropping && !closed && imagesOn ? "thread drop" : "thread"}
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
          meId={meId}
          mayDeleteAnyone={mayDeleteAnyone}
          onBack={onBack}
          onAssign={assign}
          onStatus={(status) => void change.setStatus(status)}
          onSnooze={(snooze) => void change.setSnooze(snooze)}
          onBlocked={(blocked) => void change.setBlocked(blocked)}
          onDelete={() => change.setConfirming(true)}
          onTranscript={() => void change.sendTranscript()}
          canGiveBack={canGiveBack}
          onGiveBack={() => void change.giveBack()}
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
            text={t(deleting.kind === "note" ? "noteDeleteText" : "messageDeleteText")}
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
          members={members}
          lines={lines}
          receipts={receipts}
          who={{ meId, mayDeleteAnyone, canWrite: repliesOffReason === null, canReply }}
          actions={actions}
          typingDraft={typingDraft}
          botTyping={botTyping}
          draftCount={suggestions.drafts.length}
          drafts={<DraftCards drafts={suggestions.drafts} {...draftHandlers} />}
          olderDrafts={{
            node: <OlderDrafts drafts={suggestions.drafts} {...draftHandlers} />,
            before: staleBefore(suggestions.drafts),
          }}
          onImageError={thread.refreshImages}
          onRetry={thread.retry}
        />
        <ErrorNote text={problem} />
        {repliesOffReason !== null ? (
          <p className="closed">{t(repliesOffReason)}</p>
        ) : (
          <>
            {closed && (
              <p className="closed">
                <Icon name="done" size={18} />
                {t("closedHelp")}
              </p>
            )}
            <Composer
              draft={draft.text}
              setDraft={(text) => setDraft({ text, isNote: mode === "note" })}
              onSend={send}
              onFiles={imagesOn ? sendFiles : undefined}
              mode={
                closed
                  ? { value: "note" }
                  : {
                      value: mode,
                      onChange: (next) => {
                        setEditingDraft(null);
                        setDraft({ ...draft, isNote: next === "note" });
                      },
                    }
              }
              onEscape={quoting === null ? undefined : () => setQuoting(null)}
              above={
                editingDraft !== null ? (
                  <DraftChip
                    draft={editingDraft}
                    onCancel={() => {
                      setEditingDraft(null);
                      setDraft({ text: "", isNote: false });
                    }}
                  />
                ) : quoting === null ? undefined : (
                  <QuoteChip
                    quote={quoteOf(quoting, authorOf(quoting))}
                    visitorName={visitorName}
                    onCancel={() => setQuoting(null)}
                  />
                )
              }
            />
          </>
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
          meId={meId}
          onAssign={assign}
          onGiveBack={() => void change.giveBack()}
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
