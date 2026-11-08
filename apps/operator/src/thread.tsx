/** @jsxImportSource react */
import { Fragment, useEffect, useRef, useState } from "react";
import {
  IMAGE_TYPES,
  imageProblem,
  inCommitOrder,
  isComposing,
  newClientId,
  REFRESH_LIMIT_MS,
  REFUSED,
} from "../../../packages/widget/src/compose.ts";
import {
  ApiError,
  type Conversation,
  type Member,
  type Message,
  type WorkspaceApi,
} from "./api.ts";
import { useLatestLoad } from "./load.ts";
import { type TextId, t } from "./text.ts";
import { Avatar, ErrorNote, failureText, Icon, Loading, useModal } from "./ui.tsx";
import { title } from "./visitor.ts";

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
  /** The operator who sent it. A pending line is this operator's own. */
  authorOperatorId: string | null;
  authorName: string | null;
  status: "sent" | "sending" | "failed";
}

/** Adds a confirmed message in commit order, and replaces its pending line if it has one. */
function merge(lines: Line[], message: Message): Line[] {
  const line: Line = {
    id: message.id,
    seq: BigInt(message.seq),
    body: message.body ?? "",
    image: message.image,
    imageRemoved: message.imageRemoved,
    fromVisitor: message.fromVisitor,
    authorOperatorId: message.authorOperatorId,
    authorName: message.authorName,
    status: "sent",
  };
  const others = lines.filter(
    (other) => other.id !== message.id && !(other.seq === null && other.id === message.clientId),
  );
  return inCommitOrder(others, line);
}

/** What the operator can do with this conversation. */
function ThreadHead({
  conversation,
  members,
  canDelete,
  onBack,
  onAssign,
  onStatus,
  onBlocked,
  onDelete,
}: {
  conversation: Conversation;
  members: Member[];
  canDelete: boolean;
  onBack(): void;
  onAssign(operatorId: string | null): void;
  onStatus(status: "open" | "closed"): void;
  onBlocked(blocked: boolean): void;
  onDelete(): void;
}) {
  const closed = conversation.status === "closed";
  return (
    <header className="thread-head">
      <button type="button" className="icon-button back" aria-label={t("back")} onClick={onBack}>
        <Icon name="back" />
      </button>
      <Avatar name={title(conversation)} />
      <h2>{title(conversation)}</h2>
      <div className="actions">
        <select
          aria-label={t("assignTo")}
          value={
            members.some((member) => member.id === conversation.assigneeOperatorId)
              ? (conversation.assigneeOperatorId ?? "")
              : ""
          }
          onChange={(event) => onAssign(event.target.value || null)}
        >
          <option value="">{t("unassigned")}</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn outline small"
          onClick={() => onStatus(closed ? "open" : "closed")}
        >
          {closed ? t("reopen") : t("close")}
        </button>
        <button
          type="button"
          className="btn outline small"
          onClick={() => onBlocked(!conversation.visitor.blocked)}
        >
          {conversation.visitor.blocked ? t("unblockVisitor") : t("blockVisitor")}
        </button>
        {canDelete && (
          <button type="button" className="btn outline small danger-text" onClick={onDelete}>
            {t("deleteConversation")}
          </button>
        )}
      </div>
    </header>
  );
}

