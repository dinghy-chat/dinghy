/** @jsxImportSource react */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BillingBanner, useBilling, WaitingBanner } from "../../../ee/operator/billing.tsx";
import { AlertsPage, leaveDevice, useDeviceSync } from "./alerts.tsx";
import { AnalyticsPage } from "./analytics.tsx";
import {
  ApiError,
  type Conversation,
  type Me,
  type Member,
  READ_ONLY_EVENT,
  type Role,
  signOut,
  type WorkspaceApi,
  workspaceApi,
} from "./api.ts";
import { useLatestLoad } from "./load.ts";
import { navigate } from "./nav.ts";
import { Menu, type MenuItem } from "./popup.tsx";
import {
  openOwnerStep,
  ownerStepIn,
  ProfilePage,
  SettingsPage,
  type SettingsTab,
} from "./settings.tsx";
import { chime, prepareSound } from "./sound.ts";
import { StartHint } from "./start-hint.tsx";
import { type TextId, t } from "./text.ts";
import { Thread } from "./thread.tsx";
import {
  Avatar,
  EmptyArt,
  Harbor,
  Icon,
  type IconName,
  initials,
  Logo,
  PageHead,
  ROLE_TEXT,
} from "./ui.tsx";
import { avatarLetters, isWaiting, title } from "./visitor.ts";

const RETRY_LIMIT_MS = 30_000;
const PAGE_SIZE = 50;
const SEARCH_WAIT_MS = 250;
const SEARCH_MIN = 3;
const PRESENCE_EVERY_MS = 10_000;

type Status = "open" | "closed";

const STATUS_LOOK: Record<
  Status,
  { label: TextId; empty: TextId; hint: TextId; icon: "inbox" | "done" }
> = {
  open: { label: "inbox", empty: "noOpen", hint: "emptyHint", icon: "inbox" },
  closed: { label: "closed", empty: "noClosed", hint: "closedHint", icon: "done" },
};

/** The time today, and the date before today. */
function shortTime(iso: string): string {
  const when = new Date(iso);
  return when.toDateString() === new Date().toDateString()
    ? when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : when.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Says which conversation is open, and learns who else has one open. This follows what is open, and
 * no keystroke, because the product has no typing indicators. Only a visible tab counts.
 */
function usePresence(
  api: WorkspaceApi,
  selected: string | null,
  visible: boolean,
): Record<string, string[]> {
  const [viewers, setViewers] = useState<Record<string, string[]>>({});
  const open = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) {
      void api.leave(open.current).catch(() => {});
      open.current = null;
      return;
    }
    const left = open.current;
    open.current = selected;
    let stopped = false;
    const beat = (previous: string | null) => {
      api
        .beat(selected, previous)
        .then((state) => {
          if (!stopped) setViewers(state.viewers);
        })
        .catch(() => {});
    };
    beat(left);
    const timer = setInterval(() => beat(null), PRESENCE_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, selected, visible]);

  useEffect(() => {
    const onHide = () => void api.leave(open.current).catch(() => {});
    addEventListener("pagehide", onHide);
    return () => removeEventListener("pagehide", onHide);
  }, [api]);

  return viewers;
}

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return visible;
}

/**
 * Holds the stream of changes, and counts them. Only a visible tab holds a stream, because browsers
 * allow about six HTTP/1.1 connections per origin. A tab catches up from its cursor when it becomes
 * visible again.
 */
