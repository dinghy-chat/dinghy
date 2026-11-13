/** @jsxImportSource react */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Analytics, AnalyticsDays, WorkspaceApi } from "./api.ts";
import { duration } from "./format.ts";
import { LabelDot } from "./labels.tsx";
import { Pond } from "./scene.tsx";
import { type TextId, t } from "./text.ts";
import { Avatar, Choices, DocLink, failureText, Loading, type Option, Page } from "./ui.tsx";

type Period = `${AnalyticsDays}`;

const PERIODS: readonly Option<Period>[] = [
  { value: "7", label: "period7" },
  { value: "30", label: "period30" },
  { value: "90", label: "period90" },
];

/** The browser's zone, which the server checks. Days and hours read in it. */
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const percent = (share: number) =>
  new Intl.NumberFormat([], { style: "percent", maximumFractionDigits: 0 }).format(share);

/** A part of a total, from 0 to 1; 0 when the total is 0. */
const shareOf = (count: number, total: number) => (total === 0 ? 0 : count / total);

/** A date of the period, "2026-11-08", as "Nov 8". */
function dayName(
  date: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString([], options);
}

/** Monday first, as the server sends the hours. 2024-01-01 was a Monday. */
const weekdayNames = (weekday: "short" | "long") =>
  Array.from({ length: 7 }, (_, index) =>
    new Date(2024, 0, 1 + index).toLocaleDateString([], { weekday }),
  );
