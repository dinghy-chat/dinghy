import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import { type NativeSyntheticEvent, useWindowDimensions, type ViewProps } from "react-native";
import { t } from "../../operator/src/text.ts";
import type { TabPage } from "./common";

const pages = ["inbox", "contacts", "visitors", "analytics", "settings"] as const;

type NativePageEvent = NativeSyntheticEvent<{ page: string }>;

type NativeTabBarViewProps = ViewProps & {
  page: TabPage;
  liveCount: number | null;
  dark: boolean;
  inboxLabel: string;
  contactsLabel: string;
  visitorsLabel: string;
  analyticsLabel: string;
  settingsLabel: string;
  onPage(event: NativePageEvent): void;
};

function findNativeView(): ComponentType<NativeTabBarViewProps> | null {
  if (requireOptionalNativeModule("ExpoNativeTabBar") === null) return null;
  try {
    return requireNativeView<NativeTabBarViewProps>("ExpoNativeTabBar", "ExpoNativeTabBarView");
  } catch {
    return null;
  }
}

const NativeView = findNativeView();

export const nativeTabBarAvailable = NativeView !== null;

type NativeSearchFieldViewProps = ViewProps & {
  query: string;
  placeholder: string;
  label: string;
  dark: boolean;
  onQuery(event: NativeSyntheticEvent<{ query: string }>): void;
};

function findNativeSearchField(): ComponentType<NativeSearchFieldViewProps> | null {
  // A dev build from before this view existed keeps the React Native field.
  if (
    NativeView === null ||
    !globalThis.expo?.getViewConfig("ExpoNativeTabBar", "ExpoNativeSearchFieldView")
  )
    return null;
  try {
    return requireNativeView<NativeSearchFieldViewProps>(
      "ExpoNativeTabBar",
      "ExpoNativeSearchFieldView",
    );
  } catch {
    return null;
  }
}

const NativeSearchFieldView = findNativeSearchField();

export const nativeSearchFieldAvailable = NativeSearchFieldView !== null;

// UIKit's search field on the system material, sized like the dock above the tab bar.
export function NativeSearchField({
  query,
  onQuery,
  dark,
  width,
  placeholder = t("mobileHarborSearchInput"),
  label = t("searchLabel"),
}: {
  query: string;
  onQuery(value: string): void;
  dark: boolean;
  width?: number;
  placeholder?: string;
  label?: string;
}) {
  if (NativeSearchFieldView === null) return null;
  return (
    <NativeSearchFieldView
      query={query}
      placeholder={placeholder}
      label={label}
      dark={dark}
      onQuery={({ nativeEvent }) => onQuery(nativeEvent.query)}
      style={{ width, height: 44 }}
    />
  );
}

export function NativeTabBar({
  page,
  liveCount,
  onPage,
  dark,
  width,
}: {
  page: TabPage;
  liveCount: number | null;
  onPage(page: TabPage): void;
  dark: boolean;
  width: number;
}) {
  const window = useWindowDimensions();
  if (NativeView === null) return null;

  const visitorsLabel =
    liveCount === null
      ? t("visitors")
      : `${t("visitors")}, ${t("liveCount", { count: liveCount })}`;

  return (
    <NativeView
      page={page}
      liveCount={liveCount}
      dark={dark}
      inboxLabel={t("inbox")}
      contactsLabel={t("contacts")}
      visitorsLabel={visitorsLabel}
      analyticsLabel={t("analytics")}
      settingsLabel={t("settings")}
      onPage={({ nativeEvent }) => {
        if ((pages as readonly string[]).includes(nativeEvent.page)) {
          onPage(nativeEvent.page as TabPage);
        }
      }}
      // The floating UIKit bar draws its capsule inside its host's layout margins.
      style={{
        width: Math.min(window.width, width + 40),
        height: 74,
        marginTop: page === "inbox" ? 0 : -10,
        marginBottom: -10,
      }}
    />
  );
}
