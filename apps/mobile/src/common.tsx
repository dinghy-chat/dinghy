import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../../operator/src/text.ts";
import { ApiError } from "./api";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { type Palette, styles } from "./theme";
import type { Conversation } from "./types";

export type Page = "inbox" | "settings" | "thread";

export function visitorName(conversation: Conversation): string {
  return conversation.visitor.name || conversation.visitor.email || t("visitorAnonymous");
}

export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return letters || "V";
}

export function readableError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return t("mobileSessionEnded");
  if (error instanceof Error) return error.message;
  return t("mobileSomethingWrong");
}

export function Avatar({
  name,
  picture,
  small = false,
  size = small ? 34 : 42,
  palette,
}: {
  name: string;
  picture?: string | null;
  small?: boolean;
  size?: number;
  palette: Palette;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (picture && picture !== failed)
    return (
      <Image
        source={{ uri: picture }}
        onError={() => setFailed(picture)}
        style={{ width: size, height: size, borderRadius: size / 2 }}
      />
    );
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: palette.tint },
      ]}
    >
      <Text style={[styles.avatarText, { color: palette.navy, fontFamily: fonts.bold }]}>
        {initials(name)}
      </Text>
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
}: {
  page: Page;
  palette: Palette;
  onPage(page: Page): void;
}) {
  const { bottom } = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={[
        dock.bar,
        {
          backgroundColor: palette.paper,
          borderTopColor: palette.line,
          paddingBottom: Math.max(bottom, 8),
        },
      ]}
    >
      {(["inbox", "settings"] as const).map((target) => {
        const selected = page === target;
        const label = t(target);
        return (
          <Pressable
            key={target}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            onPress={() => onPage(target)}
            style={({ pressed }) => [
              dock.tab,
              selected && { backgroundColor: palette.wash },
              pressed && { opacity: 0.84 },
            ]}
          >
            <Icon name={target} size={21} color={selected ? palette.blue : palette.sub} />
            <Text
              numberOfLines={1}
              style={[dock.label, { color: selected ? palette.ink : palette.sub }]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const dock = StyleSheet.create({
  bar: {
    minHeight: 62,
    paddingHorizontal: 12,
    paddingTop: 7,
    flexDirection: "row",
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  label: { fontFamily: fonts.semibold, fontSize: 12, lineHeight: 15 },
});
