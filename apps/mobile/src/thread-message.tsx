import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { t } from "../../operator/src/text.ts";
import type { DinghyApi } from "./api";
import { MessageAttachmentView } from "./attachments";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { MessageIcon, type MessageIconName } from "./message-icon";
import { canDeleteMessage, editAvailability, hasReceipt, type ReceiptState } from "./message-state";
import { Sheet } from "./sheet";
import type { Palette } from "./theme";
import type { Message, Quote, ReplyReceipts } from "./types";

function quoteAuthor(quote: Quote, visitorName: string): string {
  return quote.authorName ?? (quote.fromVisitor ? visitorName : t("aTeammate"));
}

function quoteText(quote: Quote): string {
  if (quote.id === null) return t("quoteDeleted");
  if (quote.hasImage && !quote.text.trim()) return t("quoteImage");
  return quote.text;
}

export function MessageQuote({
  quote,
  visitorName,
  palette,
}: {
  quote: Quote;
  visitorName: string;
  palette: Palette;
}) {
  return (
    <View style={[messageStyles.quote, { borderLeftColor: palette.blue }]}>
      <Text
        numberOfLines={1}
        style={[messageStyles.quoteAuthor, { color: palette.blue, fontFamily: fonts.semibold }]}
      >
        {quoteAuthor(quote, visitorName)}
      </Text>
      <Text
        numberOfLines={2}
        style={[messageStyles.quoteText, { color: palette.sub, fontFamily: fonts.body }]}
      >
        {quoteText(quote)}
      </Text>
    </View>
  );
}

type Action = {
  label: string;
  icon: MessageIconName;
  disabled?: string | undefined;
  danger?: boolean;
  run(): void;
};

