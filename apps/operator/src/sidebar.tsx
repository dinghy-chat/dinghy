/** @jsxImportSource react */

import { type Me, type Role, signOut } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { leave, navigate } from "./nav.ts";
import { leaveDevice } from "./notifications.tsx";
import { Menu, type MenuItem } from "./popup.tsx";
import { Logo } from "./scene.tsx";
import { type TextId, t } from "./text.ts";
import { initials, ROLE_TEXT } from "./ui.tsx";

/** What the panel shows: the Inbox, or a page. */
export type View = "inbox" | "analytics" | "settings";

const NAV: { view: View; label: TextId; icon: IconName }[] = [
  { view: "inbox", label: "inbox", icon: "inbox" },
  { view: "analytics", label: "analytics", icon: "chart" },
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
    lead: <WorkspaceTile name={one.name} logoUrl={one.logoUrl} />,
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
        { label: t("pageProfile"), lead: <Icon name="user" size={18} />, onSelect: onProfile },
        {
          divider: true,
          label: t("signOut"),
          lead: <Icon name="exit" size={18} />,
          onSelect: () => leave(() => void leaveDevice().then(signOut).finally(onSignedOut)),
        },
      ]}
    >
      {me.pictureUrl === null ? (
        <span className="me-avatar" aria-hidden="true">
          {initials(me.name)}
        </span>
      ) : (
        <img className="me-avatar" src={me.pictureUrl} alt="" />
      )}
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
  onProfile: isProfile,
  waiting,
  onView,
  onProfileOpen,
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
  /** Settings shows the Profile page, which the user menu opens. */
  onProfile: boolean;
  /** Open conversations that wait for a reply, in the whole workspace. */
  waiting: number;
  onView(view: View): void;
  onProfileOpen(): void;
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
          const counted = item.view === "inbox" && waiting > 0;
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
        current={isProfile}
        onProfile={onProfileOpen}
        onSignedOut={onSignedOut}
      />
    </aside>
  );
}
