/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { markdownText } from "../../../packages/widget/src/markdown.ts";
import type { Conversation, Label, Member, OpenCounts, WorkspaceApi } from "./api.ts";
import type { Draft } from "./drafts.ts";
import { chooseLook, type FirstSteps, type ListShows, type PaneLook } from "./empty-look.ts";
import { dayTime, shortTime } from "./format.ts";
import { rowHandler } from "./handler.tsx";
import { Icon } from "./icons.tsx";
import {
  ALL_OPEN,
  emptyLook,
  type Filter,
  isFiltered,
  ListFilters,
  type Status,
} from "./inbox-filters.tsx";
import { BulkBar, type Selection, useSelection, useTouchSelect } from "./inbox-select.tsx";
import { LabelPills } from "./labels.tsx";
import { ListEmpty } from "./list-empty.tsx";
import { Keys, useShortcutsOn } from "./shortcuts.tsx";
import { Bone, RowsSkeleton } from "./skeleton.tsx";
import { plural, t } from "./text.ts";
import { Avatar, FlagBadge, PageHead } from "./ui.tsx";
import { avatarLetters, isWaiting, messagePreview, title } from "./visitor.ts";

const SEARCH_WAIT_MS = 250;
const SEARCH_MIN = 3;

function ConversationRow({
  conversation,
  selected,
  selection,
  members,
  labels,
  replying,
  typing,
  draft,
  showClosed,
  onSelect,
}: {
  conversation: Conversation;
  selected: boolean;
  selection: Selection;
  members: Member[];
  labels: Label[];
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
  const { id, labelIds } = conversation;
  const { takesClick, ...press } = useTouchSelect(selection, id);
  const keysOn = useShortcutsOn();
  return (
    <li className={selection.isPicked(id) ? "picked" : undefined}>
      <input
        type="checkbox"
        className="row-pick"
        aria-label={t("selectConversation", { name: title(conversation) })}
        checked={selection.isPicked(id)}
        readOnly
        // A tab stop once a row is chosen, or when X is off, so a keyboard can always start a
        // selection. Otherwise Tab would pass two stops on every row.
        tabIndex={selection.chosen.length > 0 || !keysOn ? 0 : -1}
        // Shift picks a range, and must not select the text between.
        onMouseDown={(event) => event.shiftKey && event.preventDefault()}
        onClick={(event) => selection.toggle(id, event.shiftKey)}
        onKeyDown={selection.onBoxKey}
      />
      <button
        type="button"
        className={unread ? "row unread" : "row"}
        aria-current={selected}
        {...press}
        onClick={() => {
          if (!takesClick()) onSelect();
        }}
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
            handler !== null ||
            labelIds.length > 0) && (
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
              <LabelPills labelIds={labelIds} labels={labels} />
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
  return plural(count, "searchOne", "searchMany");
}

/** The line under the list's title: who waits, or what the closed list holds. */
function listContext(status: Status, waiting: number): string {
  if (status === "closed") return t("closedContext");
  if (waiting === 0) return t("waitingNone");
  if (waiting === 1) return t("waitingOne");
  return t("waitingMany", { count: waiting });
}

/** What the list shows: rows, nothing yet, or nothing at all, from a search or not. */
function listShows(
  found: Conversation[] | null,
  searching: boolean,
  listed: boolean,
  count: number,
): ListShows {
  // A search still running holds the last query's answer, so "no match" waits for the new one.
  if (found !== null && found.length === 0) return searching ? "loading" : "searchEmpty";
  if (found !== null) return "searchRows";
  if (!listed) return "loading";
  return count === 0 ? "empty" : "rows";
}

/** The block in an empty list, which says why it is empty and offers the way out. */
function EmptyBlock({
  look,
  filter,
  query,
  onClearSearch,
  onFilter,
}: {
  look: PaneLook;
  filter: Filter;
  query: string;
  onClearSearch(): void;
  onFilter(filter: Filter): void;
}) {
  switch (look.kind) {
    case "caughtUp":
      return (
        <ListEmpty
          tone="done"
          title={t("nothingOpen")}
          hint={t("nothingOpenHint")}
          action={
            <button
              type="button"
              className="btn outline small"
              onClick={() => onFilter({ ...filter, status: "closed" })}
            >
              {t("seeClosed")}
            </button>
          }
        />
      );
    case "noMatch":
      return look.by === "search" ? (
        <ListEmpty
          tone="fog"
          title={t("noMatchSearch", { query: query.trim() })}
          hint={t("noMatchSearchTry")}
          action={
            <button type="button" className="btn outline small" onClick={onClearSearch}>
              {t("clearSearch")}
              <Keys keys="Escape" />
            </button>
          }
        />
      ) : (
        <ListEmpty
          tone="fog"
          title={t(emptyLook(filter))}
          hint={filter.status === "closed" ? t("closedHint") : null}
          action={
            <button type="button" className="btn outline small" onClick={() => onFilter(ALL_OPEN)}>
              {t("resetFilter")}
            </button>
          }
        />
      );
    case "board":
    case "waitingSetup":
      return (
        <ListEmpty tone="waiting" title={t("noConversationsYet")} hint={t("firstLandsHere")} />
      );
    case "live":
      return (
        <ListEmpty
          tone="waiting"
          title={t("noConversationsYet")}
          hint={t("firstFromSiteLandsHere")}
        />
      );
    default:
      return null;
  }
}

/**
 * The Inbox's list: the search and its filters, and a row for each conversation. While rows are
 * chosen, the bar of bulk actions takes the search's place.
 */
export function InboxList({
  api,
  filter,
  isTeam,
  openBy,
  waiting,
  conversations,
  listed,
  hasMore,
  members,
  labels,
  isWritable,
  mayDelete,
  selected,
  typing,
  drafts,
  reads,
  replying,
  steps,
  maySetUp,
  onFilter,
  onSelect,
  onMore,
  onChanged,
  onLook,
}: {
  api: WorkspaceApi;
  filter: Filter;
  isTeam: boolean;
  openBy: OpenCounts | null;
  waiting: number;
  conversations: Conversation[];
  /** The first page has arrived, so an empty list means an empty inbox. */
  listed: boolean;
  hasMore: boolean;
  members: Member[];
  labels: Label[];
  /** False while the workspace is read-only or suspended, where only reading is allowed. */
  isWritable: boolean;
  /** An owner or admin of a writable workspace, who may delete conversations. */
  mayDelete: boolean;
  selected: string | null;
  /** What each visitor is typing now, by conversation. */
  typing: Record<string, string>;
  /** The operator's unsent replies and notes, by conversation. */
  drafts: Record<string, Draft>;
  /** Grows with each conversation the operator reads. */
  reads: number;
  replying(conversationId: string): string | null;
  /** The first steps that tell a new workspace from a quiet one, once loaded. */
  steps: FirstSteps | null;
  /** An owner or admin, who may send a test message. */
  maySetUp: boolean;
  onFilter(filter: Filter): void;
  onSelect(conversationId: string): void;
  onMore(): void;
  /** A bulk action changed conversations, so the list loads again. */
  onChanged(): void;
  /** The empty state changed, so the pane beside the list can follow. */
  onLook(look: PaneLook): void;
}) {
  const [query, setQuery] = useState("");
  // Grows with each bulk action, so a search shows its changes too.
  const [bulkRuns, setBulkRuns] = useState(0);
  const { found, searching, failed: searchFailed } = useSearch(api, query, reads + bulkRuns);
  const searchTooShort = query.trim().length > 0 && query.trim().length < SEARCH_MIN;
  const { status } = filter;
  const rows = found ?? conversations;
  const selection = useSelection(rows, selected);
  const look = chooseLook({
    shows: listShows(found, searching, listed, conversations.length),
    isFiltered: isFiltered(filter),
    steps,
    maySetUp,
  });
  const lookKey = JSON.stringify(look);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the look.
  useEffect(() => onLook(look), [lookKey]);
  return (
    <section className="list" aria-label={t("inbox")}>
      <PageHead
        title={t("inbox")}
        context={
          found !== null ? (
            foundContext(found.length)
          ) : listed ? (
            listContext(status, waiting)
          ) : (
            <Bone width={170} height={14} />
          )
        }
      />
      {selection.chosen.length > 0 ? (
        <BulkBar
          api={api}
          selection={selection}
          total={rows.length}
          members={members}
          labels={labels}
          isWritable={isWritable}
          mayDelete={mayDelete}
          onDone={() => {
            setBulkRuns((current) => current + 1);
            onChanged();
          }}
        />
      ) : (
        <div className="list-tools">
          <SearchField value={query} searching={searching} onChange={setQuery} />
          <ListFilters
            filter={filter}
            isTeam={isTeam}
            openBy={openBy}
            labels={labels}
            onChange={onFilter}
          />
        </div>
      )}
      {(searchTooShort || searchFailed) && (
        <p className={searchFailed ? "bad search-note" : "hint search-note"} role="status">
          {t(searchFailed ? "searchFailed" : "searchTooShort")}
        </p>
      )}
      {found === null && !listed && <RowsSkeleton />}
      <ul className={selection.chosen.length > 0 ? "rows selecting" : "rows"} aria-busy={searching}>
        {rows.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={conversation.id === selected}
            selection={selection}
            members={members}
            labels={labels}
            replying={replying(conversation.id)}
            typing={conversation.id in typing}
            draft={drafts[conversation.id]?.text}
            showClosed={found !== null}
            onSelect={() => onSelect(conversation.id)}
          />
        ))}
      </ul>
      <EmptyBlock
        look={look}
        filter={filter}
        query={query}
        onClearSearch={() => setQuery("")}
        onFilter={onFilter}
      />
      {hasMore && found === null && (
        <button type="button" className="text-button" onClick={onMore}>
          {t("loadMore")}
        </button>
      )}
    </section>
  );
}
