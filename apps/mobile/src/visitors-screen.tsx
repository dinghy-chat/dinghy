import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import type { components } from "../../../packages/sdk/src/openapi.ts";
import { flag } from "../../operator/src/place.ts";
import { t } from "../../operator/src/text.ts";
import type { DinghyApi } from "./api";
import { Avatar, readableError } from "./common";
import { bare, countryName, pageName, pagePath, webLink } from "./contact-logic";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { usePinnedHeaderLayout } from "./pinned-header";
import { SceneHeader } from "./scene-header";
import { useTabBarInset } from "./tab-bar-inset";
import type { Palette } from "./theme";

const REFRESH_MS = 15_000;
const HOUR_MINUTES = 60;
const VISITOR_CODE_LETTERS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type LiveVisitor = components["schemas"]["LiveVisitor"];
type Show = "all" | "chatting" | "known";
type VisitorList =
  | { state: "loading" }
  | { state: "unknown" }
  | { state: "error"; message: string }
  | { state: "ready"; visitors: LiveVisitor[]; warning: string | null };

function visitorCode(visitorId: string): string {
  const bits = Number.parseInt(visitorId.replaceAll("-", "").slice(0, 5), 16) || 0;
  let code = "";
  for (let shift = 15; shift >= 0; shift -= 5) {
    code += VISITOR_CODE_LETTERS[(bits >> shift) & 31];
  }
  return code;
}

function visitorName(visitor: NonNullable<LiveVisitor["visitor"]>): string {
  return (
    visitor.name ??
    visitor.email ??
    visitor.userId ??
    t("visitorLabel", { code: visitorCode(visitor.id) })
  );
}

function localTime(timeZone: string, now: number): string | null {
  try {
    return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", timeZone }).format(
      now,
    );
  } catch {
    return null;
  }
}

function onSite(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (minutes < HOUR_MINUTES) return t("onSiteMinutes", { count: minutes });
  return t("onSiteHours", {
    hours: Math.floor(minutes / HOUR_MINUTES),
    minutes: minutes % HOUR_MINUTES,
  });
}

/** "5 on your site now", with the number in bold. */
function LiveCount({ count, palette }: { count: number; palette: Palette }) {
  const [before = "", after = ""] = t("liveCount", { count: "\u0000" }).split("\u0000");
  return (
    <>
      {before}
      <Text style={{ fontFamily: fonts.bold, color: palette.coverInk }}>{count}</Text>
      {after}
    </>
  );
}

function personName(visitor: LiveVisitor): string {
  if (visitor.visitor !== null) return visitorName(visitor.visitor);
  if (visitor.country === null) return t("visitorAnonymous");
  return t("visitorFrom", { country: countryName(visitor.country) });
}

function shows(visitor: LiveVisitor, show: Show): boolean {
  if (show === "chatting") return visitor.visitor?.conversationId != null;
  if (show === "known") return visitor.visitor !== null;
  return true;
}