function useChanges(
  api: WorkspaceApi,
  visible: boolean,
  onSignedOut: () => void,
  /** A visitor's new message, live, after the stream has caught up. */
  onVisitorMessage: (conversationId: string | null) => void,
) {
  const [lost, setLost] = useState(false);
  const [version, setVersion] = useState(0);
  const [teamVersion, setTeamVersion] = useState(0);
  const [billingVersion, setBillingVersion] = useState(0);
  // A thread loads again only for its own conversation's changes, for a block of its visitor, or
  // for a change to the whole workspace.
  const [threads, setThreads] = useState<{ all: number; by: Record<string, number> }>({
    all: 0,
    by: {},
  });
  const cursor = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let retryMs = 1000;
    (async () => {
      while (!controller.signal.aborted) {
        let refusedMs: number | undefined;
        // What a stream replays before `ready` is catch-up, and makes no sound.
        let live = false;
        try {
          const reason = await api.stream(cursor.current, controller.signal, {
            change(next, kind, conversationId, fromVisitor) {
              cursor.current = next;
              if (live && kind === "message.created" && fromVisitor) {
                onVisitorMessage(conversationId);
              }
              // React batches these, so a long catch-up becomes few loads.
              setVersion((current) => current + 1);
              // A block or unblock is on the visitor, so it changes every one of their threads.
              setThreads((current) =>
                conversationId === null || kind === "conversation.moderated"
                  ? { ...current, all: current.all + 1 }
                  : {
                      ...current,
                      by: {
                        ...current.by,
                        [conversationId]: (current.by[conversationId] ?? 0) + 1,
                      },
                    },
              );
              if (kind === "team.changed") setTeamVersion((current) => current + 1);
              // Both change `me`: the billing state, or a suspension by the server's admin.
              if (kind === "billing.changed" || kind === "workspace.changed") {
                setBillingVersion((current) => current + 1);
              }
            },
            ready(next) {
              live = true;
              // A first stream starts at the present, so a billing change since `me` loaded is
              // not on it.
              if (cursor.current === null) setBillingVersion((current) => current + 1);
              cursor.current = next;
              setLost(false);
              retryMs = 1000;
              // Anything before this point is in these lists, and anything after is on the stream.
              setVersion((current) => current + 1);
              setThreads((current) => ({ ...current, all: current.all + 1 }));
              setTeamVersion((current) => current + 1);
            },
            resync(next) {
              cursor.current = next;
              // The events after the old cursor are gone, and a billing change may be among them.
              setBillingVersion((current) => current + 1);
            },
          });
          // Reading /me settles it: another workspace opens, or sign-in, or this session is fine and
          // the loop below connects again, as when another window signed in with a new cookie.
          if (reason === "unauthorized") onSignedOut();
          if (reason === "lifetime") continue;
        } catch (failure) {
          if (controller.signal.aborted) return;
          if (failure instanceof ApiError && (failure.status === 401 || failure.status === 404)) {
            onSignedOut();
          }
          if (failure instanceof ApiError) refusedMs = failure.retryMs;
        }
        if (controller.signal.aborted) return;
        setLost(true);
        // A refused stream waits as long as the server says, and anything else backs off.
        await new Promise((resolve) =>
          setTimeout(resolve, refusedMs ?? retryMs * (0.5 + Math.random() / 2)),
        );
        if (refusedMs === undefined) retryMs = Math.min(retryMs * 2, RETRY_LIMIT_MS);
      }
    })();
    return () => controller.abort();
  }, [api, onSignedOut, onVisitorMessage, visible]);

  // A write refused as read-only means this page missed the change.
  useEffect(() => {
    const onReadOnly = () => setBillingVersion((current) => current + 1);
    addEventListener(READ_ONLY_EVENT, onReadOnly);
    return () => removeEventListener(READ_ONLY_EVENT, onReadOnly);
  }, []);

  const threadVersion = (id: string) => threads.all + (threads.by[id] ?? 0);
  return { lost, version, threadVersion, teamVersion, billingVersion };
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

/** What the panel shows: one of the two lists, or a page. */
type View = Status | "analytics" | "settings" | "alerts" | "profile";

const NAV: { view: Exclude<View, "profile">; label: TextId; icon: IconName }[] = [
  { view: "open", label: "inbox", icon: STATUS_LOOK.open.icon },
  { view: "closed", label: "closed", icon: STATUS_LOOK.closed.icon },
  { view: "analytics", label: "analytics", icon: "chart" },
  { view: "alerts", label: "alerts", icon: "bell" },
  { view: "settings", label: "settings", icon: "gear" },
];

/**
 * The workspace's logo, or two letters: "Acme" gives "AC", and "Harbor Labs" gives "HL". The name
 * sits beside it, so the logo needs no text of its own.
 */
function WorkspaceTile({ name, logoUrl = null }: { name: string; logoUrl?: string | null }) {
  if (logoUrl !== null) return <img className="ws-tile" src={logoUrl} alt="" />;
  const letters = initials(name);
  return (
    <span className="ws-tile" aria-hidden="true">
      {letters.length > 1 ? letters : name.trim().slice(0, 2).toUpperCase()}
    </span>
  );
}

/**
 * The workspace's name at the top of the sidebar. With more than one workspace, or a way to make
 * one, it opens a menu to switch.
 */