const WEEKDAYS = weekdayNames("short");
const WEEKDAYS_LONG = weekdayNames("long");
const hourName = (hour: number) =>
  new Date(2024, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" });
const HOURS = Array.from({ length: 24 }, (_, hour) => hourName(hour));

const conversations = (count: number) => (count === 1 ? t("chartOne") : t("chartMany", { count }));

/** A number with its label, or the words behind an "i" button. */
type TipContent = { value: string; label: string } | { text: string };

type Tip = TipContent & { x: number; y: number };

/** The card for the part of `area` at `target`, placed above it, or null off every part. */
function tipAt(area: HTMLElement | null, target: EventTarget | null): Tip | null {
  const part =
    target instanceof Element ? target.closest<HTMLElement>("[data-value], [data-tip]") : null;
  if (part === null || area === null) return null;
  const outer = area.getBoundingClientRect();
  const inner = part.getBoundingClientRect();
  const { tip, value, label } = part.dataset;
  return {
    ...(tip === undefined ? { value: value ?? "", label: label ?? "" } : { text: tip }),
    x: inner.left + inner.width / 2 - outer.left,
    y: inner.top - outer.top,
  };
}

/**
 * An area whose parts carry data-value and data-label, or data-tip. The pointer over a part, or
 * the focus on it, shows them in a card above it, kept inside the area. Escape hides the card.
 * The words for screen readers are in each figure's caption, or in each button's label.
 */
function Tipped({ className, children }: { className: string; children: ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    const width = box.current?.clientWidth ?? 0;
    if (tip === null || element === null) return;
    const half = element.offsetWidth / 2;
    element.style.left = `${Math.min(Math.max(tip.x, half), width - half)}px`;
  }, [tip]);
  // Focus and Escape, for the keys. Listened to here, as the area itself takes no focus.
  useEffect(() => {
    const area = box.current;
    if (area === null) return;
    const focus = (event: FocusEvent) => setTip(tipAt(area, event.target));
    const hide = () => setTip(null);
    const hideOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    area.addEventListener("focusin", focus);
    area.addEventListener("focusout", hide);
    document.addEventListener("keydown", hideOnEscape);
    return () => {
      area.removeEventListener("focusin", focus);
      area.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", hideOnEscape);
    };
  }, []);
  return (
    <div
      ref={box}
      className={`tipped ${className}`}
      onPointerOver={(event) => setTip(tipAt(box.current, event.target))}
      onPointerLeave={() => setTip(null)}
    >
      {children}
      {tip !== null && (
        <div
          ref={card}
          className={"text" in tip ? "chart-tip words" : "chart-tip"}
          style={{ top: tip.y }}
          aria-hidden="true"
        >
          {"text" in tip ? (
            tip.text
          ) : (
            <>
              <b>{tip.value}</b>
              <span>{tip.label}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A small "i" whose words show in the Tipped card. Screen readers read them as its label. */
function Info({ text }: { text: TextId }) {
  return (
    <button type="button" className="info-tip" aria-label={t(text)} data-tip={t(text)}>
      i
    </button>
  );
}

/** Better, worse, or neither, as the change's color says. */
type Direction = "better" | "worse" | "neutral";

/** A change against the previous period, and which period that is. */
function Change({ words, direction, days }: { words: string; direction: Direction; days: Period }) {
  return (
    <p className={`stat-change ${direction}`}>
      {words} <span>{t("vsPrevious", { days })}</span>
    </p>
  );
}

function StartedChange({ numbers, days }: { numbers: Analytics; days: Period }) {
  const before = numbers.previous.started;
  if (before === 0) return null;
  const change = numbers.started / before - 1;
  // A change that rounds to 0% reads as none, not as "↑ 0%".
  const words =
    percent(Math.abs(change)) === percent(0)
      ? t("changeSame")
      : t(change > 0 ? "changeUp" : "changeDown", { change: percent(Math.abs(change)) });
  return <Change words={words} direction="neutral" days={days} />;
}

function MedianChange({ numbers, days }: { numbers: Analytics; days: Period }) {
  const now = numbers.firstReply.medianSeconds;
  const before = numbers.previous.firstReply.medianSeconds;
  if (now === null || before === null) return null;
  const words = duration(Math.abs(before - now));
  if (Math.round(now) === Math.round(before)) {
    return <Change words={t("changeSame")} direction="neutral" days={days} />;
  }
  return now < before ? (
    <Change words={t("replyFaster", { time: words })} direction="better" days={days} />
  ) : (
    <Change words={t("replySlower", { time: words })} direction="worse" days={days} />
  );
}

function FastChange({ numbers, days }: { numbers: Analytics; days: Period }) {
  const { started, previous } = numbers;
  if (started === 0 || previous.started === 0) return null;
  const now = shareOf(numbers.firstReply.fast, started);
  const before = shareOf(previous.firstReply.fast, previous.started);
  const points = Math.round((now - before) * 100);
  if (points === 0) return <Change words={t("changeSame")} direction="neutral" days={days} />;
  return (
    <Change
      words={t(points > 0 ? "pointsUp" : "pointsDown", { points: Math.abs(points) })}
      direction={points > 0 ? "better" : "worse"}
      days={days}
    />
  );
}

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 32;

/** The days of the period as a small line, under its own area. */
function Sparkline({ days }: { days: Analytics["perDay"] }) {
  const most = Math.max(1, ...days.map((day) => day.conversations));
  const last = Math.max(1, days.length - 1);
  const line = `M${days
    .map((day, index) => {
      const x = (index / last) * SPARK_WIDTH;
      const y = SPARK_HEIGHT - (day.conversations / most) * (SPARK_HEIGHT - 2);
      return `${x},${y}`;
    })
    .join("L")}`;
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        className="spark-area"
        d={`${line}L${SPARK_WIDTH},${SPARK_HEIGHT}L0,${SPARK_HEIGHT}Z`}
      />
      <path className="spark-line" d={line} />
    </svg>
  );
}

const RING_RADIUS = 18;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function Ring({ share }: { share: number }) {
  return (
    <svg className="ring" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r={RING_RADIUS} className="ring-back" />
      {share > 0 && (
        <circle
          cx="22"
          cy="22"
          r={RING_RADIUS}
          className="ring-front"
          strokeDasharray={`${share * RING_LENGTH} ${RING_LENGTH}`}
        />
      )}
    </svg>
  );
}

function Stat({ title, help, children }: { title: TextId; help?: TextId; children: ReactNode }) {
  return (
    <article className="stat">
      <h3>
        {t(title)}
        {help !== undefined && <Info text={help} />}
      </h3>
      {children}
    </article>
  );
}

function Stats({ numbers, days }: { numbers: Analytics; days: Period }) {
  const { started, answered, firstReply } = numbers;
  const fast = shareOf(firstReply.fast, started);
  const answeredShare = shareOf(answered, started);
  return (
    <section className="stats" aria-label={t("statsTitle")}>
      <Stat title="statStarted">
        <p className="stat-value">{started}</p>
        <StartedChange numbers={numbers} days={days} />
        <Sparkline days={numbers.perDay} />
      </Stat>
      <Stat title="statMedian" help="statMedianHelp">
        {firstReply.medianSeconds === null ? (
          <p className="stat-value none">{t("noReplies")}</p>
        ) : (
          <p className="stat-value">{duration(firstReply.medianSeconds)}</p>
        )}
        <MedianChange numbers={numbers} days={days} />
        {firstReply.p90Seconds !== null && (
          <p className="stat-note">{t("statP90", { time: duration(firstReply.p90Seconds) })}</p>
        )}
      </Stat>
      <Stat title="statFast" help="statFastHelp">
        <div className="stat-ring">
          <Ring share={fast} />
          <p className="stat-value">{percent(fast)}</p>
        </div>
        <FastChange numbers={numbers} days={days} />
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

function Card({ title, hint, children }: { title: TextId; hint?: string; children: ReactNode }) {
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
      hint={t("hoursBusiest", { day: WEEKDAYS_LONG[peak.day] ?? "", hour: hourName(peak.hour) })}
    >
      <figure className="hours">
        <figcaption className="visually-hidden">
          {t("hoursSummary", {
            day: WEEKDAYS_LONG[peak.day] ?? "",
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
            <span key={`d${WEEKDAYS[day]}`} className="heat-day">
              {WEEKDAYS[day]}
            </span>,
            ...row.map((count, hour) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the grid's cells never move.
                key={`${day}-${hour}`}
                className={`heat-cell level-${Math.ceil((count / most) * HEAT_LEVELS)}${
                  day === peak.day && hour === peak.hour ? " peak" : ""
                }`}
                data-value={conversations(count)}
                data-label={t("hoursCell", { day: WEEKDAYS_LONG[day] ?? "", hour: hourName(hour) })}
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

/** The bar and the share both measure against the conversations answered, as Outcomes does. */
function Repliers({ numbers }: { numbers: Analytics }) {
  const { repliers, answered } = numbers;
  return (
    <Card title="byOperatorTitle">
      {repliers.length === 0 ? (
        <p className="note">{t("noReplies")}</p>
      ) : (
        <ol className="repliers">
          {repliers.map((one) => {
            const { key, avatar, name } = replierLabel(one);
            const share = shareOf(one.conversations, answered);
            return (
              <li key={key}>
                <Avatar name={avatar} />
                <span className="replier-name">{name}</span>
                <span className="share-count">
                  {one.conversations}
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

/** Conversations started in the period by each label they have now. One can have several. */
function Labels({ numbers }: { numbers: Analytics }) {
  const { labels, started } = numbers;
  return (
    <Card title="byLabelTitle">
      {labels.length === 0 ? (
        <p className="note">{t("noLabeledConversations")}</p>
      ) : (
        <ol className="repliers">
          {labels.map((one) => {
            const share = shareOf(one.conversations, started);
            return (
              <li key={one.labelId}>
                <LabelDot color={one.color} />
                <span className="replier-name">{one.name}</span>
                <span className="share-count">
                  {one.conversations}
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
      {numbers === null ? (
        <Loading failure={failure} />
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
