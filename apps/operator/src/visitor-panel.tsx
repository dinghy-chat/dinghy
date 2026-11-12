/** @jsxImportSource react */
// What the team knows about a visitor, in folds: the right panel of a conversation and the contact
// page show the same sections.
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { markdownText } from "../../../packages/widget/src/markdown.ts";
import type { Contact, ContactDetail, Conversation, Member, PageView } from "./api.ts";
import { MINUTE_MS } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { countryName, flag, localTime } from "./place.ts";
import { Select } from "./popup.tsx";
import { readStored, store } from "./stored.ts";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Avatar, CopyId, DocLink, ErrorNote, failureText } from "./ui.tsx";
import {
  ago,
  avatarLetters,
  bare,
  detailRows,
  presenceLine,
  visitorName,
  webLink,
} from "./visitor.ts";

const PAGES_FIRST = 5;

/** A fold, open or closed as this device last left it. */
function Section({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: TextId;
  /** How many items the fold holds, shown beside its title. */
  count?: number;
  children: ReactNode;
}) {
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
          {count !== undefined && <span className="fold-count">{count}</span>}
          <span className="fold-chevron">
            <Icon name="chevron" size={12} />
          </span>
        </button>
      </h3>
      {open && <div className="fold-body">{children}</div>}
    </section>
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

/** One fact of the visitor's place, as a small tile: an icon, a label and the value. */
function Tile({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div>
      <Icon name={icon} size={16} />
      <dl>
        <dt>{label}</dt>
        <dd>{children}</dd>
      </dl>
    </div>
  );
}

/**
 * Where the visitor is and what with: country and local time, device and the last page, which is
 * the current one while the visitor is online.
 */
function PlaceTiles({ visitor, online }: { visitor: Place; online: boolean }) {
  const page = webLink(visitor.lastPage);
  const { country, timeZone } = visitor;
  const zone = timeZone !== null && localTime(timeZone) !== null ? timeZone : null;
  return (
    <div className="place-tiles">
      {(country !== null || zone !== null) && (
        <Tile
          icon="globe"
          label={
            country === null
              ? t("localTimeLabel")
              : zone === null
                ? t("countryLabel")
                : countryName(country)
          }
        >
          {country !== null && <span aria-hidden="true">{flag(country)} </span>}
          {zone === null ? countryName(country ?? "") : <LocalTime timeZone={zone} />}
        </Tile>
      )}
      {visitor.device !== null && (
        <Tile icon="monitor" label={t("deviceLabel")}>
          <span title={visitor.device}>{visitor.device}</span>
        </Tile>
      )}
      {page !== null && (
        <Tile icon="link" label={t(online ? "currentPageLabel" : "lastPageLabel")}>
          <a href={page} target="_blank" rel="noopener noreferrer" title={page}>
            {bare(page)}
          </a>
        </Tile>
      )}
    </div>
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
          <dd title={value}>
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
  /** The site's ID for a signed-in visitor, with a copy button. */
  userId: string | null;
  attributes: Record<string, unknown> | null;
  pageContext: Record<string, unknown> | null;
}

const hasDetails = ({ userId, attributes, pageContext }: Details) =>
  userId !== null || detailRows(attributes).length > 0 || detailRows(pageContext).length > 0;

/** The signed attributes, then what the page sent with setContext(), which says it is unverified. */
function DetailsFold({ userId, attributes, pageContext }: Details) {
  return (
    <>
      {userId !== null && (
        <dl className="context">
          <dt>{t("userIdTitle")}</dt>
          <dd>
            <CopyId value={userId} label="userIdLabel" />
          </dd>
        </dl>
      )}
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
  place,
  pages,
  conversationId,
  onOpenConversation,
  onNote,
}: {
  /** Null until it loads: the sections from it wait. */
  contact: ContactDetail | null;
  /** The newest facts, from the conversation when there is one. */
  visitor: Place & Details;
  /** Whether the place shows as a fold. The conversation's panel shows it in its head instead. */
  place: boolean;
  pages: PageView[];
  /** The conversation on screen, left out of the list. Null on the contact page. */
  conversationId: string | null;
  onOpenConversation(id: string, status: "open" | "closed"): void;
  onNote(note: string | null): Promise<unknown>;
}) {
  const others = contact?.conversations.filter((one) => one.id !== conversationId) ?? [];
  return (
    <>
      {place && hasPlace(visitor) && (
        <Section id="visitor" title="panelVisitor">
          <PlaceTiles visitor={visitor} online={false} />
        </Section>
      )}
      {hasDetails(visitor) && (
        <Section id="details" title="panelDetails">
          <DetailsFold {...visitor} />
        </Section>
      )}
      {pages.length > 0 && (
        <Section id="journey" title="pagesVisited" count={pages.length}>
          <PageJourney pages={pages} />
        </Section>
      )}
      {others.length > 0 && (
        <Section
          id="conversations"
          title={conversationId === null ? "panelAllConversations" : "panelOtherConversations"}
          count={others.length}
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

/** The right side of a conversation: who the visitor is, and everything the team knows. */
export function VisitorPanel({
  conversation,
  contact,
  online,
  pages,
  members,
  overlay,
  motion,
  onMoved,
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
  /** Slides in or out after a toggle. Null when it is still. */
  motion: PanelMotion;
  /** The slide ended. */
  onMoved(): void;
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
    <aside
      className={["visitor-panel", overlay && "overlay", motion].filter(Boolean).join(" ")}
      aria-label={name}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onMoved();
      }}
    >
      <header className="panel-head">
        <div className="panel-who">
          <span className="avatar-wrap">
            <Avatar name={name} letters={avatarLetters(visitor)} pictureUrl={visitor.pictureUrl} />
            {online === true && <i className="presence-dot" />}
          </span>
          <div className="panel-name">
            <h3>{name}</h3>
            {visitor.email !== null && visitor.email !== name && <p>{visitor.email}</p>}
            {presence !== null && (
              <p className={online === true ? "online" : undefined}>{presence}</p>
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("viewContact")}
            title={t("viewContact")}
            onClick={onOpenContact}
          >
            <Icon name="contacts" size={18} />
          </button>
          {overlay && (
            <button
              type="button"
              className="icon-button"
              aria-label={t("hidePanel")}
              title={t("hidePanel")}
              onClick={onClose}
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        {hasPlace(visitor) && <PlaceTiles visitor={visitor} online={online === true} />}
      </header>
      <div className="panel-bar">
        <Select
          label={t("assignTo")}
          className="assignee"
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
        <span
          className={conversation.status === "open" ? "chip warn" : "chip"}
          title={t("statusLabel")}
        >
          {t(conversation.status)}
        </span>
      </div>
      <ContactFolds
        contact={contact}
        visitor={{
          ...visitor,
          userId: visitor.externalId,
          pageContext: conversation.pageContext,
        }}
        place={false}
        pages={pages}
        conversationId={conversation.id}
        onOpenConversation={onOpenConversation}
        onNote={onNote}
      />
    </aside>
  );
}

const PANEL_KEY = "dinghy.panel.open";
const WIDE = "(min-width: 1200px)";
const STILL = "(prefers-reduced-motion: reduce)";

type PanelMotion = "entering" | "leaving" | null;

/**
 * Whether the visitor's panel shows. On a wide screen it remembers this device's choice, and starts
 * open. On a narrower one it opens as a drawer over the thread, and starts closed each time. A
 * toggle slides it in or out, and `shown` keeps it on screen until it has slid out.
 */
export function usePanel() {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  const [open, setOpen] = useState(() => wide && readStored(PANEL_KEY) !== "closed");
  useEffect(() => {
    const query = matchMedia(WIDE);
    const changed = () => {
      setWide(query.matches);
      setOpen(query.matches && readStored(PANEL_KEY) !== "closed");
    };
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const [motion, setMotion] = useState<PanelMotion>(null);
  const toggle = () => {
    if (wide) store(PANEL_KEY, open ? "closed" : null);
    setMotion(matchMedia(STILL).matches ? null : open ? "leaving" : "entering");
    setOpen(!open);
  };
  const moved = () => setMotion(null);
  return { open, shown: open || motion === "leaving", motion, wide, toggle, moved };
}
