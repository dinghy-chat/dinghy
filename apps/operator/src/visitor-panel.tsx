/** @jsxImportSource react */
// What the team knows about a visitor, in folds: the right panel of a conversation and the contact
// page show the same sections.
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Contact, ContactDetail, Conversation, Member, PageView } from "./api.ts";
import { MINUTE_MS, shortTime } from "./format.ts";
import { HandlerSelect } from "./handler.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { countryName, flag, localTime } from "./place.ts";
import { readStored, store } from "./stored.ts";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Avatar, CopyIcon, CopyId, DocLink, ErrorNote, failureText } from "./ui.tsx";
import {
  ago,
  avatarLetters,
  bare,
  conversationPreview,
  detailRows,
  pageName,
  pagePath,
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

/** The time now, kept current to the minute. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The time where the visitor is, kept current. */
function LocalTime({ timeZone }: { timeZone: string }) {
  return <>{localTime(timeZone, useNow())}</>;
}

type Place = Pick<Contact, "country" | "timeZone" | "device" | "lastPage">;

const hasPlace = (visitor: Place) =>
  visitor.country !== null ||
  (visitor.timeZone !== null && localTime(visitor.timeZone) !== null) ||
  visitor.device !== null ||
  webLink(visitor.lastPage) !== null;

/**
 * The visitor's name as the panel's title. An email in its place shrinks until it fits on one line,
 * down to 13px. A longer one wraps after its @, at 15px. It is never cut.
 */
function PanelName({ name }: { name: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const at = name.indexOf("@");
  useLayoutEffect(() => {
    const heading = ref.current;
    if (heading === null || at < 0) return;
    const fit = () => {
      heading.style.fontSize = "";
      heading.classList.add("one-line");
      let size = 18;
      while (heading.scrollWidth > heading.clientWidth && size > 13) {
        size -= 0.5;
        heading.style.fontSize = `${size}px`;
      }
      if (heading.scrollWidth <= heading.clientWidth) return;
      heading.classList.remove("one-line");
      heading.style.fontSize = "15px";
    };
    fit();
    let live = true;
    void document.fonts.ready.then(() => live && fit());
    return () => {
      live = false;
    };
  }, [at]);
  if (at < 0) return <h3>{name}</h3>;
  // Two blocks rather than a <wbr>, which Chrome breaks at even on a line that may not wrap.
  return (
    <h3 ref={ref} className="panel-email">
      <span className="email-part">{name.slice(0, at + 1)}</span>
      <span className="email-part">{name.slice(at + 1)}</span>
    </h3>
  );
}

/** One fact about the visitor, as a tile: an icon, a label, the value and a line under it. */
export function Tile({
  icon,
  label,
  sub,
  children,
}: {
  icon?: IconName;
  label: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="tile">
      {icon !== undefined && <Icon name={icon} size={16} />}
      <dl>
        <dt>{label}</dt>
        <dd>{children}</dd>
        {sub !== undefined && <dd className="tile-sub">{sub}</dd>}
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
            {pagePath(page)}
          </a>
        </Tile>
      )}
    </div>
  );
}

/**
 * Named values about the visitor, each cut to its line with the whole value on hover. With
 * `signed`, a web address opens in a new tab: anyone can put an address in what a page sends, so
 * unsigned values stay text, in italics. A link or an ID has a copy button.
 */
function DetailRows({
  values,
  signed,
}: {
  values: Record<string, unknown> | null;
  signed: boolean;
}) {
  return detailRows(values).map(([name, value, link]) => (
    <Fragment key={`${name}=${value}`}>
      <dt>{name}</dt>
      <dd title={value} className={signed ? undefined : "unsigned"}>
        {link === null || !signed ? (
          <span className="detail-value">{value}</span>
        ) : (
          <a className="detail-value" href={link} target="_blank" rel="noopener noreferrer">
            {bare(link)}
          </a>
        )}
        {(link !== null || ID_NAME.test(name)) && (
          <CopyIcon value={value} label={t("copyValue", { name })} />
        )}
      </dd>
    </Fragment>
  ));
}

/** A name such as "id", "orgId" or "account_id", whose value someone may paste elsewhere. */
const ID_NAME = /(^|_)(id|ID)$|[a-z0-9](Id|ID)$/;

/** Signed attributes, and the page's unsigned context. */
interface Details {
  /** The site's ID for a signed-in visitor, with a copy button. */
  userId: string | null;
  attributes: Record<string, unknown> | null;
  pageContext: Record<string, unknown> | null;
}