function InfoSheet({
  api,
  bottomInset,
  conversationId,
  message,
  meId,
  onClose,
  palette,
  visible,
  visitorName,
}: {
  api: DinghyApi;
  bottomInset: number;
  conversationId: string;
  message: Message;
  meId: string;
  onClose(): void;
  palette: Palette;
  visible: boolean;
  visitorName: string;
}) {
  const [receipt, setReceipt] = useState<{
    readAt: string | null;
    emailedAt: string | null;
  } | null>(null);
  const wantsReceipt = hasReceipt(message);
  useEffect(() => {
    if (!visible || !wantsReceipt) return;
    let active = true;
    setReceipt(null);
    void api.messageReceipt(conversationId, message.id).then(
      (found) => {
        if (active) setReceipt(found);
      },
      () => {
        if (active) setReceipt({ readAt: null, emailedAt: null });
      },
    );
    return () => {
      active = false;
    };
  }, [api, conversationId, message.id, visible, wantsReceipt]);
  const author = message.fromVisitor
    ? visitorName
    : message.authorOperatorId === meId
      ? t("you")
      : (message.authorName ?? t("aTeammate"));
  const via =
    message.via === null
      ? author
      : message.via === "api"
        ? t("infoViaApi", { name: author })
        : message.via === "mcp"
          ? t("infoViaMcp", { name: author })
          : message.via === "draft"
            ? t("infoViaDraft", { name: author })
            : t("infoViaEmail", { name: author });
  const seen = receipt
    ? [
        receipt.emailedAt && t("infoEmailedAt", { time: shortTime(receipt.emailedAt) }),
        receipt.readAt && t("infoReadAt", { time: shortTime(receipt.readAt) }),
      ].filter((line): line is string => Boolean(line))
    : [];
  return (
    <Sheet
      bottomInset={bottomInset}
      onClose={onClose}
      palette={palette}
      title={t("infoTitle")}
      visible={visible}
    >
      <View style={messageStyles.info}>
        <View style={[messageStyles.infoRow, { borderBottomColor: palette.line }]}>
          <Text style={[messageStyles.infoLabel, { color: palette.sub }]}>
            {t("infoSentLabel")}
          </Text>
          <Text style={[messageStyles.infoValue, { color: palette.ink }]}>
            {new Date(message.createdAt).toLocaleString([], {
              dateStyle: "full",
              timeStyle: "short",
            })}
          </Text>
        </View>
        <View style={[messageStyles.infoRow, { borderBottomColor: palette.line }]}>
          <Text style={[messageStyles.infoLabel, { color: palette.sub }]}>
            {t("infoAuthorLabel")}
          </Text>
          <Text style={[messageStyles.infoValue, { color: palette.ink }]}>{via}</Text>
        </View>
        {wantsReceipt && (
          <View style={messageStyles.infoRow}>
            <Text style={[messageStyles.infoLabel, { color: palette.sub }]}>
              {t("infoSeenLabel")}
            </Text>
            <View style={messageStyles.infoValues}>
              {(receipt === null ? [t("loading")] : seen.length ? seen : [t("infoNotSeen")]).map(
                (line) => (
                  <Text key={line} style={[messageStyles.infoValue, { color: palette.ink }]}>
                    {line}
                  </Text>
                ),
              )}
            </View>
          </View>
        )}
      </View>
    </Sheet>
  );
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  const today = date.toDateString() === new Date().toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function EditSheet({
  api,
  bottomInset,
  conversationId,
  message,
  onChanged,
  onClose,
  onError,
  palette,
  visible,
}: {
  api: DinghyApi;
  bottomInset: number;
  conversationId: string;
  message: Message;
  onChanged(): void;
  onClose(): void;
  onError(error: unknown): void;
  palette: Palette;
  visible: boolean;
}) {
  const [draft, setDraft] = useState(message.body ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (visible) setDraft(message.body ?? "");
  }, [message.body, visible]);
  const save = async () => {
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    try {
      await api.editMessage(
        conversationId,
        message.id,
        body,
        message.kind === "note" ? message.mentions : [],
      );
      onClose();
      onChanged();
    } catch (failure) {
      onError(failure);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet
      bottomInset={bottomInset}
      onClose={() => {
        if (!saving) onClose();
      }}
      palette={palette}
      title={t("mobileEditMessageTitle")}
      visible={visible}
    >
      <View style={messageStyles.editForm}>
        <TextInput
          accessibilityLabel={t("editLabel")}
          autoFocus
          editable={!saving}
          multiline
          onChangeText={setDraft}
          style={[
            messageStyles.editInput,
            {
              backgroundColor: palette.wash,
              borderColor: palette.line,
              color: palette.ink,
              fontFamily: fonts.body,
            },
          ]}
          textAlignVertical="top"
          value={draft}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!draft.trim() || saving}
          onPress={() => void save()}
          style={({ pressed }) => [
            messageStyles.save,
            {
              backgroundColor: palette.blue,
              opacity: !draft.trim() || saving ? 0.45 : pressed ? 0.7 : 1,
            },
          ]}
        >
          <Text style={{ color: palette.onBlue, fontFamily: fonts.semibold, fontSize: 15 }}>
            {saving ? t("mobileSavingChanges") : t("saveEdit")}
          </Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

function SwipeReply({
  children,
  enabled,
  onReply,
  palette,
}: {
  children: React.ReactNode;
  enabled: boolean;
  onReply(): void;
  palette: Palette;
}) {
  const offset = useRef(new Animated.Value(0)).current;
  const didReply = useRef(false);
  const callback = useRef(onReply);
  const isEnabled = useRef(enabled);
  callback.current = onReply;
  isEnabled.current = enabled;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        isEnabled.current && gesture.dx > 8 && gesture.dx > Math.abs(gesture.dy) * 1.2,
      onPanResponderMove: (_, gesture) => {
        offset.setValue(Math.min(76, Math.max(0, gesture.dx)));
        if (gesture.dx >= 62 && !didReply.current) {
          didReply.current = true;
          callback.current();
        }
      },
      onPanResponderRelease: () => {
        Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start();
        didReply.current = false;
      },
      onPanResponderTerminate: () => {
        Animated.spring(offset, { toValue: 0, useNativeDriver: true }).start();
        didReply.current = false;
      },
    }),
  ).current;
  return (
    <View style={messageStyles.swipeWrap}>
      {enabled && (
        <View style={messageStyles.swipeHint}>
          <MessageIcon color={palette.blue} name="reply" size={20} />
        </View>
      )}
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: offset }] }}>
        {children}
      </Animated.View>
    </View>
  );
}

