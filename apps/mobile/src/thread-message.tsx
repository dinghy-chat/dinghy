import * as Clipboard from "expo-clipboard";
import { type ComponentRef, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Animated,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { plainText } from "../../../packages/widget/src/markdown.ts";
import { t } from "../../operator/src/text.ts";
import { AnchoredMenu, type MenuItem } from "./anchored-menu";
import type { DinghyApi } from "./api";
import { MessageAttachmentView } from "./attachments";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { MessageIcon, type MessageIconName } from "./message-icon";
import { MessageMarkdown, markdownLinks, openMarkdownLink } from "./message-markdown";
import { canDeleteMessage, editAvailability, hasReceipt, type ReceiptState } from "./message-state";
import { Sheet } from "./sheet";
import type { Palette } from "./theme";
import type { Rect } from "./thread-logic";
import { conversationBackEdge } from "./thread-route";
import type { Message, Quote, ReplyReceipts } from "./types";

function quoteAuthor(quote: Quote, visitorName: string): string {
  return quote.authorName ?? (quote.fromVisitor ? visitorName : t("aTeammate"));
}

function quoteText(quote: Quote): string {
  if (quote.id === null) return t("quoteDeleted");
  if (quote.hasImage && !quote.text.trim()) return t("quoteImage");
  return plainText(quote.text);
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
      dismissible={!saving}
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

/** A word too long for one line of a bubble. */
const LONG_WORD = /\S{40,}/;

const replyThreshold = 64;
const replyMax = 96;
const backEdge = Platform.OS === "ios" ? conversationBackEdge : 24;

function SwipeReply({
  children,
  enabled,
  full,
  outgoing,
  onReply,
  palette,
}: {
  children: React.ReactNode;
  enabled: boolean;
  /** The row takes its whole width instead of its content's. */
  full: boolean;
  outgoing: boolean;
  onReply(): void;
  palette: Palette;
}) {
  const offset = useRef(new Animated.Value(0)).current;
  const touchStart = useRef(0);
  const latest = useRef({ enabled, onReply });
  latest.current = { enabled, onReply };
  const pan = useMemo(() => {
    const reset = () =>
      Animated.spring(offset, {
        toValue: 0,
        damping: 24,
        stiffness: 320,
        mass: 0.75,
        overshootClamping: true,
        useNativeDriver: true,
      }).start();
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) => {
        touchStart.current = event.nativeEvent.pageX;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        latest.current.enabled &&
        touchStart.current >= backEdge &&
        gesture.numberActiveTouches === 1 &&
        gesture.dx > 8 &&
        gesture.dx > Math.abs(gesture.dy) * 1.5,
      onPanResponderGrant: () => offset.stopAnimation(),
      // Once the row follows the finger, the list must not take the gesture back mid-swipe.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (event) => {
        const dx = Math.max(0, event.nativeEvent.pageX - touchStart.current);
        offset.setValue(
          dx <= replyThreshold
            ? dx
            : Math.min(replyMax, replyThreshold + (dx - replyThreshold) / 3),
        );
      },
      onPanResponderRelease: (event) => {
        const commit =
          latest.current.enabled && event.nativeEvent.pageX - touchStart.current >= replyThreshold;
        reset();
        if (commit) latest.current.onReply();
      },
      onPanResponderTerminate: reset,
    });
  }, [offset]);
  const reveal = offset.interpolate({
    inputRange: [0, replyThreshold],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });
  const scale = offset.interpolate({
    inputRange: [0, replyThreshold],
    outputRange: [0.75, 1],
    extrapolate: "clamp",
  });
  const armed = offset.interpolate({
    inputRange: [replyThreshold - 0.5, replyThreshold],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });
  // The arrow sits 36 pt left of the bubble. An incoming bubble starts at the list's 16 pt margin,
  // so early in the drag the arrow holds at 12 pt from the screen edge instead of leaving it.
  const hold = outgoing
    ? 0
    : offset.interpolate({ inputRange: [0, 32], outputRange: [32, 0], extrapolate: "clamp" });
  return (
    <View
      style={[messageStyles.swipeWrap, outgoing ? messageStyles.sideOut : messageStyles.sideIn]}
    >
      <Animated.View
        {...pan.panHandlers}
        style={[
          messageStyles.swipeRow,
          full && messageStyles.fullRow,
          { transform: [{ translateX: offset }] },
        ]}
      >
        {enabled && (
          <Animated.View
            accessibilityElementsHidden
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={[
              messageStyles.swipeHint,
              {
                backgroundColor: palette.tint,
                opacity: reveal,
                transform: [{ translateX: hold }, { scale }],
              },
            ]}
          >
            <MessageIcon color={palette.blue} name="reply" size={16} />
            <Animated.View
              style={[messageStyles.swipeArmed, { backgroundColor: palette.blue, opacity: armed }]}
            >
              <MessageIcon color={palette.onBlue} name="reply" size={16} />
            </Animated.View>
          </Animated.View>
        )}
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
  const [menuAnchor, setMenuAnchor] = useState<Rect | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const bubbleRef = useRef<ComponentRef<typeof View>>(null);
  if (message.kind === "closed" || message.kind === "reopened") {
    return (
      <Text style={[messageStyles.status, { color: palette.sub, fontFamily: fonts.body }]}>
        {message.kind === "closed" ? t("closedPlain") : t("reopenedPlain")} ·{" "}
        {shortTime(message.createdAt)}
      </Text>
    );
  }
  const outgoing = !message.fromVisitor;
  const isNote = message.kind === "note";
  const mayReply = canReply && !message.deleted && !isNote;
  // iOS measures a bubble that fits its text at a narrower width than it draws, and text broken
  // inside a long word, such as a DKIM key, then leaves empty lines at the bottom. Such text fills
  // the row anyway, so its bubble takes the row's width and is measured at its final width.
  const unbroken = !message.deleted && LONG_WORD.test(message.body ?? "");
  const copyable = !message.deleted && (message.kind === "text" || isNote) && Boolean(message.body);
  const links = copyable ? markdownLinks(message.body ?? "") : [];
  const availability = editAvailability(message, meId, receipts, canWrite);
  const openMenu = () => {
    bubbleRef.current?.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) return;
      setMenuAnchor({ x, y, width, height });
      setMenuOpen(true);
    });
  };
  const copy = (text: string, announcement: string) => {
    void Clipboard.setStringAsync(text)
      .then(() => AccessibilityInfo.announceForAccessibility(announcement))
      .catch(() => {});
  };
  const remove = () =>
    Alert.alert(t("messageDeleteTitle"), t(isNote ? "noteDeleteText" : "messageDeleteText"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("messageDeleteYes"),
        style: "destructive",
        onPress: () => void api.deleteMessage(conversationId, message.id).then(onChanged, onError),
      },
    ]);
  const icon = (name: MessageIconName) => (color: string) => (
    <MessageIcon color={color} name={name} size={20} />
  );
  const items: MenuItem[] = [];
  if (mayReply)
    items.push({ label: t("messageReply"), icon: icon("reply"), run: () => onReply(message) });
  if (copyable) {
    items.push({
      label: t("messageCopyText"),
      icon: icon("copy"),
      run: () => copy(message.body ?? "", t("copied")),
    });
  }
  if (!message.deleted) {
    items.push({
      label: t("messageCopyLink"),
      icon: icon("link"),
      run: () => copy(api.messageLink(conversationId, message.id), t("linkCopied")),
    });
  }
  items.push({ label: t("infoTitle"), icon: icon("info"), run: () => setInfoOpen(true) });
  // Edit and Delete keep the server's rules: your own text until the visitor read it or it went
  // by email, and Delete for your own messages, or anyone's for an owner or admin.
  if (availability !== "unavailable") {
    items.push({
      label: t("messageEdit"),
      icon: icon("edit"),
      disabled:
        availability === "read"
          ? t("messageAlreadyRead")
          : availability === "emailed"
            ? t("messageAlreadyEmailed")
            : undefined,
      run: () => setEditOpen(true),
    });
  }
  if (canDeleteMessage(message, meId, canWrite, mayDeleteAnyone)) {
    items.push({
      label: t("messageDelete"),
      icon: icon("trash"),
      danger: true,
      run: remove,
    });
  }
  const quote = message.replyTo && (
    <MessageQuote palette={palette} quote={message.replyTo} visitorName={visitorName} />
  );
  const bubble = isNote ? (
    <View
      style={[
        messageStyles.note,
        unbroken && messageStyles.fullBubble,
        { backgroundColor: palette.note },
      ]}
    >
      <View style={messageStyles.noteHead}>
        <Icon color={palette.noteInk} name="lock" size={13} />
        <Text
          style={[messageStyles.noteLabel, { color: palette.noteInk, fontFamily: fonts.semibold }]}
        >
          {message.authorName
            ? t("mobilePrivateNoteBy", { name: message.authorName })
            : t("mobilePrivateNote")}
        </Text>
      </View>
      {quote}
      {message.deleted ? (
        <Text style={[messageStyles.deleted, { color: palette.noteInk }]}>
          {t("messageDeleted")}
        </Text>
      ) : (
        <MessageMarkdown
          lineHeight={20}
          palette={palette}
          size={14.5}
          source={message.body ?? ""}
          tone={{
            ink: palette.noteInk,
            link: palette.noteInk,
            quoteLine: palette.noteInk,
            quoteInk: palette.noteInk,
          }}
        />
      )}
    </View>
  ) : !message.deleted && message.attachment ? (
    <View style={messageStyles.attachmentStack}>
      {quote}
      <MessageAttachmentView
        attachment={message.attachment}
        fromVisitor={message.fromVisitor}
        onLongPress={openMenu}
        onReload={onAttachmentError}
        palette={palette}
      />
    </View>
  ) : (
    <View
      style={[
        messageStyles.bubble,
        outgoing ? messageStyles.out : messageStyles.in,
        unbroken && messageStyles.fullBubble,
        { backgroundColor: outgoing ? palette.tint : palette.wash },
      ]}
    >
      {quote}
      {message.deleted || !message.body ? (
        <Text style={[messageStyles.deleted, { color: palette.sub }]}>
          {message.deleted ? t("messageDeleted") : t("mobileAttachment")}
        </Text>
      ) : (
        <MessageMarkdown
          palette={palette}
          source={message.body}
          tone={{
            ink: palette.ink,
            link: palette.blue,
            quoteLine: palette.blue,
            quoteInk: palette.sub,
          }}
        />
      )}
    </View>
  );
  const accessibilityActions = [
    ...(mayReply ? [{ name: "reply", label: t("messageReply") }] : []),
    ...(copyable ? [{ name: "copy", label: t("messageCopyText") }] : []),
    ...links.map((link, index) => ({
      name: `link-${index}`,
      label: t("mobileOpenLink", { link: link.label || link.href }),
    })),
    { name: "menu", label: t("messageActions") },
  ];
  const attachmentName =
    message.attachment?.type === "file" && !message.attachment.removed
      ? message.attachment.name
      : t("mobileAttachment");
  const receiptLabel =
    receipt === "sent"
      ? t("receiptSent")
      : receipt === "emailed"
        ? t("receiptEmailed")
        : receipt === "emailFailed"
          ? t("receiptEmailFailed")
          : receipt === "read"
            ? t("receiptRead")
            : null;
  const accessibilityLabel = [
    isNote ? t("mobilePrivateNote") : null,
    message.deleted ? t("messageDeleted") : message.body ? plainText(message.body) : attachmentName,
    meta,
    receiptLabel,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");
  return (
    <>
      <SwipeReply
        enabled={mayReply}
        full={unbroken}
        onReply={() => onReply(message)}
        outgoing={outgoing}
        palette={palette}
      >
        <Pressable
          accessible
          accessibilityActions={accessibilityActions}
          accessibilityHint={mayReply ? t("mobileSwipeToReply") : undefined}
          accessibilityLabel={accessibilityLabel}
          delayLongPress={300}
          onAccessibilityAction={(event) => {
            const action = event.nativeEvent.actionName;
            if (action === "reply") onReply(message);
            else if (action === "copy") copy(message.body ?? "", t("copied"));
            else if (action === "menu") openMenu();
            else {
              const link = links.findIndex((_, index) => action === `link-${index}`);
              if (link >= 0) void openMarkdownLink(links[link]?.href ?? "");
            }
          }}
          onLongPress={openMenu}
        >
          <View
            accessibilityElementsHidden
            accessible={false}
            collapsable={false}
            importantForAccessibility="no-hide-descendants"
            ref={bubbleRef}
          >
            {bubble}
          </View>
        </Pressable>
      </SwipeReply>
      {receipt && (
        <View
          accessibilityElementsHidden
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={messageStyles.receipt}
        >
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
          accessible={false}
          importantForAccessibility="no"
          style={[
            messageStyles.meta,
            outgoing ? messageStyles.metaOut : messageStyles.metaIn,
            { color: palette.sub, fontFamily: fonts.body },
          ]}
        >
          {meta}
        </Text>
      )}
      <AnchoredMenu
        anchor={menuAnchor}
        items={items}
        label={t("messageActions")}
        lift={bubble}
        onClose={() => setMenuOpen(false)}
        palette={palette}
        side={outgoing ? "end" : "start"}
        visible={menuOpen}
      />
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
  swipeWrap: { position: "relative", marginBottom: 3 },
  sideIn: { alignItems: "flex-start" },
  sideOut: { alignItems: "flex-end" },
  swipeRow: { maxWidth: "88%" },
  fullRow: { width: "88%" },
  fullBubble: { alignSelf: "stretch" },
  swipeHint: {
    position: "absolute",
    left: -36,
    top: "50%",
    marginTop: -15,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  swipeArmed: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
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
  deleted: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, fontStyle: "italic" },
  attachmentStack: { gap: 5 },
  note: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginVertical: 7 },
  noteHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  noteLabel: { flex: 1, fontSize: 12 },
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
