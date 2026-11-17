/** @jsxImportSource react */
import { type ReactNode, useEffect, useState } from "react";
import type { Contact, ContactDetail, ContactSort, Role, WorkspaceApi } from "./api.ts";
import { ContactData } from "./contact-data.tsx";
import { duration, shortDate } from "./format.ts";
import { Icon } from "./icons.tsx";
import { useLoad, useSettled } from "./load.ts";
import { MessageButton, OutboundList } from "./outbound.tsx";
import { countryName, flag, zoneCity, zoneClock } from "./place.ts";
import { Confirm, Menu, type MenuItem, Select } from "./popup.tsx";
import { EmptyArt } from "./scene.tsx";
import { TableSkeleton } from "./skeleton.tsx";
import { plural, type TextId, t } from "./text.ts";
import { ONLINE_EVERY_MS } from "./thread-lines.ts";
import { toast } from "./toast.tsx";
import {
  Avatar,
  Choices,
  CopyIcon,
  ErrorNote,
  FlagBadge,
  FormDialog,
  failureText,
  Loading,
  Page,
  Tip,
} from "./ui.tsx";
import {
  ago,
  avatarLetters,
  conversationPreview,
  pagePath,
  presenceLine,
  visitorName,
  webLink,
} from "./visitor.ts";
import {
  ContactDetails,
  hasDetails,
  NoteField,
  PageJourney,
  Tile,
  useNow,
} from "./visitor-panel.tsx";

/** Who the list shows: people with a conversation, or also those your server created or messaged. */
type Shown = "chatted" | "everyone";
const SHOWN: { value: Shown; label: TextId }[] = [
  { value: "chatted", label: "contactsHasChatted" },
  { value: "everyone", label: "contactsEveryone" },
];
const SORTS: { value: ContactSort; label: TextId }[] = [
  { value: "lastSeen", label: "sortLastSeen" },
  { value: "firstSeen", label: "sortFirstSeen" },
];

/** A country as a flag and its name, or nothing. */
function CountryCell({ country }: { country: string | null }) {
  if (country === null) return null;
  return (
    <>
      <span aria-hidden="true">{flag(country)} </span>
      {countryName(country)}
    </>
  );
}

function ContactRow({ contact, onOpen }: { contact: Contact; onOpen(): void }) {
  const name = visitorName(contact);
  return (
    <tr>
      <td>
        <button type="button" className="who-cell contact-open" onClick={onOpen}>
          <Avatar name={name} letters={avatarLetters(contact)} />
          <span className="who-lines">
            <b>{name}</b>
            {contact.email !== null && contact.email !== name && <span>{contact.email}</span>}
          </span>
        </button>
      </td>
      <td className="wide-cell">{contact.company}</td>
      <td className="wide-cell">
        <CountryCell country={contact.country} />
      </td>
      <td>
        {contact.lastSeenAt !== null && (
          <time dateTime={contact.lastSeenAt}>{ago(contact.lastSeenAt)}</time>
        )}
      </td>
      <td className="number-cell">{contact.conversationCount}</td>
      <td className="wide-cell">
        <time dateTime={contact.createdAt}>{shortDate(contact.createdAt)}</time>
      </td>
    </tr>
  );
}

