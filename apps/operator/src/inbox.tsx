/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BillingBanner, useBilling, WaitingBanner } from "../../../ee/operator/billing.tsx";
import { AlertsPage, leaveDevice, useDeviceSync } from "./alerts.tsx";
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
import { SettingsPage } from "./settings.tsx";
import { type TextId, t } from "./text.ts";
import { Thread } from "./thread.tsx";
import { Avatar, Harbor, Icon, Logo, Pond, ROLE_TEXT } from "./ui.tsx";
import { isWaiting, title } from "./visitor.ts";

const RETRY_LIMIT_MS = 30_000;
const PAGE_SIZE = 50;
const PRESENCE_EVERY_MS = 10_000;

type Status = "open" | "closed";

const STATUS_LOOK: Record<Status, { empty: TextId; icon: "inbox" | "done" }> = {
  open: { empty: "noOpen", icon: "inbox" },
  closed: { empty: "noClosed", icon: "done" },
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
function useChanges(api: WorkspaceApi, visible: boolean, onSignedOut: () => void) {
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
        try {
          const reason = await api.stream(cursor.current, controller.signal, {
            change(next, kind, conversationId) {
              cursor.current = next;
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
  }, [api, onSignedOut, visible]);

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

/** What the main area shows: one of the two lists, or a page. */
type View = Status | "settings" | "alerts";

const NAV: { view: View; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { view: "open", icon: STATUS_LOOK.open.icon },
  { view: "closed", icon: STATUS_LOOK.closed.icon },
  { view: "settings", icon: "gear" },
  { view: "alerts", icon: "bell" },
];

function Rail({
  me,
  role,
  name,
  workspaceId,
  view,
  waiting,
  onView,
  onSwitch,
  onSignedOut,
}: {
  me: Me;
  role: Role;
  name: string;
  workspaceId: string;
  view: View;
  /** Open conversations that wait for a reply, in the whole workspace. */
  waiting: number;
  onView(view: View): void;
  onSwitch(id: string): void;
  onSignedOut(): void;
}) {
  const waitingText = t("waitingCount").replace("{count}", String(waiting));
  return (
    <aside className="rail">
      <Logo />
      <div className="workspace">
        {me.workspaces.length > 1 ? (
          <select
            aria-label={t("workspacePick")}
            value={workspaceId}
            onChange={(event) => onSwitch(event.target.value)}
          >
            {me.workspaces.map((one) => (
              <option key={one.workspaceId} value={one.workspaceId}>
                {one.name}
              </option>
            ))}
          </select>
        ) : (
          <>
            <Avatar name={name} />
            <h1>{name}</h1>
          </>
        )}
      </div>
      <nav className="nav" aria-label={t("inboxLabel")}>
        {NAV.map((item) => {
          const counted = item.view === "open" && waiting > 0;
          return (
            <button
              type="button"
              key={item.view}
              aria-current={view === item.view ? "page" : undefined}
              // A description, so the button's name stays "Open" while the number changes.
              aria-describedby={counted ? "waiting-count" : undefined}
              onClick={() => onView(item.view)}
            >
              <Icon name={item.icon} size={18} />
              {t(item.view)}
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
      <div className="me">
        <Avatar name={me.name} />
        <div>
          {me.name}
          <small>{t(ROLE_TEXT[role])}</small>
        </div>
      </div>
      <button
        type="button"
        className="sign-out"
        onClick={() => void leaveDevice().then(signOut).finally(onSignedOut)}
        title={me.email}
      >
        <Icon name="exit" size={18} />
        {t("signOut")}
      </button>
    </aside>
  );
}

function ConversationRow({
  conversation,
  selected,
  members,
  replying,
  onSelect,
}: {
  conversation: Conversation;
  selected: boolean;
  members: Member[];
  replying: string | null;
  onSelect(): void;
}) {
  const assignee = members.find((member) => member.id === conversation.assigneeOperatorId);
  const preview =
    conversation.lastMessage?.body ?? (conversation.lastMessage === null ? "" : t("image"));
  return (
    <li>
      <button type="button" className="row" aria-current={selected} onClick={onSelect}>
        <Avatar name={title(conversation)} />
        <span className="row-text">
          <span className="row-top">
            <strong>{title(conversation)}</strong>
            <time dateTime={conversation.updatedAt}>{shortTime(conversation.updatedAt)}</time>
          </span>
          <span className="preview">{preview}</span>
          <span className="row-meta">
            {isWaiting(conversation) && <span className="tag waiting">{t("waiting")}</span>}
            {replying !== null && <em>{replying}</em>}
            {assignee === undefined ? (
              <span className="tag">{t("unassigned")}</span>
            ) : (
              <small>{assignee.name}</small>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

export function Inbox({
  me,
  workspaceId,
  onSignedOut,
  onSwitch,
  onAccountChanged,
}: {
  me: Me;
  workspaceId: string;
  onSignedOut(): void;
  onSwitch(id: string): void;
  /** The operator's name or a workspace's billing changed, so `me` must load again. */
  onAccountChanged(): void;
}) {
  const api = useMemo(() => workspaceApi(workspaceId), [workspaceId]);
  useDeviceSync();
  const [name, setName] = useState(t("appName"));
  const [status, setStatus] = useState<Status>("open");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [waiting, setWaiting] = useState(0);
  // In memory only, so a reload or a sign-out clears them.
  const drafts = useRef(new Map<string, string>()).current;
  // A notification opens the app on its conversation.
  const [selected, setSelected] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get("workspace") === workspaceId ? params.get("conversation") : null;
  });
  const [view, setView] = useState<View>("open");
  const visible = useTabVisible();
  const { lost, version, threadVersion, teamVersion, billingVersion } = useChanges(
    api,
    visible,
    onSignedOut,
  );
  const [members, setMembers] = useState<Member[]>([]);
  const membership = me.workspaces.find((one) => one.workspaceId === workspaceId);
  // The roster is newer than `me`, because a role can change while this page is open.
  const role = members.find((member) => member.id === me.id)?.role ?? membership?.role ?? "agent";
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
    return t(names.length === 1 ? "isReplying" : "areReplying").replace(
      "{names}",
      names.join(", "),
    );
  };
  const shown = useRef({ status, limit });
  useLayoutEffect(() => {
    shown.current = { status, limit };
  });

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
      setHasMore(page.hasMore);
      setWaiting(page.waiting);
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
      .then((workspace) => setName(workspace.name))
      .catch(() => {});
  }, [api]);

  const showView = (next: View) => {
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
      {lost && (
        <div className="banner" role="status">
          {t("reconnecting")}
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
        <BillingBanner api={api} workspaceId={workspaceId} readOnly={readOnly} billing={billing} />
      )}
      <div className={view !== status ? "app paging" : selected === null ? "app" : "app showing"}>
        <Rail
          me={me}
          role={role}
          name={name}
          workspaceId={workspaceId}
          view={view}
          waiting={waiting}
          onView={showView}
          onSwitch={onSwitch}
          onSignedOut={onSignedOut}
        />
        {view === "settings" && (
          <SettingsPage
            api={api}
            me={me}
            role={role}
            workspaceId={workspaceId}
            workspaceName={name}
            billing={billing}
            waiting={waitsForCloud}
            onLeft={() => location.assign("/")}
            onAccountChanged={() => {
              onAccountChanged();
              loadMembers();
            }}
          />
        )}
        {view === "alerts" && <AlertsPage api={api} />}
        <section className="list" aria-label={t(status)}>
          <h2>{t(status)}</h2>
          <ul className="rows">
            {conversations.length === 0 && (
              <li className="nothing empty-boat">
                <Pond />
                <b>{t(STATUS_LOOK[status].empty)}</b>
                {t("emptyHint")}
              </li>
            )}
            {conversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                selected={conversation.id === selected}
                members={members}
                replying={replying(conversation.id)}
                onSelect={() => setSelected(conversation.id)}
              />
            ))}
          </ul>
          {hasMore && (
            <button
              type="button"
              className="btn link small"
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
            canDelete={role !== "agent" && !readOnly && !suspended}
            repliesOffReason={suspended ? "suspendedHelp" : readOnly ? "readOnlyHelp" : null}
            conversationId={selected}
            version={threadVersion(selected)}
            onBack={() => setSelected(null)}
            onChanged={reload}
          />
        )}
      </div>
    </div>
  );
}
