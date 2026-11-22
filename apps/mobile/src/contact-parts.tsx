import * as Clipboard from "expo-clipboard";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { components } from "../../../packages/sdk/src/openapi.ts";
import { t } from "../../operator/src/text.ts";
import { elapsedLabel } from "./common";
import {
  type DetailRow,
  detailRows,
  isIdName,
  type PageRun,
  pageName,
  pagePath,
  webLink,
} from "./contact-logic";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import type { Palette } from "./theme";

// The parts of a contact's page that show pages and details: one line each, then everything on
// a screen of its own. Also the compact bar and the copy feedback the contact uses.

type ContactDetail = components["schemas"]["ContactDetail"];

const COPIED_MS = 1400;

function contactName(contact: Pick<ContactDetail, "email" | "name">): string {
  return contact.name || contact.email || t("visitorAnonymous");
}

function dateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function useCopy() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (value: string) => {
    void Clipboard.setStringAsync(value).then(() => {
      setCopied(true);
      AccessibilityInfo.announceForAccessibility(t("copied"));
    });
  };
  return { copied, copy };
}

export function CopiedToast({ palette, visible }: { palette: Palette; visible: boolean }) {
  if (!visible) return null;
  return (
    <View pointerEvents="none" style={s.toastWrap}>
      <View style={[s.toast, { backgroundColor: palette.ink }]}>
        <Icon name="check" size={16} color={palette.paper} />
        <Text style={[s.toastText, { color: palette.paper }]}>{t("copied")}</Text>
      </View>
    </View>
  );
}

/** Android's back button steps back inside the tab before it leaves the app. */
export function useHardwareBack(onBack: () => void) {
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      latest.current();
      return true;
    });
    return () => subscription.remove();
  }, []);
}

