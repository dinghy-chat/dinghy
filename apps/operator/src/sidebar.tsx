/** @jsxImportSource react */
import type { ReactNode } from "react";

import { type Me, type Role, setAway, signOut } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { leave, navigate } from "./nav.ts";
import { leaveDevice } from "./notifications.tsx";
import { Menu, type MenuItem } from "./popup.tsx";
import { Logo } from "./scene.tsx";
import { Keys } from "./shortcuts.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Avatar, DOCS_URL, initials, ROLE_TEXT } from "./ui.tsx";

/** What the panel shows: the Inbox, or a page. */
export type View = "inbox" | "contacts" | "visitors" | "analytics" | "settings";

/** Each view's keys: G, then its letter. */
const NAV: { view: View; label: TextId; icon: IconName; keys: string }[] = [
  { view: "inbox", label: "inbox", icon: "inbox", keys: "g i" },
  { view: "contacts", label: "contacts", icon: "contacts", keys: "g c" },
  { view: "visitors", label: "visitors", icon: "globe", keys: "g v" },
  { view: "analytics", label: "analytics", icon: "chart", keys: "g a" },
  { view: "settings", label: "settings", icon: "gear", keys: "g s" },
];

/**
 * The workspace's logo, or two letters: "Acme" gives "AC", and "Harbor Labs" gives "HL". The name
 * sits beside it, so the logo needs no text of its own.
 */
