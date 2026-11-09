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
  type PageView,
  type WorkspaceApi,
} from "./api.ts";
import { useLatestLoad } from "./load.ts";
import { Confirm, Menu, type MenuItem, Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { Avatar, ErrorNote, failureText, Icon, Loading, useModal } from "./ui.tsx";
import { attributeName, otherIdentity, title, webLink } from "./visitor.ts";

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
    createdAt: message.createdAt,
    authorOperatorId: message.authorOperatorId,
    authorName: message.authorName,
    status: "sent",
  };
  const others = lines.filter(
    (other) => other.id !== message.id && !(other.seq === null && other.id === message.clientId),
  );
  return inCommitOrder(others, line);
}

/** A page as the header shows it: with no scheme, as in "acme.example/pricing". */
const bare = (page: string) => page.replace(/^https?:\/\//, "");

/** Who the visitor is and where they came from: the quiet line under their name. */
function origin(conversation: Conversation): string | null {
  // The header shows the last page on a line of its own, so the same page is not said twice.
  const page =
    conversation.startedPage === null || conversation.startedPage === conversation.visitor.lastPage
      ? null
      : t("startedOn").replace("{page}", bare(conversation.startedPage));
  const parts = [...otherIdentity(conversation.visitor), page].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(SEPARATOR);
}

/** A no-break space after the dot keeps it with the next part, so a line never ends with a dot. */
const SEPARATOR = " ·\u00a0";

const MINUTE_MS = 60_000;
const ONLINE_EVERY_MS = 30_000;

/** "5 minutes ago", "yesterday", in the browser's words. Narrow is "5m ago" in English. */
function ago(iso: string, now = Date.now(), style: "long" | "narrow" = "long"): string {
  const words = new Intl.RelativeTimeFormat([], { numeric: "auto", style });
  const minutes = Math.round((new Date(iso).getTime() - now) / MINUTE_MS);
  if (minutes > -60) return words.format(Math.min(minutes, 0), "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return words.format(hours, "hour");
  return words.format(Math.round(hours / 24), "day");
}

/**
 * The visit, under who the visitor is: online now or when last seen, the device, and the page the
 * widget last reported, as a link. Unknown parts are left out, never guessed.
 */
function Visit({ visitor, online }: { visitor: Conversation["visitor"]; online: boolean | null }) {
  const seen =
    online === true ? null : visitor.lastSeenAt === null ? null : ago(visitor.lastSeenAt);
  const page = visitor.lastPage === null ? null : webLink(visitor.lastPage);
  if (online !== true && seen === null && visitor.device === null && page === null) return null;
  const parts = [
    online === true ? (
      <span key="online" className="online">
        {t("onlineNow")}
      </span>
    ) : seen === null ? null : (
      <span key="seen">{t("lastSeen").replace("{time}", seen)}</span>
    ),
    visitor.device === null ? null : <span key="device">{visitor.device}</span>,
  ].filter((part) => part !== null);
  return (
    <p className="visit">
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && SEPARATOR}
          {part}
        </Fragment>
      ))}
      {/* A line of its own, as an address is long and would wrap after a dot. */}
      {page !== null && (
        <a
          className="visit-page"
          href={page}
          target="_blank"
          rel="noopener noreferrer"
          title={page}
        >
          {bare(page)}
        </a>
      )}
    </p>
  );
}

const PAGES_FIRST = 5;

/**
 * The pages the visitor went through, newest first: the title, or the address when the page has
 * none, as a link, and when. Five at first, and the rest of the 20 on request.
 */
function PageJourney({ pages }: { pages: PageView[] }) {
  const [all, setAll] = useState(false);
  if (pages.length === 0) return null;
  const shown = all ? pages : pages.slice(0, PAGES_FIRST);
  return (
    <section className="journey" aria-label={t("pagesVisited")}>
      <h3>{t("pagesVisited")}</h3>
      <ol>
        {shown.map((page) => {
          const link = webLink(page.path);
          const name = page.title ?? bare(page.path);
          return (
            <li key={`${page.path} ${page.viewedAt}`}>
              {link === null ? (
                <span className="page-name">{name}</span>
              ) : (
                <a
                  className="page-name"
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={bare(link)}
                >
                  {name}
                </a>
              )}
              <time dateTime={page.viewedAt} title={new Date(page.viewedAt).toLocaleString()}>
                {ago(page.viewedAt, Date.now(), "narrow")}
              </time>
            </li>
          );
        })}
      </ol>
      {pages.length > PAGES_FIRST && (
        <button type="button" className="btn link small" onClick={() => setAll(!all)}>
          {all ? t("pagesFewer") : t("pagesAll").replace("{count}", String(pages.length))}
        </button>
      )}
    </section>
  );
}

