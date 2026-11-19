import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { components } from "../../../packages/sdk/src/openapi.ts";
import { t } from "../../operator/src/text.ts";
import type { DinghyApi } from "./api";
import { Avatar, elapsedLabel, readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import type { Palette } from "./theme";

type Contact = components["schemas"]["Contact"];
type ContactDetail = components["schemas"]["ContactDetail"];
type ContactConversation = ContactDetail["conversations"][number];
type ContactSort = "lastSeen" | "firstSeen";
type ContactPage = { contacts: Contact[]; next: string | null };

type ContactsApi = Pick<DinghyApi, "changeContact" | "contact"> & {
  contacts(query: {
    q: string;
    sort: ContactSort;
    before: string | null;
    hasChatted: boolean;
  }): Promise<ContactPage>;
};

function contactName(contact: Pick<Contact, "email" | "name">): string {
  return contact.name || contact.email || t("visitorAnonymous");
}

function shortDate(value: string): string {
  return new Date(value).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function flag(country: string): string {
  if (!/^[A-Z]{2}$/.test(country)) return "";
  const firstIndicator = 0x1f1e6;
  return String.fromCodePoint(
    ...[...country].map((letter) => firstIndicator + letter.charCodeAt(0) - 65),
  );
}

function countryName(country: string): string {
  try {
    return new Intl.DisplayNames([], { type: "region" }).of(country) ?? country;
  } catch {
    return country;
  }
}

function conversationPreview(conversation: ContactConversation): string {
  if (conversation.lastKind === null) return t("noMessages");
  if (conversation.lastBody?.trim()) return conversation.lastBody.trim();
  return t(conversation.lastKind === "file" ? "file" : "image");
}

function Choice<T extends string>({
  label,
  onChange,
  options,
  palette,
  value,
}: {
  label: string;
  onChange(value: T): void;
  options: { label: string; value: T }[];
  palette: Palette;
  value: T;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={s.choiceGroup}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              s.choice,
              {
                backgroundColor: selected ? palette.tint : palette.paper,
                borderColor: selected ? palette.blue : palette.line,
                opacity: pressed ? 0.68 : 1,
              },
            ]}
          >
            <Text style={[s.choiceText, { color: selected ? palette.blue : palette.sub }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ScreenError({
  error,
  onRetry,
  palette,
}: {
  error: string;
  onRetry(): void;
  palette: Palette;
}) {
  return (
    <View accessibilityRole="alert" style={s.centerState}>
      <Text style={[s.stateTitle, { color: palette.ink }]}>{error}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [
          s.outlineButton,
          { borderColor: palette.line, opacity: pressed ? 0.68 : 1 },
        ]}
      >
        <Text style={[s.outlineButtonText, { color: palette.ink }]}>{t("mobileRetry")}</Text>
      </Pressable>
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityHint={t("mobileOpenVisitorDetails", { name })}
      onPress={onPress}
      style={({ pressed }) => [
        s.contactRow,
        {
          borderBottomColor: palette.line,
          backgroundColor: pressed ? palette.wash : palette.paper,
        },
      ]}
    >
      <Avatar name={name} palette={palette} size={44} />
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
        <View style={s.metaLine}>
          {contact.company !== null && (
            <Text numberOfLines={1} style={[s.meta, { color: palette.sub }]}>
              {contact.company}
            </Text>
          )}
          {place !== null && (
            <Text numberOfLines={1} style={[s.meta, { color: palette.sub }]}>
              {place}
            </Text>
          )}
          <Text style={[s.meta, { color: palette.sub }]}>
            {t("colConversations")}: {contact.conversationCount}
          </Text>
        </View>
      </View>
      <Icon name="next" size={17} color={palette.sub} />
    </Pressable>
  );
}

function ContactsList({
  api,
  onOpen,
  palette,
  revision,
  topInset,
}: {
  api: ContactsApi;
  onOpen(id: string): void;
  palette: Palette;
  revision: number;
  topInset: number;
}) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ContactSort>("lastSeen");
  const [hasChatted, setHasChatted] = useState(true);
  const [page, setPage] = useState<ContactPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState("");

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
        if (current) setLoading(false);
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
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={loading && page !== null}
          onRefresh={() => setReload((value) => value + 1)}
          tintColor={palette.blue}
        />
      }
      style={{ backgroundColor: palette.paper }}
      contentContainerStyle={{ paddingBottom: 16 }}
    >
      <View style={[s.listHeader, { paddingTop: topInset + 16, backgroundColor: palette.cover }]}>
        <Text style={[s.title, { color: palette.coverInk }]}>{t("contacts")}</Text>
        <Text style={[s.subtitle, { color: palette.coverSub }]}>{t("contactsContext")}</Text>
      </View>
      <View style={[s.tools, { borderBottomColor: palette.line }]}>
        <View style={[s.search, { backgroundColor: palette.wash }]}>
          <Icon name="search" size={20} color={palette.sub} />
          <TextInput
            accessibilityLabel={t("contactsSearch")}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            onChangeText={setTyped}
            placeholder={t("contactsSearchPlaceholder")}
            placeholderTextColor={palette.sub}
            returnKeyType="search"
            value={typed}
            style={[s.searchInput, { color: palette.ink }]}
          />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.filters}
        >
          <Choice<"chatted" | "everyone">
            label={t("contactsShown")}
            onChange={(value) => setHasChatted(value === "chatted")}
            options={[
              { value: "chatted", label: t("contactsHasChatted") },
              { value: "everyone", label: t("contactsEveryone") },
            ]}
            palette={palette}
            value={hasChatted ? "chatted" : "everyone"}
          />
          <Choice<ContactSort>
            label={t("contactsSort")}
            onChange={setSort}
            options={[
              { value: "lastSeen", label: t("sortLastSeen") },
              { value: "firstSeen", label: t("sortFirstSeen") },
            ]}
            palette={palette}
            value={sort}
          />
        </ScrollView>
      </View>
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
              onPress={() => onOpen(contact.id)}
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
              <Pressable accessibilityRole="button" onPress={() => void loadMore()}>
                <Text style={[s.moreText, { color: palette.blue }]}>{t("mobileRetry")}</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </ScrollView>
  );
}