/** The bar on top of a contact and of its full lists: back, the title and an optional action. */
export function CompactBar({
  backLabel,
  onBack,
  palette,
  title,
  action,
}: {
  backLabel: string;
  onBack(): void;
  palette: Palette;
  title: string;
  action?: ReactNode;
}) {
  return (
    <View style={[s.bar, { backgroundColor: palette.paper, borderBottomColor: palette.line }]}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={[s.barTitle, { color: palette.ink }]}
      >
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("back")}, ${backLabel}`}
        hitSlop={6}
        onPress={onBack}
        style={({ pressed }) => [s.barBack, { opacity: pressed ? 0.5 : 1 }]}
      >
        <Icon
          name={Platform.OS === "ios" ? "back" : "androidBack"}
          size={24}
          color={palette.blue}
        />
        {Platform.OS === "ios" && (
          <Text numberOfLines={1} style={[s.barBackText, { color: palette.blue }]}>
            {backLabel}
          </Text>
        )}
      </Pressable>
      <View style={s.barAction}>{action}</View>
    </View>
  );
}

function openLink(link: string) {
  void Linking.openURL(link).catch(() => undefined);
}

/** One page, or one run of the same page, on a single line: its name, its path, and when. */
export function PageLine({
  copy,
  palette,
  run,
}: {
  copy(value: string): void;
  palette: Palette;
  run: PageRun;
}) {
  const link = webLink(run.path);
  const name = pageName(run.title, run.path);
  const path = pagePath(run.path);
  const when =
    run.views > 1
      ? t("mobilePageViews", { count: run.views, time: elapsedLabel(run.viewedAt) })
      : elapsedLabel(run.viewedAt);
  return (
    <Pressable
      accessibilityRole={link === null ? "text" : "link"}
      accessibilityLabel={[name, name === path ? null : path, when].filter(Boolean).join(", ")}
      accessibilityHint={link === null ? undefined : t("mobileLinkHint")}
      disabled={link === null}
      onLongPress={() => copy(link ?? path)}
      onPress={() => {
        if (link !== null) openLink(link);
      }}
      style={({ pressed }) => [s.pageRow, pressed && { backgroundColor: palette.wash }]}
    >
      <Text numberOfLines={1} style={[s.pageName, { color: palette.ink }]}>
        {name}
        {name !== path && <Text style={{ color: palette.sub }}>{`  ${path}`}</Text>}
      </Text>
      <Text style={[s.pageTime, { color: palette.sub }]}>{when}</Text>
    </Pressable>
  );
}

function CopyButton({
  label,
  onPress,
  palette,
}: {
  label: string;
  onPress(): void;
  palette: Palette;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.copyButton, { opacity: pressed ? 0.5 : 1 }]}
    >
      <Icon name="file" size={17} color={palette.sub} />
    </Pressable>
  );
}

function detailKey(row: DetailRow): string {
  return row.userId ? t("userIdTitle") : row.key;
}

/** One detail from the site on one line: the key, and the value cut in the middle. */
export function DetailLine({
  copy,
  palette,
  row,
}: {
  copy(value: string): void;
  palette: Palette;
  row: DetailRow;
}) {
  const key = detailKey(row);
  const copyable = row.link !== null || row.userId || isIdName(row.key);
  return (
    <View style={s.detailRow}>
      <Text numberOfLines={1} style={[s.detailKey, { color: palette.sub }]}>
        {key}
      </Text>
      <Pressable
        accessibilityRole={row.link === null ? "text" : "link"}
        accessibilityLabel={`${key}: ${row.value}`}
        disabled={row.link === null}
        onLongPress={() => copy(row.value)}
        onPress={() => {
          if (row.link !== null) openLink(row.link);
        }}
        style={s.detailValueHit}
      >
        <Text
          ellipsizeMode="middle"
          numberOfLines={1}
          style={[
            s.detailValue,
            { color: row.link !== null ? palette.blue : row.signed ? palette.ink : palette.sub },
          ]}
        >
          {row.value}
        </Text>
      </Pressable>
      {copyable && (
        <CopyButton
          label={t("copyValue", { name: key })}
          onPress={() => copy(row.value)}
          palette={palette}
        />
      )}
    </View>
  );
}

export function ShowAll({
  label,
  onPress,
  palette,
}: {
  label: string;
  onPress(): void;
  palette: Palette;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        s.showAll,
        { borderTopColor: palette.line, backgroundColor: pressed ? palette.wash : "transparent" },
      ]}
    >
      <Text style={[s.showAllText, { color: palette.blue }]}>{label}</Text>
      <Icon name="next" size={16} color={palette.blue} />
    </Pressable>
  );
}

/** Every page or every detail, on its own screen over the contact, with nothing cut. */
export function FullList({
  contact,
  copy,
  kind,
  onBack,
  palette,
}: {
  contact: ContactDetail;
  copy(value: string): void;
  kind: "pages" | "details";
  onBack(): void;
  palette: Palette;
}) {
  useHardwareBack(onBack);
  const rows = kind === "details" ? detailRows(contact) : [];
  const unsigned = rows.some((row) => !row.signed);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.paper }]}>
      <CompactBar
        backLabel={contactName(contact)}
        onBack={onBack}
        palette={palette}
        title={t(kind === "pages" ? "pagesVisited" : "contactDetails")}
      />
      <ScrollView contentContainerStyle={s.fullContent}>
        {kind === "pages"
          ? contact.pages.map((page) => {
              const link = webLink(page.path);
              const name = pageName(page.title, page.path);
              const path = pagePath(page.path);
              return (
                <Pressable
                  accessibilityRole={link === null ? "text" : "link"}
                  accessibilityHint={link === null ? undefined : t("mobileLinkHint")}
                  disabled={link === null}
                  key={`${page.viewedAt} ${page.path}`}
                  onLongPress={() => copy(link ?? path)}
                  onPress={() => {
                    if (link !== null) openLink(link);
                  }}
                  style={({ pressed }) => [
                    s.fullRow,
                    { borderBottomColor: palette.line },
                    pressed && { backgroundColor: palette.wash },
                  ]}
                >
                  <Text style={[s.fullTitle, { color: palette.ink }]}>{name}</Text>
                  {name !== path && (
                    <Text selectable style={[s.fullValue, { color: palette.sub }]}>
                      {path}
                    </Text>
                  )}
                  <Text style={[s.meta, { color: palette.sub }]}>{dateTime(page.viewedAt)}</Text>
                </Pressable>
              );
            })
          : rows.map((row) => {
              const key = detailKey(row);
              return (
                <View
                  key={`${row.signed} ${row.userId} ${row.key}`}
                  style={[s.fullRow, s.fullDetail, { borderBottomColor: palette.line }]}
                >
                  <View style={s.fullDetailCopy}>
                    <Text style={[s.detailKey, s.fullKey, { color: palette.sub }]}>{key}</Text>
                    <Text
                      selectable
                      style={[
                        s.fullValue,
                        {
                          color:
                            row.link !== null
                              ? palette.blue
                              : row.signed
                                ? palette.ink
                                : palette.sub,
                        },
                      ]}
                      onPress={row.link === null ? undefined : () => openLink(row.link ?? "")}
                    >
                      {row.value}
                    </Text>
                  </View>
                  <CopyButton
                    label={t("copyValue", { name: key })}
                    onPress={() => copy(row.value)}
                    palette={palette}
                  />
                </View>
              );
            })}
        {unsigned && (
          <Text style={[s.footnote, { color: palette.sub }]}>
            {`${t("mobileContactPageDetails")} ${t("pageContextNote")}`}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  meta: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  bar: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingStart: 4,
    paddingEnd: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  barTitle: {
    position: "absolute",
    left: 112,
    right: 112,
    textAlign: "center",
    fontFamily: fonts.semibold,
    fontSize: 17,
    lineHeight: 22,
  },
  barBack: {
    minHeight: 44,
    maxWidth: 108,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    gap: 1,
  },
  barBackText: { flexShrink: 1, fontFamily: fonts.body, fontSize: 17, lineHeight: 22 },
  barAction: { minWidth: 44, alignItems: "flex-end" },
  pageRow: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
  },
  pageName: { flex: 1, minWidth: 0, fontFamily: fonts.medium, fontSize: 14.5, lineHeight: 19 },
  pageTime: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  detailRow: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingStart: 14,
    paddingEnd: 4,
  },
  detailKey: { width: 92, fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 17 },
  detailValueHit: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: "center" },
  detailValue: { fontFamily: fonts.body, fontSize: 14.5, lineHeight: 19 },
  copyButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  showAll: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  showAllText: { fontFamily: fonts.semibold, fontSize: 14.5, lineHeight: 19 },
  fullContent: { paddingBottom: 28 },
  fullRow: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fullDetail: { flexDirection: "row", alignItems: "flex-start", paddingEnd: 6, gap: 6 },
  fullDetailCopy: { flex: 1, minWidth: 0, gap: 3 },
  fullKey: { width: "auto" },
  fullTitle: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20 },
  fullValue: { fontFamily: fonts.body, fontSize: 14.5, lineHeight: 20 },
  footnote: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    lineHeight: 17,
    paddingHorizontal: 20,
    paddingTop: 14,
  },
  toastWrap: { position: "absolute", left: 0, right: 0, bottom: 18, alignItems: "center" },
  toast: {
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  toastText: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 19 },
});
