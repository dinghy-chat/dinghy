import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import type { components } from "../../../packages/sdk/src/openapi.ts";
import { browserTimeZone, duration, weekdayNames } from "../../operator/src/format.ts";
import { t } from "../../operator/src/text.ts";
import type { DinghyApi } from "./api";
import { Avatar, readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import type { Palette } from "./theme";

type Analytics = components["schemas"]["Analytics"];
type AnalyticsDays = 7 | 30 | 90;

const PERIODS: AnalyticsDays[] = [7, 30, 90];
const GRAPH_WIDTH = 300;
const GRAPH_HEIGHT = 100;
const GRAPH_INSET = 7;
const DAY_NAMES_SHORT = weekdayNames("short");
const DAY_NAMES = weekdayNames("long");
const HOUR_NAMES = Array.from({ length: 24 }, (_, hour) =>
  new Date(2024, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" }),
);

const LABEL_COLORS: Record<Analytics["labels"][number]["color"], string> = {
  gray: "#77858c",
  red: "#d94841",
  orange: "#d66a1f",
  yellow: "#b9830d",
  green: "#27825f",
  teal: "#16817c",
  blue: "#3574c8",
  purple: "#7d58b3",
};

const shareOf = (count: number, total: number) => (total === 0 ? 0 : count / total);

const percent = (share: number) =>
  new Intl.NumberFormat([], { style: "percent", maximumFractionDigits: 0 }).format(share);

function dayName(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function conversations(count: number): string {
  return count === 1 ? t("chartOne") : t("chartMany", { count });
}

type Change = { text: string; kind: "better" | "worse" | "neutral" } | null;

function startedChange(numbers: Analytics, days: AnalyticsDays): Change {
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

function medianChange(numbers: Analytics, days: AnalyticsDays): Change {
  const now = numbers.firstReply.medianSeconds;
  const before = numbers.previous.firstReply.medianSeconds;
  if (now === null || before === null) return null;
  if (Math.round(now) === Math.round(before)) {
    return {
      text: `${t("changeSame")} ${t("vsPrevious", { days })}`,
      kind: "neutral",
    };
  }
  const faster = now < before;
  return {
    text: `${t(faster ? "replyFaster" : "replySlower", {
      time: duration(Math.abs(before - now)),
    })} ${t("vsPrevious", { days })}`,
    kind: faster ? "better" : "worse",
  };
}

function fastChange(numbers: Analytics, days: AnalyticsDays): Change {
  if (numbers.started === 0 || numbers.previous.started === 0) return null;
  const now = shareOf(numbers.firstReply.fast, numbers.started);
  const before = shareOf(numbers.previous.firstReply.fast, numbers.previous.started);
  const points = Math.round((now - before) * 100);
  if (points === 0) {
    return {
      text: `${t("changeSame")} ${t("vsPrevious", { days })}`,
      kind: "neutral",
    };
  }
  return {
    text: `${t(points > 0 ? "pointsUp" : "pointsDown", {
      points: Math.abs(points),
    })} ${t("vsPrevious", { days })}`,
    kind: points > 0 ? "better" : "worse",
  };
}

function changeColor(change: Change, palette: Palette): string {
  if (change?.kind === "better") return palette.green;
  if (change?.kind === "worse") return palette.amber;
  return palette.sub;
}

function PeriodPicker({
  days,
  onChange,
  palette,
}: {
  days: AnalyticsDays;
  onChange(days: AnalyticsDays): void;
  palette: Palette;
}) {
  return (
    <View accessibilityLabel={t("period")} accessibilityRole="radiogroup" style={styles.periods}>
      {PERIODS.map((period) => {
        const selected = days === period;
        return (
          <Pressable
            key={period}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(period)}
            style={({ pressed }) => [
              styles.period,
              {
                backgroundColor: selected ? palette.ink : "transparent",
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <Text style={[styles.periodText, { color: selected ? palette.paper : palette.sub }]}>
              {t(period === 7 ? "period7" : period === 30 ? "period30" : "period90")}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function StatCard({
  title,
  value,
  note,
  change,
  palette,
}: {
  title: string;
  value: string;
  note?: string | undefined;
  change: Change;
  palette: Palette;
}) {
  return (
    <View style={[styles.statCard, { backgroundColor: palette.sheet, borderColor: palette.line }]}>
      <Text style={[styles.statTitle, { color: palette.sub }]}>{title}</Text>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.statValue, { color: palette.ink }]}
      >
        {value}
      </Text>
      {note !== undefined && (
        <Text numberOfLines={2} style={[styles.statNote, { color: palette.sub }]}>
          {note}
        </Text>
      )}
      {change !== null && (
        <Text numberOfLines={2} style={[styles.change, { color: changeColor(change, palette) }]}>
          {change.text}
        </Text>
      )}
    </View>
  );
}

function DailyTrend({ days, palette }: { days: Analytics["perDay"]; palette: Palette }) {
  const busiest = days.reduce((top, day) => (day.conversations > top.conversations ? day : top));
  const most = Math.max(1, busiest.conversations);
  const lastIndex = Math.max(1, days.length - 1);
  const points = days.map((day, index) => ({
    x: GRAPH_INSET + (index / lastIndex) * (GRAPH_WIDTH - GRAPH_INSET * 2),
    y: GRAPH_HEIGHT - GRAPH_INSET - (day.conversations / most) * (GRAPH_HEIGHT - GRAPH_INSET * 2),
  }));
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join("");
  const firstPoint = points[0];
  const lastPoint = points.at(-1);
  const area =
    firstPoint === undefined || lastPoint === undefined
      ? ""
      : `${line}L${lastPoint.x},${GRAPH_HEIGHT - GRAPH_INSET}L${firstPoint.x},${GRAPH_HEIGHT - GRAPH_INSET}Z`;
  const first = days[0];
  const last = days.at(-1);
  const summary = t("perDaySummary", {
    day: dayName(busiest.date),
    conversations: conversations(busiest.conversations),
  });

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
      style={[styles.trendCard, { backgroundColor: palette.sheet, borderColor: palette.line }]}
    >
      <View style={styles.trendHeader}>
        <View style={styles.trendHeading}>
          <Text style={[styles.trendTitle, { color: palette.ink }]}>{t("perDayTitle")}</Text>
          <Text style={[styles.trendHint, { color: palette.sub }]}>
            {t("perDayBusiest", {
              day: dayName(busiest.date),
              conversations: conversations(busiest.conversations),
            })}
          </Text>
        </View>
        <Text style={[styles.trendMaximum, { color: palette.sub }]}>{most}</Text>
      </View>
      <Svg
        accessible={false}
        height={126}
        width="100%"
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
      >
        <Line
          x1={GRAPH_INSET}
          x2={GRAPH_WIDTH - GRAPH_INSET}
          y1={GRAPH_HEIGHT - GRAPH_INSET}
          y2={GRAPH_HEIGHT - GRAPH_INSET}
          stroke={palette.line}
          strokeWidth={1}
        />
        <Line
          x1={GRAPH_INSET}
          x2={GRAPH_WIDTH - GRAPH_INSET}
          y1={GRAPH_HEIGHT / 2}
          y2={GRAPH_HEIGHT / 2}
          stroke={palette.line}
          strokeDasharray="3 4"
          strokeWidth={1}
        />
        <Path d={area} fill={palette.tint} opacity={0.78} />
        <Path
          d={line}
          fill="none"
          stroke={palette.blue}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2.8}
        />
        {points.length <= 30 &&
          points.map((point, index) => (
            <Circle
              key={days[index]?.date ?? index}
              cx={point.x}
              cy={point.y}
              fill={palette.sheet}
              stroke={palette.blue}
              strokeWidth={1.8}
              r={points.length <= 7 ? 3 : 1.8}
            />
          ))}
      </Svg>
      <View style={styles.trendAxis}>
        <Text style={[styles.axisText, { color: palette.sub }]}>
          {first === undefined ? "" : dayName(first.date)}
        </Text>
        <Text style={[styles.axisText, { color: palette.sub }]}>
          {last === undefined ? "" : dayName(last.date)}
        </Text>
      </View>
    </View>
  );
}

function AnalyticsCard({
  title,
  hint,
  palette,
  children,
}: {
  title: string;
  hint?: string | undefined;
  palette: Palette;
  children: React.ReactNode;
}) {
  return (
    <View
      style={[styles.detailCard, { backgroundColor: palette.sheet, borderColor: palette.line }]}
    >
      <View style={styles.detailHeader}>
        <Text style={[styles.detailTitle, { color: palette.ink }]}>{title}</Text>
        {hint !== undefined && (
          <Text style={[styles.detailHint, { color: palette.sub }]}>{hint}</Text>
        )}
      </View>
      {children}
    </View>
  );
}

function ShareTrack({ share, palette }: { share: number; palette: Palette }) {
  return (
    <View accessible={false} style={[styles.shareTrack, { backgroundColor: palette.wash }]}>
      <View
        style={[
          styles.shareFill,
          { backgroundColor: palette.blue, width: `${Math.min(1, share) * 100}%` },
        ]}
      />
    </View>
  );
}

function Outcomes({ numbers, palette }: { numbers: Analytics; palette: Palette }) {
  const rows = [
    { key: "started", title: t("outcomeStarted"), count: numbers.started },
    {
      key: "answered",
      title: t("outcomeAnswered"),
      count: numbers.answered,
      note:
        numbers.answered < numbers.started
          ? t("outcomeWaiting", { count: numbers.started - numbers.answered })
          : undefined,
    },
    { key: "fast", title: t("outcomeFast"), count: numbers.firstReply.fast },
    {
      key: "closed",
      title: t("outcomeClosed"),
      count: numbers.closed,
      note:
        numbers.closed < numbers.started
          ? t("outcomeOpen", { count: numbers.started - numbers.closed })
          : undefined,
    },
  ];
  return (
    <AnalyticsCard title={t("outcomesTitle")} palette={palette}>
      <View style={styles.outcomes}>
        {rows.map((row) => {
          const share = shareOf(row.count, numbers.started);
          return (
            <View key={row.key} style={styles.outcomeRow}>
              <View style={styles.shareLine}>
                <Text style={[styles.shareName, { color: palette.ink }]}>{row.title}</Text>
                <Text style={[styles.shareCount, { color: palette.ink }]}>
                  {row.count.toLocaleString()}
                  <Text style={{ color: palette.sub }}> · {percent(share)}</Text>
                </Text>
              </View>
              <ShareTrack share={share} palette={palette} />
              {row.note !== undefined && (
                <Text style={[styles.outcomeNote, { color: palette.sub }]}>{row.note}</Text>
              )}
            </View>
          );
        })}
      </View>
    </AnalyticsCard>
  );
}

function heatColor(count: number, most: number, palette: Palette): string {
  if (count === 0) return palette.wash;
  const alpha = ["33", "66", "a3", "e6"][Math.ceil((count / most) * 4) - 1] ?? "e6";
  return `${palette.blue}${alpha}`;
}

function BusiestHours({ hours, palette }: { hours: Analytics["hours"]; palette: Palette }) {
  const most = Math.max(1, ...hours.flat());
  let peak = { day: 0, hour: 0, count: 0 };
  hours.forEach((row, day) => {
    row.forEach((count, hour) => {
      if (count > peak.count) peak = { day, hour, count };
    });
  });
  const peakDay = DAY_NAMES[peak.day] ?? "";
  const peakHour = HOUR_NAMES[peak.hour] ?? "";
  const summary = t("hoursSummary", {
    day: peakDay,
    hour: peakHour,
    conversations: conversations(peak.count),
  });
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={summary}>
      <AnalyticsCard
        title={t("hoursTitle")}
        hint={t("hoursBusiest", { day: peakDay, hour: peakHour })}
        palette={palette}
      >
        <View accessible={false}>
          <View style={styles.heatAxis}>
            <View style={styles.heatDay} />
            <View style={styles.heatHours}>
              {[0, 6, 12, 18].map((hour) => (
                <Text key={hour} style={[styles.heatHour, { color: palette.sub }]}>
                  {HOUR_NAMES[hour]}
                </Text>
              ))}
            </View>
          </View>
          {hours.map((row, day) => (
            <View key={DAY_NAMES[day] ?? day} style={styles.heatRow}>
              <Text style={[styles.heatDay, { color: palette.sub }]}>{DAY_NAMES_SHORT[day]}</Text>
              <View style={styles.heatCells}>
                {row.map((count, hour) => (
                  <View
                    // biome-ignore lint/suspicious/noArrayIndexKey: the hour cells do not move.
                    key={hour}
                    style={[
                      styles.heatCell,
                      {
                        backgroundColor: heatColor(count, most, palette),
                        borderColor:
                          day === peak.day && hour === peak.hour ? palette.ink : "transparent",
                      },
                    ]}
                  />
                ))}
              </View>
            </View>
          ))}
          <View style={styles.heatLegend}>
            <Text style={[styles.heatLegendText, { color: palette.sub }]}>{t("hoursFewer")}</Text>
            {[1, 2, 3, 4].map((level) => (
              <View
                key={level}
                style={[styles.heatSwatch, { backgroundColor: heatColor(level, 4, palette) }]}
              />
            ))}
            <Text style={[styles.heatLegendText, { color: palette.sub }]}>{t("hoursMore")}</Text>
          </View>
        </View>
      </AnalyticsCard>
    </View>
  );
}

type ShareRow = {
  key: string;
  name: string;
  count: number;
  avatar?: string | undefined;
  color?: string | undefined;
};

function ShareList({
  title,
  empty,
  total,
  rows,
  palette,
}: {
  title: string;
  empty: string;
  total: number;
  rows: ShareRow[];
  palette: Palette;
}) {
  return (
    <AnalyticsCard title={title} palette={palette}>
      {rows.length === 0 ? (
        <Text style={[styles.listEmpty, { color: palette.sub }]}>{empty}</Text>
      ) : (
        <View style={styles.shareList}>
          {rows.map((row) => {
            const share = shareOf(row.count, total);
            return (
              <View key={row.key} style={styles.shareRow}>
                <View style={styles.shareLine}>
                  {row.avatar !== undefined && (
                    <Avatar name={row.avatar} size={30} palette={palette} />
                  )}
                  {row.color !== undefined && (
                    <View style={[styles.labelDot, { backgroundColor: row.color }]} />
                  )}
                  <Text numberOfLines={1} style={[styles.shareName, { color: palette.ink }]}>
                    {row.name}
                  </Text>
                  <Text style={[styles.shareCount, { color: palette.ink }]}>
                    {row.count.toLocaleString()}
                    <Text style={{ color: palette.sub }}> · {percent(share)}</Text>
                  </Text>
                </View>
                <ShareTrack share={share} palette={palette} />
              </View>
            );
          })}
        </View>
      )}
    </AnalyticsCard>
  );
}

function Repliers({ numbers, palette }: { numbers: Analytics; palette: Palette }) {
  const rows = numbers.repliers.map((replier): ShareRow => {
    if (replier.kind === "operator") {
      return {
        key: `operator:${replier.operatorId}`,
        avatar: replier.name,
        name: replier.name,
        count: replier.conversations,
      };
    }
    if (replier.kind === "api_key") {
      return {
        key: `api:${replier.apiKeyId}`,
        avatar: replier.name,
        name: t("apiKeyAuthor", { name: replier.name }),
        count: replier.conversations,
      };
    }
    return {
      key: "former",
      avatar: t("formerOperator"),
      name: t("formerOperator"),
      count: replier.conversations,
    };
  });
  return (
    <ShareList
      title={t("byOperatorTitle")}
      empty={t("noReplies")}
      total={numbers.answered}
      rows={rows}
      palette={palette}
    />
  );
}

function Labels({ numbers, palette }: { numbers: Analytics; palette: Palette }) {
  return (
    <ShareList
      title={t("byLabelTitle")}
      empty={t("noLabeledConversations")}
      total={numbers.started}
      rows={numbers.labels.map((label) => ({
        key: label.labelId,
        name: label.name,
        count: label.conversations,
        color: LABEL_COLORS[label.color],
      }))}
      palette={palette}
    />
  );
}

function LoadingState({ palette }: { palette: Palette }) {
  return (
    <View accessibilityLabel={t("loading")} style={styles.centerState}>
      <ActivityIndicator color={palette.blue} size="large" />
      <Text style={[styles.stateBody, { color: palette.sub }]}>{t("loading")}</Text>
    </View>
  );
}

function ErrorState({
  error,
  onRetry,
  palette,
}: {
  error: string;
  onRetry(): void;
  palette: Palette;
}) {
  return (
    <View style={styles.centerState}>
      <View style={[styles.stateIcon, { backgroundColor: palette.wash }]}>
        <Icon name="chart" color={palette.amber} size={26} />
      </View>
      <Text style={[styles.stateTitle, { color: palette.ink }]}>{error}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [
          styles.retry,
          { backgroundColor: palette.ink, opacity: pressed ? 0.72 : 1 },
        ]}
      >
        <Text style={[styles.retryText, { color: palette.paper }]}>{t("mobileRetry")}</Text>
      </Pressable>
    </View>
  );
}

function EmptyState({ days, palette }: { days: AnalyticsDays; palette: Palette }) {
  return (
    <View style={styles.centerState}>
      <View style={[styles.stateIcon, { backgroundColor: palette.tint }]}>
        <Icon name="inbox" color={palette.blue} size={27} />
      </View>
      <Text style={[styles.stateTitle, { color: palette.ink }]}>
        {t("analyticsEmpty", { days })}
      </Text>
      <Text style={[styles.stateBody, { color: palette.sub }]}>{t("analyticsEmptyHint")}</Text>
    </View>
  );
}

export function AnalyticsScreen({
  api,
  palette,
  topInset,
  bottomInset,
}: {
  api: DinghyApi;
  palette: Palette;
  topInset: number;
  bottomInset: number;
}) {
  const [days, setDays] = useState<AnalyticsDays>(30);
  const [numbers, setNumbers] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const zone = useMemo(browserTimeZone, []);

  const load = useCallback(
    async (reset: boolean) => {
      const current = ++request.current;
      if (reset) setNumbers(null);
      setError(null);
      setLoading(true);
      try {
        const next = await api.analytics(days, zone);
        if (request.current === current) setNumbers(next);
      } catch (reason) {
        if (request.current === current) setError(readableError(reason));
      } finally {
        if (request.current === current) setLoading(false);
      }
    },
    [api, days, zone],
  );

  useEffect(() => {
    void load(true);
    return () => {
      request.current += 1;
    };
  }, [load]);

  const changeDays = useCallback((next: AnalyticsDays) => {
    setNumbers(null);
    setError(null);
    setDays(next);
  }, []);

  const firstReply = numbers?.firstReply;
  const answeredShare = numbers === null ? 0 : shareOf(numbers.answered, numbers.started);
  const fastShare = numbers === null ? 0 : shareOf(firstReply?.fast ?? 0, numbers.started);

  return (
    <View style={[styles.screen, { backgroundColor: palette.paper }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: topInset + 18, paddingBottom: bottomInset + 28 },
        ]}
        refreshControl={
          numbers !== null ? (
            <RefreshControl
              refreshing={loading}
              onRefresh={() => void load(false)}
              tintColor={palette.blue}
            />
          ) : undefined
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: palette.ink }]}>{t("analytics")}</Text>
          <Text style={[styles.context, { color: palette.sub }]}>
            {t("analyticsContext", { days, zone })}
          </Text>
          <PeriodPicker days={days} onChange={changeDays} palette={palette} />
        </View>

        {numbers === null && loading ? (
          <LoadingState palette={palette} />
        ) : numbers === null && error !== null ? (
          <ErrorState error={error} onRetry={() => void load(true)} palette={palette} />
        ) : numbers === null || numbers.started === 0 ? (
          <EmptyState days={days} palette={palette} />
        ) : (
          <>
            {error !== null && (
              <Pressable
                accessibilityRole="button"
                onPress={() => void load(false)}
                style={[styles.inlineError, { backgroundColor: palette.warm }]}
              >
                <Text style={[styles.inlineErrorText, { color: palette.amber }]}>{error}</Text>
                <Text style={[styles.inlineRetry, { color: palette.amber }]}>
                  {t("mobileRetry")}
                </Text>
              </Pressable>
            )}
            <View accessibilityLabel={t("statsTitle")} style={styles.statsGrid}>
              <StatCard
                title={t("statStarted")}
                value={numbers.started.toLocaleString()}
                note={
                  numbers.startedByTeam > 0
                    ? t("statStartedByTeam", { count: numbers.startedByTeam })
                    : undefined
                }
                change={startedChange(numbers, days)}
                palette={palette}
              />
              <StatCard
                title={t("statMedian")}
                value={
                  firstReply?.medianSeconds === null || firstReply?.medianSeconds === undefined
                    ? t("noReplies")
                    : duration(firstReply.medianSeconds)
                }
                note={
                  firstReply?.p90Seconds === null || firstReply?.p90Seconds === undefined
                    ? undefined
                    : t("statP90", { time: duration(firstReply.p90Seconds) })
                }
                change={medianChange(numbers, days)}
                palette={palette}
              />
              <StatCard
                title={t("statFast")}
                value={percent(fastShare)}
                change={fastChange(numbers, days)}
                palette={palette}
              />
              <StatCard
                title={t("statAnswered")}
                value={percent(answeredShare)}
                note={t("statAnsweredOf", {
                  answered: numbers.answered,
                  started: numbers.started,
                })}
                change={null}
                palette={palette}
              />
            </View>
            {numbers.perDay.length > 0 && <DailyTrend days={numbers.perDay} palette={palette} />}
            <Outcomes numbers={numbers} palette={palette} />
            {numbers.hours.length > 0 && <BusiestHours hours={numbers.hours} palette={palette} />}
            <Repliers numbers={numbers} palette={palette} />
            <Labels numbers={numbers} palette={palette} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 16 },
  header: { gap: 6, marginBottom: 22 },
  title: { fontFamily: fonts.displayBold, fontSize: 34, lineHeight: 39, letterSpacing: -0.6 },
  context: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, maxWidth: 560 },
  periods: {
    alignSelf: "flex-start",
    flexDirection: "row",
    borderRadius: 22,
    backgroundColor: "rgba(128, 145, 153, 0.13)",
    marginTop: 9,
    padding: 3,
  },
  period: { minHeight: 38, justifyContent: "center", paddingHorizontal: 15, borderRadius: 19 },
  periodText: { fontFamily: fonts.semibold, fontSize: 13 },
  centerState: {
    flex: 1,
    minHeight: 300,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 26,
    paddingVertical: 34,
  },
  stateIcon: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  stateTitle: {
    fontFamily: fonts.display,
    fontSize: 20,
    lineHeight: 25,
    textAlign: "center",
  },
  stateBody: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, textAlign: "center" },
  retry: { minHeight: 42, justifyContent: "center", borderRadius: 21, paddingHorizontal: 20 },
  retryText: { fontFamily: fonts.semibold, fontSize: 14 },
  inlineError: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginBottom: 12,
  },
  inlineErrorText: { flex: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  inlineRetry: { fontFamily: fonts.bold, fontSize: 13 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statCard: {
    flexBasis: "47%",
    flexGrow: 1,
    minHeight: 168,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    padding: 15,
  },
  statTitle: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 17, minHeight: 34 },
  statValue: {
    fontFamily: fonts.displayBold,
    fontSize: 29,
    lineHeight: 35,
    letterSpacing: -0.4,
    marginTop: 6,
  },
  statNote: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16, marginTop: 4 },
  change: {
    fontFamily: fonts.medium,
    fontSize: 11,
    lineHeight: 15,
    marginTop: "auto",
    paddingTop: 8,
  },
  trendCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    marginTop: 10,
    paddingHorizontal: 15,
    paddingTop: 16,
    paddingBottom: 12,
  },
  trendHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  trendHeading: { flex: 1, paddingEnd: 10 },
  trendTitle: { fontFamily: fonts.display, fontSize: 19, lineHeight: 24 },
  trendHint: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17, marginTop: 2 },
  trendMaximum: { fontFamily: fonts.semibold, fontSize: 12, lineHeight: 17 },
  trendAxis: { flexDirection: "row", justifyContent: "space-between", marginTop: -10 },
  axisText: { fontFamily: fonts.medium, fontSize: 11 },
  detailCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    marginTop: 10,
    padding: 15,
  },
  detailHeader: { gap: 2, marginBottom: 15 },
  detailTitle: { fontFamily: fonts.display, fontSize: 19, lineHeight: 24 },
  detailHint: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
  outcomes: { gap: 15 },
  outcomeRow: { gap: 7 },
  shareLine: { flexDirection: "row", alignItems: "center", gap: 9 },
  shareName: { flex: 1, fontFamily: fonts.medium, fontSize: 14, lineHeight: 19 },
  shareCount: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 18 },
  shareTrack: { height: 5, borderRadius: 3, overflow: "hidden" },
  shareFill: { height: "100%", borderRadius: 3 },
  outcomeNote: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16 },
  heatAxis: { flexDirection: "row", alignItems: "flex-end", marginBottom: 5 },
  heatHours: { flex: 1, flexDirection: "row", justifyContent: "space-between" },
  heatHour: { width: 36, fontFamily: fonts.medium, fontSize: 9, lineHeight: 12 },
  heatRow: { flexDirection: "row", alignItems: "center", minHeight: 17 },
  heatDay: { width: 30, fontFamily: fonts.medium, fontSize: 10, lineHeight: 14 },
  heatCells: { flex: 1, flexDirection: "row", gap: 2 },
  heatCell: { flex: 1, height: 11, borderWidth: 1, borderRadius: 2 },
  heatLegend: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
    marginTop: 9,
  },
  heatLegendText: { fontFamily: fonts.body, fontSize: 10, lineHeight: 14 },
  heatSwatch: { width: 11, height: 11, borderRadius: 2 },
  shareList: { gap: 16 },
  shareRow: { gap: 7 },
  listEmpty: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  labelDot: { width: 10, height: 10, borderRadius: 5 },
});
