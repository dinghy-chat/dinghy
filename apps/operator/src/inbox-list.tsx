/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { markdownText } from "../../../packages/widget/src/markdown.ts";
import type { Conversation, Member, OpenCounts, WorkspaceApi } from "./api.ts";
import { shortTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { emptyLook, ListFilters, type Status, type Who } from "./inbox-filters.tsx";
import { EmptyArt } from "./scene.tsx";
import { t } from "./text.ts";
import { Avatar, FlagBadge, PageHead } from "./ui.tsx";
import { avatarLetters, isWaiting, title } from "./visitor.ts";

const SEARCH_WAIT_MS = 250;
const SEARCH_MIN = 3;

function ConversationRow({
  conversation,
  selected,
  members,
  replying,
  typing,
  showClosed,
  onSelect,
}: {
  conversation: Conversation;
  selected: boolean;
  members: Member[];
  replying: string | null;
  /** The visitor is typing now. */
  typing: boolean;
  /** Search results mix open and closed conversations, so a closed one says so. */
  showClosed: boolean;
  onSelect(): void;
}) {
  const assignee = members.find((member) => member.id === conversation.assigneeOperatorId);
  const body = conversation.lastMessage?.body;
  const preview =
    body != null ? markdownText(body) : conversation.lastMessage === null ? "" : t("image");
  const waits = isWaiting(conversation);
  const closed = showClosed && conversation.status === "closed";
  const { handler } = conversation;
  const isTest = conversation.visitor.isTest;
  const bot = handler?.kind === "bot" ? handler.name : null;
  return (
    <li>
      <button type="button" className="row" aria-current={selected} onClick={onSelect}>
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
          </span>
          {typing ? (
            <span className="preview typing">{t("visitorTyping")}</span>
          ) : (
            <span className="preview">{preview}</span>
          )}
          {(waits ||
            closed ||
            isTest ||
            bot !== null ||
            replying !== null ||
            assignee !== undefined) && (
            <span className="row-meta">
              {waits && <span className="chip warn">{t("waiting")}</span>}
              {closed && <span className="chip">{t("closed")}</span>}
              {isTest && <span className="chip test">{t("testChip")}</span>}
              {bot !== null && (
                <span className="chip" title={t("handledByBot", { name: bot })}>
                  <Icon name="robot" size={13} />
                  <span className="visually-hidden">{t("handlerLabel")}: </span>
                  {bot}
                </span>
              )}
              {assignee !== undefined && (
                <span className="chip">
                  {handler?.kind === "human" && (
                    <span className="chip-mark" title={t("handledByPerson")}>
                      <Icon name="user" size={13} />
                      <span className="visually-hidden">{t("handledByPerson")}</span>
                    </span>
                  )}
                  {assignee.name}
                </span>
              )}
              {replying !== null && <em>{replying}</em>}
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
): { found: Conversation[] | null; searching: boolean; failed: boolean } {
  const [found, setFound] = useState<Conversation[] | null>(null);
  const [answered, setAnswered] = useState("");
  // The words whose search failed, so the list says why it did not change.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const wanted = query.trim();
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
  }, [api, wanted]);
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
        title={t("searchHint")}
        placeholder={t("searchPlaceholder")}
        maxLength={100}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onChange("");
        }}
      />
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
  replying(conversationId: string): string | null;
  onFilter(status: Status, who: Who): void;
  onSelect(conversationId: string): void;
  onMore(): void;
}) {
  const [query, setQuery] = useState("");
  const { found, searching, failed: searchFailed } = useSearch(api, query);
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
