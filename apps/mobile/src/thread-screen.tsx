import { useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from "react-native";
import { t } from "../../operator/src/text.ts";
import type { PendingReply } from "../outbox";
import { Avatar, PillButton, visitorName } from "./common";
import { type Palette, styles } from "./theme";
import type { Conversation, Message, Thread } from "./types";

function MessageBubble({ message, palette }: { message: Message; palette: Palette }) {
  if (message.kind === "closed" || message.kind === "reopened") {
    return (
      <Text style={[styles.statusMessage, { color: palette.sub }]}>
        {message.kind === "closed" ? t("closedPlain") : t("reopenedPlain")}
      </Text>
    );
  }
  if (message.kind === "note") {
    return (
      <View style={[styles.note, { backgroundColor: palette.note }]}>
        <Text style={[styles.noteLabel, { color: palette.noteInk }]}>
          {message.authorName
            ? t("mobilePrivateNoteBy", { name: message.authorName })
            : t("mobilePrivateNote")}
        </Text>
        <Text style={[styles.noteText, { color: palette.noteInk }]}>
          {message.deleted ? t("messageDeleted") : message.body}
        </Text>
      </View>
    );
  }
  const outgoing = !message.fromVisitor;
  return (
    <View
      style={[
        styles.bubble,
        outgoing ? styles.bubbleOut : styles.bubbleIn,
        { backgroundColor: outgoing ? palette.blue : palette.wash },
      ]}
    >
      <Text style={[styles.bubbleText, { color: outgoing ? "#ffffff" : palette.ink }]}>
        {message.deleted ? t("messageDeleted") : message.body || t("mobileAttachment")}
      </Text>
    </View>
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
    <View style={[styles.pending, { backgroundColor: palette.wash, borderColor: palette.line }]}>
      <Text style={[styles.pendingLabel, { color: palette.sub }]}>{t("mobileWaitingSend")}</Text>
      <Text style={[styles.pendingBody, { color: palette.ink }]}>{reply.body}</Text>
      <View style={styles.pendingFoot}>
        <Text style={[styles.pendingError, { color: palette.amber }]}>
          {canRetry ? (error?.message ?? t("mobileConnectionInterrupted")) : t("mobileReopenRetry")}
        </Text>
        <View style={styles.pendingActions}>
          {error?.discardable && (
            <PillButton label={t("draftDiscard")} onPress={onDiscard} palette={palette} />
          )}
          {canRetry && <PillButton label={t("mobileRetry")} onPress={onRetry} palette={palette} />}
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
  onBack,
  onDiscard,
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
  onBack(): void;
  onDiscard(reply: PendingReply): void;
  onReload(): void;
  onSend(body: string): Promise<void>;
  onRetry(reply: PendingReply): Promise<void>;
  onAssign(): Promise<void>;
  onStatus(): Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<FlatList<Message | PendingReply>>(null);
  const current = thread?.conversation ?? conversation;
  const isClosed = current.status === "closed";
  const name = visitorName(current);
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

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.threadPage, { paddingBottom: bottomInset }]}
    >
      <View style={[styles.threadHead, { borderBottomColor: palette.line }]}>
        <Pressable
          accessibilityLabel={t("back")}
          onPress={onBack}
          hitSlop={10}
          style={styles.headButton}
        >
          <Text style={[styles.headButtonText, { color: palette.blue }]}>‹</Text>
        </Pressable>
        <View style={styles.headPerson}>
          <Avatar name={name} picture={current.visitor.pictureUrl} small palette={palette} />
          <View style={styles.headCopy}>
            <Text numberOfLines={1} style={[styles.headName, { color: palette.ink }]}>
              {name}
            </Text>
            <Text numberOfLines={1} style={[styles.headMeta, { color: palette.sub }]}>
              {current.visitor.email || t("visitorAnonymous")}
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityLabel={
            isClosed ? t("mobileReopenConversation") : t("mobileCloseConversation")
          }
          onPress={() => void onStatus()}
          style={styles.headButton}
        >
          <Text style={[styles.doneIcon, { color: palette.blue }]}>{isClosed ? "↻" : "✓"}</Text>
        </Pressable>
      </View>
      {!isClosed && (
        <View
          style={[
            styles.actionStrip,
            { backgroundColor: palette.wash, borderBottomColor: palette.line },
          ]}
        >
          <Text style={[styles.actionText, { color: palette.sub }]}>
            {current.assigneeOperatorId === meId ? t("mobileAssigned") : t("mobileNotAssigned")}
          </Text>
          {current.assigneeOperatorId !== meId && (
            <PillButton
              label={t("keysAssignMe")}
              onPress={() => void onAssign()}
              palette={palette}
            />
          )}
        </View>
      )}
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(item) => (isPending(item) ? `pending-${item.clientId}` : item.id)}
        contentContainerStyle={styles.threadLog}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={onReload} tintColor={palette.blue} />
        }
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListHeaderComponent={
          <Text style={[styles.dayStamp, { color: palette.sub }]}>{t("today")}</Text>
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
      {isClosed ? (
        <View style={[styles.reopenBar, { borderTopColor: palette.line }]}>
          <PillButton
            label={t("mobileReopenReply")}
            onPress={() => void onStatus()}
            palette={palette}
            primary
          />
        </View>
      ) : (
        <View
          style={[
            styles.composer,
            { borderTopColor: palette.line, backgroundColor: palette.paper },
          ]}
        >
          <TextInput
            accessibilityLabel={t("mobileReplyTo", { name })}
            multiline
            onChangeText={setDraft}
            placeholder={t("mobileReplyPlaceholder", { name: name.split(" ")[0] ?? name })}
            placeholderTextColor={palette.sub}
            style={[
              styles.composerInput,
              { borderColor: palette.line, color: palette.ink, backgroundColor: palette.paper },
            ]}
            value={draft}
          />
          <Pressable
            accessibilityLabel={t("mobileSendReply")}
            disabled={!draft.trim() || sending}
            onPress={() => void send()}
            style={({ pressed }) => [
              styles.sendButton,
              {
                backgroundColor: palette.blue,
                opacity: !draft.trim() || sending ? 0.4 : pressed ? 0.75 : 1,
              },
            ]}
          >
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
