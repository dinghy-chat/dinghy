import type { ReactNode } from "react";
import { useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
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
import { Avatar, initials, visitorName } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import type { Palette } from "./theme";
import type { Conversation, Member, Message, Thread } from "./types";

function SheetFrame({
  bottomInset,
  children,
  onClose,
  palette,
  visible,
}: {
  bottomInset: number;
  children: ReactNode;
  onClose(): void;
  palette: Palette;
  visible: boolean;
}) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      <View style={screenStyles.modalRoot}>
        <Pressable
          accessibilityLabel={t("mobileDismiss")}
          onPress={onClose}
          style={screenStyles.modalBackdrop}
        />
        <View
          accessibilityViewIsModal
          style={[
            screenStyles.sheet,
            { backgroundColor: palette.paper, paddingBottom: Math.max(bottomInset, 12) },
          ]}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}

function SheetTools({ onClose, palette }: { onClose(): void; palette: Palette }) {
  return (
    <View style={screenStyles.sheetTools}>
      <View style={[screenStyles.sheetGrabber, { backgroundColor: palette.sub }]} />
      <Pressable
        accessibilityLabel={t("mobileDismiss")}
        accessibilityRole="button"
        hitSlop={6}
        onPress={onClose}
        style={({ pressed }) => [
          screenStyles.sheetClose,
          {
            backgroundColor: palette.paper,
            borderColor: palette.line,
            opacity: pressed ? 0.68 : 1,
          },
        ]}
      >
        <Icon color={palette.ink} name="x" size={18} />
      </Pressable>
    </View>
  );
}

function lastPagePath(conversation: Conversation): string | null {
  const value = (conversation as Conversation & { lastPage?: unknown }).lastPage;
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(value, "https://dinghy.invalid").pathname;
  } catch {
    return null;
  }
}

function VisitorDetailsSheet({
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
  if (!visible) return null;
  const assignee = members.find((member) => member.id === conversation.assigneeOperatorId);
  const assignment = conversation.assigneeOperatorId
    ? conversation.assigneeOperatorId === meId
      ? t("mobileAssigned")
      : assignee
        ? t("mobileAssignedTo", { name: assignee.name })
        : t("mobileAssignedOther")
    : t("unassigned");
  const page = lastPagePath(conversation);
  const facts = [
    [t("mobileConversationStatus"), conversation.status === "open" ? t("open") : t("closed")],
    [t("mobileConversationAssignment"), assignment],
    ...(page ? [[t("mobileLastPage"), page]] : []),
  ];
  return (
    <SheetFrame bottomInset={bottomInset} onClose={onClose} palette={palette} visible={visible}>
      <View style={screenStyles.visitorSky}>
        <Harbor animated={false} night={isNight} />
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
        <View style={screenStyles.detailsBottomSpace} />
      </ScrollView>
    </SheetFrame>
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
    <SheetFrame bottomInset={bottomInset} onClose={onClose} palette={palette} visible={visible}>
      <SheetTools onClose={onClose} palette={palette} />
      <View style={screenStyles.assignHead}>
        <Text style={[screenStyles.assignTitle, { color: palette.ink, fontFamily: fonts.display }]}>
          {t("mobileHandoff")}
        </Text>
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
        contentContainerStyle={screenStyles.crewGrid}
        horizontal
        showsHorizontalScrollIndicator={false}
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
                  screenStyles.crewTile,
                  {
                    backgroundColor: selected ? palette.tint : palette.wash,
                    borderColor: selected ? palette.blue : palette.line,
                    borderWidth: selected ? 2 : 1,
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}
              >
                <View style={screenStyles.crewStamp}>
                  <View style={screenStyles.crewAvatarWrap}>
                    <View style={[screenStyles.crewAvatar, { backgroundColor: palette.tint }]}>
                      <Text
                        style={[
                          screenStyles.crewInitials,
                          { color: palette.navy, fontFamily: fonts.display },
                        ]}
                      >
                        {initials(member.name)}
                      </Text>
                    </View>
                    {selected && (
                      <View style={[screenStyles.crewCheck, { backgroundColor: palette.blue }]}>
                        <Icon color="#ffffff" name="check" size={11} />
                      </View>
                    )}
                  </View>
                </View>
                <Text
                  numberOfLines={1}
                  style={[
                    screenStyles.crewName,
                    { color: palette.ink, fontFamily: fonts.semibold },
                  ]}
                >
                  {member.id === meId ? t("mobileMemberYou", { name: member.name }) : member.name}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[screenStyles.crewMeta, { color: palette.sub, fontFamily: fonts.body }]}
                >
                  {member.email}
                </Text>
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
    </SheetFrame>
  );
}

