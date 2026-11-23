import * as Clipboard from "expo-clipboard";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import type { EnrichedTextInputInstance } from "react-native-enriched-html";
import { t } from "../../operator/src/text.ts";
import { Harbor } from "../Harbor";
import type { PendingReply } from "../outbox";
import { AnchoredMenu, type MenuItem } from "./anchored-menu";
import type { DinghyApi } from "./api";
import { Avatar, readableError, SheetCloseButton, visitorName } from "./common";
import { ThreadComposer } from "./composer-tools";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { MessageIcon } from "./message-icon";
import { MessageMarkdown } from "./message-markdown";
import { shownReceipts } from "./message-state";
import { Sheet } from "./sheet";
import type { Palette } from "./theme";
import { type Rect, visitorContext } from "./thread-logic";
import { MessageQuote, ThreadMessage } from "./thread-message";
import type { Conversation, Member, Message, Thread, Workspace } from "./types";

function SheetTools({ onClose, palette }: { onClose(): void; palette: Palette }) {
  return (
    <View style={screenStyles.sheetTools}>
      <SheetCloseButton label={t("mobileDismiss")} onPress={onClose} palette={palette} />
    </View>
  );
}

function VisitorDetailsSheet({
  bottomInset,
  conversation,
  detail,
  failure,
  isNight,
  meId,
  members,
  name,
  onClose,
  onRetry,
  palette,
  visible,
}: {
  bottomInset: number;
  conversation: Conversation;
  detail: Awaited<ReturnType<DinghyApi["contact"]>> | null;
  failure: string | null;
  isNight: boolean;
  meId: string;
  members: Member[];
  name: string;
  onClose(): void;
  onRetry(): void;
  palette: Palette;
  visible: boolean;
}) {
  const visitorId = conversation.visitor.id;
  if (!visible) return null;
  const assignee = members.find((member) => member.id === conversation.assigneeOperatorId);
  const assignment = conversation.assigneeOperatorId
    ? conversation.assigneeOperatorId === meId
      ? t("mobileAssigned")
      : assignee
        ? t("mobileAssignedTo", { name: assignee.name })
        : t("mobileAssignedOther")
    : t("unassigned");
  const formatDate = (date?: string | null) =>
    date
      ? new Date(date).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;
  const facts = [
    [t("colCompany"), detail?.company],
    [t("countryLabel"), detail?.country],
    [t("businessHoursZone"), detail?.timeZone],
    [t("deviceLabel"), detail?.device],
    [t("contactFirstSeen"), formatDate(detail?.createdAt)],
    [t("sortLastSeen"), formatDate(detail?.lastSeenAt)],
    [t("mobileLastPage"), detail?.lastPage],
    [t("contactConversations"), detail?.conversationCount.toString()],
    [t("mobileConversationStatus"), conversation.status === "open" ? t("open") : t("closed")],
    [t("mobileConversationAssignment"), assignment],
  ].filter((fact): fact is [string, string] => Boolean(fact[1]));
  const attributes = Object.entries(detail?.attributes ?? {}).filter(
    ([key, value]) =>
      key !== "company" &&
      key !== "avatarPath" &&
      ["string", "number", "boolean"].includes(typeof value),
  );
  return (
    <Sheet bottomInset={bottomInset} onClose={onClose} palette={palette} visible={visible}>
      <View style={screenStyles.visitorSky}>
        <Harbor night={isNight} />
        <SheetTools onClose={onClose} palette={palette} />
      </View>
      <View style={screenStyles.visitorTop}>
        <View style={[screenStyles.visitorPortrait, { borderColor: palette.paper }]}>
          <Avatar
            name={name}
            picture={conversation.visitor.pictureUrl}
            size={53}
            palette={palette}
          />
        </View>
        <Text
          numberOfLines={2}
          style={[screenStyles.detailsName, { color: palette.ink, fontFamily: fonts.display }]}
        >
          {name}
        </Text>
        <Text
          selectable
          style={[screenStyles.detailsEmail, { color: palette.sub, fontFamily: fonts.body }]}
        >
          {conversation.visitor.email || t("mobileNoEmail")}
        </Text>
      </View>
      <ScrollView style={screenStyles.sheetScroll}>
        <View style={screenStyles.facts}>
          {facts.map(([label, value]) => (
            <View key={label} style={[screenStyles.factRow, { borderTopColor: palette.line }]}>
              <Text
                style={[screenStyles.factLabel, { color: palette.sub, fontFamily: fonts.body }]}
              >
                {label}
              </Text>
              <Text
                selectable={label === t("mobileLastPage")}
                style={[screenStyles.factValue, { color: palette.ink, fontFamily: fonts.medium }]}
              >
                {value}
              </Text>
            </View>
          ))}
        </View>
        {detail?.note && (
          <View style={[screenStyles.contactNote, { backgroundColor: palette.note }]}>
            <Text style={{ fontFamily: fonts.semibold, color: palette.noteInk }}>
              {t("mobilePrivateNote")}
            </Text>
            <Text selectable style={{ fontFamily: fonts.body, color: palette.noteInk }}>
              {detail.note}
            </Text>
          </View>
        )}
        {attributes.length > 0 && (
          <View style={screenStyles.facts}>
            <Text style={[screenStyles.sectionLabel, { color: palette.ink }]}>
              {t("contactDataAttributes")}
            </Text>
            {attributes.map(([key, value]) => (
              <View key={key} style={[screenStyles.factRow, { borderTopColor: palette.line }]}>
                <Text style={[screenStyles.factLabel, { color: palette.sub }]}>{key}</Text>
                <Text selectable style={[screenStyles.factValue, { color: palette.ink }]}>
                  {String(value)}
                </Text>
              </View>
            ))}
          </View>
        )}
        {!detail && visitorId !== "" && (
          <View style={screenStyles.contactFeedback}>
            <Text accessibilityLiveRegion="polite" style={{ color: palette.sub }}>
              {failure ?? t("loading")}
            </Text>
            {failure && (
              <Pressable
                accessibilityRole="button"
                onPress={onRetry}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={{ color: palette.blue }}>{t("mobileRetry")}</Text>
              </Pressable>
            )}
          </View>
        )}
        <View style={screenStyles.detailsBottomSpace} />
      </ScrollView>
    </Sheet>
  );
}

