import { type ComponentRef, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { components } from "../../../packages/sdk/src/openapi.ts";
import { flag } from "../../operator/src/place.ts";
import { t } from "../../operator/src/text.ts";
import { AnchoredMenu, type MenuItem } from "./anchored-menu";
import { Avatar, elapsedLabel, readableError } from "./common";
import { countryName } from "./contact-logic";
import {
  type ContactPage,
  type ContactSort,
  type ContactsApi,
  ContactView,
  contactName,
  ScreenError,
} from "./contact-view";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { NativeSearchField, nativeSearchFieldAvailable } from "./native-tab-bar";
import { usePinnedHeaderLayout } from "./pinned-header";
import { SceneHeader } from "./scene-header";
import { useTabBarInset } from "./tab-bar-inset";
import { night, type Palette } from "./theme";
import type { Rect } from "./thread-logic";

type Contact = components["schemas"]["Contact"];

/**
 * The list's count, honest about pages: with more to load, the total is not known, so it reads
 * "50+". While a search runs, it counts matches.
 */
function countLine(page: ContactPage, hasChatted: boolean, query: string): string {
  const shown = page.contacts.length;
  const count = page.next === null ? String(shown) : `${shown}+`;
  const one = shown === 1 && page.next === null;
  if (query) return t(one ? "mobileContactsMatchOne" : "mobileContactsMatchMany", { count });
  if (hasChatted)
    return t(one ? "mobileContactsChattedOne" : "mobileContactsChattedMany", { count });
  return t(one ? "mobileContactsAllOne" : "mobileContactsAllMany", { count });
}

function FilterChips({
  hasChatted,
  onChange,
  palette,
}: {
  hasChatted: boolean;
  onChange(hasChatted: boolean): void;
  palette: Palette;
}) {
  const options = [
    { value: true, label: t("mobileContactsChatted") },
    { value: false, label: t("contactsEveryone") },
  ];
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={t("contactsShown")} style={s.chips}>
      {options.map((option) => {
        const selected = option.value === hasChatted;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            key={option.label}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              s.chip,
              {
                backgroundColor: selected ? palette.ink : palette.paper,
                borderColor: selected ? palette.ink : palette.line,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text style={[s.chipText, { color: selected ? palette.paper : palette.ink }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SortButton({
  onChange,
  palette,
  sort,
}: {
  onChange(sort: ContactSort): void;
  palette: Palette;
  sort: ContactSort;
}) {
  const button = useRef<ComponentRef<typeof View>>(null);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [open, setOpen] = useState(false);
  const label = t(sort === "lastSeen" ? "sortLastSeen" : "sortFirstSeen");
  const items: MenuItem[] = (["lastSeen", "firstSeen"] as const).map((value) => ({
    label: t(value === "lastSeen" ? "sortLastSeen" : "sortFirstSeen"),
    icon: (color: string) =>
      value === sort ? <Icon name="check" size={19} color={color} /> : null,
    run: () => onChange(value),
  }));
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("contactsSort")}: ${label}`}
        hitSlop={4}
        onPress={() =>
          button.current?.measureInWindow((x, y, width, height) => {
            setAnchor({ x, y, width, height });
            setOpen(true);
          })
        }
        style={({ pressed }) => [s.sort, { opacity: pressed ? 0.6 : 1 }]}
      >
        <View collapsable={false} ref={button} style={s.sortInner}>
          <Text style={[s.sortText, { color: palette.ink }]}>{label}</Text>
          <Icon name="down" size={16} color={palette.sub} />
        </View>
      </Pressable>
      <AnchoredMenu
        anchor={anchor}
        items={items}
        label={t("contactsSort")}
        onClose={() => setOpen(false)}
        palette={palette}
        side="end"
        visible={open}
      />
    </>
  );
}

/** An iOS-style filled search field that stays with the Contacts list as it scrolls. */
function ContactSearch({
  onChange,
  palette,
  query,
}: {
  onChange(value: string): void;
  palette: Palette;
  query: string;
}) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const clear = () => {
    onChange("");
    input.current?.focus();
  };
  if (nativeSearchFieldAvailable) {
    return (
      <View style={s.searchPosition}>
        <NativeSearchField
          dark={palette === night}
          label={t("contactsSearch")}
          placeholder={t("contactsSearchPlaceholder")}
          query={query}
          onQuery={onChange}
        />
      </View>
    );
  }
  return (
    <View style={[s.searchPosition, s.search, { backgroundColor: palette.wash }]}>
      <Icon name="search" size={18} color={palette.sub} />
      <TextInput
        ref={input}
        accessibilityLabel={t("contactsSearch")}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        onChangeText={onChange}
        accessibilityHint={t("contactsSearchPlaceholder")}
        placeholder={t("contactsSearch")}
        placeholderTextColor={palette.sub}
        returnKeyType="search"
        style={[s.searchInput, { color: palette.ink }]}
        value={query}
      />
      {Platform.OS !== "ios" && query.length > 0 && (
        <Pressable
          accessibilityLabel={t("clearSearch")}
          accessibilityRole="button"
          hitSlop={6}
          onPress={clear}
          style={s.clearSearch}
        >
          <Icon name="x" size={15} color={palette.sub} />
        </Pressable>
      )}
    </View>
  );
}

function ContactRow({
  contact,
  onPress,
  palette,
}: {
  contact: Contact;
  onPress(): void;
  palette: Palette;
}) {
  const name = contactName(contact);
  const place = contact.country ? `${flag(contact.country)} ${countryName(contact.country)}` : null;
  const chats = t(contact.conversationCount === 1 ? "mobileChatOne" : "mobileChatMany", {
    count: contact.conversationCount,
  });
  const meta = [contact.company, place, chats].filter((part): part is string => Boolean(part));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[name, contact.blocked ? t("contactBlocked") : null, ...meta]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={t("mobileOpenVisitorDetails", { name })}
      onPress={onPress}
      style={({ pressed }) => [
        s.contactRow,
        { backgroundColor: pressed ? palette.wash : palette.paper },
      ]}
    >
      <Avatar name={name} palette={palette} size={42} />
      <View style={s.contactCopy}>
        <View style={s.rowTop}>
          <Text numberOfLines={1} style={[s.contactName, { color: palette.ink }]}>
            {name}
          </Text>
          {contact.lastSeenAt !== null && (
            <Text style={[s.contactTime, { color: palette.sub }]}>
              {elapsedLabel(contact.lastSeenAt)}
            </Text>
          )}
        </View>
        {contact.email !== null && contact.email !== name && (
          <Text numberOfLines={1} style={[s.contactEmail, { color: palette.sub }]}>
            {contact.email}
          </Text>
        )}
        <Text numberOfLines={1} style={[s.meta, { color: palette.sub }]}>
          {contact.blocked && (
            <Text style={{ color: palette.amber }}>{`${t("contactBlocked")} · `}</Text>
          )}
          {meta.join(" · ")}
        </Text>
      </View>
      <View style={[s.rowDivider, { backgroundColor: palette.line }]} />
    </Pressable>
  );
}

function ContactsList({
  api,
  onQuery,
  query: typed,
  onOpen,
  palette,
  revision,
  topInset,
}: {
  api: ContactsApi;
  onQuery(value: string): void;
  query: string;
  onOpen(id: string): void;
  palette: Palette;
  revision: number;
  topInset: number;
}) {
  const { hasLargeText, hideScene } = usePinnedHeaderLayout();
  const dockInset = useTabBarInset();
  const [query, setQuery] = useState(typed.trim());
  const [sort, setSort] = useState<ContactSort>("lastSeen");
  const [hasChatted, setHasChatted] = useState(true);
  const [page, setPage] = useState<ContactPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 350);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    void reload;
    void revision;
    let current = true;
    setLoading(true);
    setError("");
    setMoreError("");
    void api
      .contacts({ q: query, sort, before: null, hasChatted })
      .then((answer) => {
        if (current) setPage(answer);
      })
      .catch((failure: unknown) => {
        if (current) {
          setPage(null);
          setError(readableError(failure));
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      current = false;
    };
  }, [api, hasChatted, query, reload, revision, sort]);

  async function loadMore() {
    if (page?.next === null || page === null || moreBusy) return;
    setMoreBusy(true);
    setMoreError("");
    try {
      const answer = await api.contacts({ q: query, sort, before: page.next, hasChatted });
      setPage((current) =>
        current === null
          ? answer
          : { contacts: [...current.contacts, ...answer.contacts], next: answer.next },
      );
    } catch (failure) {
      setMoreError(readableError(failure));
    } finally {
      setMoreBusy(false);
    }
  }

  const empty = page !== null && page.contacts.length === 0;
  const subtitle =
    page === null || (empty && !query) ? t("contactsContext") : countLine(page, hasChatted, query);
  return (
    <View style={[s.screen, { backgroundColor: palette.paper, paddingTop: topInset }]}>
      <View>
        {!hideScene && !keyboardVisible && (
          <SceneHeader
            scene="contacts"
            title={t("contacts")}
            subtitle={subtitle}
            palette={palette}
          />
        )}
      </View>
      <ContactSearch onChange={onQuery} palette={palette} query={typed} />
      <View style={[s.tools, hasLargeText && s.largeTools]}>
        <FilterChips hasChatted={hasChatted} onChange={setHasChatted} palette={palette} />
        <SortButton onChange={setSort} palette={palette} sort={sort} />
      </View>
      <ScrollView
        alwaysBounceVertical
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              setReload((value) => value + 1);
            }}
            tintColor={palette.blue}
          />
        }
        scrollIndicatorInsets={{ bottom: dockInset }}
        style={s.list}
        contentContainerStyle={[s.listContent, { paddingBottom: 16 + dockInset }]}
      >
        {loading && page === null ? (
          <ActivityIndicator
            accessibilityLabel={t("loading")}
            color={palette.blue}
            style={s.loader}
          />
        ) : error ? (
          <ScreenError
            error={error}
            onRetry={() => setReload((value) => value + 1)}
            palette={palette}
          />
        ) : empty ? (
          <View style={s.centerState}>
            <Text style={[s.stateTitle, { color: palette.ink }]}>
              {t(query ? "contactsNone" : "contactsEmpty")}
            </Text>
            {!query && (
              <Text style={[s.stateCopy, { color: palette.sub }]}>{t("contactsEmptyHint")}</Text>
            )}
          </View>
        ) : (
          <View>
            {page?.contacts.map((contact) => (
              <ContactRow
                contact={contact}
                key={contact.id}
                onPress={() => {
                  Keyboard.dismiss();
                  onOpen(contact.id);
                }}
                palette={palette}
              />
            ))}
            {page?.next !== null && (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: moreBusy, disabled: moreBusy }}
                disabled={moreBusy}
                onPress={() => void loadMore()}
                style={s.moreButton}
              >
                {moreBusy ? (
                  <ActivityIndicator color={palette.blue} />
                ) : (
                  <Text style={[s.moreText, { color: palette.blue }]}>{t("loadMore")}</Text>
                )}
              </Pressable>
            )}
            {moreError && (
              <View accessibilityRole="alert" style={s.moreError}>
                <Text style={[s.stateCopy, { color: palette.amber }]}>{moreError}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void loadMore()}
                  style={s.textButton}
                >
                  <Text style={[s.moreText, { color: palette.blue }]}>{t("mobileRetry")}</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

export function ContactsScreen({
  api,
  palette,
  topInset,
  onDetailChange,
  onOpenConversation,
  onQuery,
  query,
  readOnly,
}: {
  api: ContactsApi;
  palette: Palette;
  topInset: number;
  /** Tells the app when a contact is open, so the footer hides the search field. */
  onDetailChange(open: boolean): void;
  onOpenConversation(id: string, contactId: string): void;
  /** Updates the Contacts list's inline search field. */
  onQuery(value: string): void;
  /** The text in the Contacts list's inline search field. */
  query: string;
  readOnly: boolean;
}) {
  const [contactId, setContactId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    void api;
    setContactId(null);
  }, [api]);
  const detailChange = useRef(onDetailChange);
  detailChange.current = onDetailChange;
  useEffect(() => {
    detailChange.current(contactId !== null);
  }, [contactId]);
  if (contactId !== null) {
    return (
      <ContactView
        api={api}
        contactId={contactId}
        onBack={() => setContactId(null)}
        onChanged={() => setRevision((value) => value + 1)}
        onOpenConversation={onOpenConversation}
        palette={palette}
        readOnly={readOnly}
        topInset={topInset}
      />
    );
  }
  return (
    <ContactsList
      api={api}
      onQuery={onQuery}
      query={query}
      onOpen={setContactId}
      palette={palette}
      revision={revision}
      topInset={topInset}
    />
  );
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  list: { flex: 1 },
  listContent: { flexGrow: 1, paddingBottom: 16 },
  searchPosition: { marginHorizontal: 16, marginTop: 10 },
  search: {
    minHeight: 36,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingStart: 10,
    paddingEnd: 3,
  },
  searchInput: { flex: 1, minWidth: 0, paddingVertical: 8, fontFamily: fonts.body, fontSize: 16 },
  clearSearch: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  tools: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingStart: 16,
    paddingEnd: 8,
    paddingTop: 14,
    paddingBottom: 6,
  },
  largeTools: { flexDirection: "column", alignItems: "flex-start", gap: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    minHeight: 38,
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 19,
    paddingHorizontal: 14,
  },
  chipText: { fontFamily: fonts.semibold, fontSize: 13.5, lineHeight: 18 },
  sort: { minHeight: 44, justifyContent: "center" },
  sortInner: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
  },
  sortText: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 19 },
  loader: { paddingVertical: 72 },
  centerState: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 34,
    paddingVertical: 72,
    gap: 14,
  },
  stateTitle: { fontFamily: fonts.semibold, fontSize: 18, lineHeight: 24, textAlign: "center" },
  stateCopy: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, textAlign: "center" },
  contactRow: {
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowDivider: {
    position: "absolute",
    bottom: 0,
    right: 0,
    left: 70,
    height: StyleSheet.hairlineWidth,
  },
  contactCopy: { flex: 1, minWidth: 0, gap: 1 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  contactName: { flex: 1, fontFamily: fonts.semibold, fontSize: 16, lineHeight: 21 },
  contactTime: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  contactEmail: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19 },
  meta: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  moreButton: { minHeight: 54, alignItems: "center", justifyContent: "center" },
  moreText: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 20 },
  moreError: { alignItems: "center", paddingHorizontal: 22, paddingBottom: 18, gap: 4 },
  textButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 15 },
});
