import * as Crypto from "expo-crypto";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  EnrichedTextInput,
  type EnrichedTextInputInstance,
  type OnChangeStateEvent,
} from "react-native-enriched-html";
import { markdownText } from "../../../packages/widget/src/markdown.ts";
import { type LinkPreview, previewCard } from "../../operator/src/link-preview.ts";
import { t } from "../../operator/src/text.ts";
import type { ReplyDraft } from "../outbox";
import { ApiError, type DinghyApi } from "./api";
import { usePhotoComposer } from "./attachments";
import { readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { LinkCardView, useLinkPreview } from "./link-card";
import {
  draftHtml,
  draftMarkdown,
  formatPaste,
  hiddenOffset,
  type InlineFormat,
  insertSaved,
  visibleOffset,
} from "./rich-draft";
import { SavedReplyList } from "./saved-reply-list";
import type { Palette } from "./theme";
import { matchSavedReplies, typedSlash } from "./thread-logic";
import type { Message, SavedReply } from "./types";
import { useReduceMotion } from "./use-reduce-motion";

type Mode = "reply" | "note";

type ComposerProps = {
  api: DinghyApi;
  bottomInset: number;
  conversationId: string;
  initialDraft: ReplyDraft;
  inputRef: RefObject<EnrichedTextInputInstance | null>;
  keyboardVisible: boolean;
  /** The visitor's name, for the placeholder and the reply chip. */
  name: string;
  palette: Palette;
  replyingTo: Message | null;
  onCancelReply(): void;
  onDraftChange(draft: ReplyDraft): void;
  onError(error: unknown): void;
  onNoteAdded(): void;
  onPhotoSent(): void;
  onSend(body: string, replyToMessageId: string | null, preview: LinkPreview | null): Promise<void>;
};

type IconName = Parameters<typeof Icon>[0]["name"];

type Selection = { start: number; end: number };

/** Turns a format on or off at the selection, or for the next words typed. */
const TOGGLE: Record<InlineFormat, (input: EnrichedTextInputInstance) => void> = {
  bold: (input) => input.toggleBold(),
  italic: (input) => input.toggleItalic(),
  code: (input) => input.toggleInlineCode(),
};

/**
 * The formats of the web composer, in the web's order: the styles that show each one as on, and
 * what it does. Code over several lines is a code block, as on the web.
 */
const FORMATS: {
  label: Parameters<typeof t>[0];
  icon: IconName;
  styles: ("bold" | "italic" | "inlineCode" | "codeBlock" | "unorderedList" | "orderedList")[];
  apply(input: EnrichedTextInputInstance, block: boolean): void;
}[] = [
  { label: "formatBold", icon: "bold", styles: ["bold"], apply: TOGGLE.bold },
  { label: "formatItalic", icon: "italic", styles: ["italic"], apply: TOGGLE.italic },
  {
    label: "formatCode",
    icon: "code",
    styles: ["inlineCode", "codeBlock"],
    apply: (input, block) => (block ? input.toggleCodeBlock() : TOGGLE.code(input)),
  },
  {
    label: "formatBulleted",
    icon: "bulletList",
    styles: ["unorderedList"],
    apply: (input) => input.toggleUnorderedList(),
  },
  {
    label: "formatNumbered",
    icon: "numberList",
    styles: ["orderedList"],
    apply: (input) => input.toggleOrderedList(),
  },
];

/**
 * The thread's composer: a chevron and a field. The chevron opens a row of labelled tools above the
 * field, Photo, Saved replies and Formatting, and closes it again. The row opens in place: the
 * keyboard, the field and its selection stay as they were. The field shows formats, not Markdown,
 * as the web composer does, and pasted Markdown turns into its formats. Formatting turns the row
 * into Bold, Italic, Code and the two lists. The draft stays Markdown. While the field has focus,
 * the Reply or Note switch sits above it, and `/` lists the saved replies as on the web. A note has
 * no photo, so its row leaves Photo out.
 *
 * A reply and a note keep separate drafts, so switching to Reply never turns note text into a message
 * the visitor receives. The reply draft is saved on the phone and sent through the outbox. A note
 * goes straight to the server and keeps its clientId until its text changes, so a retry after a lost
 * answer adds one note, not two.
 */
export function ThreadComposer({
  api,
  bottomInset,
  conversationId,
  initialDraft,
  inputRef,
  keyboardVisible,
  name,
  palette,
  replyingTo,
  onCancelReply,
  onDraftChange,
  onError,
  onNoteAdded,
  onPhotoSent,
  onSend,
}: ComposerProps) {
  const [mode, setMode] = useState<Mode>("reply");
  const [replyDraft, setReplyDraft] = useState(initialDraft.body);
  const [removedLinks, setRemovedLinks] = useState(initialDraft.removedLinks);
  const [noteDraft, setNoteDraft] = useState("");
  const [focused, setFocused] = useState(false);
  // The field's text as it shows it, without Markdown marks. Its selection counts in this text.
  const [initialHtml] = useState(() => draftHtml(initialDraft.body));
  const [fieldText, setFieldText] = useState(() => draftMarkdown(initialHtml).text);
  const [selection, setSelection] = useState<Selection>({
    start: fieldText.length,
    end: fieldText.length,
  });
  const [styleState, setStyleState] = useState<OnChangeStateEvent | null>(null);
  const field = useRef({ html: initialHtml, text: fieldText, mode: "reply" as Mode });
  const drafts = useRef({ reply: initialDraft.body, note: "" });
  const [toolsOpen, setToolsOpen] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [sending, setSending] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteClientId = useRef<string | null>(null);
  const [savedReplies, setSavedReplies] = useState<SavedReply[] | null>(null);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [savedToolOpen, setSavedToolOpen] = useState(false);
  // Where the operator closed the `/` list. It stays closed until that slash is gone.
  const [dismissedSlash, setDismissedSlash] = useState<number | null>(null);

  const { fontScale } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const chevronProgress = useRef(new Animated.Value(0)).current;
  const isNote = mode === "note";
  const text = isNote ? noteDraft : replyDraft;
  const caret = selection.end;
  // A `/` in code is a path, not a saved reply.
  const inCode =
    styleState?.inlineCode.isActive === true || styleState?.codeBlock.isActive === true;
  const typed = inCode ? null : typedSlash(fieldText, Math.min(caret, fieldText.length));
  const slashOpen = typed !== null && typed.from !== dismissedSlash;
  const listOpen = savedToolOpen || slashOpen;
  const showTools = focused || isNote || savedToolOpen || toolsOpen;
  const busy = isNote ? noteBusy : sending;
  const canSend = text.trim() !== "" && !busy;
  const firstName = name.split(" ")[0] || name;

  useEffect(() => {
    const transition = Animated.timing(chevronProgress, {
      toValue: toolsOpen ? 1 : 0,
      duration: reduceMotion ? 0 : 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    transition.start();
    return () => transition.stop();
  }, [chevronProgress, toolsOpen, reduceMotion]);
  // The chevron points up to open the row and down to close it.
  const chevronTurn = chevronProgress.interpolate({
    inputRange: [0, 1],
    outputRange: ["180deg", "0deg"],
  });

  const slashGone = typed === null;
  useEffect(() => {
    if (slashGone) setDismissedSlash(null);
  }, [slashGone]);
  // A swipe or a menu Reply quotes a message, and only a reply can quote, so it leaves note mode.
  const quotedId = replyingTo?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs when a new message is quoted.
  useEffect(() => {
    if (quotedId !== null) switchMode("reply");
  }, [quotedId]);

  const loadSavedReplies = async () => {
    setSavedLoading(true);
    setSavedError(null);
    try {
      const answer = await api.savedReplies();
      setSavedReplies(answer.savedReplies);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onError(failure);
      else setSavedError(readableError(failure));
    } finally {
      setSavedLoading(false);
    }
  };
  const wantsSavedReplies = listOpen && savedReplies === null && !savedLoading && !savedError;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Loads once, when the list first opens.
  useEffect(() => {
    if (wantsSavedReplies) void loadSavedReplies();
  }, [wantsSavedReplies]);

  const linkPreview = useLinkPreview({
    ask: (url) => api.linkPreview(conversationId, url),
    draft: replyDraft,
    isActive: !isNote,
    removedLinks,
    setRemovedLinks: (links) => {
      setRemovedLinks(links);
      onDraftChange({ body: replyDraft, removedLinks: links });
    },
  });

  const photo = usePhotoComposer({
    api,
    bottomInset,
    conversationId,
    replyToMessageId: replyingTo?.id,
    onError,
    onSent: onPhotoSent,
    palette,
  });

  const changeText = (body: string) => {
    const same = body.trim() === drafts.current[field.current.mode].trim();
    drafts.current[field.current.mode] = body;
    // Spaces at the ends, as the field writes them back after a mode switch, are not a new text.
    if (same) return;
    if (field.current.mode === "note") {
      setNoteDraft(body);
      setNoteError(null);
      // Changed text is a new note. It must not reuse a failed request's idempotency key.
      noteClientId.current = null;
      return;
    }
    setReplyDraft(body);
    onDraftChange({ body, removedLinks });
  };

  /**
   * Puts new HTML in the field, with the caret at `caret` or at the end, and returns its Markdown.
   * The formats that `ended` before the caret stay off for the next words typed, as on the web.
   */
  const showHtml = (html: string, caret?: number, ended: InlineFormat[] = []) => {
    const next = draftMarkdown(html);
    field.current.html = html;
    field.current.text = next.text;
    setFieldText(next.text);
    const at = caret ?? next.text.length;
    setSelection({ start: at, end: at });
    inputRef.current?.setValue(html);
    const visible = visibleOffset(next.text, at);
    const input = inputRef.current;
    input?.setSelection(visible, visible);
    if (input) for (const format of ended) TOGGLE[format](input);
    return next.markdown;
  };

  const changeHtml = (html: string) => {
    if (html === field.current.html) return;
    const before = field.current.text;
    const next = draftMarkdown(html);
    field.current.html = html;
    field.current.text = next.text;
    setFieldText(next.text);
    // Pasted Markdown shows as its formats, as on the web.
    const formatted = formatPaste(html, before);
    changeText(
      formatted ? showHtml(formatted.html, formatted.caret, formatted.ended) : next.markdown,
    );
  };

  const switchMode = (next: Mode) => {
    if (next === field.current.mode) return;
    setMode(next);
    field.current.mode = next;
    setSavedToolOpen(false);
    showHtml(draftHtml(drafts.current[next]));
    if (next === "note") AccessibilityInfo.announceForAccessibility(t("mobileNoteModeHint"));
  };

  /** Empties the field after a send, unless the operator wrote more or switched mode meanwhile. */
  const clearSent = (sent: Mode, body: string) => {
    if (drafts.current[sent].trim() !== body) return;
    drafts.current[sent] = "";
    if (sent === "note") setNoteDraft("");
    else setReplyDraft("");
    if (field.current.mode !== sent) return;
    showHtml("");
    // iOS skips the height update while the keyboard holds marked text, which left an empty field
    // six lines tall. The second empty value runs after the text is unmarked.
    requestAnimationFrame(() => {
      if (field.current.mode === sent && field.current.text === "") inputRef.current?.setValue("");
    });
  };

  const pickSaved = (reply: SavedReply) => {
    const place = slashOpen && typed ? { from: typed.from, to: typed.to } : null;
    const next = insertSaved(field.current.html, reply.body, place);
    changeText(showHtml(next.html, next.caret, next.ended));
    setSavedToolOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /** Opens or closes the row in place. The row slides in, unless the phone asks for less motion. */
  const toggleTools = (open = !toolsOpen) => {
    if (open) setFormatting(false);
    if (!reduceMotion) {
      LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"));
    }
    setToolsOpen(open);
  };

  const showFormats = (show: boolean) => {
    if (!reduceMotion) {
      LayoutAnimation.configureNext(LayoutAnimation.create(160, "easeInEaseOut", "opacity"));
    }
    setFormatting(show);
  };

  /** One format on the selection, or on the next words typed when nothing is selected. */
  const applyFormat = (format: (typeof FORMATS)[number]) => {
    const input = inputRef.current;
    if (!input) return;
    const lines = fieldText.slice(selection.start, selection.end).includes("\n");
    format.apply(input, lines || styleState?.codeBlock.isActive === true);
    input.focus();
  };

  const pickPhoto = () => {
    // The system picker covers the screen, so the keyboard goes first and the row closes.
    inputRef.current?.blur();
    toggleTools(false);
    photo.pick();
  };

  const toggleSavedReplies = () => {
    // Give the expanded list room above large accessibility text.
    if (!savedToolOpen && fontScale >= 2) inputRef.current?.blur();
    setSavedToolOpen((open) => !open);
  };

  const sendReply = async () => {
    const body = replyDraft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body, replyingTo?.id ?? null, linkPreview.card);
      clearSent("reply", body);
      onCancelReply();
    } catch {
      // The parent shows the storage error. Keep the draft so the operator can try again.
    } finally {
      setSending(false);
    }
  };

  const sendNote = async () => {
    const body = noteDraft.trim();
    if (!body || noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    const clientId = noteClientId.current ?? Crypto.randomUUID();
    noteClientId.current = clientId;
    try {
      await api.note(conversationId, clientId, body);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onError(failure);
      else setNoteError(readableError(failure));
      return;
    } finally {
      setNoteBusy(false);
    }
    noteClientId.current = null;
    clearSent("note", body);
    onNoteAdded();
  };

  const allReplies = [...(savedReplies ?? [])].sort((a, b) => a.shortcut.localeCompare(b.shortcut));
  const shown = slashOpen && typed ? matchSavedReplies(allReplies, typed.word) : allReplies;
  const ink = isNote ? palette.noteInk : palette.ink;

  return (
    <View
      style={[
        styles.composer,
        {
          backgroundColor: isNote ? palette.note : palette.paper,
          borderTopColor: palette.line,
          paddingBottom: keyboardVisible ? 6 : Math.max(bottomInset, 8),
        },
      ]}
    >
      {listOpen && (
        <SavedReplyList
          error={savedError}
          highlightFirst={slashOpen}
          loading={savedLoading && savedReplies === null}
          onClose={() => {
            setSavedToolOpen(false);
            if (typed) setDismissedSlash(typed.from);
          }}
          onPick={pickSaved}
          onRetry={() => void loadSavedReplies()}
          palette={palette}
          replies={shown}
          total={allReplies.length}
        />
      )}
      {replyingTo && !isNote && (
        <View style={[styles.replyChip, { backgroundColor: palette.wash }]}>
          <View style={styles.replyQuote}>
            <Text
              numberOfLines={1}
              style={[styles.replyTitle, { color: palette.blue, fontFamily: fonts.semibold }]}
            >
              {t("replyingTo", {
                name: replyingTo.fromVisitor ? name : (replyingTo.authorName ?? t("aTeammate")),
              })}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.replyText, { color: palette.sub, fontFamily: fonts.body }]}
            >
              {replyingTo.body
                ? markdownText(replyingTo.body)
                : t(replyingTo.kind === "image" ? "quoteImage" : "mobileAttachment")}
            </Text>
          </View>
          <Pressable
            accessibilityLabel={t("cancelReply")}
            accessibilityRole="button"
            hitSlop={4}
            onPress={onCancelReply}
            style={styles.replyClose}
          >
            <Icon color={palette.sub} name="x" size={16} />
          </Pressable>
        </View>
      )}
      {linkPreview.card !== null && (
        <LinkCardView
          link={previewCard(linkPreview.card)}
          onRemove={linkPreview.remove}
          palette={palette}
        />
      )}
      {showTools && (
        <View style={styles.tools}>
          <View
            accessibilityRole="radiogroup"
            style={[styles.segment, { backgroundColor: isNote ? palette.warm : palette.wash }]}
          >
            {(["reply", "note"] as const).map((option) => {
              const selected = option === mode;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  hitSlop={{ top: 7, bottom: 7 }}
                  key={option}
                  onPress={() => switchMode(option)}
                  style={[
                    styles.segmentItem,
                    selected && {
                      backgroundColor: option === "note" ? palette.note : palette.paper,
                    },
                    selected && styles.segmentOn,
                  ]}
                >
                  {option === "note" && (
                    <Icon color={selected ? palette.noteInk : palette.sub} name="lock" size={12} />
                  )}
                  <Text
                    style={[
                      styles.segmentText,
                      {
                        color: selected
                          ? option === "note"
                            ? palette.noteInk
                            : palette.ink
                          : palette.sub,
                        fontFamily: fonts.semibold,
                      },
                    ]}
                  >
                    {option === "note" ? t("mobileNoteMode") : t("mobileReplyMode")}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {isNote && (
            <Text
              numberOfLines={1}
              style={[styles.noteHint, { color: palette.noteInk, fontFamily: fonts.medium }]}
            >
              {t("mobileNoteModeHint")}
            </Text>
          )}
        </View>
      )}
      {isNote && noteError && (
        <Text accessibilityRole="alert" style={[styles.noteError, { color: palette.noteInk }]}>
          {noteError}
        </Text>
      )}
      <View>
        {toolsOpen && (
          <View style={styles.toolRow}>
            {formatting ? (
              <>
                <ToolButton
                  icon="back"
                  label={t("mobileComposerToolsBack")}
                  onPress={() => showFormats(false)}
                  palette={palette}
                />
                {FORMATS.map((format) => (
                  <ToolButton
                    icon={format.icon}
                    key={format.label}
                    label={t(format.label)}
                    on={format.styles.some((style) => styleState?.[style].isActive === true)}
                    onPress={() => applyFormat(format)}
                    palette={palette}
                  />
                ))}
              </>
            ) : (
              <>
                {!isNote && (
                  <ToolButton
                    icon="image"
                    label={t("mobilePhotoTool")}
                    onPress={pickPhoto}
                    palette={palette}
                    shown
                  />
                )}
                <ToolButton
                  expanded={listOpen}
                  icon="savedReply"
                  label={t("mobileUseSavedReply")}
                  onPress={toggleSavedReplies}
                  palette={palette}
                  shown
                />
                <ToolButton
                  icon="format"
                  label={t("formatTools")}
                  onPress={() => showFormats(true)}
                  palette={palette}
                  shown
                />
              </>
            )}
          </View>
        )}
        <View style={styles.row}>
          <Pressable
            accessibilityLabel={t("mobileComposerTools")}
            accessibilityRole="button"
            accessibilityState={{ expanded: toolsOpen }}
            hitSlop={{ top: 4, bottom: 4, left: 6 }}
            onPress={() => toggleTools()}
            style={({ pressed }) => [styles.chevron, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Animated.View style={{ transform: [{ rotate: chevronTurn }] }}>
              <Icon color={isNote ? palette.noteInk : palette.ink} name="down" size={22} />
            </Animated.View>
          </Pressable>
          <EnrichedTextInput
            accessibilityLabel={isNote ? t("mobilePrivateNoteTitle") : t("mobileReplyTo", { name })}
            defaultValue={initialHtml}
            htmlStyle={{
              a: { color: palette.blue, textDecorationLine: "underline" },
              blockquote: { borderColor: palette.line, color: palette.sub },
              code: { color: ink, backgroundColor: isNote ? palette.warm : palette.wash },
              codeblock: {
                color: ink,
                backgroundColor: isNote ? palette.warm : palette.wash,
                borderRadius: 8,
              },
              ol: { markerColor: ink },
              ul: { bulletColor: ink },
            }}
            // The editor would link "example.com" with no scheme, which the message shows as
            // Markdown. The message links web addresses itself.
            linkRegex={null}
            onBlur={() => setFocused(false)}
            onChangeHtml={(event) => changeHtml(event.nativeEvent.value)}
            onChangeSelection={({ nativeEvent: { start, end } }) => {
              // iOS counts the hidden character of an empty list line, and Android does not.
              const at = (offset: number) =>
                Platform.OS === "android" ? hiddenOffset(field.current.text, offset) : offset;
              setSelection({ start: at(start), end: at(end) });
            }}
            onChangeState={(event) => setStyleState(event.nativeEvent)}
            onFocus={() => setFocused(true)}
            placeholder={
              isNote
                ? t("mobilePrivateNotePlaceholder")
                : t("mobileReplyPlaceholder", { name: firstName })
            }
            placeholderTextColor={isNote ? palette.noteInk : palette.sub}
            ref={inputRef}
            style={{
              ...styles.input,
              backgroundColor: isNote ? palette.note : palette.paper,
              borderColor: isNote ? palette.noteInk : palette.line,
              color: ink,
              fontFamily: fonts.body,
            }}
          />
          {text.trim() !== "" && (
            <Pressable
              accessibilityLabel={isNote ? t("mobileSendNote") : t("mobileSendReply")}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend, busy }}
              disabled={!canSend}
              hitSlop={3}
              onPress={() => void (isNote ? sendNote() : sendReply())}
              style={({ pressed }) => [
                styles.round,
                {
                  backgroundColor: isNote ? palette.noteInk : palette.blue,
                  opacity: !canSend ? 0.5 : pressed ? 0.75 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={isNote ? palette.note : palette.onBlue} size="small" />
              ) : (
                <Icon
                  color={isNote ? palette.note : palette.onBlue}
                  name={isNote ? "check" : "send"}
                  size={19}
                />
              )}
            </Pressable>
          )}
        </View>
      </View>
      {photo.sheet}
    </View>
  );
}

/**
 * A button of the tools row. With `shown`, its name shows next to its icon. A format button shows
 * only its icon, and its name is for VoiceOver. An open list or a format that is `on` at the caret
 * shows as lit.
 */
function ToolButton({
  expanded,
  icon,
  label,
  on,
  onPress,
  palette,
  shown = false,
}: {
  expanded?: boolean;
  icon: IconName;
  label: string;
  on?: boolean;
  onPress(): void;
  palette: Palette;
  shown?: boolean;
}) {
  const lit = on ?? expanded ?? false;
  const color = lit ? palette.blue : palette.ink;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole={on === undefined ? "button" : "togglebutton"}
      accessibilityState={
        on !== undefined ? { checked: on } : expanded === undefined ? undefined : { expanded }
      }
      hitSlop={{ top: 4, bottom: 4 }}
      onPress={onPress}
      style={({ pressed }) => [
        shown ? styles.tool : styles.iconTool,
        { backgroundColor: lit || pressed ? palette.tint : palette.wash },
      ]}
    >
      <Icon color={color} name={icon} size={17} />
      {shown && (
        <Text style={[styles.toolText, { color, fontFamily: fonts.semibold }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  composer: {
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  round: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    minHeight: 38,
    // Six lines of 21 pt, then the field scrolls.
    maxHeight: 6 * 21 + 17,
    borderRadius: 19,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 16,
    lineHeight: 21,
  },
  tools: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36 },
  segment: { flexDirection: "row", borderRadius: 999, padding: 3 },
  segmentItem: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  segmentOn: {
    shadowColor: "#0b2239",
    shadowOpacity: 0.15,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentText: { fontSize: 13, lineHeight: 17 },
  noteHint: { flex: 1, fontSize: 13, lineHeight: 17, marginLeft: 4 },
  // A bare chevron, as wide as the field is tall, so it lines up with a one-line field.
  chevron: { width: 30, height: 38, alignItems: "center", justifyContent: "center" },
  // The row wraps at large text and on narrow phones, so every name stays whole.
  toolRow: {
    paddingBottom: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tool: {
    flexShrink: 1,
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 11,
    paddingRight: 14,
    borderRadius: 999,
  },
  iconTool: {
    minWidth: 44,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  toolText: { flexShrink: 1, fontSize: 13.5, lineHeight: 18 },
  noteError: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  replyChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 14,
    paddingLeft: 12,
    paddingRight: 2,
    paddingVertical: 4,
  },
  replyQuote: { flex: 1, minWidth: 0, paddingVertical: 3 },
  replyTitle: { fontSize: 12.5, lineHeight: 16 },
  replyText: { fontSize: 13, lineHeight: 17 },
  replyClose: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