export const hasDetails = ({ userId, attributes, pageContext }: Details) =>
  userId !== null || detailRows(attributes).length > 0 || detailRows(pageContext).length > 0;

/**
 * The user ID and the signed attributes, then what the page sent with setContext() in italics,
 * with a note that nobody verified it.
 */
export function ContactDetails({ userId, attributes, pageContext }: Details) {
  const unsigned = detailRows(pageContext).length > 0;
  return (
    <>
      <dl className="context">
        {userId !== null && (
          <>
            <dt>{t("userIdTitle")}</dt>
            <dd>
              <CopyId value={userId} label="userIdLabel" />
            </dd>
          </>
        )}
        <DetailRows values={attributes} signed />
        <DetailRows values={pageContext} signed={false} />
      </dl>
      {unsigned && (
        <div className="page-context">
          <p className="quiet">
            {t("pageContextItalics")} {t("pageContextNote")}
          </p>
          <DocLink
            path="add-to-your-site#tell-operators-about-the-page"
            text="pageContextDocsLink"
          />
        </div>
      )}
    </>
  );
}

/** A pause longer than this between two pages starts a new visit. */
const VISIT_GAP_MS = 30 * MINUTE_MS;

/**
 * The pages the visitor went through, newest first: the title, or the address when the page has
 * none, as a link, and when. A long pause starts an earlier visit, and the newest page is where an
 * online visitor is now. Five at first, and the rest of the 20 on request.
 */
export function PageJourney({ pages, online }: { pages: PageView[]; online: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? pages : pages.slice(0, PAGES_FIRST);
  return (
    <div className="journey">
      <ol>
        {shown.map((page, index) => {
          const link = webLink(page.path);
          const name = pageName(page.title, page.path);
          const newer = shown[index - 1];
          const isNow = online && index === 0;
          const startsVisit =
            newer !== undefined &&
            Date.parse(newer.viewedAt) - Date.parse(page.viewedAt) > VISIT_GAP_MS;
          return (
            <Fragment key={`${page.path} ${page.viewedAt}`}>
              {startsVisit && (
                <li className="visit-gap">
                  {t("earlierVisit", { date: shortTime(page.viewedAt) })}
                </li>
              )}
              <li className={isNow ? "now" : undefined}>
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
                {isNow ? (
                  <span className="here-now">{t("hereNow")}</span>
                ) : (
                  <time dateTime={page.viewedAt} title={new Date(page.viewedAt).toLocaleString()}>
                    {ago(page.viewedAt, Date.now(), "narrow")}
                  </time>
                )}
              </li>
            </Fragment>
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
            <span className="link-preview">{conversationPreview(one)}</span>
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
export function NoteField({
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

/** What the team knows about the visitor, each section hidden when it has nothing to show. */
function ContactFolds({
  contact,
  visitor,
  online,
  pages,
  conversationId,
  onOpenConversation,
  onNote,
}: {
  /** Null until it loads: the sections from it wait. */
  contact: ContactDetail | null;
  /** The newest facts, from the conversation. */
  visitor: Details;
  online: boolean;
  pages: PageView[];
  /** The conversation on screen, left out of the list. */
  conversationId: string;
  onOpenConversation(id: string, status: "open" | "closed"): void;
  onNote(note: string | null): Promise<unknown>;
}) {
  const others = contact?.conversations.filter((one) => one.id !== conversationId) ?? [];
  return (
    <>
      {hasDetails(visitor) && (
        <Section id="details" title="panelDetails">
          <ContactDetails {...visitor} />
        </Section>
      )}
      {pages.length > 0 && (
        <Section id="journey" title="pagesVisited" count={pages.length}>
          <PageJourney pages={pages} online={online} />
        </Section>
      )}
      {others.length > 0 && (
        <Section id="conversations" title="panelOtherConversations" count={others.length}>
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
  meId,
  onAssign,
  onGiveBack,
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
  meId: string;
  onAssign(operatorId: string | null): void;
  onGiveBack(): void;
  onOpenContact(): void;
  onOpenConversation(id: string, status: "open" | "closed"): void;
  onNote(note: string | null): Promise<unknown>;
  onClose(): void;
}) {
  const { visitor } = conversation;
  const name = visitorName(visitor);
  const presence = presenceLine(visitor.lastSeenAt, online);
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
            <PanelName key={name} name={name} />
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
        <HandlerSelect
          conversation={conversation}
          members={members}
          meId={meId}
          onAssign={onAssign}
          onGiveBack={onGiveBack}
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
          userId: visitor.externalId,
          attributes: visitor.attributes,
          pageContext: conversation.pageContext,
        }}
        online={online === true}
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
