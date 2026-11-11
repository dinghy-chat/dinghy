/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { LiveVisitor, WorkspaceApi } from "./api.ts";
import { COUNTRY_POINTS } from "./countries.ts";
import { useTabVisible } from "./live.ts";
import { useLatestLoad } from "./load.ts";
import { countryName, flag, localTime } from "./place.ts";
import { EmptyArt } from "./scene.tsx";
import { t } from "./text.ts";
import { Loading, Page } from "./ui.tsx";
import { bare, visitorName, webLink } from "./visitor.ts";

/** The live list loads again this often while the page shows. */
const REFRESH_MS = 15_000;
const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
/** The smallest and largest dot on the map, in pixels, by how many people are in the country. */
const DOT_MIN_PX = 10;
const DOT_MAX_PX = 36;
const DB_IP_URL = "https://db-ip.com";

/** "12 min on site", from when the tab's first beat came. */
function onSite(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / MINUTE_MS));
  if (minutes < HOUR_MINUTES) return t("onSiteMinutes", { count: minutes });
  return t("onSiteHours", {
    hours: Math.floor(minutes / HOUR_MINUTES),
    minutes: minutes % HOUR_MINUTES,
  });
}

/** People by country, most first. */
function byCountry(visitors: LiveVisitor[]): [country: string, count: number][] {
  const counts = new Map<string, number>();
  for (const one of visitors) {
    if (one.country !== null) counts.set(one.country, (counts.get(one.country) ?? 0) + 1);
  }
  return [...counts].sort((one, other) => other[1] - one[1]);
}

/** The world in dots, with one brand-colored dot per country, sized by how many are there. */
function WorldMap({ visitors }: { visitors: LiveVisitor[] }) {
  const countries = byCountry(visitors);
  const most = countries[0]?.[1] ?? 1;
  return (
    <figure className="world-map" aria-label={t("visitorsMap")}>
      <div className="world-land" aria-hidden="true" />
      {countries.map(([country, count]) => {
        const point = COUNTRY_POINTS[country];
        if (point === undefined) return null;
        const size = DOT_MIN_PX + ((DOT_MAX_PX - DOT_MIN_PX) * Math.sqrt(count)) / Math.sqrt(most);
        const label = t("visitorsInCountry", { country: countryName(country), count });
        return (
          <span
            key={country}
            className="map-dot"
            role="img"
            aria-label={label}
            title={label}
            style={{ left: `${point[0]}%`, top: `${point[1]}%`, width: size, height: size }}
          />
        );
      })}
    </figure>
  );
}

function VisitorRow({
  visitor,
  now,
  onOpenConversation,
}: {
  visitor: LiveVisitor;
  now: number;
  onOpenConversation(id: string): void;
}) {
  const page = webLink(visitor.page);
  const time = visitor.timeZone === null ? null : localTime(visitor.timeZone, new Date(now));
  const person = visitor.visitor;
  return (
    <li className="live-row">
      <span className="live-flag" aria-hidden="true">
        {visitor.country === null ? "🌐" : flag(visitor.country)}
      </span>
      <div className="live-text">
        <div className="live-top">
          <b>
            {person !== null
              ? visitorName(person)
              : visitor.country === null
                ? t("unknownCountry")
                : countryName(visitor.country)}
          </b>
          {person?.conversationId != null && (
            <button
              type="button"
              className="chip live-chat"
              onClick={() => onOpenConversation(person.conversationId ?? "")}
            >
              {t("chatting")}
            </button>
          )}
        </div>
        {page !== null && (
          <a
            className="live-page"
            href={page}
            target="_blank"
            rel="noopener noreferrer"
            title={page}
          >
            {visitor.title ?? bare(page)}
          </a>
        )}
        <small>
          {[
            time,
            onSite(visitor.startedAt, now),
            visitor.device,
            visitor.referrer === null ? null : t("cameFrom", { site: bare(visitor.referrer) }),
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </small>
      </div>
    </li>
  );
}

/** Who is on the site now: a map, and each open tab with where it is and for how long. */
export function VisitorsPage({
  api,
  onOpenConversation,
}: {
  api: WorkspaceApi;
  onOpenConversation(id: string): void;
}) {
  const [visitors, setVisitors] = useState<LiveVisitor[] | null | undefined>(undefined);
  const [now, setNow] = useState(Date.now);
  const visible = useTabVisible();
  const load = useLatestLoad(async () => {
    setVisitors((await api.liveVisitors()).visitors);
    setNow(Date.now());
  });
  useEffect(() => {
    if (!visible) return;
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, visible]);

  const count = visitors?.length ?? 0;
  return (
    <Page
      title={t("visitors")}
      context={
        visitors === undefined || visitors === null
          ? undefined
          : count === 1
            ? t("visitorsOne")
            : t("visitorsMany", { count })
      }
    >
      {visitors === undefined ? (
        <Loading />
      ) : visitors === null ? (
        <p className="hint">{t("visitorsUnknown")}</p>
      ) : (
        <>
          <WorldMap visitors={visitors} />
          {count === 0 ? (
            <div className="nothing">
              <EmptyArt scene="day" />
              <b>{t("visitorsNone")}</b>
              {t("visitorsNoneHint")}
            </div>
          ) : (
            <ul className="live-list" aria-label={t("visitorsList")}>
              {visitors.map((one) => (
                <VisitorRow
                  key={one.tab}
                  visitor={one}
                  now={now}
                  onOpenConversation={onOpenConversation}
                />
              ))}
            </ul>
          )}
        </>
      )}
      <p className="map-credit">
        <a className="credit-link" href={DB_IP_URL} target="_blank" rel="noopener noreferrer">
          {t("geoCredit")}
        </a>
      </p>
    </Page>
  );
}