/** What the host page told the server about this visitor, for the operator to read. */
function VisitorContext({ conversation }: { conversation: Conversation }) {
  const { visitor } = conversation;
  const rows: [string, string][] = [];
  if (conversation.startedPage !== null) rows.push([t("contextPage"), conversation.startedPage]);
  if (visitor.email !== null) rows.push([t("contextEmail"), visitor.email]);
  if (visitor.externalId !== null) rows.push([t("contextUser"), visitor.externalId]);
  for (const [name, value] of Object.entries(visitor.claims ?? {})) {
    rows.push([name, typeof value === "string" ? value : JSON.stringify(value)]);
  }
  if (rows.length === 0) return null;
  return (
    <dl className="context">
      {rows.map(([name, value]) => (
        <Fragment key={`${name}=${value}`}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
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

function Composer({
  draft,
  setDraft,
  onSend,
  onFiles,
}: {
  draft: string;
  setDraft(draft: string): void;
  onSend(body: string): void;
  onFiles(files: Iterable<File>): void;
}) {
  const picker = useRef<HTMLInputElement>(null);

  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const body = draft.trim();
    if (body === "") return;
    setDraft("");
    onSend(body);
  };

  return (
    <form className="compose" onSubmit={submit}>
      <div className="box">
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
          onClick={() => picker.current?.click()}
        >
          <Icon name="clip" />
        </button>
        <textarea
          rows={1}
          onPaste={(event) => {
            // A copy from Word or Excel holds its text and a picture of it. The text is what is meant.
            const { clipboardData: data } = event;
            if (data.files.length === 0 || data.getData("text/plain") !== "") return;
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
            }
          }}
        />
        <button type="submit" className="btn primary small">
          {t("send")}
        </button>
      </div>
    </form>
  );
}

/** One message in the log, under its sender's name when the sender changes. */
function ThreadLine({
  line,
  sender,
  onView,
  onImageError,
  onRetry,
}: {
  line: Line;
  sender: string | null;
  onView(): void;
  onImageError(): void;
  onRetry(): void;
}) {
  return (
    <>
      {sender !== null && <div className="who">{sender}</div>}
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
        <div className={line.fromVisitor ? "msg visitor" : "msg"}>{line.body}</div>
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

/** The sender's name above the first of a run of operator messages, and "You" for your own. */
function senderLabel(lines: Line[], index: number, meId: string): string | null {
  const line = lines[index];
  if (line === undefined || line.fromVisitor) return null;
  const before = lines[index - 1];
  if (before?.fromVisitor === false && before.authorOperatorId === line.authorOperatorId) {
    return null;
  }
  if (line.authorOperatorId === meId) return t("you");
  return line.authorName ?? t("aTeammate");
}

export function Thread({
  api,
  meId,
  conversationId,
  version,
  members,
  replying,
  canDelete,
  repliesOffReason,
  drafts,
  onBack,
  onChanged,
}: {
  api: WorkspaceApi;
  meId: string;
  /** Unsent replies by conversation, kept while the operator looks at another one. */
  drafts: Map<string, string>;
  members: Member[];
  replying: string | null;
  canDelete: boolean;
  /** Why replies are off: the subscription ended or the workspace is suspended. Null when on. */
  repliesOffReason: TextId | null;
  conversationId: string;
  /** Goes up on every change, so this loads what it has not seen, in order, with no gaps. */
  version: number;
  onBack(): void;
  onChanged(): void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
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
      setLines((current) => page.messages.reduce(merge, current));
      const last = page.messages.at(-1);
      if (last !== undefined) position.current = last.seq;
      more = page.hasMore;
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a load.
  useEffect(load, [load, version]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new line scrolls down.
  useEffect(() => {
    if (log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [lines.length]);

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
  return (
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
        if (!closed) sendFiles(event.dataTransfer.files);
      }}
    >
      <ThreadHead
        conversation={conversation}
        members={members}
        canDelete={canDelete}
        onBack={onBack}
        onAssign={(operatorId) => void assign(operatorId)}
        onStatus={(status) => void setStatus(status)}
        onBlocked={(blocked) => void setBlocked(blocked)}
        onDelete={() => setConfirming(true)}
      />
      {confirming && (
        <div className="confirm" role="alert">
          <p>{t("deleteConfirm")}</p>
          <button type="button" className="btn danger small" onClick={() => void remove()}>
            {t("deleteYes")}
          </button>
          <button type="button" className="btn outline small" onClick={() => setConfirming(false)}>
            {t("deleteNo")}
          </button>
        </div>
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
      <VisitorContext conversation={conversation} />
      <div className="log" role="log" aria-live="polite" ref={log}>
        {lines.length === 0 && <p className="empty">{t("noMessages")}</p>}
        {lines.map((line, index) => (
          <ThreadLine
            key={line.id}
            line={line}
            sender={senderLabel(lines, index, meId)}
            onView={() => setViewing(line.id)}
            onImageError={refreshImages}
            onRetry={() => void deliver(line.id, line.body, line.file)}
          />
        ))}
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
        <Composer draft={draft} setDraft={setDraft} onSend={sendText} onFiles={sendFiles} />
      )}
    </section>
  );
}