function Chip({
  children,
  palette,
  warning = false,
}: {
  children: string;
  palette: Palette;
  warning?: boolean;
}) {
  return (
    <View style={[s.chip, { backgroundColor: warning ? palette.warm : palette.wash }]}>
      <Text style={[s.chipText, { color: warning ? palette.amber : palette.sub }]}>{children}</Text>
    </View>
  );
}

function Fact({ label, palette, value }: { label: string; palette: Palette; value: string }) {
  return (
    <View style={[s.fact, { backgroundColor: palette.wash }]}>
      <Text style={[s.factLabel, { color: palette.sub }]}>{label}</Text>
      <Text numberOfLines={2} style={[s.factValue, { color: palette.ink }]}>
        {value}
      </Text>
    </View>
  );
}

function IdentityEditor({
  contact,
  onCancel,
  onSaved,
  palette,
  api,
}: {
  contact: ContactDetail;
  onCancel(): void;
  onSaved(contact: ContactDetail): void;
  palette: Palette;
  api: ContactsApi;
}) {
  const [name, setName] = useState(contact.name ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (busy) return;
    Keyboard.dismiss();
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api.changeContact(contact.id, {
          name: name.trim() || null,
          email: email.trim() || null,
        }),
      );
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={[s.editor, { backgroundColor: palette.sheet, borderColor: palette.line }]}>
      <Text style={[s.sectionTitle, { color: palette.ink }]}>{t("contactEdit")}</Text>
      <Text style={[s.stateCopy, { color: palette.sub }]}>{t("contactIdentityHelp")}</Text>
      <Text style={[s.inputLabel, { color: palette.ink }]}>{t("contactNameLabel")}</Text>
      <TextInput
        accessibilityLabel={t("contactNameLabel")}
        autoComplete="name"
        editable={!busy}
        onChangeText={setName}
        value={name}
        style={[s.field, { backgroundColor: palette.wash, color: palette.ink }]}
      />
      <Text style={[s.inputLabel, { color: palette.ink }]}>{t("mobileEmailAddress")}</Text>
      <TextInput
        accessibilityLabel={t("mobileEmailAddress")}
        autoCapitalize="none"
        autoComplete="email"
        editable={!busy}
        keyboardType="email-address"
        onChangeText={setEmail}
        value={email}
        style={[s.field, { backgroundColor: palette.wash, color: palette.ink }]}
      />
      {error && (
        <Text accessibilityRole="alert" style={[s.stateCopy, { color: palette.amber }]}>
          {error}
        </Text>
      )}
      <View style={s.editorActions}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onCancel}
          style={s.actionButton}
        >
          <Text style={[s.actionText, { color: palette.sub }]}>{t("cancel")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy }}
          disabled={busy}
          onPress={() => void save()}
          style={[s.primaryButton, { backgroundColor: palette.blue }]}
        >
          {busy ? (
            <ActivityIndicator color={palette.onBlue} />
          ) : (
            <Text style={[s.actionText, { color: palette.onBlue }]}>{t("contactSave")}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function NoteEditor({
  api,
  contact,
  onSaved,
  palette,
  readOnly,
}: {
  api: ContactsApi;
  contact: ContactDetail;
  onSaved(contact: ContactDetail): void;
  palette: Palette;
  readOnly: boolean;
}) {
  const [note, setNote] = useState(contact.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = note !== (contact.note ?? "");
  useEffect(() => setNote(contact.note ?? ""), [contact.note]);
  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setError("");
    try {
      onSaved(await api.changeContact(contact.id, { note: note || null }));
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.section}>
      <Text style={[s.sectionTitle, { color: palette.ink }]}>{t("panelNote")}</Text>
      <TextInput
        accessibilityLabel={t("panelNote")}
        accessibilityState={{ disabled: readOnly }}
        editable={!busy && !readOnly}
        multiline
        onChangeText={setNote}
        value={note}
        style={[s.noteField, { backgroundColor: palette.wash, color: palette.ink }]}
      />
      <View style={s.noteFooter}>
        <Text style={[s.noteHelp, { color: error ? palette.amber : palette.sub }]}>
          {error || t("contactNoteSaved")}
        </Text>
        {dirty && !readOnly && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy }}
            disabled={busy}
            onPress={() => void save()}
            style={[s.noteSave, { backgroundColor: palette.blue }]}
          >
            {busy ? (
              <ActivityIndicator color={palette.onBlue} size="small" />
            ) : (
              <Text style={[s.noteSaveText, { color: palette.onBlue }]}>{t("save")}</Text>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

function ConversationRow({
  conversation,
  onOpen,
  palette,
}: {
  conversation: ContactConversation;
  onOpen(): void;
  palette: Palette;
}) {
  const facts = [
    conversation.assigneeName,
    t(conversation.messageCount === 1 ? "contactMessagesOne" : "contactMessagesMany", {
      count: conversation.messageCount,
    }),
  ].filter((part): part is string => Boolean(part));
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        s.conversation,
        { borderColor: palette.line, backgroundColor: pressed ? palette.wash : palette.paper },
      ]}
    >
      <View style={s.rowTop}>
        <View
          style={[
            s.status,
            { backgroundColor: conversation.status === "open" ? palette.tint : palette.wash },
          ]}
        >
          <Text
            style={[
              s.statusText,
              { color: conversation.status === "open" ? palette.blue : palette.sub },
            ]}
          >
            {t(conversation.status)}
          </Text>
        </View>
        <Text style={[s.contactTime, { color: palette.sub }]}>
          {elapsedLabel(conversation.updatedAt)}
        </Text>
      </View>
      <Text numberOfLines={2} style={[s.conversationBody, { color: palette.ink }]}>
        {conversationPreview(conversation)}
      </Text>
      <Text numberOfLines={1} style={[s.meta, { color: palette.sub }]}>
        {facts.join(" · ")}
      </Text>
    </Pressable>
  );
}

function DetailValues({ contact, palette }: { contact: ContactDetail; palette: Palette }) {
  const values = useMemo(() => {
    const all = { ...(contact.attributes ?? {}), ...(contact.pageContext ?? {}) };
    return Object.entries(all)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 20) as [string, string | number | boolean][];
  }, [contact.attributes, contact.pageContext]);
  if (values.length === 0) return null;
  return (
    <View style={s.section}>
      <Text style={[s.sectionTitle, { color: palette.ink }]}>{t("contactDetails")}</Text>
      <View style={[s.valueList, { borderColor: palette.line }]}>
        {values.map(([key, value], index) => (
          <View
            key={key}
            style={[
              s.valueRow,
              index > 0 && {
                borderTopColor: palette.line,
                borderTopWidth: StyleSheet.hairlineWidth,
              },
            ]}
          >
            <Text selectable style={[s.valueKey, { color: palette.sub }]}>
              {key}
            </Text>
            <Text selectable numberOfLines={3} style={[s.valueText, { color: palette.ink }]}>
              {String(value)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function ContactView({
  api,
  contactId,
  onBack,
  onChanged,
  onOpenConversation,
  palette,
  readOnly,
  topInset,
}: {
  api: ContactsApi;
  contactId: string;
  onBack(): void;
  onChanged(): void;
  onOpenConversation(id: string, contactId: string): void;
  palette: Palette;
  readOnly: boolean;
  topInset: number;
}) {
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    void reload;
    let current = true;
    setLoading(true);
    setError("");
    void api
      .contact(contactId)
      .then((answer) => {
        if (current) setContact(answer);
      })
      .catch((failure: unknown) => {
        if (current) setError(readableError(failure));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, contactId, reload]);

  function saved(next: ContactDetail) {
    setContact(next);
    setEditing(false);
    onChanged();
  }

  if (loading && contact === null) {
    return (
      <View style={[s.fullState, { backgroundColor: palette.paper, paddingTop: topInset }]}>
        <ActivityIndicator accessibilityLabel={t("loading")} color={palette.blue} />
      </View>
    );
  }
  if (error && contact === null) {
    return (
      <View style={[s.fullState, { backgroundColor: palette.paper, paddingTop: topInset }]}>
        <ScreenError
          error={error}
          onRetry={() => setReload((value) => value + 1)}
          palette={palette}
        />
        <Pressable accessibilityRole="button" onPress={onBack} style={s.actionButton}>
          <Text style={[s.actionText, { color: palette.blue }]}>{t("back")}</Text>
        </Pressable>
      </View>
    );
  }
  if (contact === null) return null;
  const name = contactName(contact);
  const newest =
    contact.conversations.find((item) => item.status === "open") ?? contact.conversations[0];
  const location = contact.country
    ? `${flag(contact.country)} ${countryName(contact.country)}`
    : null;
  return (
    <ScrollView
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={() => setReload((value) => value + 1)}
          tintColor={palette.blue}
        />
      }
      style={{ backgroundColor: palette.paper }}
      contentContainerStyle={{ paddingBottom: 16 }}
    >
      <View style={[s.detailHeader, { paddingTop: topInset + 6, backgroundColor: palette.cover }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("back")}
          hitSlop={8}
          onPress={onBack}
          style={s.backButton}
        >
          <Icon name="back" size={22} color={palette.coverInk} />
          <Text style={[s.backText, { color: palette.coverInk }]}>{t("contacts")}</Text>
        </Pressable>
      </View>
      <View style={s.detailBody}>
        <View style={s.hero}>
          <Avatar name={name} palette={palette} size={68} />
          <View style={s.heroCopy}>
            <View style={s.heroNameLine}>
              <Text selectable style={[s.heroName, { color: palette.ink }]}>
                {name}
              </Text>
              {!contact.signedIn && !editing && !readOnly && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("contactEdit")}
                  hitSlop={10}
                  onPress={() => setEditing(true)}
                >
                  <Icon name="settings" size={20} color={palette.blue} />
                </Pressable>
              )}
            </View>
            {contact.email !== null && contact.email !== name && (
              <Text selectable style={[s.heroEmail, { color: palette.sub }]}>
                {contact.email}
              </Text>
            )}
            <View style={s.chips}>
              {contact.online === true && <Chip palette={palette}>{t("contactOnline")}</Chip>}
              {contact.signedIn && <Chip palette={palette}>{t("contactSignedIn")}</Chip>}
              {contact.blocked && (
                <Chip palette={palette} warning>
                  {t("contactBlocked")}
                </Chip>
              )}
            </View>
          </View>
        </View>
        {error && (
          <Text accessibilityRole="alert" style={[s.stateCopy, { color: palette.amber }]}>
            {error}
          </Text>
        )}
        {editing && (
          <IdentityEditor
            api={api}
            contact={contact}
            onCancel={() => setEditing(false)}
            onSaved={saved}
            palette={palette}
          />
        )}
        {newest !== undefined && (
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenConversation(newest.id, contactId)}
            style={({ pressed }) => [
              s.openButton,
              { backgroundColor: palette.blue, opacity: pressed ? 0.75 : 1 },
            ]}
          >
            <Icon name="chat" size={20} color={palette.onBlue} />
            <Text style={[s.openButtonText, { color: palette.onBlue }]}>
              {t("contactOpenConversation")}
            </Text>
          </Pressable>
        )}
        <View style={s.facts}>
          <Fact
            label={t("contactConversations")}
            palette={palette}
            value={String(contact.conversations.length)}
          />
          <Fact
            label={t("contactFirstSeen")}
            palette={palette}
            value={shortDate(contact.createdAt)}
          />
          {location !== null && (
            <Fact label={t("contactLocation")} palette={palette} value={location} />
          )}
          {contact.device !== null && (
            <Fact label={t("deviceLabel")} palette={palette} value={contact.device} />
          )}
        </View>
        <NoteEditor
          api={api}
          contact={contact}
          onSaved={saved}
          palette={palette}
          readOnly={readOnly}
        />
        <View style={s.section}>
          <Text style={[s.sectionTitle, { color: palette.ink }]}>{t("contactConversations")}</Text>
          {contact.conversations.length === 0 ? (
            <Text style={[s.stateCopy, { color: palette.sub }]}>{t("noMessages")}</Text>
          ) : (
            <View style={s.conversations}>
              {contact.conversations.map((conversation) => (
                <ConversationRow
                  conversation={conversation}
                  key={conversation.id}
                  onOpen={() => onOpenConversation(conversation.id, contactId)}
                  palette={palette}
                />
              ))}
            </View>
          )}
        </View>
        {contact.pages.length > 0 && (
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: palette.ink }]}>{t("pagesVisited")}</Text>
            <View style={[s.valueList, { borderColor: palette.line }]}>
              {contact.pages.slice(0, 20).map((page, index) => (
                <View
                  key={`${page.viewedAt}-${page.path}`}
                  style={[
                    s.pageRow,
                    index > 0 && {
                      borderTopColor: palette.line,
                      borderTopWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <Text numberOfLines={1} style={[s.valueText, { color: palette.ink }]}>
                    {page.title || page.path}
                  </Text>
                  <Text numberOfLines={1} style={[s.meta, { color: palette.sub }]}>
                    {page.path} · {elapsedLabel(page.viewedAt)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}
        <DetailValues contact={contact} palette={palette} />
      </View>
    </ScrollView>
  );
}

export function ContactsScreen({
  api,
  palette,
  topInset,
  initialContactId,
  onOpenConversation,
  readOnly,
}: {
  api: ContactsApi;
  palette: Palette;
  topInset: number;
  initialContactId?: string | null;
  onOpenConversation(id: string, contactId: string): void;
  readOnly: boolean;
}) {
  const [contactId, setContactId] = useState<string | null>(initialContactId ?? null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    void api;
    setContactId(initialContactId ?? null);
  }, [api, initialContactId]);
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
      onOpen={setContactId}
      palette={palette}
      revision={revision}
      topInset={topInset}
    />
  );
}

const s = StyleSheet.create({
  listHeader: { paddingHorizontal: 22, paddingBottom: 22, gap: 4 },
  title: { fontFamily: fonts.bold, fontSize: 34, lineHeight: 40 },
  subtitle: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, maxWidth: 430 },
  tools: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  search: {
    minHeight: 46,
    borderRadius: 23,
    paddingHorizontal: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  searchInput: { flex: 1, minHeight: 46, fontFamily: fonts.body, fontSize: 16, paddingVertical: 0 },
  filters: { gap: 16, paddingEnd: 8 },
  choiceGroup: { flexDirection: "row", gap: 5 },
  choice: {
    minHeight: 36,
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    paddingHorizontal: 12,
  },
  choiceText: { fontFamily: fonts.semibold, fontSize: 13 },
  loader: { paddingVertical: 72 },
  centerState: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 34,
    paddingVertical: 72,
    gap: 14,
  },
  fullState: { flex: 1, alignItems: "center", justifyContent: "center" },
  stateTitle: { fontFamily: fonts.semibold, fontSize: 18, lineHeight: 24, textAlign: "center" },
  stateCopy: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, textAlign: "center" },
  outlineButton: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  outlineButtonText: { fontFamily: fonts.semibold, fontSize: 15 },
  contactRow: {
    minHeight: 78,
    paddingHorizontal: 17,
    paddingVertical: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contactCopy: { flex: 1, minWidth: 0, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  contactName: { flex: 1, fontFamily: fonts.semibold, fontSize: 16 },
  contactTime: { fontFamily: fonts.body, fontSize: 12 },
  contactEmail: { fontFamily: fonts.body, fontSize: 14 },
  metaLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: 12,
    rowGap: 2,
  },
  meta: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
  moreButton: { minHeight: 54, alignItems: "center", justifyContent: "center" },
  moreText: { fontFamily: fonts.semibold, fontSize: 15 },
  moreError: { alignItems: "center", paddingHorizontal: 22, paddingBottom: 18, gap: 7 },
  detailHeader: { paddingHorizontal: 10, paddingBottom: 8 },
  backButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 2,
    paddingHorizontal: 6,
  },
  backText: { fontFamily: fonts.semibold, fontSize: 16 },
  detailBody: { paddingHorizontal: 20, paddingTop: 24, gap: 26 },
  hero: { flexDirection: "row", alignItems: "center", gap: 16 },
  heroCopy: { flex: 1, minWidth: 0, gap: 3 },
  heroNameLine: { flexDirection: "row", alignItems: "center", gap: 10 },
  heroName: { flexShrink: 1, fontFamily: fonts.bold, fontSize: 25, lineHeight: 31 },
  heroEmail: { fontFamily: fonts.body, fontSize: 15 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 5 },
  chip: { minHeight: 25, borderRadius: 13, paddingHorizontal: 9, justifyContent: "center" },
  chipText: { fontFamily: fonts.semibold, fontSize: 11 },
  openButton: {
    minHeight: 48,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 18,
  },
  openButtonText: { fontFamily: fonts.semibold, fontSize: 16 },
  facts: { flexDirection: "row", flexWrap: "wrap", gap: 9 },
  fact: { minWidth: "47%", flexGrow: 1, flexBasis: 150, borderRadius: 16, padding: 14, gap: 5 },
  factLabel: { fontFamily: fonts.semibold, fontSize: 12 },
  factValue: { fontFamily: fonts.semibold, fontSize: 17, lineHeight: 22 },
  section: { gap: 11 },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 19, lineHeight: 24 },
  noteField: {
    minHeight: 106,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: fonts.body,
    fontSize: 15,
    textAlignVertical: "top",
  },
  noteFooter: {
    minHeight: 35,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  noteHelp: { flex: 1, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
  noteSave: {
    minWidth: 72,
    minHeight: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  noteSaveText: { fontFamily: fonts.semibold, fontSize: 14 },
  conversations: { gap: 9 },
  conversation: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 14, gap: 8 },
  status: { minHeight: 24, borderRadius: 12, justifyContent: "center", paddingHorizontal: 9 },
  statusText: { fontFamily: fonts.semibold, fontSize: 11 },
  conversationBody: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 21 },
  editor: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 16, gap: 10 },
  inputLabel: { fontFamily: fonts.semibold, fontSize: 13, marginTop: 3 },
  field: {
    minHeight: 46,
    borderRadius: 23,
    paddingHorizontal: 15,
    fontFamily: fonts.body,
    fontSize: 16,
  },
  editorActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 5,
    paddingTop: 4,
  },
  actionButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 15 },
  actionText: { fontFamily: fonts.semibold, fontSize: 15 },
  primaryButton: {
    minWidth: 92,
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  valueList: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, overflow: "hidden" },
  valueRow: { flexDirection: "row", gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
  valueKey: { width: "38%", fontFamily: fonts.semibold, fontSize: 12, lineHeight: 18 },
  valueText: { flex: 1, fontFamily: fonts.body, fontSize: 14, lineHeight: 19 },
  pageRow: { paddingHorizontal: 14, paddingVertical: 11, gap: 2 },
});
