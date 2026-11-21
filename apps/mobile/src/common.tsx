import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  I18nManager,
  Image,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../../operator/src/text.ts";
import { ApiError } from "./api";
import { AvatarArt } from "./avatar-art";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import {
  NativeSearchField,
  NativeTabBar,
  nativeSearchFieldAvailable,
  nativeTabBarAvailable,
} from "./native-tab-bar";
import { night, type Palette, styles } from "./theme";
import type { Conversation } from "./types";

const tabs = ["inbox", "contacts", "visitors", "analytics", "settings"] as const;
export type TabPage = (typeof tabs)[number];
const tabIcons = {
  inbox: "inbox",
  contacts: "addressBook",
  visitors: "globe",
  analytics: "chart",
  settings: "profileTab",
} as const;

export function visitorName(conversation: Conversation): string {
  return conversation.visitor.name || conversation.visitor.email || t("visitorAnonymous");
}

export function readableError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return t("mobileSessionEnded");
  if (error instanceof Error) return error.message;
  return t("mobileSomethingWrong");
}

export function Avatar({
  name,
  picture,
  kind = "person",
  small = false,
  size = small ? 34 : 42,
  palette,
}: {
  name: string;
  picture?: string | null;
  kind?: "person" | "workspace";
  small?: boolean;
  size?: number;
  palette: Palette;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const radius = kind === "workspace" ? size * 0.28 : size / 2;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        overflow: "hidden",
        backgroundColor: palette.tint,
      }}
    >
      {picture && picture !== failed ? (
        <Image
          accessible={false}
          source={{ uri: picture }}
          onError={() => setFailed(picture)}
          style={{ width: size, height: size }}
        />
      ) : (
        <AvatarArt name={name} workspace={kind === "workspace"} size={size} />
      )}
    </View>
  );
}

export function SheetCloseButton({
  onPress,
  palette,
  label = t("close"),
}: {
  onPress(): void;
  palette: Palette;
  label?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [closeButton.hit, pressed && { opacity: 0.65 }]}
    >
      <View style={[closeButton.disc, { backgroundColor: palette.wash }]}>
        <Icon name="x" size={17} color={palette.ink} />
      </View>
    </Pressable>
  );
}

const closeButton = StyleSheet.create({
  hit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  disc: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
});

