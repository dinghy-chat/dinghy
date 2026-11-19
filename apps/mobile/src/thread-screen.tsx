import { type ComponentRef, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { t } from "../../operator/src/text.ts";
import { Harbor } from "../Harbor";
import type { PendingReply } from "../outbox";
import type { DinghyApi } from "./api";
import { Avatar, readableError, SheetCloseButton, visitorName } from "./common";
import { ConversationTools } from "./composer-tools";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { shownReceipts } from "./message-state";
import { Sheet } from "./sheet";
import type { Palette } from "./theme";
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
  api,
  bottomInset,
  conversation,
  isNight,
  meId,
  members,
  name,
  onClose,
  palette,
  visible,
}: {
  api: DinghyApi;
  bottomInset: number;
  conversation: Conversation;
  isNight: boolean;
  meId: string;
  members: Member[];
  name: string;
  onClose(): void;
  palette: Palette;
  visible: boolean;
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<DinghyApi["contact"]>> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const visitorId = conversation.visitor.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the same contact after a failed request.
  useEffect(() => {
    if (!visible || !visitorId) return;
    let active = true;
    setDetail(null);
    setFailure(null);
    void api.contact(visitorId).then(
      (contact) => {
        if (active) setDetail(contact);
      },
      (error) => {
        if (active) setFailure(readableError(error));
      },
    );
    return () => {
      active = false;
    };
  }, [api, visible, visitorId, attempt]);
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
        <Harbor night={isNight} variant="banner" />
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
                onPress={() => setAttempt((n) => n + 1)}
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
      <Text style={[screenStyles.pendingBody, { color: palette.ink, fontFamily: fonts.body }]}>
        {reply.body}
      </Text>
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
  const [draft, setDraft] = useState(initialDraft);
  const [sending, setSending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const list = useRef<FlatList<Message | PendingReply>>(null);
  const current = thread?.conversation ?? conversation;
  const isClosed = current.status === "closed";
  const name = visitorName(current);
  const assignee = members.find((member) => member.id === current.assigneeOperatorId);
  const messages = thread?.messages ?? [];
  const rows: (Message | PendingReply)[] = [...messages, ...pending];
  const receiptByMessage = shownReceipts(messages, thread?.receipts ?? null);
  const canWrite =
    workspace === null || (workspace.active && !workspace.readOnly && !workspace.suspended);
  const mayDeleteAnyone = workspace?.role === "owner" || workspace?.role === "admin";
  const isPending = (row: Message | PendingReply): row is PendingReply => !("kind" in row);
  const changeDraft = (body: string) => {
    setDraft(body);
    onDraftChange(body);
  };
  const send = async () => {
    const submittedDraft = draft;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      await onSend(body, replyingTo?.id ?? null);
      setDraft((current) => (current === submittedDraft ? "" : current));
      setReplyingTo(null);
    } catch {
      // The parent shows the storage error. Keep the draft so the operator can try again.
    } finally {
      setSending(false);
    }
  };
  const replyTo = (message: Message) => {
    setReplyingTo(message);
    requestAnimationFrame(() => input.current?.focus());
  };
  const confirmStatus = () => {
    Alert.alert(
      t(isClosed ? "mobileReopenConfirmTitle" : "mobileCloseConfirmTitle"),
      t(isClosed ? "mobileReopenConfirmText" : "mobileCloseConfirmText"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t(isClosed ? "mobileReopenConfirmYes" : "mobileCloseConfirmYes"),
          style: isClosed ? "default" : "destructive",
          onPress: () => void onStatus(),
        },
      ],
    );
  };
  const openHandoff = () => {
    const assigned = current.assigneeOperatorId;
    setSelectedMemberId(
      assigned && members.some((member) => member.id === assigned)
        ? assigned
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

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[screenStyles.page, { backgroundColor: palette.paper }]}
    >
      <View style={[screenStyles.header, { borderBottomColor: palette.line }]}>
        <Pressable
          accessibilityLabel={t("back")}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onBack}
          style={({ pressed }) => [
            screenStyles.headerButton,
            { backgroundColor: pressed ? palette.wash : "transparent" },
          ]}
        >
          <Icon
            color={palette.navy}
            name={Platform.OS === "ios" ? "back" : "androidBack"}
            size={21}
          />
        </Pressable>
        <Pressable
          accessibilityLabel={t("mobileOpenVisitorDetails", { name })}
          accessibilityRole="button"
          onPress={() => setDetailsOpen(true)}
          style={({ pressed }) => [screenStyles.person, { opacity: pressed ? 0.68 : 1 }]}
        >
          <Avatar name={name} picture={current.visitor.pictureUrl} size={36} palette={palette} />
          <View style={screenStyles.personCopy}>
            <Text
              numberOfLines={1}
              style={[screenStyles.name, { color: palette.ink, fontFamily: fonts.display }]}
            >
              {name}
            </Text>
            <Text
              numberOfLines={1}
              style={[screenStyles.meta, { color: palette.sub, fontFamily: fonts.body }]}
            >
              {current.subject || current.visitor.email || t("visitorAnonymous")}
            </Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityLabel={
            isClosed ? t("mobileReopenConversation") : t("mobileCloseConversation")
          }
          accessibilityRole="button"
          onPress={confirmStatus}
          style={({ pressed }) => [
            screenStyles.statusButton,
            {
              backgroundColor: pressed ? palette.tint : palette.wash,
              borderColor: palette.line,
            },
          ]}
        >
          <Text
            style={[
              screenStyles.statusButtonText,
              { color: palette.ink, fontFamily: fonts.semibold },
            ]}
          >
            {isClosed ? t("reopen") : t("close")}
          </Text>
        </Pressable>
      </View>

      {!isClosed && (
        <View style={[screenStyles.ownership, { borderBottomColor: palette.line }]}>
          <View style={screenStyles.ownershipLabel}>
            <Avatar
              name={assignee?.name ?? t("unassigned")}
              picture={assignee?.pictureUrl ?? null}
              size={30}
              palette={palette}
            />
            <Text
              numberOfLines={1}
              style={[screenStyles.ownershipText, { color: palette.sub, fontFamily: fonts.body }]}
            >
              {current.assigneeOperatorId === meId
                ? t("mobileAssigned")
                : assignee
                  ? t("mobileAssignedTo", { name: assignee.name })
                  : current.assigneeOperatorId
                    ? t("mobileAssignedOther")
                    : t("unassigned")}
            </Text>
          </View>
          <View style={screenStyles.ownershipActions}>
            {!current.assigneeOperatorId && (
              <Pressable
                accessibilityRole="button"
                onPress={() => void onAssign()}
                style={({ pressed }) => [
                  screenStyles.assignButton,
                  { backgroundColor: palette.blue, opacity: pressed ? 0.72 : 1 },
                ]}
              >
                <Text style={{ color: palette.onBlue, fontFamily: fonts.semibold, fontSize: 12 }}>
                  {t("keysAssignMe")}
                </Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              onPress={openHandoff}
              style={({ pressed }) => [
                screenStyles.handoffLink,
                {
                  backgroundColor: palette.wash,
                  borderColor: palette.line,
                  opacity: pressed ? 0.68 : 1,
                },
              ]}
            >
              <Text style={{ color: palette.ink, fontFamily: fonts.semibold, fontSize: 12 }}>
                {t("mobileHandoff")}
              </Text>
              <Icon color={palette.sub} name="next" size={13} />
            </Pressable>
          </View>
        </View>
      )}

      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(item) => (isPending(item) ? `pending-${item.clientId}` : item.id)}
        contentContainerStyle={screenStyles.log}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={onReload} tintColor={palette.blue} />
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
                <Text style={[screenStyles.day, { color: palette.sub, fontFamily: fonts.medium }]}>
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
          <Icon color={palette.blue} name="chat" size={18} />
          <Text style={[screenStyles.reopenText, { color: palette.ink, fontFamily: fonts.medium }]}>
            {t("mobileReopenReply")}
          </Text>
        </Pressable>
      ) : (
        <View
          style={[
            screenStyles.composer,
            {
              backgroundColor: palette.paper,
              borderTopColor: palette.line,
              paddingBottom: keyboardVisible ? 5 : Math.max(bottomInset, 8),
            },
          ]}
        >
          {replyingTo && (
            <View style={[screenStyles.replyChip, { backgroundColor: palette.wash }]}>
              <Icon color={palette.blue} name="chat" size={16} />
              <View style={screenStyles.replyChipCopy}>
                <Text
                  numberOfLines={1}
                  style={[
                    screenStyles.replyChipTitle,
                    { color: palette.ink, fontFamily: fonts.semibold },
                  ]}
                >
                  {t("replyingTo", {
                    name: replyingTo.fromVisitor ? name : (replyingTo.authorName ?? t("aTeammate")),
                  })}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[
                    screenStyles.replyChipText,
                    { color: palette.sub, fontFamily: fonts.body },
                  ]}
                >
                  {replyingTo.body ||
                    t(replyingTo.kind === "image" ? "quoteImage" : "mobileAttachment")}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={t("cancelReply")}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setReplyingTo(null)}
                style={screenStyles.replyChipClose}
              >
                <Icon color={palette.sub} name="x" size={16} />
              </Pressable>
            </View>
          )}
          <View style={screenStyles.composeRow}>
            <ConversationTools
              api={api}
              conversationId={current.id}
              replyToMessageId={replyingTo?.id}
              onInsert={(text) =>
                changeDraft(draft && !/\s$/.test(draft) ? `${draft}\n${text}` : draft + text)
              }
              onNoteAdded={onReload}
              onReplySent={() => setReplyingTo(null)}
              palette={palette}
              bottomInset={bottomInset}
              onError={onError}
            />
            <View
              style={[
                screenStyles.composeBox,
                { backgroundColor: palette.paper, borderColor: palette.line },
              ]}
            >
              <TextInput
                ref={input}
                accessibilityLabel={t("mobileReplyTo", { name })}
                multiline
                onChangeText={changeDraft}
                placeholder={t("mobileReplyPlaceholder", { name: name.split(" ")[0] ?? name })}
                placeholderTextColor={palette.sub}
                style={[screenStyles.input, { color: palette.ink, fontFamily: fonts.body }]}
                textAlignVertical="top"
                value={draft}
              />
              <Pressable
                hitSlop={5}
                accessibilityLabel={t("mobileSendReply")}
                accessibilityRole="button"
                disabled={!draft.trim() || sending}
                onPress={() => void send()}
                style={({ pressed }) => [
                  screenStyles.send,
                  {
                    backgroundColor: draft.trim() && !sending ? palette.blue : palette.wash,
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}
              >
                <Icon
                  color={draft.trim() && !sending ? palette.onBlue : palette.sub}
                  name="send"
                  size={18}
                />
              </Pressable>
            </View>
          </View>
        </View>
      )}
      <VisitorDetailsSheet
        api={api}
        bottomInset={bottomInset}
        conversation={current}
        isNight={isNight}
        meId={meId}
        members={members}
        name={name}
        onClose={() => setDetailsOpen(false)}
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
  header: {
    minHeight: 55,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 9,
    paddingBottom: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerButton: {
    width: 44,
    height: 44,
    borderRadius: Platform.OS === "ios" ? 22 : 10,
    alignItems: "center",
    justifyContent: "center",
  },
  statusButton: {
    minHeight: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 13,
  },
  statusButtonText: { fontSize: 12, lineHeight: 16 },
  person: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  personCopy: { flex: 1, minWidth: 0 },
  name: { fontSize: 18, lineHeight: 21, letterSpacing: -0.3 },
  meta: { fontSize: 11, lineHeight: 15 },
  log: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
  day: { textAlign: "center", fontSize: 10, marginTop: 2, marginBottom: 12 },
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
  pendingBody: { fontSize: 15, lineHeight: 21, marginVertical: 5 },
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
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  ownershipLabel: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
  ownershipText: { flex: 1, fontSize: 12 },
  ownershipActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  assignButton: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 13,
    borderRadius: 22,
  },
  handoffLink: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 12,
    borderRadius: 22,
    borderWidth: 1,
  },
  reopen: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  reopenText: { flex: 1, fontSize: 14 },
  composer: {
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composeRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  replyChip: {
    minHeight: 48,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 7,
  },
  replyChipCopy: { flex: 1, minWidth: 0 },
  replyChipTitle: { fontSize: 11, lineHeight: 15 },
  replyChipText: { fontSize: 12, lineHeight: 16 },
  replyChipClose: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  composeBox: {
    flex: 1,
    minHeight: 44,
    borderRadius: 27,
    borderWidth: 1,
    paddingLeft: 14,
    paddingRight: 5,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    shadowColor: "#22384d",
    shadowOpacity: 0.04,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  input: {
    flex: 1,
    minHeight: 34,
    maxHeight: 120,
    paddingHorizontal: 0,
    paddingTop: 7,
    paddingBottom: 6,
    fontSize: 15,
    lineHeight: 20,
  },
  send: {
    width: 34,
    height: 34,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
});