function HandoffSheet({
  bottomInset,
  busy,
  conversationName,
  members,
  meId,
  onClose,
  onConfirm,
  onSelect,
  palette,
  selectedId,
  subject,
  visible,
}: {
  bottomInset: number;
  busy: boolean;
  conversationName: string;
  members: Member[];
  meId: string;
  onClose(): void;
  onConfirm(): void;
  onSelect(operatorId: string): void;
  palette: Palette;
  selectedId: string | null;
  subject?: string | null;
  visible: boolean;
}) {
  if (!visible) return null;
  const selectedMember = members.find((member) => member.id === selectedId);
  return (
    <Sheet bottomInset={bottomInset} onClose={onClose} palette={palette} visible={visible}>
      <View style={screenStyles.assignHead}>
        <View style={screenStyles.assignTitleRow}>
          <Text
            style={[screenStyles.assignTitle, { color: palette.ink, fontFamily: fonts.display }]}
          >
            {t("mobileHandoff")}
          </Text>
          <SheetCloseButton label={t("mobileDismiss")} onPress={onClose} palette={palette} />
        </View>
        <Text style={[screenStyles.assignContext, { color: palette.sub, fontFamily: fonts.body }]}>
          {subject
            ? t("mobileHandoffContext", { name: conversationName, subject })
            : conversationName}
        </Text>
      </View>
      <Text style={[screenStyles.assignLabel, { color: palette.ink, fontFamily: fonts.display }]}>
        {t("mobileAssignTo")}
      </Text>
      <ScrollView
        contentContainerStyle={screenStyles.crewList}
        showsVerticalScrollIndicator={false}
        style={screenStyles.crewScroll}
      >
        {members.length ? (
          members.map((member) => {
            const selected = member.id === selectedId;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                key={member.id}
                onPress={() => onSelect(member.id)}
                style={({ pressed }) => [
                  screenStyles.crewRow,
                  {
                    backgroundColor: selected ? palette.tint : palette.wash,
                    borderColor: selected ? palette.blue : palette.line,
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}
              >
                <Avatar
                  name={member.name}
                  picture={member.pictureUrl}
                  size={40}
                  palette={palette}
                />
                <View style={screenStyles.crewCopy}>
                  <Text
                    style={[
                      screenStyles.crewName,
                      { color: palette.ink, fontFamily: fonts.semibold },
                    ]}
                  >
                    {member.id === meId ? t("mobileMemberYou", { name: member.name }) : member.name}
                  </Text>
                  <Text
                    style={[screenStyles.crewMeta, { color: palette.sub, fontFamily: fonts.body }]}
                  >
                    {member.email}
                  </Text>
                </View>
                <View
                  style={[
                    screenStyles.crewRadio,
                    { borderColor: selected ? palette.blue : palette.sub },
                  ]}
                >
                  {selected && (
                    <View style={[screenStyles.crewRadioDot, { backgroundColor: palette.blue }]} />
                  )}
                </View>
              </Pressable>
            );
          })
        ) : (
          <Text style={[screenStyles.noMembers, { color: palette.sub, fontFamily: fonts.body }]}>
            {t("mobileNoWorkspaceMembers")}
          </Text>
        )}
      </ScrollView>
      <View style={screenStyles.sheetAction}>
        <Pressable
          accessibilityRole="button"
          disabled={!selectedId || busy}
          onPress={onConfirm}
          style={({ pressed }) => [
            screenStyles.handoffButton,
            {
              backgroundColor: palette.blue,
              opacity: !selectedId || busy ? 0.45 : pressed ? 0.72 : 1,
            },
          ]}
        >
          <Text style={[screenStyles.handoffButtonText, { fontFamily: fonts.semibold }]}>
            {busy
              ? t("mobileHandingOff")
              : selectedMember
                ? t("mobileConfirmHandoffTo", { name: selectedMember.name })
                : t("mobileConfirmHandoff")}
          </Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

function SmallAction({
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
        screenStyles.smallAction,
        { backgroundColor: palette.tint, opacity: pressed ? 0.72 : 1 },
      ]}
    >
      <Text style={{ color: palette.blue, fontFamily: fonts.semibold, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function PendingBubble({
  reply,
  palette,
  error,
  canRetry,
  onDiscard,
  onRetry,
  quote,
  visitor,
}: {
  reply: PendingReply;
  palette: Palette;
  error: { message: string; discardable: boolean } | undefined;
  canRetry: boolean;
  onDiscard(): void;
  onRetry(): void;
  quote: Message["replyTo"];
  visitor: string;
}) {
  return (
    <View style={[screenStyles.pending, { backgroundColor: palette.wash }]}>
      <View style={screenStyles.pendingHeading}>
        <Icon color={palette.sub} name="clock" size={14} />
        <Text style={[screenStyles.pendingLabel, { color: palette.sub, fontFamily: fonts.medium }]}>
          {t("mobileWaitingSend")}
        </Text>
      </View>
      {quote && <MessageQuote palette={palette} quote={quote} visitorName={visitor} />}
      <View style={screenStyles.pendingBody}>
        <MessageMarkdown
          lineHeight={21}
          palette={palette}
          size={15}
          source={reply.body}
          tone={{
            ink: palette.ink,
            link: palette.blue,
            quoteLine: palette.blue,
            quoteInk: palette.sub,
          }}
        />
      </View>
      <View style={screenStyles.pendingFoot}>
        <Text style={[screenStyles.pendingError, { color: palette.sub, fontFamily: fonts.body }]}>
          {canRetry ? (error?.message ?? t("mobileConnectionInterrupted")) : t("mobileReopenRetry")}
        </Text>
        <View style={screenStyles.pendingActions}>
          {error?.discardable && (
            <SmallAction label={t("draftDiscard")} onPress={onDiscard} palette={palette} />
          )}
          {canRetry && <SmallAction label={t("mobileRetry")} onPress={onRetry} palette={palette} />}
        </View>
      </View>
    </View>
  );
}

function dayLabel(iso: string): string {
  const day = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return t("today");
  if (day.toDateString() === yesterday.toDateString()) return t("yesterday");
  return day.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

function sameMessageAuthor(one: Message | undefined, two: Message | undefined): boolean {
  return Boolean(
    one &&
      two &&
      one.kind !== "closed" &&
      one.kind !== "reopened" &&
      two.kind !== "closed" &&
      two.kind !== "reopened" &&
      one.fromVisitor === two.fromVisitor &&
      one.authorOperatorId === two.authorOperatorId &&
      one.authorApiKeyId === two.authorApiKeyId &&
      (one.kind === "note") === (two.kind === "note"),
  );
}

function messageMeta(messages: Message[], index: number, meId: string): string | null {
  const message = messages[index];
  if (!message || message.kind === "closed" || message.kind === "reopened") return null;
  const next = messages[index + 1];
  const edited = message.editedAt !== null && !message.deleted;
  const ends =
    !sameMessageAuthor(message, next) ||
    !next ||
    new Date(next.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
  if (!edited && !ends) return null;
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const timed = edited ? `${time} · ${t("messageEdited")}` : time;
  if (message.fromVisitor) return timed;
  const author =
    message.authorOperatorId === meId ? t("you") : (message.authorName ?? t("aTeammate"));
  return `${author} · ${timed}`;
}

type ContactDetail = Awaited<ReturnType<DinghyApi["contact"]>>;

/** A 16% wash of a six-digit color, for a tinted button behind an icon of that color. */
const wash16 = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? `${hex}29` : hex);

export function ThreadScreen({
  api,
  conversation,
  thread,
  pending,
  pendingErrors,
  bottomInset,
  initialDraft,
  loading,
  palette,
  meId,
  members,
  workspace,
  onBack,
  onDiscard,
  onDraftChange,
  onHandoff,
  onError,
  onReload,
  onSend,
  onRetry,
  onAssign,
  onStatus,
}: {
  api: DinghyApi;
  conversation: Conversation;
  thread: Thread | null;
  pending: PendingReply[];
  pendingErrors: Record<string, { message: string; discardable: boolean }>;
  bottomInset: number;
  initialDraft: string;
  loading: boolean;
  palette: Palette;
  meId: string;
  members: Member[];
  workspace: Workspace | null;
  onBack(): void;
  onDiscard(reply: PendingReply): void;
  onDraftChange(body: string): void;
  onHandoff(operatorId: string): Promise<void>;
  onError(failure: unknown): void;
  onReload(): void;
  onSend(body: string, replyToMessageId: string | null): Promise<void>;
  onRetry(reply: PendingReply): Promise<void>;
  onAssign(): Promise<void>;
  onStatus(): Promise<void>;
}) {
  const isNight = useColorScheme() === "dark";
  const [keyboardVisible, setKeyboardVisible] = useState(Keyboard.isVisible());
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
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (keyboardVisible) {
        Keyboard.dismiss();
        return true;
      }
      onBack();
      return true;
    });
    return () => back.remove();
  }, [keyboardVisible, onBack]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<Rect | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [contactFailure, setContactFailure] = useState<string | null>(null);
  const [contactRequest, setContactRequest] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const input = useRef<EnrichedTextInputInstance>(null);
  const moreButton = useRef<ComponentRef<typeof View>>(null);
  const list = useRef<FlatList<Message | PendingReply>>(null);
  const current = thread?.conversation ?? conversation;
  const isClosed = current.status === "closed";
  const name = visitorName(current);
  const visitorId = current.visitor.id;
  const owner = current.assigneeOperatorId;
  const assignee = members.find((member) => member.id === owner);
  const messages = thread?.messages ?? [];
  const rows: (Message | PendingReply)[] = [...messages, ...pending];
  const receiptByMessage = shownReceipts(messages, thread?.receipts ?? null);
  const canWrite =
    workspace === null || (workspace.active && !workspace.readOnly && !workspace.suspended);
  const mayDeleteAnyone = workspace?.role === "owner" || workspace?.role === "admin";
  const isPending = (row: Message | PendingReply): row is PendingReply => !("kind" in row);

  // The header's place, page and local time come from the contact record. A new request also runs
  // when the details open, so both show the page the visitor is on now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each contactRequest reloads the contact.
  useEffect(() => {
    if (!visitorId) return;
    let active = true;
    setContactFailure(null);
    void api.contact(visitorId).then(
      (detail) => {
        if (active) setContact(detail);
      },
      (failure) => {
        if (active) setContactFailure(readableError(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [api, visitorId, contactRequest]);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { place, time } = visitorContext(contact?.country ?? null, contact?.timeZone ?? null, now);
  const contextPlace = place ?? current.visitor.email;
  const contextTime = time ? t("mobileVisitorTimeThere", { time }) : null;
  const context = [contextPlace, contextTime]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const openDetails = () => {
    setContactRequest((value) => value + 1);
    setDetailsOpen(true);
  };
  const replyTo = (message: Message) => {
    setReplyingTo(message);
    requestAnimationFrame(() => input.current?.focus());
  };
  const changeStatus = async () => {
    if (statusBusy) return;
    setStatusBusy(true);
    try {
      await onStatus();
    } finally {
      setStatusBusy(false);
    }
  };
  const confirmStatus = () => {
    if (statusBusy) return;
    Alert.alert(
      t(isClosed ? "mobileReopenConfirmTitle" : "mobileCloseConfirmTitle"),
      t(isClosed ? "mobileReopenConfirmText" : "mobileCloseConfirmText"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t(isClosed ? "mobileReopenConfirmYes" : "mobileCloseConfirmYes"),
          style: isClosed ? "default" : "destructive",
          onPress: () => void changeStatus(),
        },
      ],
    );
  };
  const assignToMe = async () => {
    if (assignBusy) return;
    setAssignBusy(true);
    try {
      await onAssign();
    } finally {
      setAssignBusy(false);
    }
  };
  // Taking a chat a teammate owns asks first. An unowned chat is yours at once.
  const confirmAssign = () => {
    if (!owner) {
      void assignToMe();
      return;
    }
    Alert.alert(
      t("mobileTakeOverTitle"),
      t("mobileTakeOverText", { name: assignee?.name ?? t("aTeammate") }),
      [
        { text: t("cancel"), style: "cancel" },
        { text: t("keysAssignMe"), onPress: () => void assignToMe() },
      ],
    );
  };
  const openHandoff = () => {
    setSelectedMemberId(
      owner && members.some((member) => member.id === owner)
        ? owner
        : (members.find((member) => member.id !== meId)?.id ?? members[0]?.id ?? null),
    );
    setHandoffOpen(true);
  };
  const handoff = async () => {
    if (!selectedMemberId || handoffBusy) return;
    setHandoffBusy(true);
    try {
      await onHandoff(selectedMemberId);
      setHandoffOpen(false);
    } catch {
      // The parent shows the server error. Keep the selection open so the operator can retry.
    } finally {
      setHandoffBusy(false);
    }
  };
  const openMenu = () => {
    moreButton.current?.measureInWindow((x, y, width, height) => {
      setMenuAnchor({ x, y, width, height });
      setMenuOpen(true);
    });
  };
  const menuItems: MenuItem[] = [
    ...(!isClosed && owner !== meId
      ? [
          {
            label: t("keysAssignMe"),
            icon: (color: string) => <Icon color={color} name="person" size={19} />,
            run: confirmAssign,
          },
        ]
      : []),
    ...(!isClosed
      ? [
          {
            label: t("mobileHandoff"),
            icon: (color: string) => <Icon color={color} name="hand" size={19} />,
            run: openHandoff,
          },
        ]
      : []),
    {
      label: t("mobileVisitorDetails"),
      icon: (color: string) => <MessageIcon color={color} name="info" size={20} />,
      run: openDetails,
    },
    {
      label: t("messageCopyLink"),
      icon: (color: string) => <MessageIcon color={color} name="link" size={20} />,
      run: () => {
        void Clipboard.setStringAsync(api.conversationLink(current.id))
          .then(() => AccessibilityInfo.announceForAccessibility(t("linkCopied")))
          .catch(() => {});
      },
    },
    ...(isClosed
      ? [
          {
            label: t("reopen"),
            icon: (color: string) => <Icon color={color} name="reopen" size={19} />,
            run: confirmStatus,
          },
        ]
      : []),
  ];
  const ownership =
    isClosed || owner === meId
      ? null
      : owner
        ? {
            text: assignee
              ? t("mobileTeammateOwns", { name: assignee.name })
              : t("mobileSomeoneOwns"),
            action: t("mobileHandoff"),
            run: openHandoff,
          }
        : { text: t("mobileNobodyOwns"), action: t("keysAssignMe"), run: confirmAssign };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[screenStyles.page, { backgroundColor: palette.paper }]}
    >
      <View style={[screenStyles.header, { borderBottomColor: palette.line }]}>
        <View style={screenStyles.headerRow}>
          <Pressable
            accessibilityLabel={t("back")}
            accessibilityRole="button"
            onPress={onBack}
            style={({ pressed }) => [screenStyles.back, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Icon
              color={palette.blue}
              name={Platform.OS === "ios" ? "back" : "androidBack"}
              size={24}
            />
          </Pressable>
          <Pressable
            accessibilityHint={context || undefined}
            accessibilityLabel={t("mobileOpenVisitorDetails", { name })}
            accessibilityRole="button"
            onPress={openDetails}
            style={({ pressed }) => [screenStyles.person, { opacity: pressed ? 0.68 : 1 }]}
          >
            <View>
              <Avatar
                name={name}
                picture={current.visitor.pictureUrl}
                size={34}
                palette={palette}
              />
              {thread?.visitorOnline && (
                <View
                  style={[
                    screenStyles.online,
                    { backgroundColor: palette.green, borderColor: palette.paper },
                  ]}
                />
              )}
            </View>
            <View style={screenStyles.personCopy}>
              <Text
                numberOfLines={1}
                style={[screenStyles.name, { color: palette.ink, fontFamily: fonts.displayBold }]}
              >
                {name}
              </Text>
              {context !== "" && (
                <View style={screenStyles.contextRow}>
                  {contextPlace && (
                    <Text
                      numberOfLines={1}
                      style={[
                        screenStyles.context,
                        screenStyles.contextPlace,
                        { color: palette.sub, fontFamily: fonts.medium },
                      ]}
                    >
                      {contextPlace}
                    </Text>
                  )}
                  {contextTime && (
                    <Text
                      numberOfLines={1}
                      style={[
                        screenStyles.context,
                        screenStyles.contextTime,
                        { color: palette.sub, fontFamily: fonts.medium },
                      ]}
                    >
                      {`${contextPlace ? " · " : ""}${contextTime}`}
                    </Text>
                  )}
                </View>
              )}
            </View>
          </Pressable>
          <Pressable
            accessibilityLabel={t("mobileConversationMore")}
            accessibilityRole="button"
            hitSlop={3}
            onPress={openMenu}
            style={({ pressed }) => [
              screenStyles.round,
              { backgroundColor: palette.wash, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <View collapsable={false} ref={moreButton} style={screenStyles.roundInner}>
              <Icon color={palette.ink} name="dots" size={20} />
            </View>
          </Pressable>
          <Pressable
            accessibilityLabel={
              isClosed ? t("mobileReopenConversation") : t("mobileCloseConversation")
            }
            accessibilityRole="button"
            accessibilityState={{ busy: statusBusy, disabled: statusBusy }}
            disabled={statusBusy}
            hitSlop={3}
            onPress={confirmStatus}
            style={({ pressed }) => [
              screenStyles.round,
              {
                backgroundColor: isClosed ? palette.wash : wash16(palette.green),
                opacity: pressed ? 0.6 : 1,
              },
            ]}
          >
            {statusBusy ? (
              <ActivityIndicator color={isClosed ? palette.ink : palette.green} size="small" />
            ) : (
              <Icon
                color={isClosed ? palette.ink : palette.green}
                name={isClosed ? "reopen" : "check"}
                size={20}
              />
            )}
          </Pressable>
        </View>
        {ownership && (
          <View
            style={[
              screenStyles.ownership,
              { backgroundColor: palette.warm, borderTopColor: palette.line },
            ]}
          >
            <Icon color={palette.amber} name="person" size={15} />
            <Text
              numberOfLines={1}
              style={[
                screenStyles.ownershipText,
                { color: palette.amber, fontFamily: fonts.medium },
              ]}
            >
              {ownership.text}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: assignBusy }}
              disabled={assignBusy}
              hitSlop={{ top: 2, bottom: 2, left: 8, right: 8 }}
              onPress={ownership.run}
              style={({ pressed }) => [
                screenStyles.ownershipAction,
                { opacity: assignBusy ? 0.45 : pressed ? 0.6 : 1 },
              ]}
            >
              <Text
                style={[
                  screenStyles.ownershipLink,
                  { color: palette.blue, fontFamily: fonts.semibold },
                ]}
              >
                {ownership.action}
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(item) => (isPending(item) ? `pending-${item.clientId}` : item.id)}
        contentContainerStyle={screenStyles.log}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        ListEmptyComponent={
          loading && thread === null ? (
            <ActivityIndicator accessibilityLabel={t("loading")} color={palette.sub} />
          ) : undefined
        }
        refreshControl={
          <RefreshControl
            refreshing={loading && thread !== null}
            onRefresh={onReload}
            tintColor={palette.blue}
          />
        }
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        renderItem={({ item, index }) => {
          if (isPending(item)) {
            const quoted = messages.find((message) => message.id === item.replyToMessageId);
            return (
              <PendingBubble
                canRetry={!isClosed}
                error={pendingErrors[item.clientId]}
                onDiscard={() => onDiscard(item)}
                onRetry={() => void onRetry(item)}
                palette={palette}
                reply={item}
                quote={
                  quoted
                    ? {
                        id: quoted.id,
                        authorName: quoted.authorName,
                        fromVisitor: quoted.fromVisitor,
                        text:
                          quoted.attachment?.type === "file" && !quoted.attachment.removed
                            ? quoted.attachment.name
                            : (quoted.body ?? ""),
                        hasImage: quoted.kind === "image",
                      }
                    : null
                }
                visitor={name}
              />
            );
          }
          const previous = messages[index - 1];
          const startsDay =
            !previous ||
            new Date(previous.createdAt).toDateString() !== new Date(item.createdAt).toDateString();
          return (
            <View>
              {startsDay && (
                <Text
                  style={[screenStyles.day, { color: palette.sub, fontFamily: fonts.semibold }]}
                >
                  {dayLabel(item.createdAt)}
                </Text>
              )}
              <ThreadMessage
                api={api}
                bottomInset={bottomInset}
                canReply={!isClosed && canWrite}
                canWrite={canWrite}
                conversationId={current.id}
                mayDeleteAnyone={mayDeleteAnyone}
                meId={meId}
                message={item}
                meta={messageMeta(messages, index, meId)}
                onAttachmentError={onReload}
                onChanged={onReload}
                onError={onError}
                onReply={replyTo}
                palette={palette}
                receipt={receiptByMessage.get(item.id) ?? null}
                receipts={thread?.receipts ?? null}
                visitorName={name}
              />
            </View>
          );
        }}
      />

      {isClosed ? (
        <Pressable
          accessibilityRole="button"
          onPress={confirmStatus}
          style={({ pressed }) => [
            screenStyles.reopen,
            {
              borderTopColor: palette.line,
              minHeight: 50 + bottomInset,
              opacity: pressed ? 0.68 : 1,
              paddingBottom: bottomInset,
            },
          ]}
        >
          <Icon color={palette.blue} name="reopen" size={18} />
          <Text style={[screenStyles.reopenText, { color: palette.ink, fontFamily: fonts.medium }]}>
            {t("mobileReopenReply")}
          </Text>
        </Pressable>
      ) : (
        <ThreadComposer
          api={api}
          bottomInset={bottomInset}
          conversationId={current.id}
          initialDraft={initialDraft}
          inputRef={input}
          keyboardVisible={keyboardVisible}
          name={name}
          onCancelReply={() => setReplyingTo(null)}
          onDraftChange={onDraftChange}
          onError={onError}
          onNoteAdded={onReload}
          onPhotoSent={() => {
            setReplyingTo(null);
            onReload();
          }}
          onSend={onSend}
          palette={palette}
          replyingTo={replyingTo}
        />
      )}
      <AnchoredMenu
        anchor={menuAnchor}
        items={menuItems}
        label={t("mobileConversationMore")}
        onClose={() => setMenuOpen(false)}
        palette={palette}
        side="end"
        visible={menuOpen}
      />
      <VisitorDetailsSheet
        bottomInset={bottomInset}
        conversation={current}
        detail={contact}
        failure={contactFailure}
        isNight={isNight}
        meId={meId}
        members={members}
        name={name}
        onClose={() => setDetailsOpen(false)}
        onRetry={() => setContactRequest((value) => value + 1)}
        palette={palette}
        visible={detailsOpen}
      />
      <HandoffSheet
        bottomInset={bottomInset}
        busy={handoffBusy}
        conversationName={name}
        meId={meId}
        members={members}
        onClose={() => {
          if (!handoffBusy) setHandoffOpen(false);
        }}
        onConfirm={() => void handoff()}
        onSelect={setSelectedMemberId}
        palette={palette}
        selectedId={selectedMemberId}
        subject={current.subject ?? null}
        visible={handoffOpen}
      />
    </KeyboardAvoidingView>
  );
}

const screenStyles = StyleSheet.create({
  page: { flex: 1 },
  sheetTools: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingLeft: 16,
    paddingRight: 11,
    paddingTop: 2,
    position: "relative",
    zIndex: 2,
  },
  sheetScroll: { flexShrink: 1 },
  visitorSky: { height: 116, position: "relative", overflow: "hidden" },
  visitorTop: { paddingHorizontal: 19, paddingBottom: 12, marginTop: -25, position: "relative" },
  visitorPortrait: {
    width: 59,
    height: 59,
    borderRadius: 30,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  detailsName: { fontSize: 28, lineHeight: 31, letterSpacing: -0.9, marginTop: 7 },
  detailsEmail: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  facts: { paddingHorizontal: 16 },
  factRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  factLabel: { flex: 1, fontSize: 13 },
  factValue: { flex: 1.4, fontSize: 13, lineHeight: 18, textAlign: "right" },
  sectionLabel: { fontFamily: fonts.semibold, fontSize: 16, marginVertical: 12 },
  contactNote: { margin: 16, padding: 14, gap: 6, borderRadius: 16 },
  contactFeedback: { paddingHorizontal: 16, paddingVertical: 12 },
  detailsBottomSpace: { height: 12 },
  assignHead: { paddingLeft: 20, paddingRight: 11, paddingBottom: 5 },
  assignTitleRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  assignTitle: { flex: 1, fontSize: 28, lineHeight: 31, letterSpacing: -0.9 },
  assignContext: { fontSize: 13, lineHeight: 18, marginTop: 3, paddingRight: 9 },
  assignLabel: {
    fontSize: 16,
    lineHeight: 20,
    marginTop: 12,
    marginBottom: 8,
    marginHorizontal: 20,
  },
  crewScroll: { flexShrink: 1 },
  crewList: { gap: 8, alignItems: "stretch", paddingHorizontal: 20, paddingBottom: 12 },
  crewRow: {
    minHeight: 68,
    borderRadius: Platform.OS === "android" ? 10 : 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  crewCopy: { flex: 1, minWidth: 0 },
  crewName: { fontSize: 15, lineHeight: 19 },
  crewMeta: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  crewRadio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  crewRadioDot: { width: 12, height: 12, borderRadius: 6 },
  noMembers: { textAlign: "center", fontSize: 13, paddingVertical: 24 },
  sheetAction: { paddingHorizontal: 20, paddingTop: 2 },
  handoffButton: {
    minHeight: 46,
    borderRadius: 23,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 17,
  },
  handoffButtonText: { color: "#ffffff", fontSize: 15 },
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  headerRow: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 2,
    paddingRight: 10,
  },
  back: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  round: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  roundInner: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  person: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
  online: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
  },
  personCopy: { flex: 1, minWidth: 0 },
  name: { fontSize: 17, lineHeight: 21, letterSpacing: -0.2 },
  contextRow: { flexDirection: "row", minWidth: 0, overflow: "hidden" },
  context: { fontSize: 12.5, lineHeight: 16 },
  contextPlace: { flexShrink: 1 },
  contextTime: { flexShrink: 0 },
  log: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
  day: { textAlign: "center", fontSize: 12, lineHeight: 16, marginTop: 4, marginBottom: 10 },
  pending: {
    alignSelf: "flex-end",
    maxWidth: "91%",
    borderRadius: 17,
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginVertical: 10,
  },
  pendingHeading: { flexDirection: "row", alignItems: "center", gap: 7 },
  pendingLabel: { fontSize: 12 },
  pendingBody: { marginVertical: 5 },
  pendingFoot: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  pendingError: { flex: 1, minWidth: 120, fontSize: 12 },
  pendingActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  smallAction: {
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  ownership: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 16,
    paddingRight: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  ownershipText: { flex: 1, fontSize: 13.5, lineHeight: 18 },
  ownershipAction: { minHeight: 40, justifyContent: "center", paddingHorizontal: 8 },
  ownershipLink: { fontSize: 13.5, lineHeight: 18 },
  reopen: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  reopenText: { flex: 1, fontSize: 14 },
});