/** What the operator can do with this conversation. */
function ThreadHead({
  conversation,
  online,
  members,
  canDelete,
  onBack,
  onAssign,
  onStatus,
  onBlocked,
  onDelete,
}: {
  conversation: Conversation;
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
  const from = origin(conversation);
  return (
    <header className="thread-head">
      <div className="who-is">
        <button type="button" className="icon-button back" aria-label={t("back")} onClick={onBack}>
          <Icon name="back" />
        </button>
        <Avatar name={title(conversation)} />
        <div className="who-text">
          <h2>{title(conversation)}</h2>
          {from !== null && <p title={from}>{from}</p>}
          <Visit visitor={conversation.visitor} online={online} />
        </div>
      </div>
      <div className="actions">
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
              lead: <Avatar name={member.name} />,
            })),
          ]}
          onChange={(value) => onAssign(value === "" ? null : value)}
        />
        <button
          type="button"
          className="pill dark"
          onClick={() => onStatus(closed ? "open" : "closed")}
        >
          <Icon name={closed ? "inbox" : "done"} size={18} />
          {closed ? t("reopen") : t("close")}
        </button>
        <Menu label={t("moreActions")} items={more} buttonClass="round">
          <Icon name="dots" />
        </Menu>
      </div>
    </header>
  );
}

/**
 * What the host page told the server about this visitor, beyond the header: its custom attributes.
 * A web address opens in a new tab, and every other value stays text.
 */
function contextRows(visitor: Conversation["visitor"]): [string, string, string | null][] {
  const rows: [string, string, string | null][] = [];
  for (const [name, value] of Object.entries(visitor.attributes ?? {})) {
    // The title already shows a name from the attributes when the token has no `name`.
    if (name === "name" && visitor.name === null && attributeName(visitor) !== null) continue;
    rows.push([name, typeof value === "string" ? value : JSON.stringify(value), webLink(value)]);
  }
  return rows;
}

function VisitorContext({ conversation }: { conversation: Conversation }) {
  const rows = contextRows(conversation.visitor);
  if (rows.length === 0) return null;
  return (
    <dl className="context">
      {rows.map(([name, value, link]) => (
        <Fragment key={`${name}=${value}`}>
          <dt>{name}</dt>
          <dd>
            {link === null ? (
              value
            ) : (
              <a href={link} target="_blank" rel="noopener noreferrer">
                {value}
              </a>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * The visitor's attributes and pages, in a fold. It starts open on a wide screen and closed on a
 * phone, where it would push the messages below the fold.
 */
function AboutVisitor({ conversation, pages }: { conversation: Conversation; pages: PageView[] }) {
  const [open, setOpen] = useState(() => matchMedia("(min-width: 761px)").matches);
  if (contextRows(conversation.visitor).length === 0 && pages.length === 0) return null;
  return (
    <details
      className="about-visitor"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {t("visitorDetails")}
        <Icon name="chevron" size={12} />
      </summary>
      <div className="about-body">
        <VisitorContext conversation={conversation} />
        <PageJourney pages={pages} />
      </div>
    </details>
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
        <button type="submit" className="send" aria-label={t("send")} title={t("send")}>
          <Icon name="arrowUp" size={16} />
        </button>
      </div>
    </form>
  );
}

/** One message in the log. */
function ThreadLine({
  line,
  onView,
  onImageError,
  onRetry,
}: {
  line: Line;
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

const sameSender = (one: Line | undefined, other: Line | undefined) =>
  one !== undefined &&
  other !== undefined &&
  one.fromVisitor === other.fromVisitor &&
  one.authorOperatorId === other.authorOperatorId;

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
  const who = line.authorOperatorId === meId ? t("you") : (line.authorName ?? t("aTeammate"));
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
  const [online, setOnline] = useState<boolean | null>(null);
  const [pages, setPages] = useState<PageView[]>([]);
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
      setOnline(page.visitorOnline);
      setPages(page.visitorPages);
      setLines((current) => page.messages.reduce(merge, current));
      const last = page.messages.at(-1);
      if (last !== undefined) position.current = last.seq;
      more = page.hasMore;
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a load.
  useEffect(load, [load, version]);
  // The visitor's online state changes with no event, so it is read again now and then.
  useEffect(() => {
    const timer = setInterval(load, ONLINE_EVERY_MS);
    return () => clearInterval(timer);
  }, [load]);

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
        online={online}
        members={members}
        canDelete={canDelete}
        onBack={onBack}
        onAssign={(operatorId) => void assign(operatorId)}
        onStatus={(status) => void setStatus(status)}
        onBlocked={(blocked) => void setBlocked(blocked)}
        onDelete={() => setConfirming(true)}
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
      <AboutVisitor conversation={conversation} pages={pages} />
      <div className="log" role="log" aria-live="polite" ref={log}>
        {lines.length === 0 && <p className="empty">{t("noMessages")}</p>}
        {lines.map((line, index) => {
          const day = dayOf(line);
          const meta = groupMeta(lines, index, meId);
          return (
            <Fragment key={line.id}>
              {line.createdAt !== undefined && day !== dayOf(lines[index - 1]) && (
                <div className="day">{dayLabel(line.createdAt)}</div>
              )}
              <ThreadLine
                line={line}
                onView={() => setViewing(line.id)}
                onImageError={refreshImages}
                onRetry={() => void deliver(line.id, line.body, line.file)}
              />
              {meta !== null && (
                <div className={line.fromVisitor ? "meta visitor" : "meta"}>{meta}</div>
              )}
            </Fragment>
          );
        })}
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
