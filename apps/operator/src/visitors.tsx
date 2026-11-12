/** @jsxImportSource react */
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { LiveVisitor, WorkspaceApi } from "./api.ts";
import { COUNTRY_POINTS } from "./countries.ts";
import { MINUTE_MS } from "./format.ts";
import { Icon } from "./icons.tsx";
import { useTabVisible } from "./live.ts";
import { useLatestLoad } from "./load.ts";
import { countryName, flag, localTime } from "./place.ts";
import { EmptyArt } from "./scene.tsx";
import { type TextId, t } from "./text.ts";
import { Choices, initials, Loading, type Option, Page } from "./ui.tsx";
import { bare, visitorName, webLink } from "./visitor.ts";

/** The live list loads again this often while the page shows. */
const REFRESH_MS = 15_000;
const HOUR_MINUTES = 60;
const DB_IP_URL = "https://db-ip.com";
/** How many rows each tile shows. */
const TILE_ROWS = 4;
/** The shortest bar, in percent, so a count of one still shows a bar. */
const BAR_MIN_PERCENT = 8;
const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const ZOOM_STEP = 1.5;
const WHEEL_STEP = 1.2;
const COUNTRY_ZOOM = 2.6;
/** Half the card's widest, as `.live-card` sets it, so the card stays inside the map. */
const CARD_HALF_PX = 140;
/** The sea above the land, as a share of the map's height: `.live-world` starts 4% down. */
const WORLD_TOP = 0.04;

type Show = "all" | "chatting" | "known";

/** The live list: not loaded yet, unknown as Valkey cannot answer, or loaded. */
type VisitorList =
  | { state: "loading" }
  | { state: "unknown" }
  | { state: "ready"; visitors: LiveVisitor[] };

/** Zoom, and the land's offset as a share of the map's size, so a resize keeps the same view. */
type View = { scale: number; x: number; y: number };
const WHOLE_WORLD: View = { scale: ZOOM_MIN, x: 0, y: 0 };

/** A country under the pointer or focus, from a dot (which opens its card) or from a row. */
type Lit = { country: string; from: "map" | "list" } | null;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Keeps the land filling the map, so it never slides out of its box. */
function clampView(view: View): View {
  const min = 1 - view.scale;
  return { scale: view.scale, x: clamp(view.x, min, 0), y: clamp(view.y, min, 0) };
}

/** Zooms by a factor, keeping the point at (atX, atY), as shares of the map, in place. */
function zoomAround(view: View, factor: number, atX = 0.5, atY = 0.5): View {
  const scale = clamp(view.scale * factor, ZOOM_MIN, ZOOM_MAX);
  const ratio = scale / view.scale;
  return clampView({ scale, x: atX - (atX - view.x) * ratio, y: atY - (atY - view.y) * ratio });
}

/** Where a country's point sits on the unzoomed map, as shares of its width and height. */
function onMap([x, y]: [number, number]): [x: number, y: number] {
  return [x / 100, WORLD_TOP + (y / 100) * (1 - WORLD_TOP)];
}

function centerOn(point: [number, number]): View {
  const [x, y] = onMap(point);
  return clampView({ scale: COUNTRY_ZOOM, x: 0.5 - x * COUNTRY_ZOOM, y: 0.5 - y * COUNTRY_ZOOM });
}

/** "12 min on site", from when the tab's first beat came. */
function onSite(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / MINUTE_MS));
  if (minutes < HOUR_MINUTES) return t("onSiteMinutes", { count: minutes });
  return t("onSiteHours", {
    hours: Math.floor(minutes / HOUR_MINUTES),
    minutes: minutes % HOUR_MINUTES,
  });
}

const isChatting = (one: LiveVisitor) => one.visitor?.conversationId != null;

function shows(one: LiveVisitor, show: Show): boolean {
  if (show === "chatting") return isChatting(one);
  return show === "all" || one.visitor !== null;
}

