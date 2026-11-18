/** @jsxImportSource react */
import { type ReactNode, useEffect, useState } from "react";
import type { Analytics, AnalyticsDays, WorkspaceApi } from "./api.ts";
import { browserTimeZone, duration, weekdayNames } from "./format.ts";
import { LabelDot } from "./labels.tsx";
import { Pond } from "./scene.tsx";
import { AnalyticsSkeleton } from "./skeleton.tsx";
import {
  Change,
  CountChange,
  PERIOD_OPTIONS,
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
import { Avatar, Choices, DocLink, failureText, Loading, Page } from "./ui.tsx";

type Period = `${AnalyticsDays}`;

/** A date of the period, "2026-11-08", as "Nov 8". */
export function dayName(
  date: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString([], options);
}

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
        <Sparkline values={numbers.perDay.map((day) => day.conversations)} />
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
              data-label={dayName(day.date, { weekday: "long", month: "short", day: "numeric" })}
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

export function AnalyticsPage({ api }: { api: WorkspaceApi }) {
  const [days, setDays] = useState<Period>("30");
  const [numbers, setNumbers] = useState<Analytics | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  // The server checks the zone, and days and hours read in it.
  const zone = browserTimeZone();

  useEffect(() => {
    // An answer for another period or workspace must not land here.
    let current = true;
    setNumbers(null);
    setFailure(null);
    api.analytics(Number(days) as AnalyticsDays, zone).then(
      (next) => {
        if (current) setNumbers(next);
      },
      (error: unknown) => {
        if (current) setFailure(failureText(error, {}, "actionFailed"));
      },
    );
    return () => {
      current = false;
    };
  }, [api, days, zone]);

  return (
    <Page
      title={t("analytics")}
      context={t("analyticsContext", { days, zone })}
      actions={
        <Choices<Period>
          label={t("period")}
          variant="outlined"
          value={days}
          options={PERIOD_OPTIONS}
          onChange={setDays}
        />
      }
    >
      {numbers === null ? (
        <Loading failure={failure}>
          <AnalyticsSkeleton />
        </Loading>
      ) : numbers.started === 0 ? (
        <div className="nothing empty-boat">
          <Pond />
          <b>{t("analyticsEmpty", { days })}</b>
          {t("analyticsEmptyHint")}
        </div>
      ) : (
        <Tipped className="analytics">
          <Stats numbers={numbers} days={days} />
          <div className="charts">
            <PerDay days={numbers.perDay} />
            <Outcomes numbers={numbers} />
            <Hours hours={numbers.hours} />
            <Repliers numbers={numbers} />
            <Labels numbers={numbers} />
          </div>
          <DocLink path="operator-guide#see-how-support-is-going" text="analyticsDocsLink" />
        </Tipped>
      )}
    </Page>
  );
}
