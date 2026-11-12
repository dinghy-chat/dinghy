/** @jsxImportSource react */
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { useBilling } from "../../../ee/operator/billing.tsx";
import { AnalyticsPage } from "./analytics.tsx";
import { type Me, workspaceApi } from "./api.ts";
import { ContactsPage } from "./contacts.tsx";
import { GetStarted } from "./get-started.tsx";
import { InboxBanners } from "./inbox-banners.tsx";
import { useInboxData } from "./inbox-data.ts";
import {
  type Filter,
  filterAddress,
  filterInAddress,
  type Status,
  type Who,
} from "./inbox-filters.tsx";
import { InboxList } from "./inbox-list.tsx";
import { leave, NAVIGATE_EVENT, navigate, pushAddress, replaceAddress } from "./nav.ts";
import { useDeviceSync } from "./notifications.tsx";
import { Harbor } from "./scene.tsx";
import { Settings, type SettingsPage, settingsAddress, settingsInAddress } from "./settings.tsx";
import { Sidebar, type View } from "./sidebar.tsx";
import { t } from "./text.ts";
import { Thread } from "./thread.tsx";
import { VisitorsPage } from "./visitors.tsx";

/**
 * The view and Settings page shown, which the address can open, as a reload or a link does. Back
 * and Forward move between them, and a link in the app can open one.
 */
function useViews(setFilter: Dispatch<SetStateAction<Filter>>) {
  const [initialPage] = useState(settingsInAddress);
  const [view, setView] = useState<View>(initialPage === undefined ? "inbox" : "settings");
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(initialPage ?? null);
  useEffect(() => {
    const moved = () => {
      const page = settingsInAddress();
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
  }, [setFilter]);
  return { view, setView, settingsPage, setSettingsPage };
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
  const { status } = filter;
  // In memory only, so a reload or a sign-out clears them.
  const drafts = useRef(new Map<string, string>()).current;
  // A notification opens the app on its conversation.
  const [selected, setSelected] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get("workspace") === workspaceId ? params.get("conversation") : null;
  });
  const { view, setView, settingsPage, setSettingsPage } = useViews(setFilter);
  // The contact the Contacts view shows, or null for its list.
  const [contactId, setContactId] = useState<string | null>(null);
  const data = useInboxData({
    api,
    workspaceId,
    meId: me.id,
    filter,
    selected,
    // A page such as Analytics hides the thread, so its conversation is not in view then.
    shownConversation: view === "inbox" ? selected : null,
    onSignedOut,
    onAccountChanged,
    onWelcome: (id) => setSelected((current) => current ?? id),
  });
  const { members, waiting, version, who, reload, loadMembers, accountVersion } = data;
  const membership = me.workspaces.find((one) => one.workspaceId === workspaceId);
  const name = membership?.name ?? t("appName");
  const logoUrl = membership?.logoUrl ?? null;
  // The roster is newer than `me`, because a role can change while this page is open.
  const role = members.find((member) => member.id === me.id)?.role ?? membership?.role ?? "member";
  const readOnly = membership?.readOnly ?? false;
  const suspended = membership?.suspended ?? false;
  const waitsForCloud = membership?.waiting ?? false;
  const billing = useBilling(api, me.billing && role === "owner", accountVersion);
  // The conversation a link opened, whose status picks Open or Closed once it loads.
  const linked = useRef(selected);

  /** Shows a view, and a Settings page in it, and puts it in the address for Back and reloads. */
  const showView = (next: View, page: SettingsPage | null = null) => {
    setSettingsPage(page);
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

  /** Shows another filter, and puts it in the address, so a reload or a shared link keeps it. */
  const showFilter = (nextStatus: Status, nextWho: Who) => {
    if (nextStatus === status && nextWho === who) return;
    replaceAddress(filterAddress(nextStatus, nextWho));
    setFilter({ status: nextStatus, who: nextWho });
  };

  /** Opens a contact's page, from a conversation's panel or from Visitors. */
  const openContact = (visitorId: string) =>
    leave(() => {
      setContactId(visitorId);
      showView("contacts");
    });
  /** Opens a conversation in the Inbox, under Open or Closed as it is. */
  const openConversation = (conversationId: string, conversationStatus: Status) =>
    leave(() => {
      showView("inbox");
      setSelected(conversationId);
      showFilter(conversationStatus, who);
    });

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
          waitingBy={{ ...data.waitingElsewhere, [workspaceId]: waiting }}
          liveCount={data.liveCount}
          steps={
            role === "member" ? null : (
              <GetStarted api={api} version={version} onOpen={openSettings} />
            )
          }
          onView={(next) => {
            if (next === "contacts") setContactId(null);
            if (next !== view || next === "contacts") leave(() => showView(next));
          }}
          onProfileOpen={() => openSettings("profile")}
          onSwitch={onSwitch}
          onStatusChanged={onAccountChanged}
          onLeavePresence={data.leavePresence}
          onSignedOut={onSignedOut}
        />
        <div className="stage">
          <InboxBanners
            lost={data.lost}
            deletedName={deletedName}
            onCloseDeleted={onCloseDeleted}
            api={api}
            me={me}
            workspaceId={workspaceId}
            isOwner={role === "owner"}
            readOnly={readOnly}
            suspended={suspended}
            waitsForCloud={waitsForCloud}
            billing={billing}
          />
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
                page={settingsPage}
                onPage={openSettings}
                onLeft={() => navigate("/")}
                onWorkspaceDeleted={onWorkspaceDeleted}
                onProfileChanged={() => {
                  // The name shows on assignments and in the dropdown too, which read the members.
                  onAccountChanged();
                  loadMembers();
                }}
                onAccountDeleted={onAccountDeleted}
              />
            )}
            {view === "analytics" && <AnalyticsPage api={api} />}
            {view === "visitors" && (
              <VisitorsPage
                api={api}
                onOpenConversation={(id) => openConversation(id, "open")}
                onOpenContact={openContact}
              />
            )}
            {view === "contacts" && (
              <ContactsPage
                api={api}
                role={role}
                contactId={contactId}
                version={version}
                onContact={setContactId}
                onOpenConversation={openConversation}
              />
            )}
            <div className="split">
              <InboxList
                api={api}
                status={status}
                who={who}
                isTeam={data.isTeam}
                openBy={data.openBy}
                waiting={waiting}
                conversations={data.conversations}
                listed={data.listed}
                hasMore={data.hasMore}
                members={members}
                selected={selected}
                typing={data.typing}
                replying={data.replying}
                onFilter={showFilter}
                onSelect={setSelected}
                onMore={data.loadMore}
              />
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
                  replying={data.replying(selected)}
                  mayDeleteAnyone={role !== "member" && !readOnly && !suspended}
                  emailAvailable={emailAvailable}
                  readOnly={readOnly}
                  suspended={suspended}
                  conversationId={selected}
                  version={data.threadVersion(selected)}
                  receiptsVersion={data.receiptsVersion}
                  rewriteVersion={data.rewriteVersion(selected)}
                  onOpenContact={openContact}
                  onOpenConversation={openConversation}
                  typingDraft={data.typing[selected] ?? null}
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
