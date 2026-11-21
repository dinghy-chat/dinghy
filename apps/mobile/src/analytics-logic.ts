import type { components } from "../../../packages/sdk/src/openapi.ts";
import { t } from "../../operator/src/text.ts";

export type Analytics = components["schemas"]["Analytics"];
export type AnalyticsDays = 7 | 30 | 90;
export type Change = { text: string; kind: "better" | "worse" | "neutral" } | null;

export const shareOf = (count: number, total: number) => (total === 0 ? 0 : count / total);

/** "45 sec", "3 min", "2 h 5 min", "1 d 4 h". Hermes has no Intl unit style, so the units are copy. */
export function replyTime(seconds: number): string {
  if (seconds < 59.5) return t("mobileUnitSeconds", { count: Math.max(0, Math.round(seconds)) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("mobileUnitMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes === 0
      ? t("mobileUnitHours", { count: hours })
      : t("mobileUnitHoursMinutes", { hours, minutes: restMinutes });
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0
    ? t("mobileUnitDays", { count: days })
    : t("mobileUnitDaysHours", { days, hours: restHours });
}

export const chats = (count: number) =>
  count === 1 ? t("mobileChatOne") : t("mobileChatMany", { count: count.toLocaleString() });

/** "Europe/Paris" reads "Paris", "America/New_York" reads "New York". */
export function zoneName(zone: string): string {
  return (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");
}

/** A "YYYY-MM-DD" day from the API, read as a local calendar day. */
export function calendarDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** The daily chart's numbers. Every day in the period is in `perDay`, zero days too. */
export function dailySummary(perDay: Analytics["perDay"]) {
  const total = perDay.reduce((sum, day) => sum + day.conversations, 0);
  let busiest = 0;
  perDay.forEach((day, index) => {
    if (day.conversations > (perDay[busiest]?.conversations ?? 0)) busiest = index;
  });
  const average = perDay.length === 0 ? 0 : total / perDay.length;
  const last = Math.max(0, perDay.length - 1);
  return {
    total,
    average,
    most: Math.max(1, perDay[busiest]?.conversations ?? 0),
    busiest,
    axis: [...new Set([0, Math.floor(last / 2), last])],
  };
}

/** "0.8" under ten a day, "14" above, so the label stays short. */
export function averageText(average: number): string {
  return average < 10
    ? (Math.round(average * 10) / 10).toLocaleString([], { maximumFractionDigits: 1 })
    : Math.round(average).toLocaleString();
}

const MAX_BAR = 26;

/** Bars share the width evenly, and stay at most 26 pt wide so 7 days do not read as blocks. */
export function barLayout(count: number, width: number) {
  const slot = count === 0 ? 0 : width / count;
  const bar = Math.min(MAX_BAR, Math.max(1.5, slot * (count > 45 ? 0.72 : 0.62)));
  return { slot, bar, x: (index: number) => index * slot + (slot - bar) / 2 };
}

/** The day under a finger at `x`, kept inside the chart. */
export function dayAt(x: number, width: number, count: number): number {
  if (count === 0 || width <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
}

/** The API's 7 × 24 hours, Monday first, as 7 × 12 two-hour slots. */
export function twoHourSlots(hours: Analytics["hours"]): number[][] {
  return hours.map((row) =>
    Array.from({ length: 12 }, (_, slot) => (row[slot * 2] ?? 0) + (row[slot * 2 + 1] ?? 0)),
  );
}

/** The busiest slot, the first one on a tie, or null when no chat started. */
export function peakSlot(slots: number[][]): { day: number; slot: number; count: number } | null {
  let peak: { day: number; slot: number; count: number } | null = null;
  slots.forEach((row, day) => {
    row.forEach((count, slot) => {
      if (count > (peak?.count ?? 0)) peak = { day, slot, count };
    });
  });
  return peak;
}

/** The web's heat ramp: level 1 to 4 against the busiest slot, 0 for no chat. */
export function heatLevel(count: number, most: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || most <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / most) * 4))) as 1 | 2 | 3 | 4;
}

export function startedChange(numbers: Analytics, days: AnalyticsDays): Change {
  const before = numbers.previous.started;
  if (before === 0) return null;
  const change = numbers.started / before - 1;
  const formatted = percent(Math.abs(change));
  const text =
    formatted === percent(0)
      ? t("changeSame")
      : t(change > 0 ? "changeUp" : "changeDown", { change: formatted });
  return { text: `${text} ${t("vsPrevious", { days })}`, kind: "neutral" };
}

export function medianChange(numbers: Analytics, days: AnalyticsDays): Change {
  const now = numbers.firstReply.medianSeconds;
  const before = numbers.previous.firstReply.medianSeconds;
  if (now === null || before === null) return null;
  const difference = replyTime(Math.abs(before - now));
  if (Math.abs(before - now) < 30) {
    return { text: `${t("changeSame")} ${t("vsPrevious", { days })}`, kind: "neutral" };
  }
  const faster = now < before;
  return {
    text: `${t(faster ? "replyFaster" : "replySlower", { time: difference })} ${t("vsPrevious", { days })}`,
    kind: faster ? "better" : "worse",
  };
}

export function fastChange(numbers: Analytics, days: AnalyticsDays): Change {
  if (numbers.started === 0 || numbers.previous.started === 0) return null;
  const now = shareOf(numbers.firstReply.fast, numbers.started);
  const before = shareOf(numbers.previous.firstReply.fast, numbers.previous.started);
  const points = Math.round((now - before) * 100);
  if (points === 0) {
    return { text: `${t("changeSame")} ${t("vsPrevious", { days })}`, kind: "neutral" };
  }
  return {
    text: `${t(points > 0 ? "pointsUp" : "pointsDown", { points: Math.abs(points) })} ${t("vsPrevious", { days })}`,
    kind: points > 0 ? "better" : "worse",
  };
}

export const percent = (share: number) => `${Math.round(share * 100)}%`;

export type Metric = "started" | "median" | "fast" | "answered";

const countOf = (count: number, total: number) =>
  t("mobileStatOf", { count: count.toLocaleString(), total: total.toLocaleString() });

/** One number in the grid: its value, the line under it, and its change when the API has one. */
export function metricCell(metric: Metric, numbers: Analytics, days: AnalyticsDays) {
  const { started, answered, firstReply } = numbers;
  if (metric === "started") {
    return {
      title: t("statStarted"),
      value: started.toLocaleString(),
      detail:
        numbers.startedByTeam > 0
          ? t("mobileStatByTeam", { count: numbers.startedByTeam.toLocaleString() })
          : t("mobileStatByVisitors"),
      change: startedChange(numbers, days),
    };
  }
  if (metric === "median") {
    return {
      title: t("statMedian"),
      value:
        firstReply.medianSeconds === null
          ? t("mobileMetricNone")
          : replyTime(firstReply.medianSeconds),
      detail:
        firstReply.p90Seconds === null
          ? countOf(answered, started)
          : t("mobileStatP90", { time: replyTime(firstReply.p90Seconds) }),
      change: medianChange(numbers, days),
    };
  }
  if (metric === "fast") {
    return {
      title: t("statFast"),
      value: percent(shareOf(firstReply.fast, started)),
      detail: countOf(firstReply.fast, started),
      change: fastChange(numbers, days),
    };
  }
  return {
    title: t("statAnswered"),
    value: percent(shareOf(answered, started)),
    detail: countOf(answered, started),
    change: null,
  };
}

/** The sheet that explains a number. Each row names its count and what it is counted against. */
export function metricDetail(
  metric: Metric,
  numbers: Analytics,
  days: AnalyticsDays,
  zone: string,
): { help: string; rows: [string, string][] } {
  const { started, answered, firstReply, previous } = numbers;
  const before = t("mobileMetricPrevious", { days });
  if (metric === "started") {
    return {
      help: t("mobileMetricStartedHelp", { days, zone: zoneName(zone) }),
      rows: [
        [t("mobileMetricByVisitors"), (started - numbers.startedByTeam).toLocaleString()],
        [t("mobileMetricByTeam"), numbers.startedByTeam.toLocaleString()],
        [before, previous.started.toLocaleString()],
      ],
    };
  }
  if (metric === "median") {
    const time = (seconds: number | null) =>
      seconds === null ? t("mobileMetricNone") : replyTime(seconds);
    return {
      help: t("mobileMetricMedianHelp"),
      rows: [
        [t("mobileMetricMedian"), time(firstReply.medianSeconds)],
        [t("mobileMetricP90"), time(firstReply.p90Seconds)],
        [t("mobileMetricAnsweredCount"), countOf(answered, started)],
        [before, time(previous.firstReply.medianSeconds)],
      ],
    };
  }
  if (metric === "fast") {
    const rows: [string, string][] = [[t("mobileMetricFast"), countOf(firstReply.fast, started)]];
    if (previous.started > 0) {
      rows.push([
        before,
        `${percent(shareOf(previous.firstReply.fast, previous.started))}, ${countOf(previous.firstReply.fast, previous.started)}`,
      ]);
    }
    return { help: t("mobileMetricFastHelp"), rows };
  }
  return {
    help: t("mobileMetricAnsweredHelp"),
    rows: [
      [t("mobileMetricGotReply"), countOf(answered, started)],
      [t("mobileMetricNoReply"), countOf(started - answered, started)],
    ],
  };
}