function WorkspaceSwitcher({
  me,
  name,
  logoUrl,
  workspaceId,
  canCreate,
  onSwitch,
}: {
  me: Me;
  name: string;
  /** The open workspace's logo. The others in the menu show their letters. */
  logoUrl: string | null;
  workspaceId: string;
  canCreate: boolean;
  onSwitch(id: string): void;
}) {
  if (me.workspaces.length < 2 && !canCreate) {
    return (
      <div className="workspace">
        <WorkspaceTile name={name} logoUrl={logoUrl} />
        <span className="ws-name" aria-hidden="true">
          {name}
        </span>
      </div>
    );
  }
  const items: MenuItem[] = me.workspaces.map((one) => ({
    label: one.name,
    lead: <WorkspaceTile name={one.name} />,
    checked: one.workspaceId === workspaceId,
    onSelect: () => {
      if (one.workspaceId !== workspaceId) onSwitch(one.workspaceId);
    },
  }));
  if (canCreate) {
    items.push({
      label: t("createWorkspace"),
      lead: <Icon name="plusCircle" size={18} />,
      divider: true,
      onSelect: () => navigate("/signup"),
    });
  }
  return (
    <Menu
      label={t("workspaceMenu", { name })}
      items={items}
      buttonClass="workspace"
      side="start"
      className="workspace-menu"
    >
      <WorkspaceTile name={name} logoUrl={logoUrl} />
      <span className="ws-name">{name}</span>
      <Icon name="chevron" size={12} />
    </Menu>
  );
}

/** The operator at the foot of the sidebar, with their profile and sign out. */
function UserMenu({
  me,
  role,
  current,
  onProfile,
  onSignedOut,
}: {
  me: Me;
  role: Role;
  /** True on the Profile page, which the menu opens, so the menu shows it as the current page. */
  current: boolean;
  onProfile(): void;
  onSignedOut(): void;
}) {
  return (
    <Menu
      label={t("userMenu")}
      buttonClass={current ? "me current" : "me"}
      side="start"
      direction="up"
      className="me-menu"
      items={[
        { label: t("profile"), lead: <Icon name="user" size={18} />, onSelect: onProfile },
        {
          divider: true,
          label: t("signOut"),
          lead: <Icon name="exit" size={18} />,
          onSelect: () => void leaveDevice().then(signOut).finally(onSignedOut),
        },
      ]}
    >
      <span className="me-avatar" aria-hidden="true">
        {initials(me.name)}
      </span>
      <span className="me-text">
        <b>{me.name}</b>
        <small>{t(ROLE_TEXT[role])}</small>
      </span>
      <Icon name="chevron" size={12} />
    </Menu>
  );
}

