/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { Analytics, AnalyticsDays, WorkspaceApi } from "./api.ts";
import { Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { failureText, Loading, Page, PageRow, Pond } from "./ui.tsx";

type Period = `${AnalyticsDays}`;

const PERIODS: { value: Period; label: TextId }[] = [
  { value: "7", label: "period7" },
  { value: "30", label: "period30" },
  { value: "90", label: "period90" },
];

/** The browser's zone, which the server checks. Days and hours read in it. */
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const fill = (id: TextId, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, String(value)),
    t(id),
  );

/** "45 sec", "4 min", "1.5 hr", in the browser's words. */
function duration(seconds: number): string {
  const unit = (value: number, name: "second" | "minute" | "hour") =>
    new Intl.NumberFormat([], {
      style: "unit",
      unit: name,
      unitDisplay: "short",
      maximumFractionDigits: name === "hour" ? 1 : 0,
    }).format(value);
  if (seconds < 60) return unit(Math.round(seconds), "second");
  if (seconds < 3600) return unit(Math.round(seconds / 60), "minute");
  return unit(seconds / 3600, "hour");
}

const percent = (share: number) =>
  new Intl.NumberFormat([], { style: "percent", maximumFractionDigits: 0 }).format(share);

/** A date of the period, "2026-11-08", as "Nov 8". */
function dayName(
  date: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString([], options);
}

/** Monday first, as the server sends the hours. 2024-01-01 was a Monday. */
const WEEKDAYS = Array.from({ length: 7 }, (_, index) =>
  new Date(2024, 0, 1 + index).toLocaleDateString([], { weekday: "short" }),
);
const WEEKDAYS_LONG = Array.from({ length: 7 }, (_, index) =>
  new Date(2024, 0, 1 + index).toLocaleDateString([], { weekday: "long" }),
);
const hourName = (hour: number) =>
  new Date(2024, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" });
const HOURS = Array.from({ length: 24 }, (_, hour) => hourName(hour));

function Figures({ numbers }: { numbers: Analytics }) {
  const { firstReply } = numbers;
  const none = t("noReplies");
  const items: [TextId, string][] = [
    ["statStarted", String(numbers.started)],
    ["statMedian", firstReply.medianSeconds === null ? none : duration(firstReply.medianSeconds)],
    ["statP90", firstReply.p90Seconds === null ? none : duration(firstReply.p90Seconds)],
    ["statFast", firstReply.within5Minutes === null ? none : percent(firstReply.within5Minutes)],
    ["statClosed", String(numbers.closed)],
  ];
  return (
    <dl className="figures">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{t(label)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One bar per day. The busiest day sets the height. */
function PerDay({ days }: { days: Analytics["perDay"] }) {
  const most = Math.max(1, ...days.map((day) => day.conversations));
  const busiest = days.reduce((top, day) => (day.conversations > top.conversations ? day : top));
  const first = days[0];
  const last = days.at(-1);
  return (
    <figure className="per-day">
      <figcaption className="visually-hidden">
        {fill("perDaySummary", { day: dayName(busiest.date), count: busiest.conversations })}
      </figcaption>
      <div className="bars" aria-hidden="true">
        {days.map((day) => (
          <span
            key={day.date}
            title={fill("perDayBar", { day: dayName(day.date), count: day.conversations })}
          >
            {day.conversations > 0 && (
              <i style={{ height: `${(day.conversations / most) * 100}%` }} />
            )}
          </span>
        ))}
      </div>
      <div className="axis" aria-hidden="true">
        <span>{first === undefined ? "" : dayName(first.date)}</span>
        <span>{fill("perDayMost", { count: most })}</span>
        <span>{last === undefined ? "" : dayName(last.date)}</span>
      </div>
    </figure>
  );
}

function ByOperator({ operators }: { operators: Analytics["operators"] }) {
  if (operators.length === 0) return <p className="note">{t("noReplies")}</p>;
  const most = Math.max(...operators.map((one) => one.conversations));
  return (
    <ul className="by-operator">
      {operators.map((one) => (
        <li key={one.operatorId}>
          <span className="who">{one.name ?? t("formerOperator")}</span>
          <span className="track" aria-hidden="true">
            <span className="fill" style={{ width: `${(one.conversations / most) * 100}%` }} />
          </span>
          <span className="count">{one.conversations}</span>
        </li>
      ))}
    </ul>
  );
}

/** Weekdays by hours, darker for more conversations. Each cell also has its words. */
function Hours({ hours }: { hours: number[][] }) {
  const most = Math.max(1, ...hours.flat());
  let top = { day: 0, hour: 0, count: 0 };
  hours.forEach((row, day) => {
    row.forEach((count, hour) => {
      if (count > top.count) top = { day, hour, count };
    });
  });
  return (
    <figure className="hours">
      <figcaption className="visually-hidden">
        {fill("hoursSummary", {
          day: WEEKDAYS_LONG[top.day] ?? "",
          hour: hourName(top.hour),
          count: top.count,
        })}
      </figcaption>
      <div className="hours-grid" aria-hidden="true">
        <span />
        {HOURS.map((name, hour) => (
          <span key={name} className="hour-label">
            {hour % 6 === 0 ? name : ""}
          </span>
        ))}
        {hours.map((row, day) => [
          <span key={`d${WEEKDAYS[day]}`} className="day-label">
            {WEEKDAYS[day]}
          </span>,
          ...row.map((count, hour) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: the grid's cells never move.
              key={`${day}-${hour}`}
              className={`cell level-${count === 0 ? 0 : Math.ceil((count / most) * 4)}`}
              title={fill("hoursCell", {
                day: WEEKDAYS[day] ?? "",
                hour: hourName(hour),
                count,
              })}
            />
          )),
        ])}
      </div>
    </figure>
  );
}

export function AnalyticsPage({ api }: { api: WorkspaceApi }) {
  const [days, setDays] = useState<Period>("30");
  const [numbers, setNumbers] = useState<Analytics | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const zone = timeZone();

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
      context={fill("analyticsContext", { days, zone })}
      actions={
        <Select<Period>
          label={t("period")}
          value={days}
          choices={PERIODS.map((period) => ({ value: period.value, label: t(period.label) }))}
          onChange={setDays}
          side="end"
        />
      }
    >
      {numbers === null ? (
        <Loading failure={failure} />
      ) : numbers.started === 0 ? (
        <div className="nothing empty-boat">
          <Pond />
          <b>{fill("analyticsEmpty", { days })}</b>
          {t("analyticsEmptyHint")}
        </div>
      ) : (
        <>
          <Figures numbers={numbers} />
          <PageRow title={t("perDayTitle")}>
            <PerDay days={numbers.perDay} />
          </PageRow>
          <PageRow title={t("byOperatorTitle")} help={t("byOperatorHelp")}>
            <ByOperator operators={numbers.operators} />
          </PageRow>
          <PageRow title={t("hoursTitle")} help={t("hoursHelp")}>
            <Hours hours={numbers.hours} />
          </PageRow>
        </>
      )}
    </Page>
  );
}
