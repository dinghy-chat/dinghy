import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../../operator/src/text.ts";
import { ApiError } from "./api";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { type Palette, styles } from "./theme";
import type { Conversation } from "./types";

export type Page = "inbox" | "search" | "settings" | "thread";

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
  const surface = { backgroundColor: palette.paper, borderColor: palette.line };
  return (
    <View pointerEvents="box-none" style={[dock.row, { bottom: Math.max(8, bottom - 4) }]}>
      {(["inbox", "search", "settings"] as const).map((target) => {
        const label = target === "search" ? t("searchLabel") : t(target);
        return (
          <Pressable
            key={target}
            accessibilityRole="tab"
            accessibilityState={{ selected: page === target }}
            accessibilityLabel={label}
            onPress={() => onPage(target)}
            style={({ pressed }) => [
              dock.control,
              target === "search" && dock.search,
              surface,
              pressed && { opacity: 0.84 },
            ]}
          >
            <Icon name={target} size={20} color={target === "search" ? palette.sub : palette.ink} />
            {target === "search" && (
              <Text numberOfLines={1} style={[dock.label, { color: palette.sub }]}>
                {label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const dock = StyleSheet.create({
  row: {
    position: "absolute",
    left: 14,
    right: 14,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  control: {
    height: 50,
    width: 50,
    borderRadius: 25,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#183441",
    shadowOpacity: 0.13,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  search: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-start",
    paddingHorizontal: 18,
    gap: 10,
    maxWidth: 340,
  },
  label: { fontFamily: fonts.body, fontSize: 16 },
});
