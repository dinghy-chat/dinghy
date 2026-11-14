/** @jsxImportSource react */
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { useBilling } from "../../../ee/operator/billing.tsx";
import { AnalyticsPage } from "./analytics.tsx";
import { type Me, workspaceApi } from "./api.ts";
import { pauseBots } from "./bots.tsx";
import { ContactsPage } from "./contacts.tsx";
import { NO_DRAFT, useDrafts } from "./drafts.ts";
import { GetStarted } from "./get-started.tsx";
import { InboxBanners } from "./inbox-banners.tsx";
import { useInboxData } from "./inbox-data.ts";
import {
  type Filter,
  filterAddress,
  filterInAddress,
  type Status,
  sameFilter,
} from "./inbox-filters.tsx";
import { InboxList } from "./inbox-list.tsx";
import { leave, NAVIGATE_EVENT, navigate, pushAddress, replaceAddress } from "./nav.ts";
import { useDeviceSync } from "./notifications.tsx";
import { Harbor } from "./scene.tsx";
import { Settings, type SettingsPage, settingsAddress, settingsInAddress } from "./settings.tsx";
import { ShortcutsDialog, useShortcuts } from "./shortcuts.tsx";
import { Sidebar, type View } from "./sidebar.tsx";
import { t } from "./text.ts";
import { Thread } from "./thread.tsx";
import { VisitorsPage } from "./visitors.tsx";

/** The views with an address of their own besides the Inbox and Settings, as `/contacts`. */
const PAGES = ["contacts", "visitors", "analytics"] as const;

/** The view in the address, and the contact for `/contacts/<id>`. Settings reads its own page. */
function viewInAddress(): { view: View; contactId: string | null } {
  const [first, second, ...rest] = location.pathname.split("/").filter((part) => part !== "");
  if (first === "settings") return { view: "settings", contactId: null };
  const page = PAGES.find((one) => one === first);
  if (page === undefined) return { view: "inbox", contactId: null };
  const contact = page === "contacts" && rest.length === 0 ? (second ?? null) : null;
  return { view: page, contactId: contact };
}

/**
 * The address of a view other than Settings, so a reload or a copied link opens the same screen.
 * A page's names the workspace. The Inbox's names its filter, and an open conversation with its
 * workspace.
 */
function viewAddress(
  view: Exclude<View, "settings">,
  workspaceId: string,
  {
    selected,
    contactId,
    filter,
  }: { selected: string | null; contactId: string | null; filter: Filter },
): string {
  if (view !== "inbox") {
    const path = view === "contacts" && contactId !== null ? `/contacts/${contactId}` : `/${view}`;
    return `${path}?workspace=${workspaceId}`;
  }
  const url = new URL("/", location.origin);
  if (selected !== null) {
    url.searchParams.set("workspace", workspaceId);
    url.searchParams.set("conversation", selected);
  }
  return filterAddress(filter, url.href);
}

const here = () => `${location.pathname}${location.search}`;

/**
 * False while the address leads away from this workspace's views, as a notification for another
 * workspace or the signup does. The app is then loading that screen, so its address must stay.
 */
function isOwnAddress(workspaceId: string): boolean {
  const named = new URLSearchParams(location.search).get("workspace");
  if (named !== null && named !== workspaceId) return false;
  const first = location.pathname.split("/")[1] ?? "";
  return first === "" || PAGES.some((page) => page === first);
}

/**
 * The view, Settings page and contact shown, which the address can open, as a reload or a link
 * does. Back and Forward move between them, and a link in the app can open one.
 */
function useViews(setFilter: Dispatch<SetStateAction<Filter>>) {
  const [initial] = useState(() => ({ ...viewInAddress(), page: settingsInAddress() }));
  const [view, setView] = useState<View>(initial.view);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(initial.page ?? null);
  // The contact the Contacts view shows, or null for its list.
  const [contactId, setContactId] = useState<string | null>(initial.contactId);
  useEffect(() => {
    const moved = () => {
      const page = settingsInAddress();
      if (page === undefined) {
        const shown = viewInAddress();
        setView(shown.view);
        setContactId(shown.contactId);
        const next = filterInAddress();
        setFilter((current) => (sameFilter(current, next) ? current : next));
        return;
      }
      setView("settings");
      setSettingsPage(page);
    };
    addEventListener(NAVIGATE_EVENT, moved);
    return () => removeEventListener(NAVIGATE_EVENT, moved);
  }, [setFilter]);
  return { view, setView, settingsPage, setSettingsPage, contactId, setContactId };
}

/**
 * The row `by` rows from the open conversation in the list as shown, search results included.
 * With none open, it is the first row.
 */
