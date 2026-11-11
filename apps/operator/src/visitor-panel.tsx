/** @jsxImportSource react */
// What the team knows about a visitor, in folds: the right panel of a conversation and the contact
// page show the same sections.
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { markdownText } from "../../../packages/widget/src/markdown.ts";
import type { Contact, ContactDetail, Conversation, Member, PageView } from "./api.ts";
import { Icon } from "./icons.tsx";
import { countryName, flag, localTime } from "./place.ts";
import { Select } from "./popup.tsx";
import { readStored, store } from "./stored.ts";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Avatar, DocLink, ErrorNote, failureText } from "./ui.tsx";
import { ago, avatarLetters, bare, detailRows, visitorName, webLink } from "./visitor.ts";

const MINUTE_MS = 60_000;
const PAGES_FIRST = 5;

/** A fold, open or closed as this device last left it. */
function Section({ id, title, children }: { id: string; title: TextId; children: ReactNode }) {
  const key = `dinghy.panel.${id}`;
  const [open, setOpen] = useState(() => readStored(key) !== "closed");
  return (
    <section className="fold" aria-label={t(title)}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            store(key, open ? "closed" : null);
            setOpen(!open);
          }}
        >
          {t(title)}
          <span className="fold-chevron">
            <Icon name="chevron" size={12} />
          </span>
        </button>
      </h3>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