function MessageBubble({ message, palette }: { message: Message; palette: Palette }) {
  if (message.kind === "closed" || message.kind === "reopened") {
    return (
      <Text style={[screenStyles.statusMessage, { color: palette.sub, fontFamily: fonts.body }]}>
        {message.kind === "closed" ? t("closedPlain") : t("reopenedPlain")}
      </Text>
    );
  }
  if (message.kind === "note") {
    return (
      <View style={[screenStyles.note, { backgroundColor: palette.note }]}>
        <View style={screenStyles.noteHeading}>
          <Icon color={palette.noteInk} name="lock" size={13} />
          <Text
            style={[screenStyles.noteLabel, { color: palette.noteInk, fontFamily: fonts.semibold }]}
          >
            {message.authorName
              ? t("mobilePrivateNoteBy", { name: message.authorName })
              : t("mobilePrivateNote")}
          </Text>
        </View>
        <Text style={[screenStyles.noteText, { color: palette.noteInk, fontFamily: fonts.body }]}>
          {message.deleted ? t("messageDeleted") : message.body}
        </Text>
      </View>
    );
  }
  const outgoing = !message.fromVisitor;
  return (
    <View
      style={[
        screenStyles.bubble,
        outgoing ? screenStyles.bubbleOut : screenStyles.bubbleIn,
        { backgroundColor: outgoing ? palette.tint : palette.wash },
      ]}
    >
      <Text style={[screenStyles.bubbleText, { color: palette.ink, fontFamily: fonts.body }]}>
        {message.deleted ? t("messageDeleted") : message.body || t("mobileAttachment")}
      </Text>
    </View>
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
}: {
  reply: PendingReply;
  palette: Palette;
  error: { message: string; discardable: boolean } | undefined;
  canRetry: boolean;
  onDiscard(): void;
  onRetry(): void;
}) {
  return (
    <View style={[screenStyles.pending, { backgroundColor: palette.wash }]}>
      <View style={screenStyles.pendingHeading}>
        <Icon color={palette.sub} name="clock" size={14} />
        <Text style={[screenStyles.pendingLabel, { color: palette.sub, fontFamily: fonts.medium }]}>
          {t("mobileWaitingSend")}
        </Text>
      </View>
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

export function ThreadScreen({
  conversation,
  thread,
  pending,
  pendingErrors,
  bottomInset,
  loading,
  palette,
  meId,
  members,
  onBack,
  onDiscard,
  onHandoff,
  onReload,
  onSend,
  onRetry,
  onAssign,
  onStatus,
}: {
  conversation: Conversation;
  thread: Thread | null;
  pending: PendingReply[];
  pendingErrors: Record<string, { message: string; discardable: boolean }>;
  bottomInset: number;
  loading: boolean;
  palette: Palette;
  meId: string;
  members: Member[];
  onBack(): void;
  onDiscard(reply: PendingReply): void;
  onHandoff(operatorId: string): Promise<void>;
  onReload(): void;
  onSend(body: string): Promise<void>;
  onRetry(reply: PendingReply): Promise<void>;
  onAssign(): Promise<void>;
  onStatus(): Promise<void>;
}) {
  const isNight = useColorScheme() === "dark";
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const list = useRef<FlatList<Message | PendingReply>>(null);
  const current = thread?.conversation ?? conversation;
  const isClosed = current.status === "closed";
  const name = visitorName(current);
  const assignee = members.find((member) => member.id === current.assigneeOperatorId);
  const rows: (Message | PendingReply)[] = [...(thread?.messages ?? []), ...pending];
  const isPending = (row: Message | PendingReply): row is PendingReply => !("kind" in row);
  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      await onSend(body);
      setDraft("");
    } catch {
      // The parent shows the storage error. Keep the draft so the operator can try again.
    } finally {
      setSending(false);
    }
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
      style={[screenStyles.page, { backgroundColor: palette.paper, paddingBottom: bottomInset }]}
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
              {current.visitor.email || t("visitorAnonymous")}
            </Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityLabel={
            isClosed ? t("mobileReopenConversation") : t("mobileCloseConversation")
          }
          accessibilityRole="button"
          onPress={() => void onStatus()}
          style={({ pressed }) => [
            screenStyles.headerButton,
            { backgroundColor: pressed ? palette.wash : "transparent" },
          ]}
        >
          <Icon color={palette.navy} name="done" size={21} />
        </Pressable>
      </View>

      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(item) => (isPending(item) ? `pending-${item.clientId}` : item.id)}
        contentContainerStyle={screenStyles.log}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={onReload} tintColor={palette.blue} />
        }
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListHeaderComponent={
          <Text style={[screenStyles.day, { color: palette.sub, fontFamily: fonts.medium }]}>
            {t("today")}
          </Text>
        }
        renderItem={({ item }) =>
          isPending(item) ? (
            <PendingBubble
              canRetry={!isClosed}
              error={pendingErrors[item.clientId]}
              onDiscard={() => onDiscard(item)}
              onRetry={() => void onRetry(item)}
              palette={palette}
              reply={item}
            />
          ) : (
            <MessageBubble message={item} palette={palette} />
          )
        }
      />

      {!isClosed && (
        <View style={[screenStyles.ownership, { borderTopColor: palette.line }]}>
          <View style={screenStyles.ownershipMain}>
            {current.assigneeOperatorId ? (
              <View style={screenStyles.ownershipLabel}>
                <Icon color={palette.sub} name="person" size={13} />
                <Text style={{ color: palette.sub, fontFamily: fonts.body, fontSize: 13 }}>
                  {current.assigneeOperatorId === meId
                    ? t("mobileAssigned")
                    : assignee
                      ? t("mobileAssignedTo", { name: assignee.name })
                      : t("mobileAssignedOther")}
                </Text>
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => void onAssign()}
                style={({ pressed }) => [
                  screenStyles.assignButton,
                  { opacity: pressed ? 0.65 : 1 },
                ]}
              >
                <Text style={{ color: palette.blue, fontFamily: fonts.semibold, fontSize: 13 }}>
                  {t("keysAssignMe")}
                </Text>
              </Pressable>
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={openHandoff}
            style={({ pressed }) => [screenStyles.handoffLink, { opacity: pressed ? 0.65 : 1 }]}
          >
            <Text style={{ color: palette.blue, fontFamily: fonts.semibold, fontSize: 13 }}>
              {t("mobileHandoff")}
            </Text>
            <Icon color={palette.blue} name="next" size={13} />
          </Pressable>
        </View>
      )}

      {isClosed ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void onStatus()}
          style={({ pressed }) => [
            screenStyles.reopen,
            { borderTopColor: palette.line, opacity: pressed ? 0.68 : 1 },
          ]}
        >
          <Icon color={palette.blue} name="chat" size={18} />
          <Text style={[screenStyles.reopenText, { color: palette.ink, fontFamily: fonts.medium }]}>
            {t("mobileReopenReply")}
          </Text>
        </Pressable>
      ) : (
        <View style={screenStyles.composer}>
          <View style={screenStyles.modeBar}>
            <View style={[screenStyles.modeLabel, { backgroundColor: palette.wash }]}>
              <Icon color={palette.ink} name="chat" size={13} />
              <Text style={{ color: palette.ink, fontFamily: fonts.medium, fontSize: 12 }}>
                {t("mobileReplyMode")}
              </Text>
            </View>
          </View>
          <View
            style={[
              screenStyles.composeBox,
              { backgroundColor: palette.paper, borderColor: palette.line },
            ]}
          >
            <TextInput
              accessibilityLabel={t("mobileReplyTo", { name })}
              multiline
              onChangeText={setDraft}
              placeholder={t("mobileReplyPlaceholder", { name: name.split(" ")[0] ?? name })}
              placeholderTextColor={palette.sub}
              style={[screenStyles.input, { color: palette.ink, fontFamily: fonts.body }]}
              value={draft}
            />
            <View style={screenStyles.composerActions}>
              <Pressable
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
                  color={draft.trim() && !sending ? "#ffffff" : palette.sub}
                  name="send"
                  size={17}
                />
              </Pressable>
            </View>
          </View>
        </View>
      )}
      <VisitorDetailsSheet
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
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  modalBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(8, 28, 48, 0.34)",
  },
  sheet: {
    maxHeight: "82%",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden",
  },
  sheetTools: {
    minHeight: 39,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: 9,
    paddingVertical: 3,
    position: "relative",
  },
  sheetGrabber: {
    position: "absolute",
    left: "50%",
    top: 8,
    width: 36,
    height: 4,
    borderRadius: 6,
    marginLeft: -18,
    opacity: 0.54,
  },
  sheetClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetScroll: { flexShrink: 1 },
  visitorSky: { height: 104, position: "relative", overflow: "hidden" },
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
  detailsBottomSpace: { height: 12 },
  assignHead: { paddingHorizontal: 18, paddingBottom: 7 },
  assignTitle: { fontSize: 28, lineHeight: 31, letterSpacing: -0.9 },
  assignContext: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  assignLabel: {
    fontSize: 16,
    lineHeight: 20,
    marginTop: 13,
    marginBottom: 5,
    marginHorizontal: 18,
  },
  crewGrid: { gap: 8, paddingHorizontal: 18, paddingBottom: 10 },
  crewTile: {
    width: 126,
    minHeight: 113,
    borderRadius: Platform.OS === "android" ? 9 : 12,
    paddingHorizontal: 9,
    paddingVertical: 12,
  },
  crewStamp: { minHeight: 34, flexDirection: "row", alignItems: "center" },
  crewAvatarWrap: { width: 36, height: 36, position: "relative" },
  crewAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  crewInitials: { fontSize: 13 },
  crewCheck: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 17,
    height: 17,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  crewName: { fontSize: 15, lineHeight: 19, marginTop: 8 },
  crewMeta: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  noMembers: { width: 280, textAlign: "center", fontSize: 13, paddingVertical: 24 },
  sheetAction: { paddingHorizontal: 18, paddingTop: 2 },
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
  person: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  personCopy: { flex: 1, minWidth: 0 },
  name: { fontSize: 18, lineHeight: 21, letterSpacing: -0.3 },
  meta: { fontSize: 11, lineHeight: 15 },
  log: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
  day: { textAlign: "center", fontSize: 10, marginTop: 2, marginBottom: 12 },
  bubble: {
    maxWidth: "88%",
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 11,
  },
  bubbleIn: {
    alignSelf: "flex-start",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 4,
  },
  bubbleOut: {
    alignSelf: "flex-end",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 4,
  },
  bubbleText: { fontSize: 16, lineHeight: 22, letterSpacing: -0.18 },
  statusMessage: { textAlign: "center", fontSize: 11, marginVertical: 9 },
  note: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginVertical: 10 },
  noteHeading: { flexDirection: "row", alignItems: "center", gap: 6 },
  noteLabel: { flex: 1, fontSize: 12 },
  noteText: { fontSize: 14, lineHeight: 20, marginTop: 5 },
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
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  ownershipMain: { flex: 1, minWidth: 0 },
  ownershipLabel: { flexDirection: "row", alignItems: "center", gap: 6 },
  assignButton: { minHeight: 42, justifyContent: "center", paddingHorizontal: 6 },
  handoffLink: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
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
  composer: { paddingHorizontal: 10, paddingBottom: 5 },
  modeBar: { minHeight: 38, flexDirection: "row", alignItems: "center" },
  modeLabel: {
    minHeight: 31,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    borderRadius: 10,
  },
  composeBox: {
    minHeight: 86,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingTop: 5,
    paddingBottom: 3,
    shadowColor: "#22384d",
    shadowOpacity: 0.04,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  input: {
    minHeight: 38,
    maxHeight: 120,
    paddingHorizontal: 2,
    paddingTop: 7,
    paddingBottom: 4,
    fontSize: 15,
    lineHeight: 20,
  },
  composerActions: { minHeight: 39, flexDirection: "row", justifyContent: "flex-end" },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
});