/** Everyone who chatted: a table to search, sort and page through, and a CSV of them all. */
function ContactList({
  api,
  tabs,
  onOpen,
}: {
  api: WorkspaceApi;
  /** People, or attributes and events, above the list. */
  tabs: ReactNode;
  onOpen(visitorId: string): void;
}) {
  const [typed, setTyped] = useState("");
  const q = useSettled(typed);
  const [sort, setSort] = useState<ContactSort>("lastSeen");
  const [shownFilter, setShownFilter] = useState<Shown>("chatted");
  const hasChatted = shownFilter === "chatted";
  const [pages, setPages] = useState<{ contacts: Contact[]; next: string | null } | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const first = useLoad(
    () => api.contacts({ q, sort, before: null, hasChatted }),
    [api, q, sort, hasChatted],
  );
  // A new search or sort starts at its first page.
  const [shown, setShown] = useState(first.data);
  if (shown !== first.data) {
    setShown(first.data);
    setPages(first.data);
  }
  const more = async () => {
    if (pages?.next == null) return;
    setFailure(null);
    try {
      const page = await api.contacts({ q, sort, before: pages.next, hasChatted });
      setPages({ contacts: [...pages.contacts, ...page.contacts], next: page.next });
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
    }
  };
  const searching = q.trim() !== "";
  return (
    <Page
      title={t("contacts")}
      context={t("contactsContext")}
      actions={
        <a className="pill" href={api.contactsExportUrl} download>
          <Icon name="download" size={18} />
          {t("contactsExport")}
        </a>
      }
    >
      {tabs}
      <div className="contacts-tools">
        <div className="search">
          <Icon name="search" size={18} />
          <input
            type="search"
            aria-label={t("contactsSearch")}
            placeholder={t("contactsSearchPlaceholder")}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <Select<Shown>
          label={t("contactsShown")}
          value={shownFilter}
          choices={SHOWN.map((one) => ({ value: one.value, label: t(one.label) }))}
          onChange={setShownFilter}
          side="end"
        />
        <Select<ContactSort>
          label={t("contactsSort")}
          value={sort}
          choices={SORTS.map((one) => ({ value: one.value, label: t(one.label) }))}
          onChange={setSort}
          side="end"
        />
      </div>
      {pages === null ? (
        <Loading failure={first.failure}>
          <TableSkeleton />
        </Loading>
      ) : pages.contacts.length === 0 ? (
        <div className="nothing empty-boat">
          <EmptyArt />
          <b>{t(searching ? "contactsNone" : "contactsEmpty")}</b>
          {!searching && t("contactsEmptyHint")}
        </div>
      ) : (
        <>
          <table className="members contacts">
            <thead>
              <tr>
                <th scope="col">{t("colName")}</th>
                <th scope="col" className="wide-cell">
                  {t("colCompany")}
                </th>
                <th scope="col" className="wide-cell">
                  {t("colCountry")}
                </th>
                <th scope="col">{t("sortLastSeen")}</th>
                <th scope="col" className="number-cell">
                  {t("colConversations")}
                </th>
                <th scope="col" className="wide-cell">
                  {t("sortFirstSeen")}
                </th>
              </tr>
            </thead>
            <tbody>
              {pages.contacts.map((contact) => (
                <ContactRow key={contact.id} contact={contact} onOpen={() => onOpen(contact.id)} />
              ))}
            </tbody>
          </table>
          {pages.next !== null && (
            <button type="button" className="text-button" onClick={() => void more()}>
              {t("loadMore")}
            </button>
          )}
          <ErrorNote text={failure} />
        </>
      )}
    </Page>
  );
}

type ContactConversation = ContactDetail["conversations"][number];