export function ThreadMessage({
  api,
  bottomInset,
  canReply,
  canWrite,
  conversationId,
  mayDeleteAnyone,
  meId,
  message,
  meta,
  onAttachmentError,
  onChanged,
  onError,
  onReply,
  palette,
  receipt,
  receipts,
  visitorName,
}: {
  api: DinghyApi;
  bottomInset: number;
  canReply: boolean;
  canWrite: boolean;
  conversationId: string;
  mayDeleteAnyone: boolean;
  meId: string;
  message: Message;
  meta: string | null;
  onAttachmentError(): void | Promise<void>;
  onChanged(): void;
  onError(error: unknown): void;
  onReply(message: Message): void;
  palette: Palette;
  receipt: ReceiptState | null;
  receipts: ReplyReceipts | null;
  visitorName: string;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const afterActionsClose = useRef<(() => void) | null>(null);
  if (message.kind === "closed" || message.kind === "reopened") {
    return (
      <Text style={[messageStyles.status, { color: palette.sub, fontFamily: fonts.body }]}>
        {message.kind === "closed" ? t("closedPlain") : t("reopenedPlain")} ·{" "}
        {shortTime(message.createdAt)}
      </Text>
    );
  }
  const outgoing = !message.fromVisitor;
  const availability = editAvailability(message, meId, receipts, canWrite);
  const closeThen = (next: () => void) => {
    afterActionsClose.current = next;
    setActionsOpen(false);
  };
  const copy = (text: string, announcement: string) =>
    closeThen(() => {
      void Clipboard.setStringAsync(text)
        .then(() => AccessibilityInfo.announceForAccessibility(announcement))
        .catch(() => {});
    });
  const remove = () =>
    Alert.alert(
      t("messageDeleteTitle"),
      t(message.kind === "note" ? "noteDeleteText" : "messageDeleteText"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("messageDeleteYes"),
          style: "destructive",
          onPress: () =>
            void api.deleteMessage(conversationId, message.id).then(onChanged, onError),
        },
      ],
    );
  const actions: Action[] = message.deleted
    ? [
        {
          label: t("messageInfo"),
          icon: "info",
          run: () => closeThen(() => setInfoOpen(true)),
        },
      ]
    : [
        ...(canReply && message.kind !== "note"
          ? [
              {
                label: t("messageReply"),
                icon: "reply" as const,
                run: () => closeThen(() => onReply(message)),
              },
            ]
          : []),
        ...((message.kind === "text" || message.kind === "note") && message.body
          ? [
              {
                label: t("messageCopyText"),
                icon: "copy" as const,
                run: () => copy(message.body ?? "", t("copied")),
              },
            ]
          : []),
        ...(availability !== "unavailable"
          ? [
              {
                label: t("messageEdit"),
                icon: "edit" as const,
                disabled:
                  availability === "read"
                    ? t("messageAlreadyRead")
                    : availability === "emailed"
                      ? t("messageAlreadyEmailed")
                      : undefined,
                run: () => closeThen(() => setEditOpen(true)),
              },
            ]
          : []),
        {
          label: t("messageInfo"),
          icon: "info",
          run: () => closeThen(() => setInfoOpen(true)),
        },
        {
          label: t("messageCopyLink"),
          icon: "link",
          run: () => copy(api.messageLink(conversationId, message.id), t("linkCopied")),
        },
        ...(canDeleteMessage(message, meId, canWrite, mayDeleteAnyone)
          ? [
              {
                label: t("messageDelete"),
                icon: "trash" as const,
                danger: true,
                run: () => closeThen(remove),
              },
            ]
          : []),
      ];
  const quote = message.replyTo && (
    <MessageQuote palette={palette} quote={message.replyTo} visitorName={visitorName} />
  );
  const bubble =
    message.kind === "note" ? (
      <View style={[messageStyles.note, { backgroundColor: palette.note }]}>
        <View style={messageStyles.noteHead}>
          <Icon color={palette.noteInk} name="lock" size={13} />
          <Text
            style={[
              messageStyles.noteLabel,
              { color: palette.noteInk, fontFamily: fonts.semibold },
            ]}
          >
            {message.authorName
              ? t("mobilePrivateNoteBy", { name: message.authorName })
              : t("mobilePrivateNote")}
          </Text>
        </View>
        {quote}
        <Text style={[messageStyles.noteText, { color: palette.noteInk, fontFamily: fonts.body }]}>
          {message.deleted ? t("messageDeleted") : message.body}
        </Text>
      </View>
    ) : !message.deleted && message.attachment ? (
      <View style={messageStyles.attachmentStack}>
        {quote}
        <MessageAttachmentView
          attachment={message.attachment}
          fromVisitor={message.fromVisitor}
          onReload={onAttachmentError}
          palette={palette}
        />
      </View>
    ) : (
      <View
        style={[
          messageStyles.bubble,
          outgoing ? messageStyles.out : messageStyles.in,
          { backgroundColor: outgoing ? palette.tint : palette.wash },
        ]}
      >
        {quote}
        <Text style={[messageStyles.body, { color: palette.ink, fontFamily: fonts.body }]}>
          {message.deleted ? t("messageDeleted") : message.body || t("mobileAttachment")}
        </Text>
      </View>
    );
  return (
    <>
      <SwipeReply
        enabled={canReply && !message.deleted && message.kind !== "note"}
        onReply={() => onReply(message)}
        palette={palette}
      >
        <View style={[messageStyles.row, outgoing ? messageStyles.rowOut : messageStyles.rowIn]}>
          <Pressable
            accessibilityHint={t("mobileSwipeToReply")}
            delayLongPress={300}
            onLongPress={() => setActionsOpen(true)}
            style={messageStyles.bubblePress}
          >
            {bubble}
          </Pressable>
          <Pressable
            accessibilityLabel={t("messageActions")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setActionsOpen(true)}
            style={({ pressed }) => [messageStyles.more, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Icon color={palette.sub} name="dots" size={18} />
          </Pressable>
        </View>
      </SwipeReply>
      {receipt && (
        <View style={messageStyles.receipt}>
          <MessageIcon color={palette.sub} name="checks" size={14} />
          <Text style={[messageStyles.receiptText, { color: palette.sub, fontFamily: fonts.body }]}>
            {receipt === "sent"
              ? t("receiptSent")
              : receipt === "emailed"
                ? t("receiptEmailed")
                : receipt === "emailFailed"
                  ? t("receiptEmailFailed")
                  : t("receiptRead")}
          </Text>
        </View>
      )}
      {meta && (
        <Text
          style={[
            messageStyles.meta,
            outgoing ? messageStyles.metaOut : messageStyles.metaIn,
            { color: palette.sub, fontFamily: fonts.body },
          ]}
        >
          {meta}
        </Text>
      )}
      <Sheet
        bottomInset={bottomInset}
        onClose={() => setActionsOpen(false)}
        onDismiss={() => {
          const next = afterActionsClose.current;
          afterActionsClose.current = null;
          next?.();
        }}
        palette={palette}
        title={t("messageActions")}
        visible={actionsOpen}
      >
        <ScrollView contentContainerStyle={messageStyles.actions}>
          {actions.map((action) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: Boolean(action.disabled) }}
              disabled={Boolean(action.disabled)}
              key={action.label}
              onPress={action.run}
              style={({ pressed }) => [
                messageStyles.action,
                { backgroundColor: pressed ? palette.wash : "transparent" },
              ]}
            >
              <MessageIcon
                color={action.danger ? palette.amber : action.disabled ? palette.sub : palette.blue}
                name={action.icon}
              />
              <View style={messageStyles.actionCopy}>
                <Text
                  style={[
                    messageStyles.actionLabel,
                    {
                      color: action.danger
                        ? palette.amber
                        : action.disabled
                          ? palette.sub
                          : palette.ink,
                      fontFamily: fonts.medium,
                    },
                  ]}
                >
                  {action.label}
                </Text>
                {action.disabled && (
                  <Text style={[messageStyles.actionReason, { color: palette.sub }]}>
                    {action.disabled}
                  </Text>
                )}
              </View>
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
      <EditSheet
        api={api}
        bottomInset={bottomInset}
        conversationId={conversationId}
        message={message}
        onChanged={onChanged}
        onClose={() => setEditOpen(false)}
        onError={onError}
        palette={palette}
        visible={editOpen}
      />
      <InfoSheet
        api={api}
        bottomInset={bottomInset}
        conversationId={conversationId}
        message={message}
        meId={meId}
        onClose={() => setInfoOpen(false)}
        palette={palette}
        visible={infoOpen}
        visitorName={visitorName}
      />
    </>
  );
}

const messageStyles = StyleSheet.create({
  quote: { borderLeftWidth: 2, paddingLeft: 8, marginBottom: 7, gap: 1 },
  quoteAuthor: { fontSize: 11, lineHeight: 15 },
  quoteText: { fontSize: 12, lineHeight: 16 },
  status: { textAlign: "center", fontSize: 11, lineHeight: 16, marginVertical: 10 },
  swipeWrap: { position: "relative" },
  swipeHint: { position: "absolute", left: 18, top: "50%", marginTop: -10 },
  row: { flexDirection: "row", alignItems: "center", gap: 3, marginBottom: 3 },
  rowIn: { justifyContent: "flex-start" },
  rowOut: { flexDirection: "row-reverse", justifyContent: "flex-start" },
  bubblePress: { maxWidth: "88%" },
  more: { width: 34, height: 38, alignItems: "center", justifyContent: "center" },
  bubble: { paddingHorizontal: 12, paddingVertical: 9 },
  in: {
    alignSelf: "flex-start",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 4,
  },
  out: {
    alignSelf: "flex-end",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 4,
  },
  body: { fontSize: 16, lineHeight: 22, letterSpacing: -0.18 },
  attachmentStack: { gap: 5 },
  note: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginVertical: 7 },
  noteHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  noteLabel: { flex: 1, fontSize: 12 },
  noteText: { fontSize: 14, lineHeight: 20, marginTop: 5 },
  receipt: {
    alignSelf: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 2,
    marginRight: 3,
  },
  receiptText: { fontSize: 10, lineHeight: 14 },
  meta: { fontSize: 10, lineHeight: 14, marginBottom: 8 },
  metaIn: { alignSelf: "flex-start", marginLeft: 3 },
  metaOut: { alignSelf: "flex-end", marginRight: 3 },
  actions: { paddingHorizontal: 12, paddingBottom: 8 },
  action: {
    minHeight: 54,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionCopy: { flex: 1, minWidth: 0 },
  actionLabel: { fontSize: 16, lineHeight: 21 },
  actionReason: { fontFamily: fonts.body, fontSize: 11, lineHeight: 15, marginTop: 1 },
  editForm: { paddingHorizontal: 20, paddingBottom: 8, gap: 10 },
  editInput: {
    minHeight: 120,
    maxHeight: 260,
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    fontSize: 15,
    lineHeight: 21,
  },
  save: { minHeight: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  info: { paddingHorizontal: 20, paddingBottom: 8 },
  infoRow: {
    flexDirection: "row",
    gap: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  infoLabel: { width: 60, fontFamily: fonts.body, fontSize: 12, lineHeight: 18 },
  infoValue: { flex: 1, fontFamily: fonts.medium, fontSize: 13, lineHeight: 18 },
  infoValues: { flex: 1, gap: 3 },
});
