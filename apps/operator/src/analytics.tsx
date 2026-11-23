/** @jsxImportSource react */
import { type ReactNode, useEffect, useState } from "react";
import type { Analytics, AnalyticsDays, VisitorStats, WorkspaceApi } from "./api.ts";
import { browserTimeZone, dayAndTime, duration, weekdayNames } from "./format.ts";
import { LabelDot } from "./labels.tsx";
import { Lookout } from "./lookout.tsx";
import { AnalyticsSkeleton, SiteSkeleton } from "./skeleton.tsx";
import {
  Change,
  CountChange,
  percent,
  Ring,
  rateOf,
  ShareChange,
  Sparkline,
  Stat,
  shareOf,
  Tipped,
} from "./stat.tsx";
import { plural, type TextId, t } from "./text.ts";
import { Avatar, Choices, DocLink, failureText, Loading, type Option, Page } from "./ui.tsx";
import { pageName, sourceName } from "./visitor.ts";

type Period = `${AnalyticsDays}`;

const PERIODS: readonly Option<Period>[] = [
  { value: "7", label: "period7" },
  { value: "30", label: "period30" },
  { value: "90", label: "period90" },
];

/** A date of the period, "2026-11-08", as "Nov 8". */
export function dayName(
  date: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString([], options);
}

/** A day of the period in full, "Sunday, Nov 8", as a chart's card names it. */
const FULL_DAY: Intl.DateTimeFormatOptions = { weekday: "long", month: "short", day: "numeric" };

