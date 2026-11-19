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
  View,
} from "react-native";
import type { components } from "../../../packages/sdk/src/openapi.ts";
import { t } from "../../operator/src/text.ts";
import type { DinghyApi } from "./api";
import { Avatar, readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
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

function countryName(country: string): string {
  try {
    return new Intl.DisplayNames([], { type: "region" }).of(country) ?? country;
  } catch {
    return country;
  }
}

function flag(country: string): string {
  if (!/^[A-Z]{2}$/.test(country)) return "";
  const regionalA = 0x1f1e6;
  return String.fromCodePoint(
    ...[...country].map((letter) => regionalA + letter.charCodeAt(0) - "A".charCodeAt(0)),
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

function webLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function bare(value: string): string {
  return value.replace(/^https?:\/\//i, "");
}

function pagePath(page: string): string {
  const link = webLink(page);
  if (link === null) return bare(page);
  const url = new URL(link);
  return `${url.pathname}${url.search}${url.hash}` || "/";
}

function pageTitle(visitor: LiveVisitor): string {
  return visitor.title?.trim() || pagePath(visitor.page);
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

function countLine(count: number): string {
  return count === 1 ? t("visitorsOne") : t("visitorsMany", { count });
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
    <View accessibilityRole="tablist" style={screen.filters}>
      {options.map((option) => {
        const selected = option.value === show;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => onShow(option.value)}
            style={[
              screen.filter,
              {
                backgroundColor: selected ? palette.ink : palette.paper,
                borderColor: selected ? palette.ink : palette.line,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[screen.filterText, { color: selected ? palette.paper : palette.sub }]}
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
    const name = visitorName(visitor.visitor);
    return (
      <View style={screen.faceWrap}>
        <Avatar name={name} size={44} palette={palette} />
        {country !== "" && (
          <View
            style={[
              screen.flagBadge,
              { backgroundColor: palette.paper, borderColor: palette.paper },
            ]}
          >
            <Text style={screen.flagText}>{country}</Text>
          </View>
        )}
      </View>
    );
  }
  return (
    <View style={[screen.anonymousFace, { backgroundColor: palette.wash }]}>
      <Text style={screen.anonymousFaceText}>{country || "•"}</Text>
    </View>
  );
}

function MetaItem({ children, palette }: { children: string; palette: Palette }) {
  return (
    <View style={screen.metaItem}>
      <View style={[screen.metaDot, { backgroundColor: palette.sub }]} />
      <Text style={[screen.metaText, { color: palette.sub }]}>{children}</Text>
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
  const page = webLink(visitor.page);
  const name = personName(visitor);
  const time = visitor.timeZone === null ? null : localTime(visitor.timeZone, now);
  const conversationId = visitor.visitor?.conversationId ?? null;
  const place = visitor.country === null ? null : countryName(visitor.country);
  return (
    <View style={[screen.row, { borderBottomColor: palette.line }]}>
      <VisitorFace visitor={visitor} palette={palette} />
      <View style={screen.rowBody}>
        <View style={screen.nameLine}>
          <Text numberOfLines={1} style={[screen.name, { color: palette.ink }]}>
            {name}
          </Text>
          {conversationId !== null && (
            <View style={[screen.chatting, { backgroundColor: palette.tint }]}>
              <Text style={[screen.chattingText, { color: palette.blue }]}>{t("chatting")}</Text>
            </View>
          )}
        </View>
        <Pressable
          accessibilityRole={page === null ? undefined : "link"}
          disabled={page === null}
          onPress={() => {
            if (page !== null) void Linking.openURL(page).catch(onOpenError);
          }}
          style={({ pressed }) => [screen.pageLine, pressed && { opacity: 0.6 }]}
        >
          <Text
            numberOfLines={1}
            style={[screen.pageTitle, { color: page === null ? palette.ink : palette.blue }]}
          >
            {pageTitle(visitor)}
          </Text>
          {page !== null && <Icon name="arrow" size={14} color={palette.blue} />}
        </Pressable>
        <View style={screen.meta}>
          {place !== null && <MetaItem palette={palette}>{place}</MetaItem>}
          {time !== null && <MetaItem palette={palette}>{time}</MetaItem>}
          <MetaItem palette={palette}>{onSite(visitor.startedAt, now)}</MetaItem>
          {visitor.device !== null && <MetaItem palette={palette}>{visitor.device}</MetaItem>}
          {visitor.referrer !== null && (
            <MetaItem palette={palette}>{t("cameFrom", { site: bare(visitor.referrer) })}</MetaItem>
          )}
        </View>
        {conversationId !== null && (
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenConversation(conversationId)}
            style={({ pressed }) => [
              screen.openChat,
              { backgroundColor: palette.ink, opacity: pressed ? 0.72 : 1 },
            ]}
          >
            <Icon name="chat" size={16} color={palette.paper} />
            <Text style={[screen.openChatText, { color: palette.paper }]}>{t("openChat")}</Text>
          </Pressable>
        )}
      </View>
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
  bottomInset,
  onOpenConversation,
  onCount,
}: {
  api: DinghyApi;
  palette: Palette;
  topInset: number;
  bottomInset: number;
  onOpenConversation(id: string): void;
  onCount?(count: number | null): void;
}) {
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
    if (!isActive) {
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
  }, [api, isActive]);

  const visitors = list.state === "ready" ? list.visitors : [];
  const shown = useMemo(() => visitors.filter((visitor) => shows(visitor, show)), [show, visitors]);
  const retry = () => refreshRef.current?.();

  return (
    <ScrollView
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={retry} tintColor={palette.blue} />
      }
      style={{ backgroundColor: palette.paper }}
      contentContainerStyle={[screen.content, { paddingBottom: bottomInset + 88 }]}
    >
      <View style={[screen.header, { paddingTop: topInset + 18, backgroundColor: palette.cover }]}>
        <Text style={[screen.title, { color: palette.coverInk }]}>{t("visitors")}</Text>
        {list.state === "ready" && (
          <View style={screen.liveLine}>
            <View style={[screen.liveDot, { backgroundColor: palette.green }]} />
            <Text style={[screen.liveText, { color: palette.coverSub }]}>
              {countLine(list.visitors.length)}
            </Text>
          </View>
        )}
      </View>

      {list.state === "ready" && (
        <FilterTabs palette={palette} show={show} visitors={list.visitors} onShow={setShow} />
      )}

      {(list.state === "ready" && list.warning !== null) || openError !== null ? (
        <View style={[screen.warning, { backgroundColor: palette.warm }]}>
          <Text style={[screen.warningText, { color: palette.amber }]}>
            {openError ?? (list.state === "ready" ? list.warning : null)}
          </Text>
          <Pressable
            accessibilityRole="button"
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
        <View style={screen.list}>
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
  );
}

const screen = StyleSheet.create({
  content: { flexGrow: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  title: { fontFamily: fonts.displayBold, fontSize: 32, letterSpacing: -0.8 },
  liveLine: { alignItems: "center", flexDirection: "row", gap: 8, marginTop: 5 },
  liveDot: { borderRadius: 4, height: 8, width: 8 },
  liveText: { fontFamily: fonts.body, fontSize: 15 },
  filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  filter: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
    minWidth: 0,
    paddingHorizontal: 9,
    paddingVertical: 8,
  },
  filterText: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 13 },
  filterCount: { fontFamily: fonts.medium, fontSize: 12 },
  warning: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  warningText: { flex: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  warningAction: { fontFamily: fonts.bold, fontSize: 13 },
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
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: { fontFamily: fonts.semibold, fontSize: 14 },
  emptyIcon: {
    alignItems: "center",
    borderRadius: 30,
    height: 60,
    justifyContent: "center",
    marginBottom: 14,
    width: 60,
  },
  emptyTitle: { fontFamily: fonts.semibold, fontSize: 18, marginBottom: 5, textAlign: "center" },
  list: { paddingHorizontal: 16 },
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 17,
  },
  faceWrap: { height: 48, width: 48 },
  flagBadge: {
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 2,
    bottom: 0,
    height: 21,
    justifyContent: "center",
    position: "absolute",
    right: 0,
    width: 25,
  },
  flagText: { fontSize: 13 },
  anonymousFace: {
    alignItems: "center",
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  anonymousFaceText: { fontSize: 20 },
  rowBody: { flex: 1, minWidth: 0 },
  nameLine: { alignItems: "center", flexDirection: "row", gap: 8 },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 18, letterSpacing: -0.25 },
  chatting: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  chattingText: { fontFamily: fonts.semibold, fontSize: 11 },
  pageLine: { alignItems: "center", flexDirection: "row", gap: 5, marginTop: 4 },
  pageTitle: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 15 },
  meta: { flexDirection: "row", flexWrap: "wrap", marginTop: 7, rowGap: 4 },
  metaItem: { alignItems: "center", flexDirection: "row", marginRight: 10 },
  metaDot: { borderRadius: 2, height: 3, marginRight: 5, width: 3 },
  metaText: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
  openChat: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: 999,
    flexDirection: "row",
    gap: 6,
    marginTop: 11,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  openChatText: { fontFamily: fonts.semibold, fontSize: 13 },
  credit: { fontFamily: fonts.body, fontSize: 11, paddingVertical: 18, textAlign: "center" },
});
