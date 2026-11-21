import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { markdownText } from "../../../packages/widget/src/markdown.ts";
import { t } from "../../operator/src/text.ts";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import type { Palette } from "./theme";
import { savedReplyPreview } from "./thread-logic";
import type { SavedReply } from "./types";

/** The saved replies above the composer, opened by `/` or by the Saved tool. A tap inserts one. */
export function SavedReplyList({
  error,
  highlightFirst,
  loading,
  onClose,
  onPick,
  onRetry,
  palette,
  replies,
  total,
}: {
  error: string | null;
  /** While `/` is typed, the first match is the likely pick, as on the web. */
  highlightFirst: boolean;
  loading: boolean;
  onClose(): void;
  onPick(reply: SavedReply): void;
  onRetry(): void;
  palette: Palette;
  replies: SavedReply[];
  /** How many saved replies the team has, to tell "none yet" from "none match". */
  total: number;
}) {
  return (
    <View style={[styles.card, { backgroundColor: palette.sheet, borderColor: palette.line }]}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: palette.sub, fontFamily: fonts.semibold }]}>
          {t("pickerSavedReplies")}
        </Text>
        <Pressable
          accessibilityLabel={t("mobileDismiss")}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onClose}
          style={styles.close}
        >
          <Icon color={palette.sub} name="x" size={16} />
        </Pressable>
      </View>
      <ScrollView keyboardShouldPersistTaps="always" style={styles.scroll}>
        {loading ? (
          <ActivityIndicator color={palette.blue} style={styles.state} />
        ) : error ? (
          <View style={styles.state}>
            <Text style={[styles.note, { color: palette.sub }]}>
              {t("mobileSavedRepliesLoadFailed")} {error}
            </Text>
            <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retry}>
              <Text style={{ color: palette.blue, fontFamily: fonts.semibold, fontSize: 14 }}>
                {t("mobileReloadSavedReplies")}
              </Text>
            </Pressable>
          </View>
        ) : replies.length === 0 ? (
          <Text style={[styles.note, styles.state, { color: palette.sub }]}>
            {total === 0 ? t("mobileSavedRepliesEmpty") : t("pickerNoSavedReplies")}
          </Text>
        ) : (
          replies.map((reply, index) => (
            <Pressable
              accessibilityHint={markdownText(reply.body)}
              accessibilityLabel={t("mobileInsertSavedReply", { shortcut: reply.shortcut })}
              accessibilityRole="button"
              key={reply.id}
              onPress={() => onPick(reply)}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor:
                    pressed || (highlightFirst && index === 0) ? palette.wash : "transparent",
                  borderTopColor: palette.line,
                  borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[styles.shortcut, { color: palette.blue, fontFamily: fonts.semibold }]}
              >
                /{reply.shortcut}
              </Text>
              <Text
                numberOfLines={1}
                style={[styles.preview, { color: palette.sub, fontFamily: fonts.body }]}
              >
                {savedReplyPreview(reply)}
              </Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowColor: "#0b2239",
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  head: { flexDirection: "row", alignItems: "center", paddingLeft: 14, minHeight: 36 },
  title: { flex: 1, fontSize: 12.5, lineHeight: 16 },
  close: { width: 40, height: 36, alignItems: "center", justifyContent: "center" },
  scroll: { maxHeight: 232 },
  row: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  shortcut: { minWidth: 84, maxWidth: 140, fontSize: 14, lineHeight: 19 },
  preview: { flex: 1, fontSize: 14, lineHeight: 19 },
  state: { paddingHorizontal: 14, paddingVertical: 16 },
  note: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19 },
  retry: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
});
