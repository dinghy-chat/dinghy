import * as Crypto from "expo-crypto";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../../operator/src/text.ts";
import type { DinghyApi } from "./api";
import { readableError, SheetCloseButton } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import type { Palette } from "./theme";
import type { Message, SavedReply } from "./types";

type ConversationToolsProps = {
  api: DinghyApi;
  children?: ReactNode;
  conversationId: string;
  palette: Palette;
  onInsert(text: string): void;
  onNoteAdded(message: Message): void;
};

function Sheet({
  children,
  onClose,
  palette,
  title,
  visible,
}: {
  children: ReactNode;
  onClose(): void;
  palette: Palette;
  title: string;
  visible: boolean;
}) {
  const { bottom } = useSafeAreaInsets();
  if (!visible) return null;
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.modalRoot}
      >
        <Pressable
          accessibilityLabel={t("mobileDismiss")}
          onPress={onClose}
          style={styles.backdrop}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { backgroundColor: palette.paper, paddingBottom: Math.max(bottom, 14) },
          ]}
        >
          <View style={styles.sheetHead}>
            <View style={[styles.grabber, { backgroundColor: palette.sub }]} />
            <Text style={[styles.sheetTitle, { color: palette.ink, fontFamily: fonts.display }]}>
              {title}
            </Text>
            <SheetCloseButton label={t("mobileDismiss")} onPress={onClose} palette={palette} />
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ToolButton({
  icon,
  label,
  onPress,
  palette,
}: {
  icon: "bookmark" | "lock";
  label: string;
  onPress(): void;
  palette: Palette;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.tool,
        {
          backgroundColor: pressed ? palette.tint : palette.paper,
          borderColor: palette.line,
        },
      ]}
    >
      <Icon color={palette.blue} name={icon} size={15} />
      <Text style={[styles.toolText, { color: palette.ink, fontFamily: fonts.medium }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ConversationTools({
  api,
  children,
  conversationId,
  onInsert,
  onNoteAdded,
  palette,
}: ConversationToolsProps) {
  const [savedOpen, setSavedOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [savedReplies, setSavedReplies] = useState<SavedReply[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [savedLoading, setSavedLoading] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteClientId = useRef<string | null>(null);
  const activeConversationId = useRef(conversationId);

  useEffect(() => {
    activeConversationId.current = conversationId;
    setSavedOpen(false);
    setNoteOpen(false);
    setNoteBody("");
    setNoteBusy(false);
    setNoteError(null);
    noteClientId.current = null;
  }, [conversationId]);

  const loadSavedReplies = async () => {
    setSavedLoading(true);
    setSavedError(null);
    try {
      const answer = await api.savedReplies();
      setSavedReplies(answer.savedReplies);
    } catch (failure) {
      setSavedError(readableError(failure));
    } finally {
      setSavedLoading(false);
    }
  };

  const openSavedReplies = () => {
    setSavedOpen(true);
    void loadSavedReplies();
  };

  const changeNote = (body: string) => {
    setNoteBody(body);
    setNoteError(null);
    // Edited text is a new operation. It must not reuse a failed request's idempotency key.
    noteClientId.current = null;
  };

  const sendNote = async () => {
    const body = noteBody.trim();
    if (!body || noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    const clientId = noteClientId.current ?? Crypto.randomUUID();
    const targetConversationId = conversationId;
    noteClientId.current = clientId;
    let message: Message;
    try {
      message = await api.note(targetConversationId, clientId, body);
    } catch (failure) {
      if (activeConversationId.current !== targetConversationId) return;
      setNoteError(readableError(failure));
      return;
    } finally {
      if (activeConversationId.current === targetConversationId) setNoteBusy(false);
    }
    if (activeConversationId.current !== targetConversationId) return;
    noteClientId.current = null;
    setNoteBody("");
    setNoteOpen(false);
    onNoteAdded(message);
  };

  return (
    <>
      <View accessibilityLabel={t("mobileConversationTools")} style={styles.toolbar}>
        {children}
        <ToolButton
          icon="bookmark"
          label={t("mobileUseSavedReply")}
          onPress={openSavedReplies}
          palette={palette}
        />
        <ToolButton
          icon="lock"
          label={t("mobileAddPrivateNote")}
          onPress={() => {
            setNoteError(null);
            setNoteOpen(true);
          }}
          palette={palette}
        />
      </View>

      <Sheet
        onClose={() => setSavedOpen(false)}
        palette={palette}
        title={t("mobileSavedRepliesTitle")}
        visible={savedOpen}
      >
        <Text style={[styles.help, { color: palette.sub, fontFamily: fonts.body }]}>
          {t("mobileSavedRepliesHelp")}
        </Text>
        <ScrollView
          contentContainerStyle={styles.replyList}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {savedLoading && savedReplies === null ? (
            <ActivityIndicator color={palette.blue} style={styles.loading} />
          ) : savedError ? (
            <View style={styles.empty}>
              <Text style={[styles.emptyText, { color: palette.sub, fontFamily: fonts.body }]}>
                {t("mobileSavedRepliesLoadFailed")}
              </Text>
              <Text style={[styles.errorDetail, { color: palette.sub, fontFamily: fonts.body }]}>
                {savedError}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void loadSavedReplies()}
                style={({ pressed }) => [
                  styles.retry,
                  { backgroundColor: palette.tint, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text
                  style={[styles.retryText, { color: palette.blue, fontFamily: fonts.semibold }]}
                >
                  {t("mobileReloadSavedReplies")}
                </Text>
              </Pressable>
            </View>
          ) : savedReplies?.length ? (
            savedReplies.map((reply) => (
              <Pressable
                accessibilityLabel={t("mobileInsertSavedReply", { shortcut: reply.shortcut })}
                accessibilityRole="button"
                key={reply.id}
                onPress={() => {
                  onInsert(reply.body);
                  setSavedOpen(false);
                }}
                style={({ pressed }) => [
                  styles.reply,
                  {
                    backgroundColor: pressed ? palette.tint : palette.wash,
                    borderColor: palette.line,
                  },
                ]}
              >
                <View style={styles.replyHead}>
                  <Text
                    style={[styles.shortcut, { color: palette.blue, fontFamily: fonts.semibold }]}
                  >
                    /{reply.shortcut}
                  </Text>
                  <Icon color={palette.sub} name="next" size={15} />
                </View>
                <Text
                  numberOfLines={4}
                  style={[styles.replyBody, { color: palette.ink, fontFamily: fonts.body }]}
                >
                  {reply.body}
                </Text>
              </Pressable>
            ))
          ) : (
            <View style={styles.empty}>
              <Icon color={palette.sub} name="bookmark" size={22} />
              <Text style={[styles.emptyText, { color: palette.sub, fontFamily: fonts.body }]}>
                {t("mobileSavedRepliesEmpty")}
              </Text>
            </View>
          )}
        </ScrollView>
      </Sheet>

      <Sheet
        onClose={() => {
          if (!noteBusy) setNoteOpen(false);
        }}
        palette={palette}
        title={t("mobilePrivateNoteTitle")}
        visible={noteOpen}
      >
        <View style={[styles.privateCallout, { backgroundColor: palette.note }]}>
          <Icon color={palette.noteInk} name="lock" size={15} />
          <Text style={[styles.privateText, { color: palette.noteInk, fontFamily: fonts.body }]}>
            {t("mobilePrivateNoteHelp")}
          </Text>
        </View>
        <View style={styles.noteForm}>
          <TextInput
            accessibilityLabel={t("mobilePrivateNoteTitle")}
            autoFocus
            editable={!noteBusy}
            multiline
            onChangeText={changeNote}
            placeholder={t("mobilePrivateNotePlaceholder")}
            placeholderTextColor={palette.sub}
            style={[
              styles.noteInput,
              {
                backgroundColor: palette.wash,
                borderColor: noteError ? palette.amber : palette.line,
                color: palette.ink,
                fontFamily: fonts.body,
              },
            ]}
            textAlignVertical="top"
            value={noteBody}
          />
          {noteError && (
            <Text accessibilityRole="alert" style={[styles.noteError, { color: palette.amber }]}>
              {noteError}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            disabled={!noteBody.trim() || noteBusy}
            onPress={() => void sendNote()}
            style={({ pressed }) => [
              styles.noteSend,
              {
                backgroundColor: palette.blue,
                opacity: !noteBody.trim() || noteBusy ? 0.42 : pressed ? 0.72 : 1,
              },
            ]}
          >
            <Icon color={palette.onBlue} name="lock" size={15} />
            <Text
              style={[styles.noteSendText, { color: palette.onBlue, fontFamily: fonts.semibold }]}
            >
              {noteBusy ? t("mobileSendingPrivateNote") : t("mobileSendPrivateNote")}
            </Text>
          </Pressable>
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    paddingHorizontal: 2,
    paddingBottom: 8,
  },
  tool: {
    minHeight: 36,
    maxWidth: "100%",
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
  },
  toolText: { flexShrink: 1, fontSize: 12, lineHeight: 16 },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
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
  sheetHead: {
    minHeight: 66,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 20,
    paddingRight: 11,
    paddingTop: 8,
  },
  grabber: {
    position: "absolute",
    left: "50%",
    top: 8,
    width: 36,
    height: 4,
    borderRadius: 2,
    marginLeft: -18,
    opacity: 0.54,
  },
  sheetTitle: { flex: 1, fontSize: 24, lineHeight: 29, letterSpacing: -0.6 },
  help: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, paddingBottom: 12 },
  replyList: { gap: 9, paddingHorizontal: 20, paddingBottom: 12 },
  loading: { paddingVertical: 28 },
  reply: {
    borderRadius: Platform.OS === "android" ? 12 : 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
  },
  replyHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  shortcut: { flex: 1, fontSize: 13, lineHeight: 17 },
  replyBody: { fontSize: 14, lineHeight: 20 },
  empty: { alignItems: "center", paddingHorizontal: 18, paddingVertical: 30, gap: 9 },
  emptyText: { textAlign: "center", fontSize: 14, lineHeight: 20 },
  errorDetail: { textAlign: "center", fontSize: 12, lineHeight: 17 },
  retry: { minHeight: 38, borderRadius: 19, justifyContent: "center", paddingHorizontal: 16 },
  retryText: { fontSize: 13 },
  privateCallout: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    borderRadius: 14,
    marginHorizontal: 20,
    marginBottom: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  privateText: { flex: 1, fontSize: 13, lineHeight: 18 },
  noteForm: { paddingHorizontal: 20, gap: 9 },
  noteInput: {
    minHeight: 132,
    maxHeight: 240,
    borderRadius: Platform.OS === "android" ? 12 : 16,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 12,
    fontSize: 15,
    lineHeight: 21,
  },
  noteError: { fontSize: 12, lineHeight: 17, fontFamily: fonts.body },
  noteSend: {
    minHeight: 46,
    borderRadius: 23,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  noteSendText: { fontSize: 15 },
});
