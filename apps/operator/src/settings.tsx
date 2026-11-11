/** @jsxImportSource react */
import type { BillingState, Me, Member, Role, WorkspaceApi } from "./api.ts";
import { AppearancePage } from "./appearance.tsx";
import { DevelopersPage } from "./developers.tsx";
import { Icon } from "./icons.tsx";
import { InstallPage } from "./install.tsx";
import { useLoad } from "./load.ts";
import { navigate } from "./nav.ts";
import { NotificationsPage } from "./notifications.tsx";
import { ProfilePage } from "./profile.tsx";
import { TeamPage, useTeam } from "./team.tsx";
import { type TextId, t } from "./text.ts";
import { isPlainClick, Loading } from "./ui.tsx";
import { WorkspacePage } from "./workspace.tsx";

const PAGES = [
  "profile",
  "notifications",
  "workspace",
  "team",
  "appearance",
  "install",
  "developers",
] as const;
/** One page of Settings, each at its own address, such as /settings/team. */
export type SettingsPage = (typeof PAGES)[number];

/** The list on the left of Settings, in groups, in this order. */
const GROUPS: { label: TextId; pages: SettingsPage[] }[] = [
  { label: "settingsGroupYou", pages: ["profile", "notifications"] },
  { label: "settingsGroupWorkspace", pages: ["workspace", "team"] },
  { label: "settingsGroupWidget", pages: ["appearance", "install"] },
  { label: "settingsGroupDevelopers", pages: ["developers"] },
];

const PAGE_TEXT: Record<SettingsPage, TextId> = {
  profile: "pageProfile",
  notifications: "pageNotifications",
  workspace: "pageWorkspace",
  team: "pageTeam",
  appearance: "pageAppearance",
  install: "pageInstall",
  developers: "pageDevelopers",
};

/** The pages that read the workspace's settings: its usage, its delete's counts or its code. */
const SETTINGS_READERS: readonly SettingsPage[] = ["workspace", "team", "install"];

/** A member reads the team and the widget, and changes only their own settings. */
const MEMBER_PAGES: readonly SettingsPage[] = ["profile", "notifications", "team", "appearance"];

const isSettingsPage = (value: string): value is SettingsPage =>
  PAGES.some((page) => page === value);

/**
 * The address of a page, or of the list alone, which is what a phone shows first. It names the
 * workspace, so a copied link or a bookmark opens the same one.
 */
export const settingsAddress = (page: SettingsPage | null, workspaceId: string) =>
  `${page === null ? "/settings" : `/settings/${page}`}?workspace=${workspaceId}`;

/** The page in the address: undefined outside Settings, and null for the list or an unknown page. */
export function settingsInAddress(): SettingsPage | null | undefined {
  const [first, second, ...rest] = location.pathname.split("/").filter((part) => part !== "");
  if (first !== "settings") return undefined;
  return second !== undefined && rest.length === 0 && isSettingsPage(second) ? second : null;
}

/** Where the account's delete sends a sole owner: a workspace's Team page or its delete dialog. */
export type OwnerStep = "team" | "delete";

/** The page each step opens: the Team page, or the Workspace page with its delete dialog. */
export const ownerStepPage = (step: OwnerStep): SettingsPage =>
  step === "delete" ? "workspace" : "team";

/** Opens another workspace on the page of this step. */
export const openOwnerStep = (workspaceId: string, step: OwnerStep) =>
  navigate(
    `${settingsAddress(ownerStepPage(step), workspaceId)}${step === "delete" ? "&delete=1" : ""}`,
  );

/** True when `openOwnerStep` asked to open this workspace's delete dialog. */
export function wantsDelete(workspaceId: string): boolean {
  const params = new URLSearchParams(location.search);
  return params.get("workspace") === workspaceId && params.get("delete") === "1";
}