/** "France: 2 people", for a dot and its card. */
function countryLine(country: string, count: number): string {
  const name = countryName(country);
  return count === 1
    ? t("visitorsInCountryOne", { country: name })
    : t("visitorsInCountry", { country: name, count });
}

function pageTitle(one: LiveVisitor): string {
  return one.title ?? bare(one.page);
}

/** People by country, for the map's dots. */
function byCountry(visitors: LiveVisitor[]): Map<string, LiveVisitor[]> {
  const groups = new Map<string, LiveVisitor[]>();
  for (const one of visitors) {
    if (one.country !== null) groups.set(one.country, [...(groups.get(one.country) ?? []), one]);
  }
  return groups;
}

/** Counts by a key, most first, as the rows of a tile. */
interface Tally {
  key: string;
  label: string;
  count: number;
}

/** The most common values of `key`, each shown as its first `label`. */
function tally(
  visitors: LiveVisitor[],
  key: (one: LiveVisitor) => string,
  label: (one: LiveVisitor) => string = key,
): Tally[] {
  const counts = new Map<string, Tally>();
  for (const one of visitors) {
    const found = counts.get(key(one));
    if (found === undefined) counts.set(key(one), { key: key(one), label: label(one), count: 1 });
    else found.count += 1;
  }
  return [...counts.values()].sort((one, other) => other.count - one.count).slice(0, TILE_ROWS);
}

/** Drag to pan, and wheel to zoom around the pointer. */
function usePanZoom(mapRef: RefObject<HTMLElement | null>) {
  const [view, setView] = useState(WHOLE_WORLD);
  const [isDragging, setDragging] = useState(false);
  const drag = useRef<{ pointerX: number; pointerY: number; start: View } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const map = mapRef.current;
    if (map === null) return;
    const onWheel = (event: WheelEvent) => {
      const zoomIn = event.deltaY < 0;
      // At the whole world, scrolling down moves the page instead of trapping it.
      if (!zoomIn && viewRef.current.scale === ZOOM_MIN) return;
      event.preventDefault();
      const box = map.getBoundingClientRect();
      const atX = (event.clientX - box.left) / box.width;
      const atY = (event.clientY - box.top) / box.height;
      setView((current) => zoomAround(current, zoomIn ? WHEEL_STEP : 1 / WHEEL_STEP, atX, atY));
    };
    map.addEventListener("wheel", onWheel, { passive: false });
    return () => map.removeEventListener("wheel", onWheel);
  }, [mapRef]);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    drag.current = { pointerX: event.clientX, pointerY: event.clientY, start: view };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const from = drag.current;
    if (from === null) return;
    const box = event.currentTarget.getBoundingClientRect();
    setView(
      clampView({
        scale: from.start.scale,
        x: from.start.x + (event.clientX - from.pointerX) / box.width,
        y: from.start.y + (event.clientY - from.pointerY) / box.height,
      }),
    );
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };
  return {
    view,
    setView,
    isDragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}