export function WorkspaceTile({ name, logoUrl = null }: { name: string; logoUrl?: string | null }) {
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
  waitingBy,
  botsPaused,
  onBotsPaused,
  onSwitch,
}: {
  me: Me;
  name: string;
  logoUrl: string | null;
  workspaceId: string;
  canCreate: boolean;
  waitingBy: Record<string, number>;
  botsPaused: boolean;
  /** Pauses or resumes every bot. Null for a member. */
  onBotsPaused: ((paused: boolean) => void) | null;
  onSwitch(id: string): void;
}) {
  // The menu switches workspaces, makes one, or pauses the bots.
  const switches = me.workspaces.length > 1 || canCreate;
  if (!switches && onBotsPaused === null) {
    return (
      <div className="workspace">
        <WorkspaceTile name={name} logoUrl={logoUrl} />
        <span className="ws-name" aria-hidden="true">
          {name}
        </span>
      </div>
    );
  }
  const waitingIn = (id: string) => waitingBy[id] ?? 0;
  // Another workspace's chats wait, so the closed button says so with a dot.
  const elsewhere = me.workspaces.some(
    (one) => one.workspaceId !== workspaceId && waitingIn(one.workspaceId) > 0,
  );
  const items: MenuItem[] = (switches ? me.workspaces : []).map((one) => ({
    label: one.name,
    lead: <WorkspaceTile name={one.name} logoUrl={one.logoUrl} />,
    trail: waitingIn(one.workspaceId) > 0 && (
      <span className="ws-waiting" title={t("waitingCount", { count: waitingIn(one.workspaceId) })}>
        {waitingIn(one.workspaceId)}
      </span>
    ),
    checked: one.workspaceId === workspaceId,
    onSelect: () => {
      if (one.workspaceId !== workspaceId) leave(() => onSwitch(one.workspaceId));
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
  if (onBotsPaused !== null) {
    items.push({
      label: t("botsPauseMenu"),
      lead: <Icon name="prohibit" size={18} />,
      // The label stays, and the switch shows whether the bots are paused.
      switched: botsPaused,
      divider: items.length > 0,
      onSelect: () => onBotsPaused(!botsPaused),
    });
  }
  return (
    <Menu
      label={
        elsewhere
          ? `${t("workspaceMenu", { name })}, ${t("waitingElsewhere")}`
          : t("workspaceMenu", { name })
      }
      items={items}
      buttonClass="workspace"
      side="start"
      className="workspace-menu"
    >
      <WorkspaceTile name={name} logoUrl={logoUrl} />
      <span className="ws-name">{name}</span>
      {elsewhere && <i className="ws-dot" aria-hidden="true" />}
      <Icon name="chevron" size={12} />
    </Menu>
  );
}

/** Above the operator: the docs, and the keyboard shortcuts. */
function HelpMenu({ onShortcuts }: { onShortcuts(): void }) {
  return (
    <Menu
      label={t("help")}
      buttonClass="help"
      side="start"
      placement="up"
      className="help-menu"
      items={[
        {
          label: t("helpDocs"),
          lead: <Icon name="book" size={18} />,
          onSelect: () => open(`${DOCS_URL}operator-guide`, "_blank", "noopener,noreferrer"),
        },
        {
          label: t("keysTitle"),
          lead: <Icon name="keyboard" size={18} />,
          shortcut: "?",
          onSelect: onShortcuts,
        },
      ]}
    >
      <Icon name="question" size={20} />
      <span className="help-text">{t("help")}</span>
    </Menu>
  );
}

/** The operator at the foot of the sidebar, with their status, their profile and sign out. */
function UserMenu({
  me,
  role,
  current,
  onProfile,
  onStatusChanged,
  onLeavePresence,
  onSignedOut,
}: {
  me: Me;
  role: Role;
  /** True on the Profile page, which the menu opens, so the menu shows it as the current page. */
  current: boolean;
  onProfile(): void;
  /** The status is in `me`, which loads again. */
  onStatusChanged(): void;
  /** Says the operator left, before the session ends. */
  onLeavePresence(): Promise<void>;
  onSignedOut(): void;
}) {
  const status = t(me.away ? "statusAway" : "statusAvailable");
  const switchStatus = () =>
    void setAway(!me.away).then(onStatusChanged, () => toast("statusFailed", false));
  return (
    <Menu
      label={`${t("userMenu")}, ${status}`}
      buttonClass={current ? "me current" : "me"}
      side="start"
      placement="up"
      className="me-menu"
      items={[
        {
          label: t(me.away ? "setAvailable" : "setAway"),
          lead: <i className={me.away ? "status-dot" : "status-dot away"} />,
          onSelect: switchStatus,
        },
        {
          divider: true,
          label: t("pageProfile"),
          lead: <Icon name="user" size={18} />,
          onSelect: onProfile,
        },
        {
          divider: true,
          label: t("signOut"),
          lead: <Icon name="exit" size={18} />,
          onSelect: () =>
            leave(
              () =>
                void Promise.all([onLeavePresence(), leaveDevice()])
                  .then(signOut)
                  .finally(onSignedOut),
            ),
        },
      ]}
    >
      <span className="avatar-wrap">
        <Avatar name={me.name} pictureUrl={me.pictureUrl} />
        <i className={me.away ? "status-dot away" : "status-dot"} title={status} />
      </span>
      <span className="me-text">
        <b>{me.name}</b>
        <small>{t(ROLE_TEXT[role])}</small>
      </span>
      <Icon name="chevron" size={12} />
    </Menu>
  );
}

export function Sidebar({
  me,
  role,
  name,
  logoUrl,
  workspaceId,
  canCreate,
  view,
  isProfile,
  waiting,
  waitingBy,
  liveCount,
  botsPaused,
  onBotsPaused,
  steps,
  onView,
  onShortcuts,
  onProfileOpen,
  onSwitch,
  onStatusChanged,
  onLeavePresence,
  onSignedOut,
}: {
  me: Me;
  role: Role;
  name: string;
  logoUrl: string | null;
  workspaceId: string;
  canCreate: boolean;
  view: View;
  /** Settings shows the Profile page, which the user menu opens. */
  isProfile: boolean;
  /** Open conversations that wait for a reply from this operator or from anyone, as unassigned. */
  waiting: number;
  /** The same count in each of the operator's workspaces, by workspace ID. */
  waitingBy: Record<string, number>;
  /** Tabs of the site open now, or null when unknown. */
  liveCount: number | null;
  botsPaused: boolean;
  /** Pauses or resumes every bot. Null for a member. */
  onBotsPaused: ((paused: boolean) => void) | null;
  /** Above the user menu: the Get started steps, while they show. */
  steps: ReactNode;
  onView(view: View): void;
  /** Opens the sheet of keyboard shortcuts. */
  onShortcuts(): void;
  onProfileOpen(): void;
  onSwitch(id: string): void;
  onStatusChanged(): void;
  onLeavePresence(): Promise<void>;
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
        waitingBy={waitingBy}
        botsPaused={botsPaused}
        onBotsPaused={onBotsPaused}
        onSwitch={onSwitch}
      />
      <nav className="nav" aria-label={t("mainMenu")}>
        {NAV.map((item) => {
          const counted = item.view === "inbox" && waiting > 0;
          const live = item.view === "visitors" && liveCount !== null && liveCount > 0;
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
              {live && (
                <span className="count live" title={t("liveCount", { count: liveCount })}>
                  {liveCount}
                </span>
              )}
              <Keys keys={item.keys} />
            </button>
          );
        })}
      </nav>
      {waiting > 0 && (
        <span id="waiting-count" className="visually-hidden">
          {waitingText}
        </span>
      )}
      <HelpMenu onShortcuts={onShortcuts} />
      {steps}
      <UserMenu
        me={me}
        role={role}
        current={isProfile}
        onProfile={onProfileOpen}
        onStatusChanged={onStatusChanged}
        onLeavePresence={onLeavePresence}
        onSignedOut={onSignedOut}
      />
    </aside>
  );
}