/** A signed-out contact's name and email, which the team may correct, in a dialog. */
function IdentityForm({
  contact,
  onSave,
  onClose,
}: {
  contact: ContactDetail;
  onSave(change: { name: string | null; email: string | null }): Promise<unknown>;
  onClose(): void;
}) {
  const [name, setName] = useState(contact.name ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [failure, setFailure] = useState<TextId | null>(null);
  const save = async (close: () => void) => {
    setFailure(null);
    try {
      await onSave({
        name: name.trim() === "" ? null : name.trim(),
        email: email.trim() === "" ? null : email.trim(),
      });
      toast("saved");
      close();
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
    }
  };
  return (
    <FormDialog
      title={t("contactEdit")}
      help={t("contactIdentityHelp")}
      failure={failure}
      submitLabel={t("contactSave")}
      onSubmit={(close) => void save(close)}
      onClose={onClose}
    >
      <label className="identity-field">
        {t("contactNameLabel")}
        <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="identity-field">
        {t("email")}
        <input
          type="email"
          value={email}
          maxLength={320}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
    </FormDialog>
  );
}

/** On the site now with the page, or when last seen. */
function LiveLine({ contact }: { contact: ContactDetail }) {
  const page = webLink(contact.lastPage);
  if (contact.online === true) {
    return (
      <p className="contact-seen">
        <span className="live-pulse" aria-hidden="true" />
        <span>
          {t("contactOnline")}
          {page !== null && " ·"}
        </span>
        {page !== null && (
          <a
            className="contact-seen-link"
            href={page}
            target="_blank"
            rel="noopener noreferrer"
            title={page}
          >
            {pagePath(page)}
          </a>
        )}
      </p>
    );
  }
  const seen = presenceLine(contact.lastSeenAt, contact.online);
  return seen === null ? null : <p className="contact-seen">{seen}</p>;
}

/** Who the contact is: the avatar, name, chips, email and presence, and the page's actions. */
function ContactHero({ contact, actions }: { contact: ContactDetail; actions: ReactNode }) {
  const name = visitorName(contact);
  return (
    <header className="contact-hero">
      <span className="avatar-wrap">
        <Avatar name={name} letters={avatarLetters(contact)} />
        {contact.country !== null && <FlagBadge country={contact.country} />}
      </span>
      <div className="contact-who">
        <div className="contact-name">
          <h2>{name}</h2>
          {contact.signedIn && (
            <Tip text={t("contactSignedInTip")}>
              {(tipId) => (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the tip shows on keyboard focus.
                <span className="chip signed" tabIndex={0} aria-describedby={tipId}>
                  {t("contactSignedIn")}
                </span>
              )}
            </Tip>
          )}
          {contact.company !== null && <span className="chip">{contact.company}</span>}
          {contact.blocked && <span className="chip bad">{t("contactBlocked")}</span>}
        </div>
        {contact.email !== null && contact.email !== name && (
          <p className="contact-email">
            <a className="contact-email-link" href={`mailto:${contact.email}`}>
              {contact.email}
            </a>
            <CopyIcon value={contact.email} label={t("copyValue", { name: t("emailLabel") })} />
          </p>
        )}
        <LiveLine contact={contact} />
      </div>
      <div className="contact-actions">{actions}</div>
    </header>
  );
}

/** The facts as tiles, each left out when unknown. */
function ContactTiles({ contact }: { contact: ContactDetail }) {
  const now = useNow();
  const zone =
    contact.timeZone === null
      ? null
      : { clock: zoneClock(contact.timeZone, now), city: zoneCity(contact.timeZone) };
  const open = contact.conversations.filter((one) => one.status === "open").length;
  // The server writes the device as "Chrome on macOS", or one of the two alone.
  const [browser, system] = contact.device?.split(" on ") ?? [];
  const device = browser === undefined ? null : { browser, system };
  return (
    <div className="contact-tiles">
      {zone?.clock != null && (
        <Tile label={t("localTimeLabel")} sub={`${zone.city} · ${zone.clock.utc}`}>
          {zone.clock.time}
        </Tile>
      )}
      {contact.country !== null && (
        <Tile label={t("contactLocation")} sub={t("contactLocationFrom")}>
          <CountryCell country={contact.country} />
        </Tile>
      )}
      {device !== null && (
        <Tile label={t("deviceLabel")} sub={device.system}>
          <span title={contact.device ?? undefined}>{device.browser}</span>
        </Tile>
      )}
      <Tile label={t("contactFirstSeen")} sub={ago(contact.createdAt)}>
        {shortDate(contact.createdAt)}
      </Tile>
      <Tile
        label={t("contactConversations")}
        sub={open > 0 ? t("contactOpenCount", { count: open }) : undefined}
      >
        {contact.conversations.length}
      </Tile>
    </div>
  );
}

/** The second line of a conversation's card: who has or closed it, its size and the first reply. */
function conversationFacts(one: ContactConversation): string {
  const who =
    one.status === "open"
      ? one.assigneeName
      : one.closedBy === null
        ? null
        : t("contactClosedBy", { name: one.closedBy });
  return [
    who,
    plural(one.messageCount, "contactMessagesOne", "contactMessagesMany"),
    one.firstReplySeconds === null
      ? null
      : t("contactRepliedIn", { time: duration(one.firstReplySeconds) }),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Every conversation as a card that opens it, newest activity first. */
function ConversationCards({
  conversations,
  onOpen,
}: {
  conversations: ContactConversation[];
  onOpen(id: string, status: "open" | "closed"): void;
}) {
  return (
    <ol className="contact-conversations">
      {conversations.map((one) => (
        <li key={one.id}>
          <button
            type="button"
            className="conversation-card"
            onClick={() => onOpen(one.id, one.status)}
          >
            <span className="conversation-top">
              <span className={one.status === "open" ? "chip warn" : "chip"}>{t(one.status)}</span>
              <b>{conversationPreview(one)}</b>
              <time dateTime={one.updatedAt} title={new Date(one.updatedAt).toLocaleString()}>
                {ago(one.updatedAt, Date.now(), "narrow")}
              </time>
            </span>
            <span className="conversation-facts">{conversationFacts(one)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

type ContactTab = "conversations" | "outbound" | "pages";

const TAB_LABEL: Record<ContactTab, TextId> = {
  conversations: "contactConversations",
  outbound: "contactOutbound",
  pages: "pagesVisited",
};

/** The conversation to open from the page: the newest open one, or else the newest. */
const conversationToOpen = (conversations: ContactConversation[]) =>
  conversations.find((one) => one.status === "open") ?? conversations[0];

/** One person: who they are, their conversations and pages, the note and their details. */
function ContactView({
  api,
  visitorId,
  role,
  version,
  onBack,
  onOpenConversation,
}: {
  api: WorkspaceApi;
  visitorId: string;
  role: Role;
  version: number;
  onBack(): void;
  onOpenConversation(id: string, status: "open" | "closed"): void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a load.
  const loaded = useLoad(() => api.contact(visitorId), [api, visitorId, version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a load.
  const outbound = useLoad(() => api.outboundMessages(visitorId), [api, visitorId, version]);
  const { reload } = loaded;
  useEffect(() => {
    const timer = setInterval(reload, ONLINE_EVERY_MS);
    return () => clearInterval(timer);
  }, [reload]);
  const [tab, setTab] = useState<ContactTab>("conversations");
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<TextId | null>(null);
  const contact = loaded.data;
  const change = async (next: Parameters<WorkspaceApi["changeContact"]>[1]) => {
    loaded.setData(await api.changeContact(visitorId, next));
  };
  const remove = async () => {
    try {
      await api.deleteContact(visitorId);
      onBack();
    } catch (error) {
      setConfirming(false);
      setFailure(failureText(error, {}, "deleteFailed"));
    }
  };
  if (contact === null) {
    return (
      <section className="page">
        <div className="page-body">
          <Loading failure={loaded.failure} />
        </div>
      </section>
    );
  }
  const name = visitorName(contact);
  const newest = conversationToOpen(contact.conversations);
  // A block goes through a conversation, so it needs one.
  const setBlocked = async (conversationId: string, blocked: boolean) => {
    setFailure(null);
    try {
      await (blocked ? api.block(conversationId) : api.unblock(conversationId));
      loaded.setData({ ...contact, blocked });
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
    }
  };
  const more: MenuItem[] = [
    ...(contact.signedIn
      ? []
      : [
          {
            label: t("contactEdit"),
            lead: <Icon name="pencil" size={18} />,
            onSelect: () => setEditing(true),
          },
        ]),
    ...(newest === undefined
      ? []
      : [
          {
            label: contact.blocked ? t("unblockVisitor") : t("blockVisitor"),
            lead: <Icon name="prohibit" size={18} />,
            onSelect: () => void setBlocked(newest.id, !contact.blocked),
          },
        ]),
    ...(role === "member"
      ? []
      : [
          {
            label: t("deleteContact"),
            lead: <Icon name="trash" size={18} />,
            danger: true,
            divider: true,
            onSelect: () => setConfirming(true),
          },
        ]),
  ];
  const details = {
    userId: contact.userId,
    attributes: contact.attributes,
    pageContext: contact.pageContext,
  };
  return (
    <section className="page contact-page" aria-label={name}>
      <button type="button" className="text-button back-link" onClick={onBack}>
        <Icon name="back" size={14} />
        {t("contacts")}
      </button>
      <ContactHero
        contact={contact}
        actions={
          <>
            <MessageButton api={api} visitorId={visitorId} name={name} onSent={outbound.reload} />
            {newest !== undefined && (
              <button
                type="button"
                className="pill dark"
                onClick={() => onOpenConversation(newest.id, newest.status)}
              >
                {t("contactOpenConversation")}
              </button>
            )}
            {more.length > 0 && (
              <Menu label={t("moreActions")} items={more} buttonClass="round">
                <Icon name="dots" />
              </Menu>
            )}
          </>
        }
      />
      <ErrorNote text={failure} />
      <ContactTiles contact={contact} />
      <div className="contact-columns">
        <section className="contact-main" aria-label={t(TAB_LABEL[tab])}>
          <Choices<ContactTab>
            label={t("contactViewTabs")}
            variant="tabs"
            value={tab}
            options={[
              {
                value: "conversations",
                label: TAB_LABEL.conversations,
                count: contact.conversations.length,
              },
              {
                value: "outbound",
                label: TAB_LABEL.outbound,
                count: outbound.data?.outboundMessages.length ?? 0,
              },
              { value: "pages", label: TAB_LABEL.pages, count: contact.pages.length },
            ]}
            onChange={setTab}
          />
          {tab === "conversations" ? (
            <ConversationCards conversations={contact.conversations} onOpen={onOpenConversation} />
          ) : tab === "outbound" ? (
            <OutboundList
              messages={outbound.data?.outboundMessages ?? []}
              onCancel={(id) =>
                void api.cancelOutbound(id).then(outbound.reload, (error: unknown) => {
                  setFailure(failureText(error, {}, "actionFailed"));
                })
              }
            />
          ) : contact.pages.length === 0 ? (
            <p className="quiet">{t("contactNoPages")}</p>
          ) : (
            <PageJourney pages={contact.pages} online={contact.online === true} />
          )}
        </section>
        <aside className="contact-side">
          <section className="contact-note" aria-label={t("panelNote")}>
            <h3>{t("panelNote")}</h3>
            <NoteField note={contact.note} onSave={(note) => change({ note })} />
            <small>{t("contactNoteSaved")}</small>
          </section>
          {hasDetails(details) && (
            <section className="contact-details" aria-label={t("contactDetails")}>
              <h3>{t("contactDetails")}</h3>
              <ContactDetails {...details} />
            </section>
          )}
        </aside>
      </div>
      {editing && (
        <IdentityForm contact={contact} onSave={change} onClose={() => setEditing(false)} />
      )}
      {confirming && (
        <Confirm
          title={t("deleteContactTitle", { name })}
          text={t("deleteContactConfirm", { count: contact.conversations.length })}
          confirm={t("deleteContact")}
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

/** The Contacts view: the list, or one contact. */
export function ContactsPage({
  api,
  role,
  contactId,
  version,
  onContact,
  onOpenConversation,
}: {
  api: WorkspaceApi;
  role: Role;
  /** The contact on screen, or null for the list. */
  contactId: string | null;
  /** Goes up on every change in the workspace. */
  version: number;
  onContact(visitorId: string | null): void;
  onOpenConversation(id: string, status: "open" | "closed"): void;
}) {
  if (contactId !== null) {
    return (
      <ContactView
        api={api}
        visitorId={contactId}
        role={role}
        version={version}
        onBack={() => onContact(null)}
        onOpenConversation={onOpenConversation}
      />
    );
  }
  return <ContactsHome api={api} onOpen={onContact} />;
}

type ContactsView = "people" | "data";

/** The list of people, or the attributes and events your app sends about them. */
function ContactsHome({ api, onOpen }: { api: WorkspaceApi; onOpen(visitorId: string): void }) {
  const [view, setView] = useState<ContactsView>("people");
  const tabs = (
    <Choices<ContactsView>
      label={t("contactsViews")}
      variant="pills"
      value={view}
      options={[
        { value: "people", label: "contactsPeople" },
        { value: "data", label: "contactDataTab" },
      ]}
      onChange={setView}
    />
  );
  if (view === "people") return <ContactList api={api} tabs={tabs} onOpen={onOpen} />;
  return (
    <Page title={t("contacts")} context={t("contactsContext")}>
      {tabs}
      <ContactData api={api} />
    </Page>
  );
}