export function elapsedLabel(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t("mobileWaitNow");
  if (minutes < 60) return t("mobileWaitMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? t("mobileWaitHours", { count: hours })
    : t("mobileWaitDays", { count: Math.floor(hours / 24) });
}

export function ErrorBanner({
  message,
  palette,
  onDismiss,
}: {
  message: string;
  palette: Palette;
  onDismiss(): void;
}) {
  return (
    <View style={[styles.errorBanner, { backgroundColor: palette.ink }]}>
      <Text style={[styles.errorBannerText, { color: palette.paper }]}>{message}</Text>
      <Pressable onPress={onDismiss} hitSlop={12}>
        <Text style={[styles.errorDismiss, { color: palette.paper }]}>{t("mobileDismiss")}</Text>
      </Pressable>
    </View>
  );
}

export function BottomNav({
  page,
  palette,
  onPage,
  onQuery,
  query,
  liveCount,
}: {
  page: TabPage;
  liveCount: number | null;
  palette: Palette;
  onPage(page: TabPage): void;
  onQuery(value: string): void;
  query: string;
}) {
  const search = page === "inbox";
  const { bottom } = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const dark = palette === night;
  const { width, height } = useWindowDimensions();
  const showClouds = page === "inbox" && !keyboardVisible;
  const cloudTiles =
    width > 900 ? ["left", "middle", "right"] : width > 540 ? ["left", "right"] : ["middle"];
  const barWidth = Math.min(340, width - 32);
  const tabWidth = (barWidth - 10) / tabs.length;
  const index = tabs.indexOf(page);
  const position = useRef(new Animated.Value(index)).current;
  const settle = useCallback(
    (destination: number) => {
      Animated.spring(position, {
        toValue: destination,
        damping: 24,
        stiffness: 300,
        mass: 0.8,
        useNativeDriver: true,
      }).start();
    },
    [position],
  );
  useEffect(() => {
    settle(index);
  }, [index, settle]);
  const swipe = useMemo(() => {
    const progress = (dx: number) =>
      Math.max(0, Math.min(tabs.length - 1, index + (I18nManager.isRTL ? -dx : dx) / tabWidth));
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        Math.abs(gesture.dx) > 7 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4,
      onPanResponderGrant: () => position.stopAnimation(),
      onPanResponderMove: (_, gesture) => position.setValue(progress(gesture.dx)),
      onPanResponderRelease: (_, gesture) => {
        const next = Math.round(progress(gesture.dx));
        settle(next);
        const target = tabs[next];
        if (next !== index && target) onPage(target);
      },
      onPanResponderTerminate: () => settle(index),
    });
  }, [index, onPage, position, settle, tabWidth]);
  if (page === "contacts" && keyboardVisible) return null;
  const glass = isLiquidGlassAvailable();

  const surface = {
    width: barWidth,
    backgroundColor: dark ? "rgba(94, 126, 147, 0.15)" : "rgba(209, 223, 231, 0.24)",
    borderColor: dark ? "rgba(222, 239, 250, 0.17)" : "rgba(55, 82, 101, 0.15)",
  };
  const material = glass && (
    <GlassView
      pointerEvents="none"
      colorScheme={dark ? "dark" : "light"}
      glassEffectStyle={showClouds ? "clear" : "regular"}
      style={dock.glass}
    />
  );
  return (
    <View
      pointerEvents="box-none"
      style={[
        dock.anchor,
        showClouds && height > width && dock.cloudClearance,
        { paddingBottom: keyboardVisible ? 6 : bottom + 6 },
      ]}
    >
      {showClouds && (
        <View
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={dock.cloudBackdrop}
        >
          {cloudTiles.map((tile) => (
            <Image
              key={tile}
              accessible={false}
              fadeDuration={0}
              resizeMode="stretch"
              source={
                dark
                  ? require("../assets/inbox-clouds-dark.png")
                  : require("../assets/inbox-clouds-light.png")
              }
              style={dock.cloudTile}
            />
          ))}
        </View>
      )}
      {search && nativeSearchFieldAvailable && (
        <NativeSearchField query={query} onQuery={onQuery} dark={dark} width={barWidth} />
      )}
      {search && !nativeSearchFieldAvailable && (
        <View style={[dock.search, surface]}>
          {material}
          <Icon name="search" size={18} color={palette.sub} />
          <TextInput
            accessibilityLabel={t("searchLabel")}
            placeholder={t("mobileHarborSearchInput")}
            placeholderTextColor={palette.sub}
            value={query}
            onChangeText={onQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={[dock.searchInput, { color: palette.ink }]}
          />
          {query.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("clearSearch")}
              onPress={() => onQuery("")}
              style={dock.clear}
            >
              <Icon name="x" size={16} color={palette.sub} />
            </Pressable>
          )}
        </View>
      )}
      {!(search && keyboardVisible) && nativeTabBarAvailable && (
        <NativeTabBar
          page={page}
          onPage={onPage}
          liveCount={liveCount}
          dark={dark}
          width={barWidth}
        />
      )}
      {!(search && keyboardVisible) && !nativeTabBarAvailable && (
        <View {...swipe.panHandlers} accessibilityRole="tablist" style={[dock.bar, surface]}>
          {material}
          <Animated.View
            pointerEvents="none"
            style={[
              dock.selection,
              {
                width: tabWidth,
                backgroundColor: dark ? "rgba(255,255,255,0.17)" : "rgba(49,83,104,0.13)",
                transform: [
                  {
                    translateX: position.interpolate({
                      inputRange: [0, tabs.length - 1],
                      outputRange: [0, (I18nManager.isRTL ? -1 : 1) * tabWidth * (tabs.length - 1)],
                    }),
                  },
                ],
              },
            ]}
          />
          {tabs.map((target) => {
            const selected = page === target;
            return (
              <Pressable
                key={target}
                accessibilityRole="tab"
                accessibilityLabel={
                  target === "visitors" && liveCount !== null
                    ? `${t(target)}, ${t("liveCount", { count: liveCount })}`
                    : t(target)
                }
                accessibilityState={{ selected }}
                onPress={() => onPage(target)}
                style={({ pressed }) => [
                  dock.tab,
                  { width: tabWidth, opacity: pressed ? 0.65 : 1 },
                ]}
              >
                <Icon
                  name={tabIcons[target]}
                  color={selected ? palette.ink : palette.sub}
                  size={24}
                  filled={selected}
                />
                {target === "visitors" && liveCount !== null && liveCount > 0 && (
                  <View accessible={false} style={[dock.badge, { backgroundColor: palette.ink }]}>
                    <Text allowFontScaling={false} style={[dock.count, { color: palette.paper }]}>
                      {liveCount > 99 ? "99+" : liveCount}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const dock = StyleSheet.create({
  anchor: {
    paddingTop: 6,
    gap: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  // Leave room for the few cloud pixels above search and keep the last conversation visible.
  cloudClearance: { paddingTop: 48 },
  cloudBackdrop: { ...StyleSheet.absoluteFill, flexDirection: "row" },
  cloudTile: { flex: 1, width: 0, height: "100%" },
  bar: {
    height: 54,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 5,
    borderRadius: 27,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  search: {
    height: 44,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingStart: 18,
    paddingEnd: 5,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, height: "100%", minWidth: 0, fontFamily: fonts.body, fontSize: 16 },
  clear: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  glass: { ...StyleSheet.absoluteFill, borderRadius: 27 },
  badge: {
    position: "absolute",
    top: 6,
    start: "57%",
    minWidth: 13,
    paddingHorizontal: 2,
    height: 13,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  count: { fontSize: 9, lineHeight: 12, includeFontPadding: false, fontWeight: "700" },
  selection: {
    position: "absolute",
    start: 5,
    top: 5,
    height: 44,
    borderRadius: 22,
  },
  tab: { height: 50, alignItems: "center", justifyContent: "center" },
});
