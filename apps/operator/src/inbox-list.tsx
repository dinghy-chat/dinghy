/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { markdownText } from "../../../packages/widget/src/markdown.ts";
import type { Conversation, Member, OpenCounts, WorkspaceApi } from "./api.ts";
import type { Draft } from "./drafts.ts";
import { dayTime, shortTime } from "./format.ts";
import { rowHandler } from "./handler.tsx";
import { Icon } from "./icons.tsx";
import { emptyLook, ListFilters, type Status, type Who } from "./inbox-filters.tsx";
import { EmptyArt } from "./scene.tsx";
import { Keys, useShortcutsOn } from "./shortcuts.tsx";
import { t } from "./text.ts";
import { Avatar, FlagBadge, PageHead } from "./ui.tsx";
import { avatarLetters, isWaiting, messagePreview, title } from "./visitor.ts";

const SEARCH_WAIT_MS = 250;
const SEARCH_MIN = 3;

function ConversationRow({
  conversation,
  selected,
  members,
  replying,
  typing,
  draft,
  showClosed,
  onSelect,
}: {
  conversation: Conversation;
  selected: boolean;
  members: Member[];
  replying: string | null;
  /** The visitor is typing now. */
  typing: boolean;
  /** The operator's unsent reply here. */
  draft: string | undefined;
  /** Search results mix open and closed conversations, so a closed one says so. */
  showClosed: boolean;
  onSelect(): void;
}) {
  const assignee = members.find((member) => member.id === conversation.assigneeOperatorId);
  const last = conversation.lastMessage;
  const preview = last === null ? "" : messagePreview(last.body, last.kind);
  const waits = isWaiting(conversation);
  const { snooze } = conversation;
  const closed = showClosed && conversation.status === "closed";
  const isTest = conversation.visitor.isTest;
  const handler = rowHandler(conversation, assignee);
  // The open conversation shows its draft in the composer, and is read. A blank draft is no draft.
  const shownDraft = selected || draft?.trim() === "" ? undefined : draft;
  const unread = conversation.unread && !selected;
  return (
    <li>
      <button
        type="button"
        className={unread ? "row unread" : "row"}
        aria-current={selected}
        onClick={onSelect}
      >
        <span className="avatar-wrap">
          <Avatar
            name={title(conversation)}
            letters={avatarLetters(conversation.visitor)}
            pictureUrl={conversation.visitor.pictureUrl}
          />
          {conversation.visitor.country !== null && (
            <FlagBadge country={conversation.visitor.country} />
          )}
        </span>
        <span className="row-text">
          <span className="row-top">
            <strong>{title(conversation)}</strong>
            <time dateTime={conversation.updatedAt}>{shortTime(conversation.updatedAt)}</time>
            {unread && <span className="unread-dot" role="img" aria-label={t("unread")} />}
          </span>
          {typing ? (
            <span className="preview typing">{t("visitorTyping")}</span>
          ) : shownDraft !== undefined ? (
            <span className="preview">
              <b className="draft-label">{t("draft")}</b> {markdownText(shownDraft)}
            </span>
          ) : (
            <span className="preview">{preview}</span>
          )}
          {(waits ||
            snooze !== null ||
            closed ||
            isTest ||
            replying !== null ||
            handler !== null) && (
            <span className="row-meta">
              {waits && <span className="chip warn">{t("waiting")}</span>}
              {snooze !== null && (
                <span className="chip">
                  {snooze.until === null
                    ? t("snoozed")
                    : t("snoozedUntil", { time: dayTime(snooze.until) })}
                </span>
              )}
              {closed && <span className="chip">{t("closed")}</span>}
              {isTest && (
                <span className="chip test">
                  <Icon name="flask" size={12} />
                  {t("testChip")}
                </span>
              )}
              {replying !== null && <em>{replying}</em>}
              {handler}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * Searches open and closed conversations as the operator types. It waits for a pause, and a newer
 * search cancels the one before, so a slow answer never replaces a newer one. Null means no search.
 * Searching is true from the first key until the answer for the latest words arrives.
 */
function useSearch(
  api: WorkspaceApi,
  query: string,
  /** Grows when the results may have changed, such as after a read. */
  version: number,
): { found: Conversation[] | null; searching: boolean; failed: boolean } {
  const [found, setFound] = useState<Conversation[] | null>(null);
  const [answered, setAnswered] = useState("");
  // The words whose search failed, so the list says why it did not change.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const wanted = query.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a new search.
  useEffect(() => {
    if (wanted.length < SEARCH_MIN) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.search(wanted, controller.signal).then(
        (result) => {
          setFound(result.conversations);
          setAnswered(wanted);
          setFailedFor(null);
        },
        () => {
          // An aborted search has a newer one behind it, and a failed one keeps the last rows.
          if (controller.signal.aborted) return;
          setAnswered(wanted);
          setFailedFor(wanted);
        },
      );
    }, SEARCH_WAIT_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, wanted, version]);
  if (wanted.length < SEARCH_MIN) return { found: null, searching: false, failed: false };
  return { found, searching: answered !== wanted, failed: failedFor === wanted };
}

/** The search field at the top of the list. Escape clears it. */
function SearchField({
  value,
  searching,
  onChange,
}: {
  value: string;
  searching: boolean;
  onChange(value: string): void;
}) {
  const keysOn = useShortcutsOn();
  return (
    <div className="search">
      {searching ? (
        <span className="spinner" role="status" aria-label={t("searching")} />
      ) : (
        <Icon name="search" size={18} />
      )}
      <input
        type="search"
        aria-label={t("searchLabel")}
        aria-busy={searching}
        aria-description={t("searchHint")}
        aria-keyshortcuts={keysOn ? "/" : undefined}
        title={t("searchHint")}
        placeholder={t("searchPlaceholder")}
        maxLength={100}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onChange("");
        }}
      />
      <Keys keys="/" />
    </div>
  );
}

/** The line under the list's title while a search shows its results. */
function foundContext(count: number): string {
  return count === 1 ? t("searchOne") : t("searchMany", { count });
}

/** The line under the list's title: who waits, or what the closed list holds. */
function listContext(status: Status, waiting: number): string {
  if (status === "closed") return t("closedContext");
  if (waiting === 0) return t("waitingNone");
  if (waiting === 1) return t("waitingOne");
  return t("waitingMany", { count: waiting });
}

/** The Inbox's list: the search and its filters, and a row for each conversation. */
export function InboxList({
  api,
  status,
  who,
  isTeam,
  openBy,
  waiting,
  conversations,
  listed,
  hasMore,
  members,
  selected,
  typing,
  drafts,
  reads,
  replying,
  onFilter,
  onSelect,
  onMore,
}: {
  api: WorkspaceApi;
  status: Status;
  who: Who;
  isTeam: boolean;
  openBy: OpenCounts | null;
  waiting: number;
  conversations: Conversation[];
  /** The first page has arrived, so an empty list means an empty inbox. */
  listed: boolean;
  hasMore: boolean;
  members: Member[];
  selected: string | null;
  /** What each visitor is typing now, by conversation. */
  typing: Record<string, string>;
  /** The operator's unsent replies and notes, by conversation. */
  drafts: Record<string, Draft>;
  /** Grows with each conversation the operator reads. */
  reads: number;
  replying(conversationId: string): string | null;
  onFilter(status: Status, who: Who): void;
  onSelect(conversationId: string): void;
  onMore(): void;
}) {
  const [query, setQuery] = useState("");
  const { found, searching, failed: searchFailed } = useSearch(api, query, reads);
  const searchTooShort = query.trim().length > 0 && query.trim().length < SEARCH_MIN;
  const empty = emptyLook(status, who);
  return (
    <section className="list" aria-label={t("inbox")}>
      <PageHead
        title={t("inbox")}
        context={found === null ? listContext(status, waiting) : foundContext(found.length)}
      />
      <div className="list-tools">
        <SearchField value={query} searching={searching} onChange={setQuery} />
        <ListFilters
          status={status}
          who={who}
          isTeam={isTeam}
          openBy={openBy}
          onChange={onFilter}
        />
      </div>
      {(searchTooShort || searchFailed) && (
        <p className={searchFailed ? "bad search-note" : "hint search-note"} role="status">
          {t(searchFailed ? "searchFailed" : "searchTooShort")}
        </p>
      )}
      <ul className="rows" aria-busy={searching}>
        {found === null && listed && conversations.length === 0 && (
          <li className="list-empty">
            <EmptyArt scene={status === "open" ? "day" : "evening"} />
            <b>{t(empty.empty)}</b>
            {empty.hint !== null && t(empty.hint)}
          </li>
        )}
        {found !== null && found.length === 0 && !searching && (
          <li className="nothing">
            <b>{t("searchNone")}</b>
          </li>
        )}
        {(found ?? conversations).map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={conversation.id === selected}
            members={members}
            replying={replying(conversation.id)}
            typing={conversation.id in typing}
            draft={drafts[conversation.id]?.text}
            showClosed={found !== null}
            onSelect={() => onSelect(conversation.id)}
          />
        ))}
      </ul>
      {hasMore && found === null && (
        <button type="button" className="text-button" onClick={onMore}>
          {t("loadMore")}
        </button>
      )}
    </section>
  );
}