function rowFrom(by: 1 | -1): HTMLElement | undefined {
  const rows = [...document.querySelectorAll<HTMLElement>(".list .rows .row")];
  const at = rows.findIndex((row) => row.getAttribute("aria-current") === "true");
  return rows[at === -1 ? 0 : at + by];
}

function openRow(row: HTMLElement | undefined) {
  row?.click();
  row?.scrollIntoView({ block: "nearest" });
}

/** The conversation the address names, when it is in this workspace, as a notification's link. */
function linkedConversation(workspaceId: string): string | null {
  const params = new URLSearchParams(location.search);
  return params.get("workspace") === workspaceId ? params.get("conversation") : null;
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
  const [drafts, setDraft] = useDrafts(me.id, workspaceId);
  // A notification opens the app on its conversation.
  const [selected, setSelected] = useState(() => linkedConversation(workspaceId));
  const { view, setView, settingsPage, setSettingsPage, contactId, setContactId } =
    useViews(setFilter);
  // Each opening of the shortcuts is a new sheet. A dialog's close event comes a moment after
  // Escape, so a quick ? must not meet the old sheet's late close.
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const [keysSheet, setKeysSheet] = useState<number | null>(null);
  const keysSheets = useRef(0);
  const openKeys = () => {
    keysSheets.current += 1;
    setKeysSheet(keysSheets.current);
  };
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
  const { members, waiting, version, who, reload, loadMembers, accountVersion, labels } = data;
  // What the list shows: a team of one has no assignee filter.
  const shownFilter = { ...filter, who };
  const membership = me.workspaces.find((one) => one.workspaceId === workspaceId);
  const name = membership?.name ?? t("appName");
  const logoUrl = membership?.logoUrl ?? null;
  // The roster is newer than `me`, because a role can change while this page is open.
  const role = members.find((member) => member.id === me.id)?.role ?? membership?.role ?? "member";
  const readOnly = membership?.readOnly ?? false;
  const suspended = membership?.suspended ?? false;
  const waitsForCloud = membership?.waiting ?? false;
  const botsPaused = membership?.botsPaused ?? false;
  const botsPausedBy = membership?.botsPausedBy ?? null;
  // Only owners and admins pause or resume the bots.
  const setBotsPaused =
    role === "member" ? null : (paused: boolean) => void pauseBots(api, paused, onAccountChanged);
  const billing = useBilling(api, me.billing && role === "owner", accountVersion);
  // The conversation a link opened, whose status picks Open or Closed once it loads.
  const linked = useRef(selected);
  // A notification clicked while the app is open, or Back and Forward, open the address's
  // conversation.
  useEffect(() => {
    const moved = () => {
      const id = linkedConversation(workspaceId);
      if (id === selectedNow.current) return;
      linked.current = id;
      setSelected(id);
    };
    addEventListener(NAVIGATE_EVENT, moved);
    return () => removeEventListener(NAVIGATE_EVENT, moved);
  }, [workspaceId]);

  /** Shows a view, and a Settings page in it, and puts it in the address for Back and reloads. */
  const showView = (next: View, page: SettingsPage | null = null, contact = contactId) => {
    setSettingsPage(page);
    // The account's delete reads who owns what, which can change in Settings.
    if (page === "profile") onAccountChanged();
    setView(next);
    const address =
      next === "settings"
        ? settingsAddress(page, workspaceId)
        : viewAddress(next, workspaceId, { selected, contactId: contact, filter: shownFilter });
    if (address !== here()) pushAddress(address);
  };
  const openSettings = (page: SettingsPage | null) => leave(() => showView("settings", page));
  // The conversation and the contact on screen stay in the address, in place, so a reload keeps
  // them and Back does not step through each one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter writes its own address.
  useEffect(() => {
    if (view === "settings" || !isOwnAddress(workspaceId)) return;
    const address = viewAddress(view, workspaceId, { selected, contactId, filter: shownFilter });
    if (address !== here()) replaceAddress(address);
  }, [view, workspaceId, selected, contactId]);

  /** Shows another filter, and puts it in the address, so a reload or a shared link keeps it. */
  const showFilter = (next: Filter) => {
    if (sameFilter(next, shownFilter)) return;
    replaceAddress(filterAddress(next));
    setFilter(next);
  };
  // A label deleted while the list shows only its conversations would leave the list empty.
  const isLabelGone =
    data.labelsLoaded && filter.label !== null && !labels.some((one) => one.id === filter.label);
  useEffect(() => {
    if (isLabelGone) showFilter({ ...shownFilter, label: null });
  });

  /** Opens a contact's page, from a conversation's panel or from Visitors. */
  const openContact = (visitorId: string) =>
    leave(() => {
      setContactId(visitorId);
      showView("contacts", null, visitorId);
    });
  /** Opens a conversation in the Inbox, under Open or Closed as it is. */
  const openConversation = (conversationId: string, conversationStatus: Status) =>
    leave(() => {
      showView("inbox");
      setSelected(conversationId);
      showFilter({ ...shownFilter, status: conversationStatus });
    });

  /** Shows a view from the sidebar or the keyboard. Contacts opens on its list. */
  const openView = (next: View) => {
    if (next !== view || next === "contacts") {
      leave(() => {
        if (next === "contacts") setContactId(null);
        showView(next, null, null);
      });
    }
  };
  useShortcuts({
    "?": openKeys,
    "/": () =>
      [...document.querySelectorAll<HTMLElement>("input[type='search']")]
        .find((field) => field.getClientRects().length > 0)
        ?.focus(),
    "g i": () => openView("inbox"),
    "g c": () => openView("contacts"),
    "g v": () => openView("visitors"),
    "g a": () => openView("analytics"),
    "g s": () => openView("settings"),
    ...(view === "inbox" && {
      j: () => openRow(rowFrom(1)),
      k: () => openRow(rowFrom(-1)),
    }),
  });

  return (
    <div className="shell">
      {keysSheet !== null && (
        <ShortcutsDialog
          key={keysSheet}
          onClose={() => setKeysSheet((shown) => (shown === keysSheet ? null : shown))}
        />
      )}
      <div className={view !== "inbox" ? "app paging" : selected === null ? "app" : "app showing"}>
        <Sidebar
          me={me}
          role={role}
          name={name}
          logoUrl={logoUrl}
          workspaceId={workspaceId}
          canCreate={canCreate}
          view={view}
          isProfile={view === "settings" && settingsPage === "profile"}
          waiting={waiting}
          waitingBy={{ ...data.waitingElsewhere, [workspaceId]: waiting }}
          liveCount={data.liveCount}
          botsPaused={botsPaused}
          onBotsPaused={setBotsPaused}
          steps={
            role === "member" ? null : (
              <GetStarted api={api} version={version} onOpen={openSettings} />
            )
          }
          onView={openView}
          onShortcuts={openKeys}
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
            botsPaused={botsPaused}
            botsPausedBy={botsPausedBy}
            botsPausedAt={membership?.botsPausedAt ?? null}
            onResumeBots={setBotsPaused && (() => setBotsPaused(false))}
            onRemovalCancelled={onAccountChanged}
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
                botsPaused={botsPaused}
                botsPausedBy={botsPausedBy}
                onBotsPaused={setBotsPaused}
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
                filter={shownFilter}
                isTeam={data.isTeam}
                openBy={data.openBy}
                waiting={waiting}
                conversations={data.conversations}
                listed={data.listed}
                hasMore={data.hasMore}
                members={members}
                labels={labels}
                isWritable={!readOnly && !suspended}
                mayDelete={role !== "member" && !readOnly && !suspended}
                selected={selected}
                typing={data.typing}
                drafts={drafts}
                reads={data.reads}
                replying={data.replying}
                onFilter={showFilter}
                onSelect={setSelected}
                onMore={data.loadMore}
                onChanged={reload}
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
                  draft={drafts[selected] ?? NO_DRAFT}
                  setDraft={(draft) => setDraft(selected, draft)}
                  members={members}
                  labels={labels}
                  onLabelAdded={data.reloadLabels}
                  replying={data.replying(selected)}
                  mayDeleteAnyone={role !== "member" && !readOnly && !suspended}
                  emailAvailable={emailAvailable}
                  readOnly={readOnly}
                  suspended={suspended}
                  conversationId={selected}
                  version={data.threadVersion(selected)}
                  receiptsVersion={data.receiptsVersion}
                  rewriteVersion={data.rewriteVersion(selected)}
                  savedReplies={data.savedReplies}
                  onOpenContact={openContact}
                  onOpenConversation={openConversation}
                  typingDraft={data.typing[selected] ?? null}
                  botTyping={data.botTyping[selected] ?? null}
                  draftsVersion={data.draftsVersion(selected)}
                  onBack={() => setSelected(null)}
                  nextAfterClose={(closing) => {
                    // Chosen now, as the close's update may take its row out of the list first.
                    const next = rowFrom(1) ?? rowFrom(-1);
                    return () => {
                      // The operator moved on while the close saved, as with J or a second E.
                      if (selectedNow.current !== closing) return;
                      if (next?.isConnected) openRow(next);
                      else setSelected(null);
                    };
                  }}
                  onChanged={reload}
                  inView={view === "inbox"}
                  onRead={data.markedRead}
                  onLoaded={(conversation) => {
                    if (linked.current !== conversation.id) return;
                    linked.current = null;
                    showFilter({ ...shownFilter, status: conversation.status });
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
