import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  ActivityIndicator,
  PanResponder,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Line, Path, Rect } from "react-native-svg";
import { browserTimeZone, weekdayNames } from "../../operator/src/format.ts";
import { t } from "../../operator/src/text.ts";
import {
  type Analytics,
  type AnalyticsDays,
  averageText,
  barLayout,
  type Change,
  calendarDay,
  chats,
  dailySummary,
  dayAt,
  heatLevel,
  type Metric,
  metricCell,
  metricDetail,
  peakSlot,
  percent,
  shareOf,
  twoHourSlots,
  zoneName,
} from "./analytics-logic";
import { AnalyticsScene } from "./analytics-scene";
import type { DinghyApi } from "./api";
import { Avatar, readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { usePinnedHeaderLayout } from "./pinned-header";
import { Sheet } from "./sheet";
import { useTabBarInset } from "./tab-bar-inset";
import { night, type Palette } from "./theme";

const PERIODS: AnalyticsDays[] = [7, 30, 90];
const METRICS: Metric[] = ["started", "median", "fast", "answered"];
const DAY_NAMES_SHORT = weekdayNames("short");
const DAY_NAMES = weekdayNames("long");
const HOUR_NAMES = Array.from({ length: 24 }, (_, hour) =>
  new Date(2024, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" }),
);
const CHART_HEIGHT = 132;
const CHART_TOP = 16;
const CHART_BASE = CHART_HEIGHT - 2;

// The operator web app's tokens (app.css): the night sky of the pixel scenes and the heat ramp.
const HEAT = {
  day: ["#d6e4ff", "#9dbdff", "#5b8fff", "#1f5ad6"],
  night: ["#1d3558", "#24508f", "#3a74d6", "#7fb0ff"],
};

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

const longDay = (date: string) =>
  calendarDay(date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const shortDay = (date: string) =>
  calendarDay(date).toLocaleDateString([], { month: "short", day: "numeric" });
const slotName = (day: number, slot: number) =>
  t("mobileHoursSlot", {
    day: DAY_NAMES_SHORT[day] ?? "",
    from: HOUR_NAMES[slot * 2] ?? "",
    to: HOUR_NAMES[(slot * 2 + 2) % 24] ?? "",
  });

function changeColor(change: Change, palette: Palette): string {
  if (change?.kind === "better") return palette.green;
  if (change?.kind === "worse") return palette.amber;
  return palette.sub;
}

function stepAction(event: AccessibilityActionEvent): 1 | -1 | 0 {
  if (event.nativeEvent.actionName === "increment") return 1;
  if (event.nativeEvent.actionName === "decrement") return -1;
  return 0;
}

const ADJUSTABLE_ACTIONS: AccessibilityActionInfo[] = [
  { name: "increment" },
  { name: "decrement" },
];

function AnalyticsHeader({
  days,
  hasLargeText,
  zone,
  palette,
}: {
  days: AnalyticsDays;
  hasLargeText: boolean;
  zone: string;
  palette: Palette;
}) {
  const dark = palette === night;
  const sky = palette.analyticsSky;
  return (
    <View style={[styles.header, hasLargeText && styles.largeHeader, { backgroundColor: sky }]}>
      {/* The sky continues above the header when the page bounces. */}
      <View pointerEvents="none" style={[styles.headerBounce, { backgroundColor: sky }]} />
      <AnalyticsScene dark={dark} />
      <Text accessibilityRole="header" style={[styles.title, { color: palette.coverInk }]}>
        {t("analytics")}
      </Text>
      <Text
        style={[styles.subtitle, hasLargeText && styles.wideSubtitle, { color: palette.coverSub }]}
      >
        {t("mobileAnalyticsSubtitle", { days, zone: zoneName(zone) })}
      </Text>
    </View>
  );
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
    <View
      accessibilityLabel={t("period")}
      accessibilityRole="radiogroup"
      style={[styles.periods, { backgroundColor: palette.wash }]}
    >
      {PERIODS.map((period) => {
        const selected = days === period;
        return (
          <Pressable
            key={period}
            accessibilityRole="radio"
            accessibilityLabel={t("mobileAnalyticsPeriod", { days: period })}
            accessibilityState={{ checked: selected }}
            onPress={() => {
              if (!selected) onChange(period);
            }}
            style={({ pressed }) => [
              styles.period,
              {
                backgroundColor: selected ? palette.sheet : "transparent",
                borderColor: selected ? palette.line : "transparent",
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.periodText,
                { color: selected ? palette.ink : palette.sub },
                selected && { fontFamily: fonts.bold },
              ]}
            >
              {t(period === 7 ? "period7" : period === 30 ? "period30" : "period90")}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Metrics({
  numbers,
  days,
  open,
  onOpen,
  palette,
}: {
  numbers: Analytics;
  days: AnalyticsDays;
  open: Metric | null;
  onOpen(metric: Metric): void;
  palette: Palette;
}) {
  return (
    <View
      accessibilityLabel={t("statsTitle")}
      style={[
        styles.card,
        styles.metrics,
        { backgroundColor: palette.sheet, borderColor: palette.line },
      ]}
    >
      {METRICS.map((metric, index) => {
        const cell = metricCell(metric, numbers, days);
        const selected = open === metric;
        return (
          <Pressable
            key={metric}
            accessibilityRole="button"
            accessibilityLabel={[cell.title, cell.value, cell.detail, cell.change?.text]
              .filter(Boolean)
              .join(", ")}
            accessibilityHint={t("mobileMetricHint")}
            onPress={() => onOpen(metric)}
            style={({ pressed }) => [
              styles.metric,
              {
                borderColor: palette.line,
                borderRightWidth: index % 2 === 0 ? StyleSheet.hairlineWidth : 0,
                borderBottomWidth: index < 2 ? StyleSheet.hairlineWidth : 0,
                backgroundColor: pressed || selected ? palette.wash : "transparent",
              },
            ]}
          >
            <View style={styles.metricTop}>
              <Text numberOfLines={1} style={[styles.metricTitle, { color: palette.sub }]}>
                {cell.title}
              </Text>
              <Icon name="next" size={13} color={palette.sub} />
            </View>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={[styles.metricValue, { color: palette.ink }]}
            >
              {cell.value}
            </Text>
            <Text numberOfLines={1} style={[styles.metricDetail, { color: palette.sub }]}>
              {cell.detail}
            </Text>
            {cell.change !== null && (
              <Text
                numberOfLines={2}
                style={[styles.metricChange, { color: changeColor(cell.change, palette) }]}
              >
                {cell.change.text}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function MetricSheet({
  metric,
  numbers,
  days,
  zone,
  onClose,
  palette,
}: {
  metric: Metric | null;
  numbers: Analytics;
  days: AnalyticsDays;
  zone: string;
  onClose(): void;
  palette: Palette;
}) {
  // Keep the last number while the sheet slides away.
  const [shown, setShown] = useState<Metric>(metric ?? "started");
  if (metric !== null && metric !== shown) setShown(metric);
  const cell = metricCell(shown, numbers, days);
  const detail = metricDetail(shown, numbers, days, zone);
  return (
    <Sheet visible={metric !== null} onClose={onClose} palette={palette} title={cell.title}>
      <View style={styles.sheetBody}>
        <Text style={[styles.sheetValue, { color: palette.ink }]}>{cell.value}</Text>
        {cell.change !== null && (
          <Text style={[styles.sheetChange, { color: changeColor(cell.change, palette) }]}>
            {cell.change.text}
          </Text>
        )}
        <Text style={[styles.sheetHelp, { color: palette.sub }]}>{detail.help}</Text>
        <View style={[styles.sheetRows, { borderColor: palette.line }]}>
          {detail.rows.map(([label, value]) => (
            <View
              key={label}
              accessible
              accessibilityLabel={`${label}, ${value}`}
              style={[styles.sheetRow, { borderColor: palette.line }]}
            >
              <Text style={[styles.sheetRowLabel, { color: palette.sub }]}>{label}</Text>
              <Text style={[styles.sheetRowValue, { color: palette.ink }]}>{value}</Text>
            </View>
          ))}
        </View>
      </View>
    </Sheet>
  );
}

function Card({
  title,
  hint,
  palette,
  children,
}: {
  title: string;
  hint?: string | undefined;
  palette: Palette;
  children: ReactNode;
}) {
  return (
    <View
      style={[
        styles.card,
        styles.cardPad,
        { backgroundColor: palette.sheet, borderColor: palette.line },
      ]}
    >
      <View style={styles.cardHeader}>
        <Text accessibilityRole="header" style={[styles.cardTitle, { color: palette.ink }]}>
          {title}
        </Text>
        {hint !== undefined && (
          <Text style={[styles.cardHint, { color: palette.sub }]}>{hint}</Text>
        )}
      </View>
      {children}
    </View>
  );
}

function StepButton({
  icon,
  label,
  disabled = false,
  onPress,
  palette,
}: {
  icon: "back" | "next" | "x";
  label: string;
  disabled?: boolean;
  onPress(): void;
  palette: Palette;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.step,
        { backgroundColor: palette.wash, opacity: disabled ? 0.35 : pressed ? 0.6 : 1 },
      ]}
    >
      <Icon name={icon} size={16} color={palette.ink} />
    </Pressable>
  );
}

function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(3, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function DailyChart({ perDay, palette }: { perDay: Analytics["perDay"]; palette: Palette }) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const summary = useMemo(() => dailySummary(perDay), [perDay]);
  const count = perDay.length;
  const layout = barLayout(count, width);
  const plot = CHART_BASE - CHART_TOP;
  const averageY = CHART_BASE - (summary.average / summary.most) * plot;
  const busiest = perDay[summary.busiest];
  const day = selected === null ? undefined : perDay[selected];

  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const gesture = useRef({ start: 0, before: null as number | null, last: -1 });
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const index = dayAt(event.nativeEvent.locationX, width, count);
          gesture.current.start = event.nativeEvent.locationX;
          gesture.current.last = index;
          gesture.current.before = selectedNow.current;
        },
        onPanResponderMove: (_, move) => {
          if (Math.abs(move.dx) < Math.max(4, Math.abs(move.dy))) return;
          const index = dayAt(gesture.current.start + move.dx, width, count);
          if (index === gesture.current.last) return;
          gesture.current.last = index;
          setSelected(index);
        },
        onPanResponderRelease: (_, move) => {
          // A second tap on the same bar clears it.
          const tap = Math.abs(move.dx) < 4 && Math.abs(move.dy) < 4;
          if (tap) {
            const { before, last } = gesture.current;
            setSelected(before === last ? null : last);
          }
        },
      }),
    [count, width],
  );

  const step = (by: number) =>
    setSelected((current) =>
      Math.min(count - 1, Math.max(0, current === null ? (by > 0 ? 0 : count - 1) : current + by)),
    );

  const dayText = (index: number) => {
    const item = perDay[index];
    return item === undefined
      ? ""
      : t("mobileChartDay", { day: longDay(item.date), chats: chats(item.conversations) });
  };
  const overview =
    busiest === undefined
      ? ""
      : t("mobileChartSummary", {
          chats: chats(summary.total),
          days: count,
          average: averageText(summary.average),
          day: longDay(busiest.date),
          busiest: chats(busiest.conversations),
        });

  return (
    <Card title={t("mobileChartTitle")} palette={palette}>
      <View style={styles.readout}>
        {day === undefined || selected === null ? (
          <View style={styles.readoutText}>
            <Text style={[styles.readoutMain, { color: palette.ink }]}>
              {busiest === undefined
                ? ""
                : t("mobileChartBusiest", {
                    day: longDay(busiest.date),
                    chats: chats(busiest.conversations),
                  })}
            </Text>
            <Text style={[styles.readoutHint, { color: palette.sub }]}>{t("mobileChartHint")}</Text>
          </View>
        ) : (
          <>
            <StepButton
              icon="back"
              label={t("mobileChartPrevious")}
              disabled={selected === 0}
              onPress={() => step(-1)}
              palette={palette}
            />
            <Text
              accessibilityLiveRegion="polite"
              numberOfLines={1}
              style={[styles.readoutSelected, { color: palette.ink }]}
            >
              {dayText(selected)}
            </Text>
            <StepButton
              icon="next"
              label={t("mobileChartNext")}
              disabled={selected === count - 1}
              onPress={() => step(1)}
              palette={palette}
            />
            <StepButton
              icon="x"
              label={t("mobileChartClear")}
              onPress={() => setSelected(null)}
              palette={palette}
            />
          </>
        )}
      </View>
      <View style={styles.chart} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 && (
          <Svg width={width} height={CHART_HEIGHT}>
            {perDay.map((item, index) => {
              const x = layout.x(index);
              if (item.conversations === 0) {
                return (
                  <Rect
                    key={item.date}
                    x={x}
                    y={CHART_BASE - 2}
                    width={layout.bar}
                    height={2}
                    fill={index === selected ? palette.blue : palette.line}
                  />
                );
              }
              const height = Math.max(3, (item.conversations / summary.most) * plot);
              return (
                <Path
                  key={item.date}
                  d={barPath(x, CHART_BASE - height, layout.bar, height)}
                  fill={palette.blue}
                  opacity={selected === null || selected === index ? 1 : 0.3}
                />
              );
            })}
            <Line
              x1={0}
              x2={width}
              y1={averageY}
              y2={averageY}
              stroke={palette.sub}
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          </Svg>
        )}
        <Text
          style={[
            styles.averageLabel,
            { color: palette.sub, backgroundColor: palette.sheet, top: Math.max(0, averageY - 17) },
          ]}
        >
          {t("mobileChartAverage", { value: averageText(summary.average) })}
        </Text>
        <View
          {...responder.panHandlers}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={t("mobileChartTitle")}
          accessibilityValue={{ text: selected === null ? overview : dayText(selected) }}
          accessibilityActions={ADJUSTABLE_ACTIONS}
          onAccessibilityAction={(event) => {
            const by = stepAction(event);
            if (by !== 0) step(by);
          }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <View accessible={false} style={styles.axis}>
        {summary.axis.map((index, position) => {
          const item = perDay[index];
          return (
            <Text
              key={index}
              style={[
                styles.axisText,
                { color: palette.sub },
                position === 0
                  ? styles.axisStart
                  : position === summary.axis.length - 1
                    ? styles.axisEnd
                    : styles.axisMiddle,
              ]}
            >
              {item === undefined ? "" : shortDay(item.date)}
            </Text>
          );
        })}
      </View>
    </Card>
  );
}

type Row = {
  key: string;
  name: string;
  count: number;
  detail: string;
  leading?: ReactNode;
};

function BreakdownRows({
  rows,
  total,
  inline = false,
  palette,
}: {
  rows: Row[];
  total: number;
  inline?: boolean;
  palette: Palette;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <View style={styles.rows}>
      {rows.map((row) => {
        const share = shareOf(row.count, total);
        const expanded = open === row.key;
        const amount = (
          <Text style={[styles.rowCount, { color: palette.ink }]}>
            {row.count.toLocaleString()}
            <Text style={{ color: palette.sub }}> · {percent(share)}</Text>
          </Text>
        );
        const track = (
          <View
            style={[styles.track, inline && styles.trackInline, { backgroundColor: palette.wash }]}
          >
            <View
              style={[
                styles.trackFill,
                { backgroundColor: palette.blue, width: `${Math.min(1, share) * 100}%` },
              ]}
            />
          </View>
        );
        return (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={`${row.name}, ${row.count.toLocaleString()}, ${percent(share)}`}
            accessibilityHint={t("mobileRowHint")}
            accessibilityState={{ expanded }}
            onPress={() => setOpen(expanded ? null : row.key)}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
          >
            {inline ? (
              <View style={styles.rowLine}>
                <Text
                  numberOfLines={2}
                  style={[styles.rowName, styles.rowNameInline, { color: palette.ink }]}
                >
                  {row.name}
                </Text>
                {track}
                {amount}
              </View>
            ) : (
              <View style={styles.rowLine}>
                {row.leading}
                <View style={styles.rowStack}>
                  <View style={styles.rowLine}>
                    <Text numberOfLines={1} style={[styles.rowName, { color: palette.ink }]}>
                      {row.name}
                    </Text>
                    {amount}
                  </View>
                  {track}
                </View>
              </View>
            )}
            {expanded && (
              <Text
                style={[styles.rowDetail, { color: palette.sub, backgroundColor: palette.wash }]}
              >
                {row.detail}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function Outcomes({ numbers, palette }: { numbers: Analytics; palette: Palette }) {
  const { started, answered, closed, startedByTeam } = numbers;
  const fast = numbers.firstReply.fast;
  const total = started.toLocaleString();
  const rows: Row[] = [
    {
      key: "started",
      name: t("outcomeStarted"),
      count: started,
      detail:
        startedByTeam > 0
          ? t("mobileOutcomeStartedTeam", { count: startedByTeam.toLocaleString(), total })
          : t("mobileOutcomeStartedVisitors", { total }),
    },
    {
      key: "answered",
      name: t("outcomeAnswered"),
      count: answered,
      detail:
        answered < started
          ? t("mobileOutcomeAnsweredSome", {
              count: answered.toLocaleString(),
              total,
              rest: (started - answered).toLocaleString(),
            })
          : t("mobileOutcomeAnsweredAll", { total }),
    },
    {
      key: "fast",
      name: t("outcomeFast"),
      count: fast,
      detail: t("mobileOutcomeFastDetail", { count: fast.toLocaleString(), total }),
    },
    {
      key: "closed",
      name: t("outcomeClosed"),
      count: closed,
      detail:
        closed < started
          ? t("mobileOutcomeClosedSome", {
              count: closed.toLocaleString(),
              total,
              rest: (started - closed).toLocaleString(),
            })
          : t("mobileOutcomeClosedAll", { total }),
    },
  ];
  return (
    <Card
      title={t("mobileOutcomesTitle")}
      hint={t("mobileOutcomesOf", { count: total })}
      palette={palette}
    >
      <BreakdownRows rows={rows} total={started} inline palette={palette} />
    </Card>
  );
}

function BusiestHours({ hours, palette }: { hours: Analytics["hours"]; palette: Palette }) {
  const slots = useMemo(() => twoHourSlots(hours), [hours]);
  const peak = useMemo(() => peakSlot(slots), [slots]);
  const filled = useMemo(
    () =>
      slots.flatMap((row, day) => row.flatMap((count, slot) => (count > 0 ? [{ day, slot }] : []))),
    [slots],
  );
  const [selected, setSelected] = useState<{ day: number; slot: number } | null>(null);
  const ramp = palette === night ? HEAT.night : HEAT.day;
  const most = peak?.count ?? 1;
  const cellText = (day: number, slot: number) =>
    t("mobileHoursCell", { slot: slotName(day, slot), chats: chats(slots[day]?.[slot] ?? 0) });
  const busiest =
    peak === null
      ? ""
      : t("mobileHoursBusiest", { slot: slotName(peak.day, peak.slot), chats: chats(peak.count) });

  const step = (by: number) => {
    if (filled.length === 0) return;
    const at =
      selected === null
        ? -1
        : filled.findIndex((cell) => cell.day === selected.day && cell.slot === selected.slot);
    const next =
      at === -1 ? (by > 0 ? 0 : filled.length - 1) : (at + by + filled.length) % filled.length;
    setSelected(filled[next] ?? null);
  };

  return (
    <Card title={t("hoursTitle")} palette={palette}>
      <View style={styles.readout}>
        {selected === null ? (
          <View style={styles.readoutText}>
            <Text style={[styles.readoutMain, { color: palette.ink }]}>{busiest}</Text>
            <Text style={[styles.readoutHint, { color: palette.sub }]}>{t("mobileHoursHint")}</Text>
          </View>
        ) : (
          <>
            <Text
              accessibilityLiveRegion="polite"
              numberOfLines={1}
              style={[styles.readoutSelected, { color: palette.ink }]}
            >
              {cellText(selected.day, selected.slot)}
            </Text>
            <StepButton
              icon="x"
              label={t("mobileChartClear")}
              onPress={() => setSelected(null)}
              palette={palette}
            />
          </>
        )}
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t("hoursTitle")}
        accessibilityValue={{
          text: selected === null ? busiest : cellText(selected.day, selected.slot),
        }}
        accessibilityActions={ADJUSTABLE_ACTIONS}
        onAccessibilityAction={(event) => {
          const by = stepAction(event);
          if (by !== 0) step(by);
        }}
      >
        <View style={styles.heatAxis}>
          <View style={styles.heatDay} />
          {[0, 3, 6, 9].map((slot) => (
            <Text key={slot} numberOfLines={1} style={[styles.heatHour, { color: palette.sub }]}>
              {HOUR_NAMES[slot * 2]}
            </Text>
          ))}
        </View>
        {slots.map((row, day) => (
          <View key={DAY_NAMES[day] ?? day} style={styles.heatRow}>
            <Text style={[styles.heatDay, { color: palette.sub }]}>{DAY_NAMES_SHORT[day]}</Text>
            {row.map((count, slot) => {
              const level = heatLevel(count, most);
              const active = selected?.day === day && selected.slot === slot;
              return (
                <Pressable
                  // biome-ignore lint/suspicious/noArrayIndexKey: the slots do not move.
                  key={slot}
                  accessible={false}
                  hitSlop={1}
                  onPress={() => setSelected(active ? null : { day, slot })}
                  style={[
                    styles.heatCell,
                    {
                      backgroundColor: level === 0 ? palette.wash : ramp[level - 1],
                      borderColor: active ? palette.ink : "transparent",
                    },
                  ]}
                />
              );
            })}
          </View>
        ))}
        <View style={styles.heatLegend}>
          <Text style={[styles.heatLegendText, { color: palette.sub }]}>{t("hoursFewer")}</Text>
          {ramp.map((color) => (
            <View key={color} style={[styles.heatSwatch, { backgroundColor: color }]} />
          ))}
          <Text style={[styles.heatLegendText, { color: palette.sub }]}>{t("hoursMore")}</Text>
        </View>
      </View>
    </Card>
  );
}

function Repliers({ numbers, palette }: { numbers: Analytics; palette: Palette }) {
  const total = numbers.answered;
  const rows = numbers.repliers.map((replier): Row => {
    const name =
      replier.kind === "operator"
        ? replier.name
        : replier.kind === "api_key"
          ? t("apiKeyAuthor", { name: replier.name })
          : t("formerOperator");
    return {
      key:
        replier.kind === "operator"
          ? `operator:${replier.operatorId}`
          : replier.kind === "api_key"
            ? `api:${replier.apiKeyId}`
            : "former",
      name,
      count: replier.conversations,
      leading: (
        <Avatar
          name={replier.kind === "former" ? name : replier.name}
          size={28}
          palette={palette}
        />
      ),
      detail: t("mobileReplierDetail", {
        name,
        count: replier.conversations.toLocaleString(),
        total: total.toLocaleString(),
      }),
    };
  });
  return (
    <Card
      title={t("mobileRepliersTitle")}
      hint={
        rows.length === 0 ? undefined : t("mobileRepliersOf", { count: total.toLocaleString() })
      }
      palette={palette}
    >
      {rows.length === 0 ? (
        <Text style={[styles.cardEmpty, { color: palette.sub }]}>{t("noReplies")}</Text>
      ) : (
        <BreakdownRows rows={rows} total={total} palette={palette} />
      )}
    </Card>
  );
}

function Labels({ numbers, palette }: { numbers: Analytics; palette: Palette }) {
  const total = numbers.started;
  const rows = numbers.labels.map(
    (label): Row => ({
      key: label.labelId,
      name: label.name,
      count: label.conversations,
      leading: <View style={[styles.labelDot, { backgroundColor: LABEL_COLORS[label.color] }]} />,
      detail: t("mobileLabelDetail", {
        count: label.conversations.toLocaleString(),
        total: total.toLocaleString(),
        name: label.name,
      }),
    }),
  );
  return (
    <Card
      title={t("mobileLabelsTitle")}
      hint={rows.length === 0 ? undefined : t("mobileLabelsOf", { count: total.toLocaleString() })}
      palette={palette}
    >
      {rows.length === 0 ? (
        <Text style={[styles.cardEmpty, { color: palette.sub }]}>{t("mobileLabelsEmpty")}</Text>
      ) : (
        <BreakdownRows rows={rows} total={total} palette={palette} />
      )}
    </Card>
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
}: {
  api: DinghyApi;
  palette: Palette;
  topInset: number;
}) {
  const { hasLargeText, hideScene } = usePinnedHeaderLayout();
  const dockInset = useTabBarInset();
  const [days, setDays] = useState<AnalyticsDays>(30);
  const [numbers, setNumbers] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<Metric | null>(null);
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
    setMetric(null);
    setDays(next);
  }, []);

  return (
    <View style={[styles.screen, { backgroundColor: palette.paper, paddingTop: topInset }]}>
      <View>
        {!hideScene && (
          <AnalyticsHeader
            days={days}
            hasLargeText={hasLargeText}
            zone={numbers?.timeZone ?? zone}
            palette={palette}
          />
        )}
      </View>
      <View style={styles.controls}>
        <PeriodPicker days={days} onChange={changeDays} palette={palette} />
      </View>
      <ScrollView
        alwaysBounceVertical
        contentContainerStyle={[styles.content, { paddingBottom: dockInset }]}
        refreshControl={
          numbers !== null ? (
            <RefreshControl
              refreshing={loading}
              onRefresh={() => void load(false)}
              tintColor={palette === night ? palette.ink : palette.blue}
            />
          ) : undefined
        }
        style={styles.list}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.body}>
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
              <Metrics
                numbers={numbers}
                days={days}
                open={metric}
                onOpen={setMetric}
                palette={palette}
              />
              {numbers.perDay.length > 0 && (
                <DailyChart
                  key={`${days}:${numbers.perDay[0]?.date}`}
                  perDay={numbers.perDay}
                  palette={palette}
                />
              )}
              <Outcomes numbers={numbers} palette={palette} />
              {numbers.hours.length > 0 && (
                <BusiestHours key={days} hours={numbers.hours} palette={palette} />
              )}
              <Repliers numbers={numbers} palette={palette} />
              <Labels numbers={numbers} palette={palette} />
              <MetricSheet
                metric={metric}
                numbers={numbers}
                days={days}
                zone={numbers.timeZone}
                onClose={() => setMetric(null)}
                palette={palette}
              />
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { flex: 1 },
  content: { flexGrow: 1 },
  header: { height: 150, overflow: "visible", paddingStart: 20, paddingTop: 20 },
  largeHeader: { height: "auto", paddingEnd: 20, paddingBottom: 150 },
  headerBounce: { position: "absolute", left: 0, right: 0, top: -600, height: 600 },
  title: { fontFamily: fonts.displayBold, fontSize: 34, lineHeight: 38, letterSpacing: -0.6 },
  subtitle: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, marginTop: 2, maxWidth: 190 },
  wideSubtitle: { maxWidth: "100%" },
  controls: { paddingHorizontal: 16, paddingTop: 14 },
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32, gap: 12 },
  periods: { flexDirection: "row", height: 40, borderRadius: 12, padding: 3 },
  period: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
  },
  periodText: { fontFamily: fonts.semibold, fontSize: 14 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, overflow: "hidden" },
  cardPad: { padding: 16 },
  cardHeader: { gap: 2, marginBottom: 12 },
  cardTitle: { fontFamily: fonts.display, fontSize: 19, lineHeight: 24 },
  cardHint: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  cardEmpty: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  metrics: { flexDirection: "row", flexWrap: "wrap" },
  metric: { width: "50%", minHeight: 104, paddingHorizontal: 14, paddingVertical: 12 },
  metricTop: { flexDirection: "row", alignItems: "center", gap: 4 },
  metricTitle: { flex: 1, fontFamily: fonts.semibold, fontSize: 13, lineHeight: 17 },
  metricValue: {
    fontFamily: fonts.displayBold,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
    marginTop: 2,
  },
  metricDetail: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  metricChange: { fontFamily: fonts.medium, fontSize: 11.5, lineHeight: 15, marginTop: 3 },
  sheetBody: { paddingHorizontal: 20, paddingBottom: 12, gap: 6 },
  sheetValue: { fontFamily: fonts.displayBold, fontSize: 40, lineHeight: 46, letterSpacing: -0.6 },
  sheetChange: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18 },
  sheetHelp: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, marginTop: 6 },
  sheetRows: { marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  sheetRow: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetRowLabel: { flex: 1, fontFamily: fonts.body, fontSize: 15, lineHeight: 20 },
  sheetRowValue: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 20, textAlign: "right" },
  readout: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  readoutText: { flex: 1 },
  readoutMain: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 19 },
  readoutHint: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  readoutSelected: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 15,
    lineHeight: 20,
    textAlign: "center",
  },
  step: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  chart: { height: CHART_HEIGHT },
  averageLabel: {
    position: "absolute",
    left: 0,
    fontFamily: fonts.medium,
    fontSize: 11,
    lineHeight: 15,
    paddingEnd: 4,
  },
  axis: { height: 18, marginTop: 4 },
  axisText: {
    position: "absolute",
    top: 0,
    fontFamily: fonts.medium,
    fontSize: 11,
    lineHeight: 15,
  },
  axisStart: { left: 0 },
  axisMiddle: { left: 0, right: 0, textAlign: "center" },
  axisEnd: { right: 0 },
  rows: { gap: 4 },
  row: { paddingVertical: 6, gap: 8 },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowStack: { flex: 1, gap: 6 },
  rowName: { flex: 1, fontFamily: fonts.medium, fontSize: 14, lineHeight: 19 },
  rowNameInline: { flex: 0, width: 112 },
  rowCount: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 18 },
  rowDetail: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    overflow: "hidden",
  },
  track: { height: 8, borderRadius: 4, overflow: "hidden" },
  trackInline: { flex: 1 },
  trackFill: { height: "100%", borderRadius: 4 },
  labelDot: { width: 10, height: 10, borderRadius: 5 },
  heatAxis: { flexDirection: "row", gap: 3, marginBottom: 5 },
  heatHour: { flex: 3, fontFamily: fonts.medium, fontSize: 10, lineHeight: 13 },
  heatRow: { flexDirection: "row", alignItems: "center", gap: 3, marginBottom: 3 },
  heatDay: { width: 34, fontFamily: fonts.medium, fontSize: 11, lineHeight: 14 },
  heatCell: { flex: 1, height: 22, borderRadius: 4, borderWidth: 2 },
  heatLegend: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
    marginTop: 8,
  },
  heatLegendText: { fontFamily: fonts.body, fontSize: 11, lineHeight: 14 },
  heatSwatch: { width: 12, height: 12, borderRadius: 3 },
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
  stateTitle: { fontFamily: fonts.display, fontSize: 20, lineHeight: 25, textAlign: "center" },
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
  },
  inlineErrorText: { flex: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  inlineRetry: { fontFamily: fonts.bold, fontSize: 13 },
});
