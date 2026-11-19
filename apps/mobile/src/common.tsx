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
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../../operator/src/text.ts";
import { ApiError } from "./api";
import { AvatarArt } from "./avatar-art";
import { Icon } from "./icon";
import { night, type Palette, styles } from "./theme";
import type { Conversation } from "./types";

const tabs = ["inbox", "contacts", "visitors", "analytics", "settings"] as const;
export type TabPage = (typeof tabs)[number];
export type Page = TabPage | "thread";
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
  onSearch,
  searching,
  liveCount,
}: {
  page: Page;
  liveCount: number | null;
  palette: Palette;
  onPage(page: Page): void;
  onSearch(): void;
  searching: boolean;
}) {
  const { bottom } = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const dark = palette === night;
  const { width } = useWindowDimensions();
  const tabWidth = Math.max(44, Math.min(56, Math.floor((width - 90) / tabs.length)));
  const index = page === "thread" ? 0 : tabs.indexOf(page);
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
  if (searching || (page === "contacts" && keyboardVisible)) return null;
  const glass = isLiquidGlassAvailable();
  const base = !glass && {
    backgroundColor: palette.sheet,
    borderColor: palette.line,
    borderWidth: StyleSheet.hairlineWidth,
  };
  const material = glass && (
    <GlassView
      pointerEvents="none"
      colorScheme={dark ? "dark" : "light"}
      glassEffectStyle="regular"
      style={dock.glass}
    />
  );
  return (
    <View pointerEvents="box-none" style={[dock.anchor, { bottom: bottom + 6 }]}>
      <View {...swipe.panHandlers} accessibilityRole="tablist" style={[dock.bar, base]}>
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
              style={({ pressed }) => [dock.tab, { width: tabWidth, opacity: pressed ? 0.65 : 1 }]}
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
      {page === "inbox" && (
        <Pressable
          onPress={onSearch}
          accessibilityRole="button"
          accessibilityLabel={t("searchLabel")}
          style={({ pressed }) => [dock.search, base, { opacity: pressed ? 0.8 : 1 }]}
        >
          {material}
          <Icon name="search" size={23} color={palette.ink} />
        </Pressable>
      )}
    </View>
  );
}

const dock = StyleSheet.create({
  anchor: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  bar: {
    height: 54,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 5,
    borderRadius: 27,
    boxShadow: "0 4px 18px rgba(8, 23, 38, 0.16)",
  },
  search: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 18px rgba(8, 23, 38, 0.16)",
  },
  glass: { ...StyleSheet.absoluteFill, borderRadius: 27 },
  badge: {
    position: "absolute",
    top: 3,
    end: 1,
    minWidth: 16,
    paddingHorizontal: 3,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  count: { fontSize: 10, fontWeight: "700" },
  selection: {
    position: "absolute",
    start: 5,
    top: 5,
    height: 44,
    borderRadius: 22,
  },
  tab: { height: 50, alignItems: "center", justifyContent: "center" },
});