/** A name and its value, as one line of a fold. */
function Fact({ name, children }: { name: TextId; children: ReactNode }) {
  return (
    <>
      <dt>{t(name)}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** The time where the visitor is, kept current. */
function LocalTime({ timeZone }: { timeZone: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return <>{localTime(timeZone, now)}</>;
}

type Place = Pick<Contact, "country" | "timeZone" | "device" | "lastPage">;

const hasPlace = (visitor: Place) =>
  visitor.country !== null ||
  (visitor.timeZone !== null && localTime(visitor.timeZone) !== null) ||
  visitor.device !== null ||
  webLink(visitor.lastPage) !== null;

/** Where the visitor is and what with: country, local time, device and the last page. */
function PlaceFacts({ visitor }: { visitor: Place }) {
  const page = webLink(visitor.lastPage);
  return (
    <dl className="facts">
      {visitor.country !== null && (
        <Fact name="countryLabel">
          <span aria-hidden="true">{flag(visitor.country)} </span>
          {countryName(visitor.country)}
        </Fact>
      )}
      {visitor.timeZone !== null && localTime(visitor.timeZone) !== null && (
        <Fact name="localTimeLabel">
          <LocalTime timeZone={visitor.timeZone} />
        </Fact>
      )}
      {visitor.device !== null && <Fact name="deviceLabel">{visitor.device}</Fact>}
      {page !== null && (
        <Fact name="currentPageLabel">
          <a href={page} target="_blank" rel="noopener noreferrer" title={page}>
            {bare(page)}
          </a>
        </Fact>
      )}
    </dl>
  );
}

/**
 * Named values about the visitor. With `links`, a web address opens in a new tab. Only signed values
 * get links, because anyone can put an address in what a page sends.
 */
function DetailList({ values, links }: { values: Record<string, unknown> | null; links: boolean }) {
  const rows = detailRows(values);
  if (rows.length === 0) return null;
  return (
    <dl className="context">
      {rows.map(([name, value, link]) => (
        <Fragment key={`${name}=${value}`}>
          <dt>{name}</dt>
          <dd>
            {link === null || !links ? (
              value
            ) : (
              <a href={link} target="_blank" rel="noopener noreferrer" title={link}>
                {bare(link)}
              </a>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Signed attributes, and the page's unsigned context. */
interface Details {
  attributes: Record<string, unknown> | null;
  pageContext: Record<string, unknown> | null;
}

const hasDetails = ({ attributes, pageContext }: Details) =>
  detailRows(attributes).length > 0 || detailRows(pageContext).length > 0;

/** The signed attributes, then what the page sent with setContext(), which says it is unverified. */
function DetailsFold({ attributes, pageContext }: Details) {
  return (
    <>
      <DetailList values={attributes} links />
      {detailRows(pageContext).length > 0 && (
        <div className="page-context">
          <h4>{t("pageContextTitle")}</h4>
          <p className="quiet">{t("pageContextNote")}</p>
          <DocLink
            path="add-to-your-site#tell-operators-about-the-page"
            text="pageContextDocsLink"
          />
          <DetailList values={pageContext} links={false} />
        </div>
      )}
    </>
  );
}

/**
 * The pages the visitor went through, newest first: the title, or the address when the page has
 * none, as a link, and when. Five at first, and the rest of the 20 on request.
 */
function PageJourney({ pages }: { pages: PageView[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? pages : pages.slice(0, PAGES_FIRST);
  return (
    <div className="journey">
      <ol>
        {shown.map((page) => {
          const link = webLink(page.path);
          const name = page.title ?? bare(page.path);
          return (
            <li key={`${page.path} ${page.viewedAt}`}>
              {link === null ? (
                <span className="page-name">{name}</span>
              ) : (
                <a
                  className="page-name"
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={bare(link)}
                >
                  {name}
                </a>
              )}
              <time dateTime={page.viewedAt} title={new Date(page.viewedAt).toLocaleString()}>
                {ago(page.viewedAt, Date.now(), "narrow")}
              </time>
            </li>
          );
        })}
      </ol>
      {pages.length > PAGES_FIRST && (
        <button type="button" className="text-button" onClick={() => setAll(!all)}>
          {all ? t("pagesFewer") : t("pagesAll", { count: pages.length })}
        </button>
      )}
    </div>
  );
}

/** A visitor's conversations, as links that open each one. */
function ConversationLinks({
  conversations,
  onOpen,
}: {
  conversations: ContactDetail["conversations"];
  onOpen(id: string, status: "open" | "closed"): void;
}) {
  return (
    <ul className="conversation-links">
      {conversations.map((one) => (
        <li key={one.id}>
          <button type="button" className="text-button" onClick={() => onOpen(one.id, one.status)}>
            <span className="link-preview">
              {one.lastBody === null ? t("image") : markdownText(one.lastBody)}
            </span>
            <small>
              {t(one.status)} · {ago(one.updatedAt, Date.now(), "narrow")}
            </small>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The team's private note. It saves when the field loses focus. */
function NoteField({
  note,
  onSave,
}: {
  note: string | null;
  onSave(note: string | null): Promise<unknown>;
}) {
  const [draft, setDraft] = useState(note ?? "");
  const [failure, setFailure] = useState<TextId | null>(null);
  // A save elsewhere, or another operator's, shows here while this field is not being changed.
  const [saved, setSaved] = useState(note);
  if (saved !== note) {
    setSaved(note);
    setDraft(note ?? "");
  }
  const save = async () => {
    const next = draft.trim() === "" ? null : draft;
    if (next === note) return;
    setFailure(null);
    try {
      await onSave(next);
      toast("saved");
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
    }
  };
  return (
    <>
      <textarea
        className="note-field"
        aria-label={t("panelNote")}
        placeholder={t("notePlaceholder")}
        maxLength={5000}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
      />
      <ErrorNote text={failure} />
    </>
  );
}

/** The sections both views share, each hidden when it has nothing to show. */
export function ContactFolds({
  contact,
  visitor,
  pages,
  conversationId,
  onOpenConversation,
  onNote,
}: {
  /** Null until it loads: the sections from it wait. */
  contact: ContactDetail | null;
  /** The newest facts, from the conversation when there is one. */
  visitor: Place & Details;
  pages: PageView[];
  /** The conversation on screen, left out of the list. Null on the contact page. */
  conversationId: string | null;
  onOpenConversation(id: string, status: "open" | "closed"): void;
  onNote(note: string | null): Promise<unknown>;
}) {
  const others = contact?.conversations.filter((one) => one.id !== conversationId) ?? [];
  return (
    <>
      {hasPlace(visitor) && (
        <Section id="visitor" title="panelVisitor">
          <PlaceFacts visitor={visitor} />
        </Section>
      )}
      {hasDetails(visitor) && (
        <Section id="details" title="panelDetails">
          <DetailsFold attributes={visitor.attributes} pageContext={visitor.pageContext} />
        </Section>
      )}
      {pages.length > 0 && (
        <Section id="journey" title="pagesVisited">
          <PageJourney pages={pages} />
        </Section>
      )}
      {others.length > 0 && (
        <Section
          id="conversations"
          title={conversationId === null ? "panelAllConversations" : "panelOtherConversations"}
        >
          <ConversationLinks conversations={others} onOpen={onOpenConversation} />
        </Section>
      )}
      {contact !== null && (
        <Section id="note" title="panelNote">
          <NoteField note={contact.note} onSave={onNote} />
        </Section>
      )}
    </>
  );
}

/** Online now, or when the visitor was last seen, or nothing when unknown. */
function presenceLine(lastSeenAt: string | null, online: boolean | null): string | null {
  if (online === true) return t("onlineNow");
  return lastSeenAt === null ? null : t("lastSeen", { time: ago(lastSeenAt) });
}

/** The right side of a conversation: who the visitor is, and everything the team knows. */
export function VisitorPanel({
  conversation,
  contact,
  online,
  pages,
  members,
  overlay,
  onAssign,
  onOpenContact,
  onOpenConversation,
  onNote,
  onClose,
}: {
  conversation: Conversation;
  contact: ContactDetail | null;
  online: boolean | null;
  pages: PageView[];
  members: Member[];
  /** A drawer over the thread, on a narrow screen. */
  overlay: boolean;
  onAssign(operatorId: string | null): void;
  onOpenContact(): void;
  onOpenConversation(id: string, status: "open" | "closed"): void;
  onNote(note: string | null): Promise<unknown>;
  onClose(): void;
}) {
  const { visitor } = conversation;
  const name = visitorName(visitor);
  const presence = presenceLine(visitor.lastSeenAt, online);
  const assignee = members.some((member) => member.id === conversation.assigneeOperatorId)
    ? (conversation.assigneeOperatorId ?? "")
    : "";
  return (
    <aside className={overlay ? "visitor-panel overlay" : "visitor-panel"} aria-label={name}>
      <header className="panel-head">
        <Avatar name={name} letters={avatarLetters(visitor)} />
        <div className="panel-who">
          <h3>{name}</h3>
          {visitor.email !== null && visitor.email !== name && <p>{visitor.email}</p>}
          {presence !== null && (
            <p className={online === true ? "online" : undefined}>{presence}</p>
          )}
        </div>
        {overlay && (
          <button
            type="button"
            className="icon-button"
            aria-label={t("hidePanel")}
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        )}
        <button type="button" className="pill soft panel-contact" onClick={onOpenContact}>
          {t("viewContact")}
        </button>
      </header>
      <Section id="conversation" title="panelConversation">
        <dl className="facts">
          <dt>{t("assignTo")}</dt>
          <dd>
            <Select
              label={t("assignTo")}
              className="assignee"
              side="end"
              value={assignee}
              choices={[
                { value: "", label: t("unassigned"), lead: <span className="avatar nobody" /> },
                ...members.map((member) => ({
                  value: member.id,
                  label: member.name,
                  lead: <Avatar name={member.name} pictureUrl={member.pictureUrl} />,
                })),
              ]}
              onChange={(value) => onAssign(value === "" ? null : value)}
            />
          </dd>
          <Fact name="statusLabel">
            <span className={conversation.status === "open" ? "chip warn" : "chip"}>
              {t(conversation.status)}
            </span>
          </Fact>
        </dl>
      </Section>
      <ContactFolds
        contact={contact}
        visitor={{ ...visitor, pageContext: conversation.pageContext }}
        pages={pages}
        conversationId={conversation.id}
        onOpenConversation={onOpenConversation}
        onNote={onNote}
      />
    </aside>
  );
}