/** The card over a dot: who is in that country, and on which page. */
function MapCard({
  country,
  people,
  view,
}: {
  country: string;
  people: LiveVisitor[];
  view: View;
}) {
  const point = COUNTRY_POINTS[country];
  if (point === undefined) return null;
  const [x, y] = onMap(point);
  const top = view.y + y * view.scale;
  return (
    <div
      // In the upper half the card opens below the dot, so the map's edge does not cut it.
      className={top < 0.5 ? "live-card below" : "live-card"}
      aria-hidden="true"
      style={{
        left: `clamp(${CARD_HALF_PX}px, ${(view.x + x * view.scale) * 100}%, calc(100% - ${CARD_HALF_PX}px))`,
        top: `${top * 100}%`,
      }}
    >
      <b>
        {flag(country)} {countryLine(country, people.length)}
      </b>
      <ul>
        {people.map((one) => (
          <li key={one.tab} className="live-card-row">
            <span>{one.visitor === null ? t("visitorAnonymous") : visitorName(one.visitor)}</span>
            <em>{pageTitle(one)}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The world in dots: one per country, with its count when more than one person is there. */
function WorldMap({
  visitors,
  country,
  lit,
  onLight,
  onCountry,
}: {
  visitors: LiveVisitor[];
  country: string | null;
  lit: Lit;
  onLight(lit: Lit): void;
  onCountry(country: string | null): void;
}) {
  const mapRef = useRef<HTMLElement>(null);
  const { view, setView, isDragging, handlers } = usePanZoom(mapRef);
  const groups = byCountry(visitors);
  const choose = (next: string | null) => {
    const point = next === null ? undefined : COUNTRY_POINTS[next];
    setView(point === undefined ? WHOLE_WORLD : centerOn(point));
    onCountry(next);
  };
  const cardCountry = lit?.from === "map" ? lit.country : null;
  const cardPeople = cardCountry === null ? undefined : groups.get(cardCountry);
  return (
    <figure
      ref={mapRef}
      className={["live-map", isDragging && "dragging", view.scale > ZOOM_MIN && "zoomed"]
        .filter(Boolean)
        .join(" ")}
      aria-label={t("visitorsMap")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && country !== null) choose(null);
      }}
      {...handlers}
    >
      <div
        className="live-zoom"
        style={{ transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.scale})` }}
      >
        <div className="live-world">
          <div className="live-land" aria-hidden="true" />
          {[...groups].map(([place, people]) => {
            const point = COUNTRY_POINTS[place];
            if (point === undefined) return null;
            const className = [
              "live-dot",
              people.length > 1 && "group",
              lit?.country === place && "lit",
              country !== null && country !== place && "dim",
            ];
            return (
              <button
                key={place}
                type="button"
                className={className.filter(Boolean).join(" ")}
                // The inverse of the zoom keeps each dot the same size on screen.
                style={{
                  left: `${point[0]}%`,
                  top: `${point[1]}%`,
                  transform: `translate(-50%, -50%) scale(${1 / view.scale})`,
                }}
                aria-label={countryLine(place, people.length)}
                aria-pressed={country === place}
                onClick={() => choose(place)}
                onPointerEnter={() => onLight({ country: place, from: "map" })}
                onPointerLeave={() => onLight(null)}
                onFocus={() => onLight({ country: place, from: "map" })}
                onBlur={() => onLight(null)}
              >
                {people.length > 1 && people.length}
              </button>
            );
          })}
        </div>
      </div>
      {cardCountry !== null && cardPeople !== undefined && (
        <MapCard country={cardCountry} people={cardPeople} view={view} />
      )}
      {country !== null && (
        <button type="button" className="live-reset" onClick={() => choose(null)}>
          {t("visitorsAllCountries")}
          <Icon name="close" size={14} />
        </button>
      )}
      <div className="live-tools">
        <button
          type="button"
          className="live-tool"
          aria-label={t("zoomIn")}
          onClick={() => setView((current) => zoomAround(current, ZOOM_STEP))}
        >
          <Icon name="plusBold" size={16} />
        </button>
        <button
          type="button"
          className="live-tool"
          aria-label={t("zoomOut")}
          onClick={() => setView((current) => zoomAround(current, 1 / ZOOM_STEP))}
        >
          <Icon name="minusBold" size={16} />
        </button>
      </div>
      <figcaption className="live-hint">{t("visitorsMapHint")}</figcaption>
    </figure>
  );
}

/** Initials on a tile with a flag badge for a known person, or the flag alone for anyone else. */
function Face({ one }: { one: LiveVisitor }) {
  const badge = one.country === null ? null : flag(one.country);
  if (one.visitor !== null) {
    return (
      <span className="live-face known" aria-hidden="true">
        {initials(visitorName(one.visitor))}
        {badge !== null && <span className="live-badge">{badge}</span>}
      </span>
    );
  }
  return (
    <span className="live-face" aria-hidden="true">
      {badge ?? <Icon name="globe" size={20} />}
    </span>
  );
}

function personName(one: LiveVisitor): string {
  if (one.visitor !== null) return visitorName(one.visitor);
  if (one.country === null) return t("visitorAnonymous");
  return t("visitorFrom", { country: countryName(one.country) });
}

function PersonRow({
  one,
  now,
  isLit,
  onLight,
  onOpenConversation,
  onOpenContact,
}: {
  one: LiveVisitor;
  now: number;
  isLit: boolean;
  onLight(lit: Lit): void;
  onOpenConversation(id: string): void;
  onOpenContact(visitorId: string): void;
}) {
  const page = webLink(one.page);
  const time = one.timeZone === null ? null : localTime(one.timeZone, new Date(now));
  const person = one.visitor;
  const conversationId = person?.conversationId ?? null;
  const country = one.country;
  return (
    <li
      className={isLit ? "live-row lit" : "live-row"}
      onPointerEnter={() => onLight(country === null ? null : { country, from: "list" })}
      onPointerLeave={() => onLight(null)}
    >
      <Face one={one} />
      <div className="live-text">
        <div className="live-who">
          <b>{personName(one)}</b>
          {conversationId !== null && <span className="chip live-chatting">{t("chatting")}</span>}
        </div>
        {page !== null && (
          <div className="live-page">
            <a href={page} target="_blank" rel="noopener noreferrer" title={page}>
              {pageTitle(one)}
            </a>
            <span>{new URL(page).pathname}</span>
          </div>
        )}
        <div className="live-meta">
          {time !== null && (
            <span>
              <Icon name="clock" size={13} />
              {time}
            </span>
          )}
          <span>{onSite(one.startedAt, now)}</span>
          {one.device !== null && (
            <span>
              <Icon name="monitor" size={13} />
              {one.device}
            </span>
          )}
          {one.referrer !== null && (
            <span>
              <Icon name="arrowRight" size={13} />
              {t("cameFrom", { site: bare(one.referrer) })}
            </span>
          )}
        </div>
        {person !== null && (
          <div className="live-actions">
            {conversationId !== null && (
              <button
                type="button"
                className="pill small dark"
                onClick={() => onOpenConversation(conversationId)}
              >
                {t("openChat")}
              </button>
            )}
            <button type="button" className="pill small" onClick={() => onOpenContact(person.id)}>
              {t("viewContact")}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

/** A tile of counts drawn as bars, such as the pages people are on. */
function Bars({ title, rows }: { title: string; rows: Tally[] }) {
  const most = rows[0]?.count ?? 1;
  return (
    <section className="live-tile" aria-label={title}>
      <h3>{title}</h3>
      <ol className="live-bars">
        {rows.map(({ key, label, count }) => (
          <li key={key} className="live-bars-row">
            <span
              className="live-bar"
              style={{ width: `${Math.max(BAR_MIN_PERCENT, (count / most) * 100)}%` }}
            />
            <span>{label}</span>
            <span>{count}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const LIST_TITLES = {
  all: { anywhere: "visitorsEveryone", inPlace: "visitorsInPlace" },
  chatting: { anywhere: "visitorsChattingTitle", inPlace: "visitorsChattingInPlace" },
  known: { anywhere: "visitorsKnownTitle", inPlace: "visitorsKnownInPlace" },
} as const satisfies Record<Show, { anywhere: TextId; inPlace: TextId }>;

function listTitle(show: Show, country: string | null): string {
  const titles = LIST_TITLES[show];
  return country === null
    ? t(titles.anywhere)
    : t(titles.inPlace, { country: countryName(country) });
}

/** Who is on the site now: a map, each open tab, and which pages and sites they came through. */
function LiveVisitors({
  visitors,
  now,
  show,
  onOpenConversation,
  onOpenContact,
}: {
  visitors: LiveVisitor[];
  now: number;
  show: Show;
  onOpenConversation(id: string): void;
  onOpenContact(visitorId: string): void;
}) {
  const [country, setCountry] = useState<string | null>(null);
  const [lit, setLit] = useState<Lit>(null);
  const shown = visitors.filter((one) => shows(one, show));
  const listed = country === null ? shown : shown.filter((one) => one.country === country);
  return (
    <div className="live-layout">
      <div className="live-side">
        <WorldMap
          visitors={shown}
          country={country}
          lit={lit}
          onLight={setLit}
          onCountry={setCountry}
        />
        {listed.length > 0 && (
          <div className="live-tiles">
            <Bars title={t("visitorsPages")} rows={tally(listed, (one) => one.page, pageTitle)} />
            <Bars
              title={t("visitorsSources")}
              rows={tally(listed, (one) =>
                one.referrer === null ? t("visitorsNoReferrer") : bare(one.referrer),
              )}
            />
          </div>
        )}
      </div>
      <section className="live-people" aria-labelledby="live-people-title">
        <h3 id="live-people-title">{listTitle(show, country)}</h3>
        {visitors.length === 0 ? (
          <div className="nothing">
            <EmptyArt scene="day" />
            <b>{t("visitorsNone")}</b>
            {t("visitorsNoneHint")}
          </div>
        ) : listed.length === 0 ? (
          <p className="hint">{t("visitorsNoneShown")}</p>
        ) : (
          <ul className="live-list">
            {listed.map((one) => (
              <PersonRow
                key={one.tab}
                one={one}
                now={now}
                isLit={lit?.from === "map" && lit.country === one.country}
                onLight={setLit}
                onOpenConversation={onOpenConversation}
                onOpenContact={onOpenContact}
              />
            ))}
          </ul>
        )}
        <p className="live-credit">
          <a href={DB_IP_URL} target="_blank" rel="noopener noreferrer">
            {t("geoCredit")}
          </a>
        </p>
      </section>
    </div>
  );
}

function showOptions(visitors: LiveVisitor[]): Option<Show>[] {
  return [
    { value: "all", label: "visitorsEveryone", count: visitors.length },
    { value: "chatting", label: "chatting", count: visitors.filter(isChatting).length },
    {
      value: "known",
      label: "visitorsKnown",
      count: visitors.filter((one) => one.visitor !== null).length,
    },
  ];
}

export function VisitorsPage({
  api,
  onOpenConversation,
  onOpenContact,
}: {
  api: WorkspaceApi;
  onOpenConversation(id: string): void;
  onOpenContact(visitorId: string): void;
}) {
  const [list, setList] = useState<VisitorList>({ state: "loading" });
  const [now, setNow] = useState(Date.now);
  const [show, setShow] = useState<Show>("all");
  const visible = useTabVisible();
  const load = useLatestLoad(async () => {
    const { visitors } = await api.liveVisitors();
    setList(visitors === null ? { state: "unknown" } : { state: "ready", visitors });
    setNow(Date.now());
  });
  useEffect(() => {
    if (!visible) return;
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, visible]);

  const count = list.state === "ready" ? list.visitors.length : 0;
  return (
    <Page
      title={t("visitors")}
      context={
        list.state === "ready" ? (
          <span className="live-count">
            <span className="live-pulse" aria-hidden="true" />
            {count === 1 ? t("visitorsOne") : t("visitorsMany", { count })}
          </span>
        ) : undefined
      }
      actions={
        list.state === "ready" ? (
          <Choices<Show>
            label={t("visitorsShow")}
            variant="outlined"
            value={show}
            options={showOptions(list.visitors)}
            onChange={setShow}
          />
        ) : undefined
      }
    >
      {list.state === "loading" ? (
        <Loading />
      ) : list.state === "unknown" ? (
        <p className="hint">{t("visitorsUnknown")}</p>
      ) : (
        <LiveVisitors
          visitors={list.visitors}
          now={now}
          show={show}
          onOpenConversation={onOpenConversation}
          onOpenContact={onOpenContact}
        />
      )}
    </Page>
  );
}