/** The grouped list. Each page is a link, so it opens in a new tab too. */
function SettingsNav({
  pages,
  current,
  workspaceId,
  onPick,
}: {
  pages: readonly SettingsPage[];
  workspaceId: string;
  current: SettingsPage;
  onPick(page: SettingsPage): void;
}) {
  return (
    <nav className="settings-nav" aria-labelledby="settings-title">
      <h2 id="settings-title">{t("settings")}</h2>
      {GROUPS.map((group) => {
        const shown = group.pages.filter((page) => pages.includes(page));
        if (shown.length === 0) return null;
        return (
          <div key={group.label} className="settings-group">
            <h3 id={`settings-${group.label}`}>{t(group.label)}</h3>
            <ul aria-labelledby={`settings-${group.label}`}>
              {shown.map((page) => (
                <li key={page}>
                  <a
                    className="settings-link"
                    href={settingsAddress(page, workspaceId)}
                    aria-current={page === current ? "page" : undefined}
                    onClick={(event) => {
                      if (!isPlainClick(event)) return;
                      event.preventDefault();
                      onPick(page);
                    }}
                  >
                    {t(PAGE_TEXT[page])}
                    <span className="settings-arrow">
                      <Icon name="chevronRight" size={14} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Settings: the grouped list, and the open page beside it. A phone shows one at a time: the list
 * first, then the page with a way back to the list.
 */
export function Settings({
  api,
  me,
  role,
  members,
  onMembersChanged,
  workspaceId,
  workspaceName,
  logoUrl,
  billing,
  waiting,
  emailAvailable,
  keepsLastWorkspace,
  page,
  openDelete,
  onPage,
  onLeft,
  onWorkspaceDeleted,
  onAccountChanged,
  onProfileChanged,
  onOpenWorkspace,
  onAccountDeleted,
}: {
  api: WorkspaceApi;
  me: Me;
  role: Role;
  /** The team, which the inbox keeps too. */
  members: Member[];
  onMembersChanged(): void;
  workspaceId: string;
  workspaceName: string;
  logoUrl: string | null;
  /** The owner's billing state on the cloud plan, and null otherwise. */
  billing: BillingState | null;
  /** The workspace waits for the cloud to open, so its widget is off. */
  waiting: boolean;
  /** The server sends email, so invites and the account's delete go by email. */
  emailAvailable: boolean;
  /** A self-hosted server, which keeps its last workspace. */
  keepsLastWorkspace: boolean;
  /** The page in the address. Null shows the list on a phone, and the first page beside it. */
  page: SettingsPage | null;
  /** Opens the delete dialog at once, for the account's delete. */
  openDelete: boolean;
  onPage(page: SettingsPage | null): void;
  onLeft(): void;
  onWorkspaceDeleted(name: string): void;
  /** The workspace's name or logo changed, so the account loads again. */
  onAccountChanged(): void;
  /** The operator's name or picture changed. */
  onProfileChanged(): void;
  onOpenWorkspace(workspaceId: string, step: OwnerStep): void;
  onAccountDeleted(): void;
}) {
  const team = useTeam(api, role, members, onMembersChanged);
  const pages = role === "member" ? MEMBER_PAGES : PAGES;
  const current = page !== null && pages.includes(page) ? page : null;
  const shown = current ?? "profile";
  // Owners and admins read them, and only on a page that shows them.
  const readsSettings = role !== "member" && SETTINGS_READERS.includes(shown);
  const settings = useLoad(() => (readsSettings ? api.settings() : null), [api, readsSettings]);
  const counted = settings.data?.usage ?? null;
  // The plan's limit counts pending invites as operators, so the bar and the line count them too.
  const usage =
    counted === null
      ? null
      : {
          ...counted,
          operators: { ...counted.operators, used: counted.operators.used + team.invites.length },
        };

  const pageView = () => {
    switch (shown) {
      case "profile":
        return (
          <ProfilePage
            me={me}
            emailAvailable={emailAvailable}
            keepsLastWorkspace={keepsLastWorkspace}
            onChanged={onProfileChanged}
            onOpenWorkspace={onOpenWorkspace}
            onAccountDeleted={onAccountDeleted}
          />
        );
      case "notifications":
        return <NotificationsPage api={api} />;
      case "workspace":
        return (
          <WorkspacePage
            api={api}
            isOwner={role === "owner"}
            name={workspaceName}
            logoUrl={logoUrl}
            endsSubscription={billing !== null && billing.state !== "free"}
            deletion={settings.data?.deletion ?? null}
            usage={usage}
            billing={billing}
            workspaceId={workspaceId}
            team={team}
            openDelete={openDelete}
            onChanged={onAccountChanged}
            onDeleted={() => onWorkspaceDeleted(workspaceName)}
          />
        );
      case "team":
        return (
          <TeamPage
            api={api}
            me={me}
            role={role}
            team={team}
            usage={usage}
            emailAvailable={emailAvailable}
            workspaceName={workspaceName}
            onLeft={onLeft}
          />
        );
      case "appearance":
        return (
          <AppearancePage
            api={api}
            me={me}
            workspaceId={workspaceId}
            canEdit={role !== "member"}
            onOpenWorkspace={() => onPage("workspace")}
          />
        );
      case "install":
        return settings.data === null ? (
          <Loading failure={settings.failure} />
        ) : (
          <InstallPage
            api={api}
            settings={settings.data}
            waiting={waiting}
            onSaved={settings.setData}
          />
        );
      case "developers":
        return <DevelopersPage api={api} />;
    }
  };

  return (
    <div className={current === null ? "settings listing" : "settings"}>
      <SettingsNav pages={pages} current={shown} workspaceId={workspaceId} onPick={onPage} />
      <div className="settings-pane">
        <button type="button" className="text-button settings-back" onClick={() => onPage(null)}>
          <Icon name="back" size={14} />
          {t("back")}
        </button>
        {/* A new page starts at its top, and its dialogs and forms start fresh. */}
        <div className="settings-page" key={shown}>
          {pageView()}
        </div>
      </div>
    </div>
  );
}