function Sidebar({
  me,
  role,
  name,
  logoUrl,
  workspaceId,
  canCreate,
  view,
  waiting,
  onView,
  onSwitch,
  onSignedOut,
}: {
  me: Me;
  role: Role;
  name: string;
  logoUrl: string | null;
  workspaceId: string;
  canCreate: boolean;
  view: View;
  /** Open conversations that wait for a reply, in the whole workspace. */
  waiting: number;
  onView(view: View): void;
  onSwitch(id: string): void;
  onSignedOut(): void;
}) {
  const waitingText = t("waitingCount", { count: waiting });
  return (
    <aside className="side">
      <div className="brand">
        <Logo />
      </div>
      {/* The page's heading is the workspace, which the switcher shows. */}
      <h1 className="visually-hidden">{name}</h1>
      <WorkspaceSwitcher
        me={me}
        name={name}
        logoUrl={logoUrl}
        workspaceId={workspaceId}
        canCreate={canCreate}
        onSwitch={onSwitch}
      />
      <nav className="nav" aria-label={t("mainMenu")}>
        {NAV.map((item) => {
          const counted = item.view === "open" && waiting > 0;
          return (
            <button
              type="button"
              key={item.view}
              aria-current={view === item.view ? "page" : undefined}
              // A description, so the button's name stays "Inbox" while the number changes.
              aria-describedby={counted ? "waiting-count" : undefined}
              onClick={() => onView(item.view)}
            >
              <Icon name={item.icon} size={20} />
              {t(item.label)}
              {counted && (
                <span className="count" aria-hidden="true">
                  {waiting}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      {waiting > 0 && (
        <span id="waiting-count" className="visually-hidden">
          {waitingText}
        </span>
      )}
      <UserMenu
        me={me}
        role={role}
        current={view === "profile"}
        onProfile={() => onView("profile")}
        onSignedOut={onSignedOut}
      />
    </aside>
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
): { found: Conversation[] | null; searching: boolean } {
  const [found, setFound] = useState<Conversation[] | null>(null);
  const [answered, setAnswered] = useState("");
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
        },
        () => {
          // An aborted search has a newer one behind it, and a failed one keeps the last rows.
          if (!controller.signal.aborted) setAnswered(wanted);
        },
      );
    }, SEARCH_WAIT_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, wanted]);
  if (wanted.length < SEARCH_MIN) return { found: null, searching: false };
  return { found, searching: answered !== wanted };
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

/** Whether this browser already did something once. Storage can be off, which reads as no. */
function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Without storage, the welcome chat opens again on the next load, which is harmless.
  }
}

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
  /** The operator's name or a workspace's billing changed, so `me` must load again. */
  onAccountChanged(): void;
  /** The workspace the operator just deleted, for a note, or null. */
  deletedName: string | null;
  onWorkspaceDeleted(name: string): void;
  onCloseDeleted(): void;
  onAccountDeleted(): void;
}) {
  const api = useMemo(() => workspaceApi(workspaceId), [workspaceId]);
  useDeviceSync();
  const [name, setName] = useState(t("appName"));
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("open");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // The first page has arrived, so an empty list means an empty inbox and not one still loading.
  const [listed, setListed] = useState(false);
  const [waiting, setWaiting] = useState(0);
  // In memory only, so a reload or a sign-out clears them.
  const drafts = useRef(new Map<string, string>()).current;
  // A notification opens the app on its conversation.
  const [selected, setSelected] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get("workspace") === workspaceId ? params.get("conversation") : null;
  });
  // The account's delete can open this workspace on its Team tab or its delete dialog.
  const [ownerStep] = useState(() => ownerStepIn(workspaceId));
  const [view, setView] = useState<View>(ownerStep === null ? "open" : "settings");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(
    ownerStep === "delete" ? "data" : "team",
  );
  const [openDelete, setOpenDelete] = useState(ownerStep === "delete");
  const visible = useTabVisible();
  const [query, setQuery] = useState("");
  const { found, searching } = useSearch(api, query);
  useEffect(prepareSound, []);
  const shownConversation = useRef(selected);
  useLayoutEffect(() => {
    // A page such as Analytics hides the thread, so its conversation is not in view then.
    shownConversation.current = view === "open" || view === "closed" ? selected : null;
  });
  // A sound only when the operator is not already looking at that conversation.
  const onVisitorMessage = useCallback((conversationId: string | null) => {
    const looking = document.visibilityState === "visible" && document.hasFocus();
    if (!looking || conversationId !== shownConversation.current) chime();
  }, []);
  const { lost, version, threadVersion, teamVersion, billingVersion } = useChanges(
    api,
    visible,
    onSignedOut,
    onVisitorMessage,
  );
  const [members, setMembers] = useState<Member[]>([]);
  const membership = me.workspaces.find((one) => one.workspaceId === workspaceId);
  // The roster is newer than `me`, because a role can change while this page is open.
  const role = members.find((member) => member.id === me.id)?.role ?? membership?.role ?? "member";
  const readOnly = membership?.readOnly ?? false;
  const suspended = membership?.suspended ?? false;
  const waitsForCloud = membership?.waiting ?? false;
  const billing = useBilling(api, me.billing && role === "owner", billingVersion);
  // The read-only flag is in `me`, so it loads again with the billing state.
  const seenBillingVersion = useRef(billingVersion);
  useEffect(() => {
    if (billingVersion === seenBillingVersion.current) return;
    seenBillingVersion.current = billingVersion;
    onAccountChanged();
  }, [billingVersion, onAccountChanged]);
  const loadMembers = useLatestLoad(async () => {
    setMembers((await api.members()).members);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: teamVersion asks for a load.
  useEffect(loadMembers, [loadMembers, teamVersion]);
  const [limit, setLimit] = useState(PAGE_SIZE);
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
  const shown = useRef({ status, limit });
  useLayoutEffect(() => {
    shown.current = { status, limit };
  });

  // A new workspace's first open list holds only the welcome chat, which opens by itself, once.
  const firstList = useRef(true);
  const welcomeKey = `dinghy.welcome-opened.${workspaceId}`;
  const reload = useLatestLoad(async () => {
    const wanted = shown.current;
    try {
      const page = await api.list(
        wanted.status,
        wanted.limit,
        () => wanted.status !== shown.current.status,
      );
      // The operator may have switched tabs while this was on its way.
      if (wanted.status !== shown.current.status) return;
      setConversations(page.conversations);
      setListed(true);
      setHasMore(page.hasMore);
      setWaiting(page.waiting);
      if (firstList.current && wanted.status === "open") {
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
  useEffect(reload, [reload, status, limit, version]);

  // A count in the tab's title, so a waiting visitor shows from another tab.
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) ${t("appName")}` : t("appName");
    return () => {
      document.title = t("appName");
    };
  }, [waiting]);

  useEffect(() => {
    api
      .get()
      .then((workspace) => {
        setName(workspace.name);
        setLogoUrl(workspace.logoUrl);
      })
      .catch(() => {});
  }, [api]);

  const showView = (next: View, tab: SettingsTab = "team") => {
    setSettingsTab(tab);
    setOpenDelete(false);
    // The account's delete reads who owns what, which can change in Settings.
    if (next === "profile") onAccountChanged();
    // Settings can change the team, so the names in the list load again after it.
    if (view === "settings" && next !== "settings") loadMembers();
    setView(next);
    // The list reloads only when the tab changes, so the open tab must keep its rows.
    if (next !== "open" && next !== "closed") return;
    if (next === status) return;
    setStatus(next);
    setLimit(PAGE_SIZE);
    // The old tab's rows must not show under this one while it loads.
    setConversations([]);
  };

  return (
    <div className="shell">
      <div className={view !== status ? "app paging" : selected === null ? "app" : "app showing"}>
        <Sidebar
          me={me}
          role={role}
          name={name}
          logoUrl={logoUrl}
          workspaceId={workspaceId}
          canCreate={canCreate}
          view={view}
          waiting={waiting}
          onView={showView}
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
              <SettingsPage
                api={api}
                me={me}
                role={role}
                workspaceId={workspaceId}
                workspaceName={name}
                billing={billing}
                waiting={waitsForCloud}
                emailAvailable={emailAvailable}
                initialTab={settingsTab}
                openDelete={openDelete}
                onLeft={() => navigate("/")}
                onDeleted={onWorkspaceDeleted}
                onLogoChanged={setLogoUrl}
              />
            )}
            {view === "analytics" && <AnalyticsPage api={api} />}
            {view === "alerts" && <AlertsPage api={api} />}
            {view === "profile" && (
              <ProfilePage
                me={me}
                emailAvailable={emailAvailable}
                keepsLastWorkspace={!canCreate}
                onOpenWorkspace={(id, step) => {
                  if (id !== workspaceId) {
                    openOwnerStep(id, step);
                    return;
                  }
                  showView("settings", step === "delete" ? "data" : "team");
                  setOpenDelete(step === "delete");
                }}
                onAccountDeleted={onAccountDeleted}
                onChanged={() => {
                  // The name shows on assignments and in the dropdown too, which read the members.
                  onAccountChanged();
                  loadMembers();
                }}
              />
            )}
            <div className="split">
              <section className="list" aria-label={t(STATUS_LOOK[status].label)}>
                <PageHead
                  title={t(STATUS_LOOK[status].label)}
                  context={
                    found === null ? listContext(status, waiting) : foundContext(found.length)
                  }
                />
                <SearchField value={query} searching={searching} onChange={setQuery} />
                <ul className="rows" aria-busy={searching}>
                  {found === null && conversations.length === 0 && (
                    <li className="list-empty">
                      <EmptyArt scene={status === "open" ? "day" : "evening"} />
                      <b>{t(STATUS_LOOK[status].empty)}</b>
                      {t(STATUS_LOOK[status].hint)}
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
                      showClosed={found !== null && status === "open"}
                      onSelect={() => setSelected(conversation.id)}
                    />
                  ))}
                </ul>
                {status === "open" && listed && found === null && role !== "member" && (
                  <StartHint
                    api={api}
                    workspaceId={workspaceId}
                    hasConversations={conversations.length > 0}
                    version={version}
                    onOpen={(tab) => showView("settings", tab)}
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
                />
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
