/** @jsxImportSource react */
import { type FormEvent, useEffect, useState } from "react";
import type { Contact, ContactDetail, ContactSort, Role, WorkspaceApi } from "./api.ts";
import { shortDate } from "./format.ts";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import { countryName, flag } from "./place.ts";
import { Confirm, Select } from "./popup.tsx";
import { EmptyArt } from "./scene.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Avatar, ErrorNote, failureText, Loading, Page, PageRow } from "./ui.tsx";
import { ago, avatarLetters, visitorName } from "./visitor.ts";
import { ContactFolds } from "./visitor-panel.tsx";

const SEARCH_WAIT_MS = 250;
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

/** The search box's words, once the operator pauses. */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SEARCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

/** Everyone who chatted: a table to search, sort and page through, and a CSV of them all. */
function ContactList({ api, onOpen }: { api: WorkspaceApi; onOpen(visitorId: string): void }) {
  const [typed, setTyped] = useState("");
  const q = useSettled(typed);
  const [sort, setSort] = useState<ContactSort>("lastSeen");
  const [pages, setPages] = useState<{ contacts: Contact[]; next: string | null } | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const first = useLoad(() => api.contacts({ q, sort, before: null }), [api, q, sort]);
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
      const page = await api.contacts({ q, sort, before: pages.next });
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
        <Select<ContactSort>
          label={t("contactsSort")}
          value={sort}
          choices={SORTS.map((one) => ({ value: one.value, label: t(one.label) }))}
          onChange={setSort}
          side="end"
        />
      </div>
      {pages === null ? (
        <Loading failure={first.failure} />
      ) : pages.contacts.length === 0 ? (
        <div className="nothing empty-boat">
          <EmptyArt scene="day" />
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

/** A signed-out contact's name and email, which the team may correct. */
function IdentityForm({
  contact,
  onSave,
}: {
  contact: ContactDetail;
  onSave(change: { name: string | null; email: string | null }): Promise<unknown>;
}) {
  const [name, setName] = useState(contact.name ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [failure, setFailure] = useState<TextId | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    try {
      await onSave({
        name: name.trim() === "" ? null : name.trim(),
        email: email.trim() === "" ? null : email.trim(),
      });
      toast("saved");
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
    }
  };
  return (
    <form className="stack identity-form" onSubmit={(event) => void save(event)}>
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
      <button type="submit" className="pill dark">
        {t("contactSave")}
      </button>
      <ErrorNote text={failure} />
    </form>
  );
}

/** One person: what the team knows, every conversation, the note, and the delete. */
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
        <Loading failure={loaded.failure} />
      </section>
    );
  }
  const name = visitorName(contact);
  const context = [
    contact.email !== name ? contact.email : null,
    contact.externalId === null ? null : t("contactUserId", { id: contact.externalId }),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Page
      title={name}
      context={
        <>
          <button type="button" className="text-button back-link" onClick={onBack}>
            <Icon name="back" size={14} />
            {t("contacts")}
          </button>
          {context !== "" && <span> {context}</span>}
        </>
      }
    >
      <div className="contact-page">
        <div className="contact-folds">
          <ContactFolds
            contact={contact}
            visitor={{ ...contact, userId: null }}
            place
            pages={contact.pages}
            conversationId={null}
            onOpenConversation={onOpenConversation}
            onNote={(note) => change({ note })}
          />
        </div>
        <div className="contact-rows">
          <PageRow
            title={t("contactIdentityTitle")}
            help={t(contact.signedIn ? "contactIdentitySigned" : "contactIdentityHelp")}
          >
            {!contact.signedIn && <IdentityForm contact={contact} onSave={change} />}
          </PageRow>
          {role !== "member" && (
            <PageRow title={t("deleteContact")} help={t("deleteContactHelp")}>
              <button
                type="button"
                className="pill danger-soft"
                onClick={() => setConfirming(true)}
              >
                <Icon name="trash" size={18} />
                {t("deleteContact")}
              </button>
              <ErrorNote text={failure} />
            </PageRow>
          )}
        </div>
      </div>
      {confirming && (
        <Confirm
          title={t("deleteContactTitle", { name })}
          text={t("deleteContactConfirm", { count: contact.conversations.length })}
          confirm={t("deleteContact")}
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Page>
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
  return <ContactList api={api} onOpen={onContact} />;
}