const DAY_NAMES_SHORT = weekdayNames("short");
const DAY_NAMES = weekdayNames("long");
const hourName = (hour: number) =>
  new Date(2024, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" });
const HOURS = Array.from({ length: 24 }, (_, hour) => hourName(hour));

const conversations = (count: number) => plural(count, "chartOne", "chartMany");

function MedianChange({ numbers, compared }: { numbers: Analytics; compared: string }) {
  const now = numbers.firstReply.medianSeconds;
  const before = numbers.previous.firstReply.medianSeconds;
  if (now === null || before === null) return null;
  const words = duration(Math.abs(before - now));
  if (Math.round(now) === Math.round(before)) {
    return <Change words={t("changeSame")} direction="neutral" compared={compared} />;
  }
  return now < before ? (
    <Change words={t("replyFaster", { time: words })} direction="better" compared={compared} />
  ) : (
    <Change words={t("replySlower", { time: words })} direction="worse" compared={compared} />
  );
}

function Stats({ numbers, days }: { numbers: Analytics; days: Period }) {
  const { started, answered, firstReply, previous } = numbers;
  const compared = t("vsPrevious", { days });
  const fast = shareOf(firstReply.fast, started);
  const answeredShare = shareOf(answered, started);
  return (
    <section className="stats" aria-label={t("statsTitle")}>
      <Stat title="statStarted">
        <p className="stat-value">{started}</p>
        <CountChange count={started} before={previous.started} compared={compared} />
        {numbers.startedByTeam > 0 && (
          <p className="stat-note">{t("statStartedByTeam", { count: numbers.startedByTeam })}</p>
        )}
        <Sparkline
          values={numbers.perDay.map((day) => day.conversations)}
          tips={numbers.perDay.map((day) => ({
            value: conversations(day.conversations),
            label: dayName(day.date, FULL_DAY),
          }))}
        />
      </Stat>
      <Stat title="statMedian" help="statMedianHelp">
        {firstReply.medianSeconds === null ? (
          <p className="stat-value none">{t("noReplies")}</p>
        ) : (
          <p className="stat-value">{duration(firstReply.medianSeconds)}</p>
        )}
        <MedianChange numbers={numbers} compared={compared} />
        {firstReply.p90Seconds !== null && (
          <p className="stat-note">{t("statP90", { time: duration(firstReply.p90Seconds) })}</p>
        )}
      </Stat>
      <Stat title="statFast" help="statFastHelp">
        <div className="stat-ring">
          <Ring share={fast} />
          <p className="stat-value">{percent(fast)}</p>
        </div>
        <ShareChange
          share={rateOf(firstReply.fast, started)}
          before={rateOf(previous.firstReply.fast, previous.started)}
          compared={compared}
        />
      </Stat>
      <Stat title="statAnswered">
        <p className="stat-value">{percent(answeredShare)}</p>
        <p className="stat-note">{t("statAnsweredOf", { answered, started })}</p>
        <span className="stat-meter" aria-hidden="true">
          <span style={{ width: `${answeredShare * 100}%` }} />
        </span>
      </Stat>
    </section>
  );
}

export function Card({
  title,
  hint,
  children,
}: {
  title: TextId;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="chart-card">
      <div className="chart-head">
        <h3>{t(title)}</h3>
        {hint !== undefined && <span>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** One bar per day, on a scale whose top is an even number, so its middle is a whole one. */
function PerDay({ days }: { days: Analytics["perDay"] }) {
  const busiest = days.reduce((top, day) => (day.conversations > top.conversations ? day : top));
  const top = Math.max(2, Math.ceil(busiest.conversations / 2) * 2);
  const first = days[0];
  const last = days.at(-1);
  return (
    <Card
      title="perDayTitle"
      hint={t("perDayBusiest", {
        day: dayName(busiest.date),
        conversations: conversations(busiest.conversations),
      })}
    >
      <figure className="per-day">
        <figcaption className="visually-hidden">
          {t("perDaySummary", {
            day: dayName(busiest.date),
            conversations: conversations(busiest.conversations),
          })}
        </figcaption>
        <div className="day-bars" aria-hidden="true">
          <span className="day-scale" style={{ top: 0 }}>
            {top}
          </span>
          <span className="day-scale" style={{ top: "50%" }}>
            {top / 2}
          </span>
          <span className="day-scale" style={{ top: "100%" }}>
            0
          </span>
          {days.map((day) => (
            <span
              key={day.date}
              className="day-bar"
              data-value={conversations(day.conversations)}
              data-label={dayName(day.date, FULL_DAY)}
            >
              {day.conversations > 0 && (
                <i style={{ height: `${(day.conversations / top) * 100}%` }} />
              )}
            </span>
          ))}
        </div>
        <div className="day-axis" aria-hidden="true">
          <span>{first === undefined ? "" : dayName(first.date)}</span>
          <span>{last === undefined ? "" : dayName(last.date)}</span>
        </div>
      </figure>
    </Card>
  );
}

/** What became of the conversations that started: each step as a count and a share of them. */
function Outcomes({ numbers }: { numbers: Analytics }) {
  const { started, answered, closed } = numbers;
  const { fast } = numbers.firstReply;
  const steps: { label: TextId; count: number; note?: string }[] = [
    { label: "outcomeStarted", count: started },
    {
      label: "outcomeAnswered",
      count: answered,
      ...(answered < started && { note: t("outcomeWaiting", { count: started - answered }) }),
    },
    { label: "outcomeFast", count: fast },
    {
      label: "outcomeClosed",
      count: closed,
      ...(closed < started && { note: t("outcomeOpen", { count: started - closed }) }),
    },
  ];
  return (
    <Card title="outcomesTitle">
      <ol className="outcomes">
        {steps.map((step) => (
          <li key={step.label}>
            <span className="outcome-label">{t(step.label)}</span>
            <span className="share-count">
              {step.count}
              <span>{percent(shareOf(step.count, started))}</span>
            </span>
            <span className="share-track" aria-hidden="true">
              <span style={{ width: `${shareOf(step.count, started) * 100}%` }} />
            </span>
            {step.note !== undefined && <span className="outcome-note">{step.note}</span>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** The share of the busiest cell, in four steps, so the legend can show them. */
const HEAT_LEVELS = 4;

/** Weekdays by hours, darker for more conversations, with the busiest hour ringed. */
function Hours({ hours }: { hours: number[][] }) {
  const most = Math.max(1, ...hours.flat());
  let peak = { day: 0, hour: 0, count: 0 };
  hours.forEach((row, day) => {
    row.forEach((count, hour) => {
      if (count > peak.count) peak = { day, hour, count };
    });
  });
  return (
    <Card
      title="hoursTitle"
      hint={t("hoursBusiest", { day: DAY_NAMES[peak.day] ?? "", hour: hourName(peak.hour) })}
    >
      <figure className="hours">
        <figcaption className="visually-hidden">
          {t("hoursSummary", {
            day: DAY_NAMES[peak.day] ?? "",
            hour: hourName(peak.hour),
            conversations: conversations(peak.count),
          })}
        </figcaption>
        <div className="heat" aria-hidden="true">
          <span />
          {HOURS.map((name, hour) => (
            <span key={name} className="heat-hour">
              {hour % 6 === 0 ? name : ""}
            </span>
          ))}
          {hours.map((row, day) => [
            <span key={`d${DAY_NAMES_SHORT[day]}`} className="heat-day">
              {DAY_NAMES_SHORT[day]}
            </span>,
            ...row.map((count, hour) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the grid's cells never move.
                key={`${day}-${hour}`}
                className={`heat-cell level-${Math.ceil((count / most) * HEAT_LEVELS)}${
                  day === peak.day && hour === peak.hour ? " peak" : ""
                }`}
                data-value={conversations(count)}
                data-label={t("hoursCell", { day: DAY_NAMES[day] ?? "", hour: hourName(hour) })}
              />
            )),
          ])}
        </div>
        <div className="heat-legend" aria-hidden="true">
          {t("hoursFewer")}
          {Array.from({ length: HEAT_LEVELS }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the legend's steps never move.
            <i key={index} className={`heat-swatch level-${index + 1}`} />
          ))}
          {t("hoursMore")}
        </div>
      </figure>
    </Card>
  );
}

type Replier = Analytics["repliers"][number];

/** A key for the list, the name the avatar draws, and the words beside it. */
function replierLabel(one: Replier): { key: string; avatar: string; name: string } {
  switch (one.kind) {
    case "operator":
      return { key: `operator:${one.operatorId}`, avatar: one.name, name: one.name };
    case "api_key":
      return {
        key: `key:${one.apiKeyId}`,
        avatar: one.name,
        name: t("apiKeyAuthor", { name: one.name }),
      };
    case "former":
      return { key: "former", avatar: t("formerOperator"), name: t("formerOperator") };
  }
}

/** One row of a ShareList: what it counts, with an avatar or a dot before it if it has one. */
interface ShareRow {
  key: string;
  lead?: ReactNode;
  name: ReactNode;
  count: number;
}

/** A card of rows, each with its count, its share of `total` and a bar, or a note when empty. */
export function ShareList({
  title,
  empty,
  total,
  rows,
}: {
  title: TextId;
  empty: TextId;
  total: number;
  rows: ShareRow[];
}) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="note">{t(empty)}</p>
      ) : (
        <ol className={rows[0]?.lead === undefined ? "repliers no-lead" : "repliers"}>
          {rows.map((row) => {
            const share = shareOf(row.count, total);
            return (
              <li key={row.key}>
                {row.lead}
                <span className="replier-name">{row.name}</span>
                <span className="share-count">
                  {row.count}
                  <span>{percent(share)}</span>
                </span>
                <span className="share-track" aria-hidden="true">
                  <span style={{ width: `${share * 100}%` }} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/** The bar and the share both measure against the conversations answered, as Outcomes does. */
function Repliers({ numbers }: { numbers: Analytics }) {
  return (
    <ShareList
      title="byOperatorTitle"
      empty="noReplies"
      total={numbers.answered}
      rows={numbers.repliers.map((one) => {
        const { key, avatar, name } = replierLabel(one);
        return { key, lead: <Avatar name={avatar} />, name, count: one.conversations };
      })}
    />
  );
}

/** Conversations started in the period by each label they have now. One can have several. */
function Labels({ numbers }: { numbers: Analytics }) {
  return (
    <ShareList
      title="byLabelTitle"
      empty="noLabeledConversations"
      total={numbers.started}
      rows={numbers.labels.map((one) => ({
        key: one.labelId,
        lead: <LabelDot color={one.color} />,
        name: one.name,
        count: one.conversations,
      }))}
    />
  );
}

/** The conversations' key numbers, then the charts. */
function Support({ numbers, days }: { numbers: Analytics; days: Period }) {
  return (
    <>
      <Stats numbers={numbers} days={days} />
      <div className="charts">
        <PerDay days={numbers.perDay} />
        <Outcomes numbers={numbers} />
        <Hours hours={numbers.hours} />
        <Repliers numbers={numbers} />
        <Labels numbers={numbers} />
      </div>
    </>
  );
}

/**
 * The site's key numbers, each against the period before. A period before Dinghy started counting
 * the site has no numbers, so no change shows.
 */
function SiteStats({
  site,
  dates,
  compared,
}: {
  site: VisitorStats;
  /** The period's days, which the support numbers name; the line has no card until they load. */
  dates: string[] | null;
  compared: string;
}) {
  const { visits, pageViews, chats, peak, previous } = site;
  const rate = rateOf(chats, visits);
  const rateBefore = previous === null ? null : rateOf(previous.chats, previous.visits);
  return (
    <div className="stats">
      <Stat title="statsVisits">
        <p className="stat-value">{visits.toLocaleString()}</p>
        <CountChange count={visits} before={previous?.visits ?? 0} compared={compared} />
        <Sparkline
          values={site.series}
          tips={dates?.map((date, index) => ({
            value: plural(site.series[index] ?? 0, "statsVisitsOne", "statsVisitsMany"),
            label: dayName(date, FULL_DAY),
          }))}
        />
      </Stat>
      <Stat title="statsPageViews">
        <p className="stat-value">{pageViews.toLocaleString()}</p>
        <CountChange count={pageViews} before={previous?.pageViews ?? 0} compared={compared} />
      </Stat>
      <Stat title="statsChatRate" help="statsChatRateHelp">
        {rate === null ? (
          <p className="stat-value none">{t("statsNoneYet")}</p>
        ) : (
          <div className="stat-ring">
            <Ring share={Math.min(1, rate)} />
            <p className="stat-value">{percent(rate)}</p>
          </div>
        )}
        <ShareChange share={rate} before={rateBefore} compared={compared} />
        {rate !== null && (
          <p className="stat-note">
            {t("statsChatsFrom", {
              chats: plural(chats, "statsChatsOne", "statsChats"),
              visits: plural(visits, "statsVisitsOne", "statsVisitsMany"),
            })}
          </p>
        )}
      </Stat>
      <Stat title="statsPeak" help="statsPeakHelp">
        {peak === null ? (
          <p className="stat-value none">{t("statsNoneYet")}</p>
        ) : (
          <>
            <p className="stat-value">{peak.count}</p>
            <p className="stat-note">{dayAndTime(peak.at)}</p>
          </>
        )}
      </Stat>
    </div>
  );
}

/** The site's key numbers, then the pages people saw and where they came from. */
function Site({
  site,
  dates,
  failure,
  days,
}: {
  site: VisitorStats | null;
  dates: string[] | null;
  failure: TextId | null;
  days: Period;
}) {
  return (
    <>
      {site === null ? (
        <Loading failure={failure}>
          <SiteSkeleton />
        </Loading>
      ) : (
        <>
          <SiteStats site={site} dates={dates} compared={t("vsPrevious", { days })} />
          <div className="charts">
            <ShareList
              title="siteTopPages"
              empty="siteNothing"
              total={site.pageViews}
              rows={site.pages.map(({ page, title, count }) => ({
                key: page,
                name: pageName(title, page),
                count,
              }))}
            />
            <ShareList
              title="siteTopSources"
              empty="siteNothing"
              total={site.visits}
              rows={site.referrers.map(({ referrer, count }) => ({
                key: referrer ?? "",
                name: sourceName(referrer),
                count,
              }))}
            />
          </div>
        </>
      )}
    </>
  );
}

/** The period's support numbers and site numbers, loaded together, each with its own failure. */
function usePeriodNumbers(api: WorkspaceApi, days: Period, zone: string) {
  const [numbers, setNumbers] = useState<Analytics | null>(null);
  const [site, setSite] = useState<VisitorStats | null>(null);
  const [numbersFailure, setNumbersFailure] = useState<TextId | null>(null);
  const [siteFailure, setSiteFailure] = useState<TextId | null>(null);
  useEffect(() => {
    // An answer for another period or workspace must not land here.
    let current = true;
    setNumbers(null);
    setSite(null);
    setNumbersFailure(null);
    setSiteFailure(null);
    const fail = (set: (failure: TextId) => void) => (error: unknown) => {
      if (current) set(failureText(error, {}, "actionFailed"));
    };
    const period = Number(days) as AnalyticsDays;
    api.analytics(period, zone).then((next) => {
      if (current) setNumbers(next);
    }, fail(setNumbersFailure));
    api.visitorStats(period, zone).then((next) => {
      if (current) setSite(next);
    }, fail(setSiteFailure));
    return () => {
      current = false;
    };
  }, [api, days, zone]);
  return { numbers, site, numbersFailure, siteFailure };
}

type Tab = "support" | "site";

const TABS: readonly Option<Tab>[] = [
  { value: "support", label: "analyticsSupportTab" },
  { value: "site", label: "siteTitle" },
];

export function AnalyticsPage({ api }: { api: WorkspaceApi }) {
  const [days, setDays] = useState<Period>("30");
  const [tab, setTab] = useState<Tab>("support");
  // The server checks the zone, and days and hours read in it.
  const zone = browserTimeZone();
  const { numbers, site, numbersFailure, siteFailure } = usePeriodNumbers(api, days, zone);

  return (
    <Page
      title={t("analytics")}
      context={t("analyticsContext", { days, zone })}
      actions={
        <Choices<Period>
          label={t("period")}
          variant="outlined"
          value={days}
          options={PERIODS}
          onChange={setDays}
        />
      }
    >
      <Choices<Tab>
        label={t("analytics")}
        variant="tabs"
        value={tab}
        options={TABS}
        onChange={setTab}
      />
      {tab === "site" ? (
        <Tipped className="analytics">
          <Site
            site={site}
            dates={numbers?.perDay.map((day) => day.date) ?? null}
            failure={siteFailure}
            days={days}
          />
          <DocLink path="operator-guide#see-how-support-is-going" text="analyticsDocsLink" />
        </Tipped>
      ) : numbers === null ? (
        <Loading failure={numbersFailure}>
          <AnalyticsSkeleton />
        </Loading>
      ) : numbers.started === 0 ? (
        // Placed as the page's empty state, so it takes the room under the tabs.
        <Lookout
          kind="lighthouse"
          className="gull-pane empty-boat"
          title={t("analyticsEmpty", { days })}
          hint={t("analyticsEmptyHint")}
        />
      ) : (
        <Tipped className="analytics">
          <Support numbers={numbers} days={days} />
          <DocLink path="operator-guide#see-how-support-is-going" text="analyticsDocsLink" />
        </Tipped>
      )}
    </Page>
  );
}
