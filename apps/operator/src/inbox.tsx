/** @jsxImportSource react */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BillingBanner, useBilling, WaitingBanner } from "../../../ee/operator/billing.tsx";
import { AnalyticsPage } from "./analytics.tsx";
import {
  ApiError,
  type Assignee,
  type Conversation,
  type Me,
  type Member,
  type WorkspaceApi,
  workspaceApi,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { useChanges, usePresence, useTabVisible } from "./live.ts";
import { useLatestLoad } from "./load.ts";
import { leave, NAVIGATE_EVENT, navigate, pushAddress, replaceAddress } from "./nav.ts";
import { useDeviceSync } from "./notifications.tsx";
import { EmptyArt, Harbor } from "./scene.tsx";
import {
  openOwnerStep,
  ownerStepPage,
  Settings,
  type SettingsPage,
  settingsAddress,
  settingsInAddress,
  wantsDelete,
} from "./settings.tsx";
import { Sidebar, type View } from "./sidebar.tsx";
import { chime, prepareSound } from "./sound.ts";
import { StartHint } from "./start-hint.tsx";
import { readStored, store } from "./stored.ts";
import { type TextId, t } from "./text.ts";
import { Thread } from "./thread.tsx";
import { Avatar, Choices, type Option, PageHead } from "./ui.tsx";
import { avatarLetters, isWaiting, title } from "./visitor.ts";

const PAGE_SIZE = 50;
const SEARCH_WAIT_MS = 250;
const SEARCH_MIN = 3;

type Status = "open" | "closed";
/** Whose conversations the Inbox lists. */
type Who = "all" | "mine" | "unassigned";

const STATUS_EMPTY: Record<Status, { empty: TextId; hint: TextId }> = {
  open: { empty: "noOpen", hint: "emptyHint" },
  closed: { empty: "noClosed", hint: "closedHint" },
};

const STATUS_OPTIONS: Option<Status>[] = [
  { value: "open", label: "open" },
  { value: "closed", label: "closed" },
];
const WHO_OPTIONS: Option<Who>[] = [
  { value: "all", label: "filterAll" },
  { value: "mine", label: "filterMine" },
  { value: "unassigned", label: "unassigned" },
];
const WHO_ASSIGNEE: Record<Who, Assignee | null> = { all: null, mine: "me", unassigned: "none" };

/** What the Inbox lists. */
type Filter = { status: Status; who: Who };

/** What the Inbox shows, from the address: `?view=closed` and `&who=mine` or `&who=unassigned`. */
function filterInAddress(): Filter {
  const params = new URLSearchParams(location.search);
  const who = params.get("who");
  return {
    status: params.get("view") === "closed" ? "closed" : "open",
    who: who === "mine" || who === "unassigned" ? who : "all",
  };
}

/** The Inbox's address with this choice, keeping the rest of `from`, such as a conversation. */
function filterAddress(status: Status, who: Who, from = location.href): string {
  const url = new URL(from);
  if (status === "closed") url.searchParams.set("view", "closed");
  else url.searchParams.delete("view");
  if (who === "all") url.searchParams.delete("who");
  else url.searchParams.set("who", who);
  return `${url.pathname}${url.search}`;
}

/** The empty list's words: a filter's own, or the status's. */
function emptyLook(status: Status, who: Who): { empty: TextId; hint: TextId | null } {
  if (who === "mine") return { empty: "noMine", hint: null };
  if (who === "unassigned" && status === "open") return { empty: "noUnassigned", hint: null };
  return STATUS_EMPTY[status];
}

/** The time today, and the date before today. */
function shortTime(iso: string): string {
  const when = new Date(iso);
  return when.toDateString() === new Date().toDateString()
    ? when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : when.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Above every page of a suspended workspace, with whom to write to. */
function SuspendedBanner({ contact }: { contact: string | null }) {
  if (contact === null) {
    return (
      <div className="banner billing-banner" role="status">
        {t("suspendedBannerSelfHosted")}
      </div>
    );
  }
  const [before, after] = t("suspendedBanner").split("{contact}");
  return (
    <div className="banner billing-banner" role="status">
      <span>
        {before}
        <a href={`mailto:${contact}`}>{contact}</a>
        {after}
      </span>
    </div>
  );
}

function ConversationRow({
  conversation,
  selected,
  members,
  replying,
  showClosed,
  onSelect,
}: {
  conversation: Conversation;
  selected: boolean;
  members: Member[];
  replying: string | null;
  /** Search results mix open and closed conversations, so a closed one says so. */
  showClosed: boolean;
  onSelect(): void;
}) {
  const assignee = members.find((member) => member.id === conversation.assigneeOperatorId);
  const preview =
    conversation.lastMessage?.body ?? (conversation.lastMessage === null ? "" : t("image"));
  const waits = isWaiting(conversation);
  const closed = showClosed && conversation.status === "closed";
  return (
    <li>
      <button type="button" className="row" aria-current={selected} onClick={onSelect}>
        <Avatar name={title(conversation)} letters={avatarLetters(conversation.visitor)} />
        <span className="row-text">
          <span className="row-top">
            <strong>{title(conversation)}</strong>
            <time dateTime={conversation.updatedAt}>{shortTime(conversation.updatedAt)}</time>
          </span>
          <span className="preview">{preview}</span>
          {(waits || closed || replying !== null || assignee !== undefined) && (
            <span className="row-meta">
              {waits && <span className="chip warn">{t("waiting")}</span>}
              {closed && <span className="chip">{t("closed")}</span>}
              {assignee !== undefined && <span className="chip">{assignee.name}</span>}
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

/** Whether this browser already did something once. Without storage, it reads as no. */
const remembered = (key: string) => readStored(key) !== null;
const remember = (key: string) => store(key, "1");

export function Inbox({
  me,
  workspaceId,
  canCreate,
  emailAvailable,
  onSignedOut,
  onSwitch,
  onAccountChanged,
  deletedName,
  onWorkspaceDeleted,
  onCloseDeleted,
  onAccountDeleted,
}: {
  me: Me;
  workspaceId: string;
  /** Dinghy Cloud lets an operator make another workspace. */
  canCreate: boolean;
  /** The server sends email, so invites go by email. */
  emailAvailable: boolean;
  onSignedOut(): void;
  onSwitch(id: string): void;
  /** The operator's name, or a workspace's billing, name or logo changed, so `me` must load again. */
  onAccountChanged(): void;
  /** The workspace the operator just deleted, for a note, or null. */
  deletedName: string | null;
  onWorkspaceDeleted(name: string): void;
  onCloseDeleted(): void;
  onAccountDeleted(): void;
}) {
  const api = useMemo(() => workspaceApi(workspaceId), [workspaceId]);
  useDeviceSync();
  const [filter, setFilter] = useState(filterInAddress);
  const { status, who: chosenWho } = filter;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // The first page has arrived, so an empty list means an empty inbox and not one still loading.
  const [listed, setListed] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  // A new filter starts at its first page, and the old filter's rows must not show while it loads.
  const [listedFilter, setListedFilter] = useState(filter);
  if (listedFilter !== filter) {
    setListedFilter(filter);
    setLimit(PAGE_SIZE);
    setConversations([]);
    setListed(false);
  }
  const [waiting, setWaiting] = useState(0);
  // In memory only, so a reload or a sign-out clears them.
  const drafts = useRef(new Map<string, string>()).current;
  // A notification opens the app on its conversation.
  const [selected, setSelected] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get("workspace") === workspaceId ? params.get("conversation") : null;
  });
  // The address can open Settings, as the account's delete does for its Team page or delete dialog.
  const [initialPage] = useState(settingsInAddress);
  const [view, setView] = useState<View>(initialPage === undefined ? "inbox" : "settings");
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(initialPage ?? null);
  const [openDelete, setOpenDelete] = useState(() => wantsDelete(workspaceId));
  const visible = useTabVisible();
  const [query, setQuery] = useState("");
  const { found, searching, failed: searchFailed } = useSearch(api, query);
  const searchTooShort = query.trim().length > 0 && query.trim().length < SEARCH_MIN;
  useEffect(prepareSound, []);
  const shownConversation = useRef(selected);
  useLayoutEffect(() => {
    // A page such as Analytics hides the thread, so its conversation is not in view then.
    shownConversation.current = view === "inbox" ? selected : null;
  });
  // A sound only when the operator is not already looking at that conversation.
  const onVisitorMessage = useCallback((conversationId: string | null) => {
    const looking = document.visibilityState === "visible" && document.hasFocus();
    if (!looking || conversationId !== shownConversation.current) chime();
  }, []);
  const { lost, version, threadVersion, teamVersion, accountVersion } = useChanges(
    api,
    visible,
    onSignedOut,
    onVisitorMessage,
  );
  const [members, setMembers] = useState<Member[]>([]);
  const membership = me.workspaces.find((one) => one.workspaceId === workspaceId);
  const name = membership?.name ?? t("appName");
  const logoUrl = membership?.logoUrl ?? null;
  // The roster is newer than `me`, because a role can change while this page is open.
  const role = members.find((member) => member.id === me.id)?.role ?? membership?.role ?? "member";
  const readOnly = membership?.readOnly ?? false;
  const suspended = membership?.suspended ?? false;
  const waitsForCloud = membership?.waiting ?? false;
  const billing = useBilling(api, me.billing && role === "owner", accountVersion);
  // The read-only flag is in `me`, so it loads again with the billing state.
  const seenAccountVersion = useRef(accountVersion);
  useEffect(() => {
    if (accountVersion === seenAccountVersion.current) return;
    seenAccountVersion.current = accountVersion;
    onAccountChanged();
  }, [accountVersion, onAccountChanged]);
  const loadMembers = useLatestLoad(async () => {
    setMembers((await api.members()).members);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: teamVersion asks for a load.
  useEffect(loadMembers, [loadMembers, teamVersion]);
  const [hasMore, setHasMore] = useState(false);
  const viewers = usePresence(api, selected, visible);
  /** Who else has this conversation open, by name. Someone who left the team has no name here. */
  const replying = (conversationId: string) => {
    const names = (viewers[conversationId] ?? [])
      .filter((id) => id !== me.id)
      .flatMap((id) => members.find((member) => member.id === id)?.name ?? []);
    if (names.length === 0) return null;
    return t(names.length === 1 ? "isReplying" : "areReplying", { names: names.join(", ") });
  };
  // A team of one has nothing to filter. The roster is empty only until it loads, and the
  // address's filter holds until then.
  const isTeam = members.length > 1;
  const who: Who = isTeam || members.length === 0 ? chosenWho : "all";
  const assignee = WHO_ASSIGNEE[who];
  const shown = useRef({ status, assignee, limit });
  useLayoutEffect(() => {
    shown.current = { status, assignee, limit };
  });
  // The conversation a link opened, whose status picks Open or Closed once it loads.
  const linked = useRef(selected);

  // A new workspace's first open list holds only the welcome chat, which opens by itself, once.
  const firstList = useRef(true);
  const welcomeKey = `dinghy.welcome-opened.${workspaceId}`;
  const reload = useLatestLoad(async () => {
    const wanted = shown.current;
    try {
      const moved = () =>
        wanted.status !== shown.current.status || wanted.assignee !== shown.current.assignee;
      const page = await api.list(wanted.status, wanted.assignee, wanted.limit, moved);
      // The operator may have picked another filter while this was on its way.
      if (moved()) return;
      setConversations(page.conversations);
      setListed(true);
      setHasMore(page.hasMore);
      setWaiting(page.waiting);
      if (firstList.current && wanted.status === "open" && wanted.assignee === null) {
        firstList.current = false;
        const [only, ...rest] = page.conversations;
        if (only?.welcome && rest.length === 0 && !remembered(welcomeKey)) {
          remember(welcomeKey);
          setSelected((current) => current ?? only.id);
        }
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onSignedOut();
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: each of these asks for a load.
  useEffect(reload, [reload, status, assignee, limit, version]);

  // A count in the tab's title, so a waiting visitor shows from another tab.
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) ${t("appName")}` : t("appName");
    return () => {
      document.title = t("appName");
    };
  }, [waiting]);

  /** Shows a view, and a Settings page in it, and puts it in the address for Back and reloads. */
  const showView = (next: View, page: SettingsPage | null = null, deleting = false) => {
    setSettingsPage(page);
    setOpenDelete(deleting);
    // The account's delete reads who owns what, which can change in Settings.
    if (page === "profile") onAccountChanged();
    setView(next);
    const address =
      next === "settings"
        ? settingsAddress(page, workspaceId)
        : filterAddress(status, who, new URL("/", location.origin).href);
    if (address !== `${location.pathname}${location.search}`) pushAddress(address);
  };
  const openSettings = (page: SettingsPage | null) => leave(() => showView("settings", page));

  // Back and Forward move between the pages, and a link in the app can open one.
  useEffect(() => {
    const moved = () => {
      const page = settingsInAddress();
      setOpenDelete(false);
      if (page === undefined) {
        setView((current) => (current === "settings" ? "inbox" : current));
        const next = filterInAddress();
        setFilter((current) =>
          current.status === next.status && current.who === next.who ? current : next,
        );
        return;
      }
      setView("settings");
      setSettingsPage(page);
    };
    addEventListener(NAVIGATE_EVENT, moved);
    return () => removeEventListener(NAVIGATE_EVENT, moved);
  }, []);

  /** Shows another filter, and puts it in the address, so a reload or a shared link keeps it. */
  const showFilter = (nextStatus: Status, nextWho: Who) => {
    if (nextStatus === status && nextWho === who) return;
    replaceAddress(filterAddress(nextStatus, nextWho));
    setFilter({ status: nextStatus, who: nextWho });
  };
  const empty = emptyLook(status, who);

  return (
    <div className="shell">
      <div className={view !== "inbox" ? "app paging" : selected === null ? "app" : "app showing"}>
        <Sidebar
          me={me}
          role={role}
          name={name}
          logoUrl={logoUrl}
          workspaceId={workspaceId}
          canCreate={canCreate}
          view={view}
          onProfile={view === "settings" && settingsPage === "profile"}
          waiting={waiting}
          onView={(next) => {
            if (next !== view) leave(() => showView(next));
          }}
          onProfileOpen={() => openSettings("profile")}
          onSwitch={onSwitch}
          onSignedOut={onSignedOut}
        />
        <div className="stage">
          {lost && (
            <div className="banner" role="status">
              {t("reconnecting")}
            </div>
          )}
          {deletedName !== null && (
            <div className="banner deleted-banner" role="status">
              {t("workspaceDeleted", { name: deletedName })}
              <button
                type="button"
                className="icon-button"
                aria-label={t("close")}
                onClick={onCloseDeleted}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          {suspended ? (
            <SuspendedBanner contact={me.contact} />
          ) : waitsForCloud ? (
            <WaitingBanner
              api={api}
              workspaceId={workspaceId}
              email={me.email}
              owner={role === "owner"}
              billing={me.billing}
            />
          ) : (
            <BillingBanner
              api={api}
              workspaceId={workspaceId}
              readOnly={readOnly}
              billing={billing}
            />
          )}
          <main className="panel">
            {view === "settings" && (
              <Settings
                api={api}
                me={me}
                role={role}
                members={members}
                onMembersChanged={loadMembers}
                workspaceId={workspaceId}
                workspaceName={name}
                logoUrl={logoUrl}
                billing={billing}
                waiting={waitsForCloud}
                emailAvailable={emailAvailable}
                keepsLastWorkspace={!canCreate}
                page={settingsPage}
                openDelete={openDelete}
                onPage={openSettings}
                onLeft={() => navigate("/")}
                onWorkspaceDeleted={onWorkspaceDeleted}
                onProfileChanged={() => {
                  // The name shows on assignments and in the dropdown too, which read the members.
                  onAccountChanged();
                  loadMembers();
                }}
                onOpenWorkspace={(id, step) => {
                  if (id === workspaceId)
                    showView("settings", ownerStepPage(step), step === "delete");
                  else openOwnerStep(id, step);
                }}
                onAccountDeleted={onAccountDeleted}
              />
            )}
            {view === "analytics" && <AnalyticsPage api={api} />}
            <div className="split">
              <section className="list" aria-label={t("inbox")}>
                <PageHead
                  title={t("inbox")}
                  context={
                    found === null ? listContext(status, waiting) : foundContext(found.length)
                  }
                />
                <div className="list-filters">
                  <Choices
                    label={t("listStatus")}
                    variant="outlined"
                    value={status}
                    options={STATUS_OPTIONS}
                    onChange={(next) => showFilter(next, who)}
                  />
                  {isTeam && (
                    <Choices
                      label={t("listAssignee")}
                      variant="quiet"
                      value={who}
                      options={WHO_OPTIONS}
                      onChange={(next) => showFilter(status, next)}
                    />
                  )}
                </div>
                <SearchField value={query} searching={searching} onChange={setQuery} />
                {(searchTooShort || searchFailed) && (
                  <p
                    className={searchFailed ? "bad search-note" : "hint search-note"}
                    role="status"
                  >
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
                      showClosed={found !== null}
                      onSelect={() => setSelected(conversation.id)}
                    />
                  ))}
                </ul>
                {status === "open" &&
                  who === "all" &&
                  listed &&
                  found === null &&
                  role !== "member" && (
                    <StartHint
                      api={api}
                      workspaceId={workspaceId}
                      hasConversations={conversations.length > 0}
                      version={version}
                      onOpen={openSettings}
                    />
                  )}
                {hasMore && found === null && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setLimit((current) => current + PAGE_SIZE)}
                  >
                    {t("loadMore")}
                  </button>
                )}
              </section>
              {selected === null ? (
                <div className="thread">
                  <Harbor title={t("pickOne")} />
                </div>
              ) : (
                <Thread
                  key={selected}
                  api={api}
                  meId={me.id}
                  drafts={drafts}
                  members={members}
                  replying={replying(selected)}
                  canDelete={role !== "member" && !readOnly && !suspended}
                  readOnly={readOnly}
                  suspended={suspended}
                  conversationId={selected}
                  version={threadVersion(selected)}
                  onBack={() => setSelected(null)}
                  onChanged={reload}
                  onLoaded={(conversation) => {
                    if (linked.current !== conversation.id) return;
                    linked.current = null;
                    showFilter(conversation.status, who);
                  }}
                />
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
