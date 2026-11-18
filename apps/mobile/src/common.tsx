import { Image, Pressable, Text, View } from "react-native";
import { t } from "../../operator/src/text.ts";
import { ApiError } from "./api";
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
  palette,
}: {
  name: string;
  picture?: string | null;
  small?: boolean;
  palette: Palette;
}) {
  const size = small ? 34 : 42;
  if (picture)
    return (
      <Image
        source={{ uri: picture }}
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
      <Text style={[styles.avatarText, { color: palette.navy }]}>{initials(name)}</Text>
    </View>
  );
}

export function PillButton({
  label,
  onPress,
  palette,
  primary = false,
  disabled = false,
}: {
  label: string;
  onPress(): void;
  palette: Palette;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pillButton,
        {
          backgroundColor: primary ? palette.blue : palette.wash,
          borderColor: primary ? palette.blue : palette.line,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text style={[styles.pillButtonText, { color: primary ? "#ffffff" : palette.ink }]}>
        {label}
      </Text>
    </Pressable>
  );
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
    <View style={[styles.errorBanner, { backgroundColor: palette.navy }]}>
      <Text style={styles.errorBannerText}>{message}</Text>
      <Pressable onPress={onDismiss} hitSlop={12}>
        <Text style={styles.errorDismiss}>{t("mobileDismiss")}</Text>
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
  return (
    <View pointerEvents="box-none" style={styles.navWrap}>
      <View style={[styles.nav, { backgroundColor: palette.paper, borderColor: palette.line }]}>
        {[
          ["inbox", t("inbox"), "▤"],
          ["search", t("searchPlaceholder"), "⌕"],
          ["settings", t("settings"), "⚙"],
        ].map(([target, label, icon]) => {
          const selected = page === target;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              key={target}
              onPress={() => onPage(target as Page)}
              style={[styles.navItem, selected && { backgroundColor: palette.tint }]}
            >
              <Text style={[styles.navIcon, { color: selected ? palette.blue : palette.ink }]}>
                {icon}
              </Text>
              <Text style={[styles.navLabel, { color: selected ? palette.blue : palette.sub }]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
