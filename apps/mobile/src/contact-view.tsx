import {
  type ComponentRef,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
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
import { flag } from "../../operator/src/place.ts";
import { t } from "../../operator/src/text.ts";
import { AnchoredMenu, type MenuItem } from "./anchored-menu";
import type { DinghyApi } from "./api";
import { Avatar, elapsedLabel, readableError } from "./common";
import { countryName, detailRows, pageRuns } from "./contact-logic";
import {
  CompactBar,
  CopiedToast,
  DetailLine,
  FullList,
  PageLine,
  ShowAll,
  useCopy,
  useHardwareBack,
} from "./contact-parts";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import type { Palette } from "./theme";
import type { Rect } from "./thread-logic";

// One contact: who they are, the actions, the note, their chats, and short lists of the pages they
// saw and the details the site sent, each with a way to see all of it.

type Contact = components["schemas"]["Contact"];
type ContactDetail = components["schemas"]["ContactDetail"];
type ContactConversation = ContactDetail["conversations"][number];
export type ContactSort = "lastSeen" | "firstSeen";
export type ContactPage = { contacts: Contact[]; next: string | null };

export type ContactsApi = Pick<DinghyApi, "changeContact" | "contact" | "setBlocked"> & {
  contacts(query: {
    q: string;
    sort: ContactSort;
    before: string | null;
    hasChatted: boolean;
  }): Promise<ContactPage>;
};

/** Rows of pages and of details that the contact shows before "Show all". */
const PAGES_FIRST = 5;
const DETAILS_FIRST = 4;

export function contactName(contact: Pick<Contact, "email" | "name">): string {
  return contact.name || contact.email || t("visitorAnonymous");
}

function shortDate(value: string): string {
  return new Date(value).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function conversationPreview(conversation: ContactConversation): string {
  if (conversation.lastKind === null) return t("noMessages");
  if (conversation.lastBody?.trim()) return conversation.lastBody.trim();
  return t(conversation.lastKind === "file" ? "file" : "image");
}

export function ScreenError({
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

function Badge({
  children,
  palette,
  tone = "plain",
}: {
  children: string;
  palette: Palette;
  tone?: "plain" | "live" | "warning";
}) {
  const colors =
    tone === "warning"
      ? { backgroundColor: palette.warm, color: palette.amber }
      : tone === "live"
        ? { backgroundColor: palette.tint, color: palette.blue }
        : { backgroundColor: palette.wash, color: palette.sub };
  return (
    <View style={[s.badge, { backgroundColor: colors.backgroundColor }]}>
      {tone === "live" && <View style={[s.liveDot, { backgroundColor: palette.green }]} />}
      <Text style={[s.badgeText, { color: colors.color }]}>{children}</Text>
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
      <Text style={[s.help, { color: palette.sub }]}>{t("contactIdentityHelp")}</Text>
      <Text style={[s.inputLabel, { color: palette.ink }]}>{t("contactNameLabel")}</Text>
      <TextInput
        accessibilityLabel={t("contactNameLabel")}
        autoComplete="name"
        autoFocus
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
        onSubmitEditing={() => void save()}
        returnKeyType="done"
        value={email}
        style={[s.field, { backgroundColor: palette.wash, color: palette.ink }]}
      />
      {error && (
        <Text accessibilityRole="alert" style={[s.help, { color: palette.amber }]}>
          {error}
        </Text>
      )}
      <View style={s.editorActions}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onCancel}
          style={s.textButton}
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
  inputRef,
  onSaved,
  palette,
  readOnly,
}: {
  api: ContactsApi;
  contact: ContactDetail;
  inputRef: RefObject<ComponentRef<typeof TextInput> | null>;
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
        placeholder={readOnly ? undefined : t("mobileContactNotePlaceholder")}
        placeholderTextColor={palette.sub}
        ref={inputRef}
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
  const open = conversation.status === "open";
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
        <View style={[s.status, { backgroundColor: open ? palette.tint : palette.wash }]}>
          <Text style={[s.statusText, { color: open ? palette.blue : palette.sub }]}>
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

export function ContactView({
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
  const [full, setFull] = useState<"pages" | "details" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<Rect | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const moreButton = useRef<ComponentRef<typeof View>>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const noteInput = useRef<ComponentRef<typeof TextInput>>(null);
  const noteY = useRef(0);
  const { copied, copy } = useCopy();
  useHardwareBack(() => {
    if (full === null) onBack();
  });

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

  const runs = useMemo(() => pageRuns(contact?.pages ?? []), [contact?.pages]);
  const details = useMemo(() => (contact === null ? [] : detailRows(contact)), [contact]);

  function openFull(kind: "pages" | "details") {
    Keyboard.dismiss();
    setFull(kind);
  }

  function saved(next: ContactDetail) {
    setContact(next);
    setEditing(false);
    onChanged();
  }

  const bar = (title: string, action?: ReactNode) => (
    <View style={{ paddingTop: topInset }}>
      <CompactBar
        action={action}
        backLabel={t("contacts")}
        onBack={onBack}
        palette={palette}
        title={title}
      />
    </View>
  );

  if (loading && contact === null) {
    return (
      <View style={[s.page, { backgroundColor: palette.paper }]}>
        {bar("")}
        <View style={s.fullState}>
          <ActivityIndicator accessibilityLabel={t("loading")} color={palette.blue} />
        </View>
      </View>
    );
  }
  if (error && contact === null) {
    return (
      <View style={[s.page, { backgroundColor: palette.paper }]}>
        {bar("")}
        <View style={s.fullState}>
          <ScreenError
            error={error}
            onRetry={() => setReload((value) => value + 1)}
            palette={palette}
          />
        </View>
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

  const setBlocked = async (blocked: boolean) => {
    if (newest === undefined || blockBusy) return;
    setBlockBusy(true);
    setError("");
    try {
      await api.setBlocked(newest.id, blocked);
      setContact((current) => (current === null ? current : { ...current, blocked }));
      onChanged();
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBlockBusy(false);
    }
  };
  const confirmBlock = () =>
    Alert.alert(t("mobileContactBlockTitle", { name }), t("mobileContactBlockText"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("blockVisitor"), style: "destructive", onPress: () => void setBlocked(true) },
    ]);
  const menuItems: MenuItem[] = [
    ...(!contact.signedIn && !readOnly
      ? [
          {
            label: t("contactEdit"),
            icon: (color: string) => <Icon name="person" size={19} color={color} />,
            run: () => setEditing(true),
          },
        ]
      : []),
    ...(contact.email !== null
      ? [
          {
            label: t("mobileCopyEmail"),
            icon: (color: string) => <Icon name="mail" size={19} color={color} />,
            run: () => copy(contact.email ?? ""),
          },
        ]
      : []),
    ...(newest !== undefined && !readOnly
      ? [
          contact.blocked
            ? {
                label: t("unblockVisitor"),
                icon: (color: string) => <Icon name="lock" size={19} color={color} />,
                group: 1 as const,
                run: () => void setBlocked(false),
              }
            : {
                label: t("blockVisitor"),
                icon: (color: string) => <Icon name="lock" size={19} color={color} />,
                danger: true,
                group: 1 as const,
                run: confirmBlock,
              },
        ]
      : []),
  ];
  const moreAction =
    menuItems.length === 0 ? undefined : (
      <Pressable
        accessibilityLabel={t("moreActions")}
        accessibilityRole="button"
        accessibilityState={{ busy: blockBusy }}
        hitSlop={3}
        onPress={() =>
          moreButton.current?.measureInWindow((x, y, width, height) => {
            setMenuAnchor({ x, y, width, height });
            setMenuOpen(true);
          })
        }
        style={({ pressed }) => [
          s.round,
          { backgroundColor: palette.wash, opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <View collapsable={false} ref={moreButton} style={s.round}>
          {blockBusy ? (
            <ActivityIndicator color={palette.ink} size="small" />
          ) : (
            <Icon color={palette.ink} name="dots" size={20} />
          )}
        </View>
      </Pressable>
    );
  const showNote = !readOnly || Boolean(contact.note);
  const facts = [
    {
      label: t("mobileContactChats"),
      value: String(contact.conversationCount),
      detail: null,
    },
    { label: t("contactFirstSeen"), value: shortDate(contact.createdAt), detail: null },
    ...(location !== null || contact.device !== null
      ? [
          {
            label: t("mobileContactWhere"),
            value: location ?? contact.device ?? "",
            detail: location === null ? null : contact.device,
          },
        ]
      : []),
  ];

  return (
    <View style={[s.page, { backgroundColor: palette.paper }]}>
      <View
        style={s.page}
        accessibilityElementsHidden={full !== null}
        importantForAccessibility={full === null ? "auto" : "no-hide-descendants"}
      >
        {bar(name, moreAction)}
        <ScrollView
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          ref={scroll}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => setReload((value) => value + 1)}
              tintColor={palette.blue}
            />
          }
          contentContainerStyle={s.detailBody}
        >
          <View style={s.hero}>
            <Avatar name={name} palette={palette} size={60} />
            <View style={s.heroCopy}>
              <Text selectable style={[s.heroName, { color: palette.ink }]}>
                {name}
              </Text>
              {contact.email !== null && contact.email !== name && (
                <Text selectable numberOfLines={1} style={[s.heroEmail, { color: palette.sub }]}>
                  {contact.email}
                </Text>
              )}
              {(contact.online === true || contact.signedIn || contact.blocked) && (
                <View style={s.badges}>
                  {contact.online === true && (
                    <Badge palette={palette} tone="live">
                      {t("contactOnline")}
                    </Badge>
                  )}
                  {contact.signedIn && <Badge palette={palette}>{t("contactSignedIn")}</Badge>}
                  {contact.blocked && (
                    <Badge palette={palette} tone="warning">
                      {t("contactBlocked")}
                    </Badge>
                  )}
                </View>
              )}
            </View>
          </View>
          {error && (
            <Text accessibilityRole="alert" style={[s.help, { color: palette.amber }]}>
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
          {(newest !== undefined || showNote) && (
            <View style={s.actions}>
              {newest !== undefined && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onOpenConversation(newest.id, contactId)}
                  style={({ pressed }) => [
                    s.action,
                    { backgroundColor: palette.blue, opacity: pressed ? 0.75 : 1 },
                  ]}
                >
                  <Icon name="chat" size={19} color={palette.onBlue} />
                  <Text style={[s.actionText, { color: palette.onBlue }]}>{t("openChat")}</Text>
                </Pressable>
              )}
              {showNote && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("panelNote")}
                  onPress={() => {
                    scroll.current?.scrollTo({
                      y: Math.max(0, noteY.current - 12),
                      animated: true,
                    });
                    if (!readOnly) setTimeout(() => noteInput.current?.focus(), 250);
                  }}
                  style={({ pressed }) => [
                    s.action,
                    { backgroundColor: palette.wash, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Icon name="savedReply" size={19} color={palette.ink} />
                  <Text style={[s.actionText, { color: palette.ink }]}>{t("mobileNoteMode")}</Text>
                </Pressable>
              )}
            </View>
          )}
          <View style={[s.factStrip, { borderColor: palette.line }]}>
            {facts.map((fact, index) => (
              <View
                accessible
                accessibilityLabel={[fact.label, fact.value, fact.detail]
                  .filter(Boolean)
                  .join(", ")}
                key={fact.label}
                style={[
                  s.fact,
                  index > 0 && {
                    borderStartColor: palette.line,
                    borderStartWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Text numberOfLines={1} style={[s.factLabel, { color: palette.sub }]}>
                  {fact.label}
                </Text>
                <Text numberOfLines={2} style={[s.factValue, { color: palette.ink }]}>
                  {fact.value}
                </Text>
                {fact.detail !== null && (
                  <Text numberOfLines={2} style={[s.factDetail, { color: palette.sub }]}>
                    {fact.detail}
                  </Text>
                )}
              </View>
            ))}
          </View>
          {showNote && (
            <View
              onLayout={(event) => {
                noteY.current = event.nativeEvent.layout.y;
              }}
            >
              <NoteEditor
                api={api}
                contact={contact}
                inputRef={noteInput}
                onSaved={saved}
                palette={palette}
                readOnly={readOnly}
              />
            </View>
          )}
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: palette.ink }]}>
              {t("contactConversations")}
            </Text>
            {contact.conversations.length === 0 ? (
              <Text style={[s.help, { color: palette.sub }]}>{t("noMessages")}</Text>
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
          {runs.length > 0 && (
            <View style={s.section}>
              <Text style={[s.sectionTitle, { color: palette.ink }]}>{t("pagesVisited")}</Text>
              <View style={[s.card, { borderColor: palette.line }]}>
                {runs.slice(0, PAGES_FIRST).map((run, index) => (
                  <View
                    key={`${run.viewedAt}-${run.path}`}
                    style={
                      index > 0 && {
                        borderTopColor: palette.line,
                        borderTopWidth: StyleSheet.hairlineWidth,
                      }
                    }
                  >
                    <PageLine copy={copy} palette={palette} run={run} />
                  </View>
                ))}
                {(runs.length > PAGES_FIRST || contact.pages.length > runs.length) && (
                  <ShowAll
                    label={t("mobilePagesShowAll", { count: contact.pages.length })}
                    onPress={() => openFull("pages")}
                    palette={palette}
                  />
                )}
              </View>
            </View>
          )}
          {details.length > 0 && (
            <View style={s.section}>
              <Text style={[s.sectionTitle, { color: palette.ink }]}>{t("contactDetails")}</Text>
              <View style={[s.card, { borderColor: palette.line }]}>
                {details.slice(0, DETAILS_FIRST).map((row, index) => (
                  <View
                    key={`${row.signed} ${row.userId} ${row.key}`}
                    style={
                      index > 0 && {
                        borderTopColor: palette.line,
                        borderTopWidth: StyleSheet.hairlineWidth,
                      }
                    }
                  >
                    <DetailLine copy={copy} palette={palette} row={row} />
                  </View>
                ))}
                <ShowAll
                  label={
                    details.length > DETAILS_FIRST
                      ? t("mobileDetailsShowAll", { count: details.length })
                      : t("mobileDetailsShowFull")
                  }
                  onPress={() => openFull("details")}
                  palette={palette}
                />
              </View>
            </View>
          )}
        </ScrollView>
      </View>
      {full !== null && (
        <View style={[StyleSheet.absoluteFill, { paddingTop: topInset }]}>
          <FullList
            contact={contact}
            copy={copy}
            kind={full}
            onBack={() => setFull(null)}
            palette={palette}
          />
        </View>
      )}
      <AnchoredMenu
        anchor={menuAnchor}
        items={menuItems}
        label={t("moreActions")}
        onClose={() => setMenuOpen(false)}
        palette={palette}
        side="end"
        visible={menuOpen}
      />
      <CopiedToast palette={palette} visible={copied} />
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1 },
  centerState: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 34,
    paddingVertical: 72,
    gap: 14,
  },
  fullState: { flex: 1, alignItems: "center", justifyContent: "center" },
  stateTitle: { fontFamily: fonts.semibold, fontSize: 18, lineHeight: 24, textAlign: "center" },
  help: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  outlineButton: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  outlineButtonText: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 20 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  contactTime: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  meta: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  textButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 15 },
  round: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  detailBody: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 28, gap: 22 },
  hero: { flexDirection: "row", alignItems: "center", gap: 14 },
  heroCopy: { flex: 1, minWidth: 0, gap: 2 },
  heroName: { fontFamily: fonts.displayBold, fontSize: 22, lineHeight: 27, letterSpacing: -0.3 },
  heroEmail: { fontFamily: fonts.body, fontSize: 14.5, lineHeight: 19 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 5 },
  badge: {
    minHeight: 24,
    borderRadius: 12,
    paddingHorizontal: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontFamily: fonts.semibold, fontSize: 11.5, lineHeight: 15 },
  actions: { flexDirection: "row", gap: 10 },
  action: {
    flex: 1,
    minHeight: 46,
    borderRadius: 23,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 14,
  },
  actionText: { fontFamily: fonts.semibold, fontSize: 15.5, lineHeight: 20 },
  factStrip: {
    flexDirection: "row",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 12,
  },
  fact: { flex: 1, minWidth: 0, paddingHorizontal: 12, gap: 3 },
  factLabel: { fontFamily: fonts.semibold, fontSize: 12, lineHeight: 16 },
  factValue: { fontFamily: fonts.semibold, fontSize: 15.5, lineHeight: 20 },
  factDetail: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16 },
  section: { gap: 10 },
  sectionTitle: { fontFamily: fonts.displayBold, fontSize: 19, lineHeight: 24 },
  noteField: {
    minHeight: 96,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: "top",
  },
  noteFooter: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  noteHelp: { flex: 1, fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  noteSave: {
    minWidth: 72,
    minHeight: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  noteSaveText: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 19 },
  conversations: { gap: 9 },
  conversation: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 14, gap: 7 },
  status: { minHeight: 24, borderRadius: 12, justifyContent: "center", paddingHorizontal: 9 },
  statusText: { fontFamily: fonts.semibold, fontSize: 11.5, lineHeight: 15 },
  conversationBody: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 21 },
  editor: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 16, gap: 10 },
  inputLabel: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 18, marginTop: 3 },
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
  primaryButton: {
    minWidth: 92,
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, overflow: "hidden" },
});