function FilterTabs({
  palette,
  show,
  visitors,
  onShow,
}: {
  palette: Palette;
  show: Show;
  visitors: LiveVisitor[];
  onShow(show: Show): void;
}) {
  const largeText = useWindowDimensions().fontScale > 1.35;
  const options: { value: Show; label: string; count: number }[] = [
    { value: "all", label: t("visitorsEveryone"), count: visitors.length },
    {
      value: "chatting",
      label: t("chatting"),
      count: visitors.filter((visitor) => visitor.visitor?.conversationId != null).length,
    },
    {
      value: "known",
      label: t("visitorsKnown"),
      count: visitors.filter((visitor) => visitor.visitor !== null).length,
    },
  ];
  return (
    <View accessibilityRole="tablist" style={[screen.filters, largeText && screen.wrapped]}>
      {options.map((option) => {
        const selected = option.value === show;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityLabel={`${option.label}, ${option.count}`}
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => onShow(option.value)}
            style={({ pressed }) => [
              screen.filter,
              largeText && screen.naturalFilter,
              {
                backgroundColor: selected ? palette.ink : palette.paper,
                borderColor: selected ? palette.ink : palette.line,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[screen.filterText, { color: selected ? palette.paper : palette.ink }]}
            >
              {option.label}
            </Text>
            <Text style={[screen.filterCount, { color: selected ? palette.paper : palette.sub }]}>
              {option.count}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function VisitorFace({ visitor, palette }: { visitor: LiveVisitor; palette: Palette }) {
  const country = visitor.country === null ? "" : flag(visitor.country);
  if (visitor.visitor !== null) {
    return (
      <View style={screen.face}>
        <Avatar name={visitorName(visitor.visitor)} size={40} palette={palette} />
        {country !== "" && (
          <View style={[screen.flagBadge, { backgroundColor: palette.paper }]}>
            <Text allowFontScaling={false} style={screen.flagText}>
              {country}
            </Text>
          </View>
        )}
      </View>
    );
  }
  return (
    <View style={[screen.anonymousFace, { backgroundColor: palette.wash }]}>
      {country === "" ? (
        <Icon name="person" size={19} color={palette.sub} />
      ) : (
        <Text allowFontScaling={false} style={screen.anonymousFaceText}>
          {country}
        </Text>
      )}
    </View>
  );
}

function VisitorRow({
  visitor,
  now,
  palette,
  onOpenConversation,
  onOpenError,
}: {
  visitor: LiveVisitor;
  now: number;
  palette: Palette;
  onOpenConversation(id: string): void;
  onOpenError(error: unknown): void;
}) {
  const largeText = useWindowDimensions().fontScale > 1.35;
  const link = webLink(visitor.page);
  const name = personName(visitor);
  const title = pageName(visitor.title, visitor.page);
  const path = pagePath(visitor.page);
  const time = visitor.timeZone === null ? null : localTime(visitor.timeZone, now);
  const conversationId = visitor.visitor?.conversationId ?? null;
  // An unknown visitor's country is already in the name, as in "Visitor from Spain".
  const place =
    visitor.visitor !== null && visitor.country !== null ? countryName(visitor.country) : null;
  const meta = [
    onSite(visitor.startedAt, now),
    visitor.referrer === null ? null : t("cameFrom", { site: bare(visitor.referrer) }),
    place,
    time === null ? null : t("mobileVisitorTimeThere", { time }),
  ].filter((part): part is string => part !== null);
  const openButton = conversationId !== null && (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("openChat")}, ${name}`}
      hitSlop={5}
      onPress={() => onOpenConversation(conversationId)}
      style={({ pressed }) => [
        screen.openChat,
        largeText && { alignSelf: "flex-start", marginTop: 6 },
        { backgroundColor: palette.blue, opacity: pressed ? 0.72 : 1 },
      ]}
    >
      <Text style={[screen.openChatText, { color: palette.onBlue }]}>{t("open")}</Text>
    </Pressable>
  );
  return (
    <View style={screen.row}>
      <VisitorFace visitor={visitor} palette={palette} />
      <View style={screen.rowBody}>
        <View style={[screen.nameLine, largeText && screen.wrapped]}>
          <Text
            numberOfLines={largeText ? undefined : 1}
            style={[screen.name, { color: palette.ink }]}
          >
            {name}
          </Text>
          {conversationId !== null && (
            <View style={[screen.chatting, { backgroundColor: palette.tint }]}>
              <Text style={[screen.chattingText, { color: palette.blue }]}>{t("chatting")}</Text>
            </View>
          )}
        </View>
        <Pressable
          accessibilityRole={link === null ? undefined : "link"}
          accessibilityLabel={title === path ? path : `${title}, ${path}`}
          disabled={link === null}
          onPress={() => {
            if (link !== null) void Linking.openURL(link).catch(onOpenError);
          }}
          style={({ pressed }) => [screen.pageLine, pressed && { opacity: 0.6 }]}
        >
          <Text
            numberOfLines={largeText ? undefined : 1}
            style={[screen.pageTitle, { color: palette.ink }]}
          >
            {title}
            {title !== path && <Text style={{ color: palette.sub }}>{`  ${path}`}</Text>}
          </Text>
        </Pressable>
        <Text
          numberOfLines={largeText ? undefined : 2}
          style={[screen.metaText, { color: palette.sub }]}
        >
          {meta.join(" · ")}
        </Text>
        {largeText && openButton}
      </View>
      {!largeText && openButton}
      <View style={[screen.divider, { backgroundColor: palette.line }]} />
    </View>
  );
}

function RetryState({
  message,
  palette,
  onRetry,
}: {
  message: string;
  palette: Palette;
  onRetry(): void;
}) {
  return (
    <View style={screen.state}>
      <Text style={[screen.stateText, { color: palette.sub }]}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [
          screen.retry,
          { borderColor: palette.line, opacity: pressed ? 0.65 : 1 },
        ]}
      >
        <Text style={[screen.retryText, { color: palette.blue }]}>{t("mobileRetry")}</Text>
      </Pressable>
    </View>
  );
}

export function VisitorsScreen({
  api,
  palette,
  topInset,
  isCovered,
  onOpenConversation,
  onCount,
}: {
  api: DinghyApi;
  palette: Palette;
  topInset: number;
  /** A conversation is on top of the list, so the list stops polling until it shows again. */
  isCovered: boolean;
  onOpenConversation(id: string): void;
  onCount?(count: number | null): void;
}) {
  const { hideScene } = usePinnedHeaderLayout();
  const dockInset = useTabBarInset();
  const [list, setList] = useState<VisitorList>({ state: "loading" });
  const [show, setShow] = useState<Show>("all");
  const [now, setNow] = useState(Date.now);
  const [refreshing, setRefreshing] = useState(false);
  const [isActive, setActive] = useState(AppState.currentState === "active");
  const [openError, setOpenError] = useState<string | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const listRef = useRef(list);
  const onCountRef = useRef(onCount);
  const apiRef = useRef(api);
  listRef.current = list;
  onCountRef.current = onCount;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (apiRef.current !== api) {
      const loading = { state: "loading" } as const;
      apiRef.current = api;
      listRef.current = loading;
      setList(loading);
      setShow("all");
      setOpenError(null);
      onCountRef.current?.(null);
    }
    if (!isActive || isCovered) {
      refreshRef.current = null;
      return;
    }
    let current = true;
    let inFlight = false;
    const load = async (manual: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (manual) setRefreshing(true);
      try {
        const { visitors } = await api.liveVisitors();
        if (!current) return;
        setNow(Date.now());
        if (visitors === null) {
          setList({ state: "unknown" });
          onCountRef.current?.(null);
        } else {
          setList({ state: "ready", visitors, warning: null });
          onCountRef.current?.(visitors.length);
        }
      } catch (error) {
        if (!current) return;
        const message = readableError(error);
        const previous = listRef.current;
        setList(
          previous.state === "ready"
            ? { ...previous, warning: message }
            : { state: "error", message },
        );
      } finally {
        inFlight = false;
        if (current) setRefreshing(false);
      }
    };
    refreshRef.current = () => void load(true);
    void load(false);
    const timer = setInterval(() => void load(false), REFRESH_MS);
    return () => {
      current = false;
      refreshRef.current = null;
      clearInterval(timer);
    };
  }, [api, isActive, isCovered]);

  const visitors = list.state === "ready" ? list.visitors : [];
  const shown = useMemo(() => visitors.filter((visitor) => shows(visitor, show)), [show, visitors]);
  const retry = () => refreshRef.current?.();

  return (
    <View style={[screen.screen, { backgroundColor: palette.paper, paddingTop: topInset }]}>
      <View>
        {!hideScene && (
          <SceneHeader
            scene="visitors"
            title={t("visitors")}
            subtitle={
              list.state === "ready" ? (
                <LiveCount count={list.visitors.length} palette={palette} />
              ) : null
            }
            palette={palette}
          />
        )}
      </View>
      <View>
        {list.state === "ready" && list.visitors.length > 0 && (
          <FilterTabs palette={palette} show={show} visitors={list.visitors} onShow={setShow} />
        )}
      </View>
      <ScrollView
        alwaysBounceVertical
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={retry} tintColor={palette.blue} />
        }
        style={screen.list}
        scrollIndicatorInsets={{ bottom: dockInset }}
        contentContainerStyle={[screen.content, { paddingBottom: 16 + dockInset }]}
      >
        {(list.state === "ready" && list.warning !== null) || openError !== null ? (
          <View
            accessibilityRole="alert"
            style={[screen.warning, { backgroundColor: palette.warm }]}
          >
            <Text style={[screen.warningText, { color: palette.amber }]}>
              {openError ?? (list.state === "ready" ? list.warning : null)}
            </Text>
            <Pressable
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => {
                if (openError !== null) setOpenError(null);
                else retry();
              }}
            >
              <Text style={[screen.warningAction, { color: palette.amber }]}>
                {openError !== null ? t("mobileDismiss") : t("mobileRetry")}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {list.state === "loading" ? (
          <View accessibilityLabel={t("loading")} style={screen.loading}>
            <ActivityIndicator color={palette.blue} />
          </View>
        ) : list.state === "unknown" ? (
          <RetryState message={t("visitorsUnknown")} palette={palette} onRetry={retry} />
        ) : list.state === "error" ? (
          <RetryState message={list.message} palette={palette} onRetry={retry} />
        ) : list.visitors.length === 0 ? (
          <View style={screen.state}>
            <View style={[screen.emptyIcon, { backgroundColor: palette.wash }]}>
              <Icon name="people" size={28} color={palette.sub} />
            </View>
            <Text style={[screen.emptyTitle, { color: palette.ink }]}>{t("visitorsNone")}</Text>
            <Text style={[screen.stateText, { color: palette.sub }]}>{t("visitorsNoneHint")}</Text>
          </View>
        ) : shown.length === 0 ? (
          <View style={screen.state}>
            <Text style={[screen.stateText, { color: palette.sub }]}>{t("visitorsNoneShown")}</Text>
          </View>
        ) : (
          <View>
            {shown.map((visitor) => (
              <VisitorRow
                key={visitor.tab}
                now={now}
                onOpenConversation={onOpenConversation}
                onOpenError={(error) => setOpenError(readableError(error))}
                palette={palette}
                visitor={visitor}
              />
            ))}
            <Text style={[screen.credit, { color: palette.sub }]}>{t("geoCredit")}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const screen = StyleSheet.create({
  screen: { flex: 1 },
  list: { flex: 1 },
  content: { flexGrow: 1, paddingBottom: 16 },
  filters: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  filter: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 38,
    minWidth: 0,
    paddingHorizontal: 9,
  },
  wrapped: { flexWrap: "wrap" },
  naturalFilter: { flex: 0, paddingVertical: 2, paddingHorizontal: 12 },
  filterText: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 13.5, lineHeight: 18 },
  filterCount: { fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 17 },
  warning: {
    alignItems: "center",
    borderRadius: 12,
    flexDirection: "row",
    gap: 12,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  warningText: { flex: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  warningAction: { fontFamily: fonts.bold, fontSize: 13, lineHeight: 18 },
  loading: { alignItems: "center", flex: 1, justifyContent: "center", minHeight: 260 },
  state: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: 280,
    paddingHorizontal: 36,
  },
  stateText: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, textAlign: "center" },
  retry: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    marginTop: 16,
    minHeight: 44,
    paddingHorizontal: 18,
  },
  retryText: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 19 },
  emptyIcon: {
    alignItems: "center",
    borderRadius: 30,
    height: 60,
    justifyContent: "center",
    marginBottom: 14,
    width: 60,
  },
  emptyTitle: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    lineHeight: 24,
    marginBottom: 5,
    textAlign: "center",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 76,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  divider: {
    position: "absolute",
    bottom: 0,
    right: 0,
    left: 68,
    height: StyleSheet.hairlineWidth,
  },
  face: { height: 40, width: 40 },
  flagBadge: {
    alignItems: "center",
    borderRadius: 9,
    bottom: -3,
    height: 18,
    justifyContent: "center",
    position: "absolute",
    right: -5,
    width: 22,
  },
  flagText: { fontSize: 12, lineHeight: 15 },
  anonymousFace: {
    alignItems: "center",
    borderRadius: 20,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  anonymousFaceText: { fontSize: 19, lineHeight: 24 },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  nameLine: { alignItems: "center", flexDirection: "row", gap: 7 },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 16, lineHeight: 21 },
  chatting: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  chattingText: { fontFamily: fonts.semibold, fontSize: 11, lineHeight: 15 },
  pageLine: { minHeight: 22, justifyContent: "center" },
  pageTitle: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19 },
  metaText: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  openChat: {
    alignItems: "center",
    borderRadius: 17,
    minHeight: 34,
    paddingVertical: 4,
    justifyContent: "center",
    minWidth: 64,
    paddingHorizontal: 14,
  },
  openChatText: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 19 },
  credit: {
    fontFamily: fonts.body,
    fontSize: 11,
    lineHeight: 15,
    paddingVertical: 18,
    textAlign: "center",
  },
});
