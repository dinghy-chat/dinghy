import { describe, expect, test } from "vitest";
import {
  type Analytics,
  averageText,
  barLayout,
  dailySummary,
  dayAt,
  fastChange,
  heatLevel,
  medianChange,
  metricCell,
  metricDetail,
  peakSlot,
  replyTime,
  startedChange,
  twoHourSlots,
  zoneName,
} from "./src/analytics-logic.ts";

const numbers = (overrides: Partial<Analytics> = {}): Analytics => ({
  days: 30,
  timeZone: "Europe/Paris",
  started: 20,
  startedByTeam: 2,
  closed: 16,
  answered: 18,
  firstReply: { medianSeconds: 180, p90Seconds: 1680, fast: 12 },
  previous: { started: 10, firstReply: { medianSeconds: 300, fast: 5 } },
  perDay: [],
  repliers: [],
  hours: [],
  labels: [],
  ...overrides,
});

describe("replyTime", () => {
  test("reads seconds, minutes, hours and days without Intl units", () => {
    expect(replyTime(42)).toBe("42 sec");
    expect(replyTime(180)).toBe("3 min");
    expect(replyTime(1680)).toBe("28 min");
    expect(replyTime(3570)).toBe("1 h");
    expect(replyTime(7500)).toBe("2 h 5 min");
    expect(replyTime(86_400)).toBe("1 d");
    expect(replyTime(100_800)).toBe("1 d 4 h");
  });

  test("rounds 59.6 seconds up to a minute", () => {
    expect(replyTime(59.6)).toBe("1 min");
  });
});

test("zoneName keeps the city", () => {
  expect(zoneName("Europe/Paris")).toBe("Paris");
  expect(zoneName("America/New_York")).toBe("New York");
  expect(zoneName("UTC")).toBe("UTC");
});

describe("daily chart", () => {
  const perDay = [
    { date: "2026-11-10", conversations: 0 },
    { date: "2026-11-11", conversations: 5 },
    { date: "2026-11-12", conversations: 5 },
    { date: "2026-11-13", conversations: 2 },
  ];

  test("counts every day, zero days too, and keeps the first busiest day", () => {
    const summary = dailySummary(perDay);
    expect(summary.total).toBe(12);
    expect(summary.average).toBe(3);
    expect(summary.busiest).toBe(1);
    expect(summary.most).toBe(5);
    expect(summary.axis).toEqual([0, 1, 3]);
  });

  test("an empty period has a scale of one and no repeated axis label", () => {
    const summary = dailySummary([{ date: "2026-11-10", conversations: 0 }]);
    expect(summary.most).toBe(1);
    expect(summary.axis).toEqual([0]);
  });

  test("the average label stays short", () => {
    expect(averageText(0.8333)).toBe("0.8");
    expect(averageText(3)).toBe("3");
    expect(averageText(14.4)).toBe("14");
  });

  test("bars stay narrow on 7 days and fit 90 days", () => {
    const week = barLayout(7, 343);
    expect(week.bar).toBe(26);
    expect(week.x(0)).toBeCloseTo((49 - 26) / 2);
    const quarter = barLayout(90, 343);
    expect(quarter.bar).toBeLessThan(quarter.slot);
    expect(quarter.x(89) + quarter.bar).toBeLessThanOrEqual(343);
  });

  test("a finger outside the bars picks the nearest end", () => {
    expect(dayAt(-20, 300, 30)).toBe(0);
    expect(dayAt(155, 300, 30)).toBe(15);
    expect(dayAt(400, 300, 30)).toBe(29);
  });
});

describe("busiest hours", () => {
  const counts: Record<string, number> = { "2:20": 3, "2:21": 1, "0:9": 2 };
  const hours = Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => counts[`${day}:${hour}`] ?? 0),
  );

  test("pairs the hours into twelve two-hour slots", () => {
    const slots = twoHourSlots(hours);
    expect(slots).toHaveLength(7);
    expect(slots[0]).toHaveLength(12);
    expect(slots[2]?.[10]).toBe(4);
    expect(slots[0]?.[4]).toBe(2);
  });

  test("finds the busiest slot, or none", () => {
    expect(peakSlot(twoHourSlots(hours))).toEqual({ day: 2, slot: 10, count: 4 });
    expect(peakSlot([[0, 0]])).toBeNull();
  });

  test("uses the four heat levels", () => {
    expect(heatLevel(0, 4)).toBe(0);
    expect(heatLevel(1, 4)).toBe(1);
    expect(heatLevel(3, 4)).toBe(3);
    expect(heatLevel(4, 4)).toBe(4);
  });
});

describe("changes against the previous period", () => {
  test("use only the numbers the API gives", () => {
    expect(startedChange(numbers(), 30)?.text).toBe("↑ 100% vs previous 30 days");
    expect(medianChange(numbers(), 30)).toEqual({
      text: "↓ 2 min faster vs previous 30 days",
      kind: "better",
    });
    expect(fastChange(numbers(), 30)).toEqual({
      text: "↑ 10 pts vs previous 30 days",
      kind: "better",
    });
  });

  test("the grid names each share's denominator, and Answered has no invented change", () => {
    expect(metricCell("fast", numbers(), 30)).toMatchObject({
      value: "60%",
      detail: "12 of 20 chats",
    });
    expect(metricCell("median", numbers(), 30)).toMatchObject({
      value: "3 min",
      detail: "9 in 10 by 28 min",
    });
    expect(metricCell("answered", numbers(), 30)).toMatchObject({
      value: "90%",
      detail: "18 of 20 chats",
      change: null,
    });
  });

  test("the explanation sheet shows p50, p90 and the previous period", () => {
    expect(metricDetail("median", numbers(), 30, "Europe/Paris").rows).toEqual([
      ["Half of chats by", "3 min"],
      ["9 in 10 chats by", "28 min"],
      ["Answered chats counted", "18 of 20 chats"],
      ["Previous 30 days", "5 min"],
    ]);
    expect(metricDetail("fast", numbers(), 30, "Europe/Paris").rows).toEqual([
      ["Replied within 5 min", "12 of 20 chats"],
      ["Previous 30 days", "50%, 5 of 10 chats"],
    ]);
  });

  test("show nothing without a previous number", () => {
    const empty = numbers({
      previous: { started: 0, firstReply: { medianSeconds: null, fast: 0 } },
    });
    expect(startedChange(empty, 30)).toBeNull();
    expect(medianChange(empty, 30)).toBeNull();
    expect(fastChange(empty, 30)).toBeNull();
  });
});
