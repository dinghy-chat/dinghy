import * as Clipboard from "expo-clipboard";
import { AccessibilityInfo, Linking, Platform, StyleSheet, Text, View } from "react-native";
import {
  type Block,
  isBareLinkText,
  parseMarkdown,
} from "../../../packages/widget/src/markdown.ts";
import { t } from "../../operator/src/text.ts";
import { fonts } from "./fonts";
import type { Palette } from "./theme";
import { displayLink } from "./thread-logic";

type Inline = Extract<Block, { tag: "p" }>["children"][number];
type Marks = { bold: boolean; italic: boolean };

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

export type MarkdownTone = { ink: string; link: string; quoteLine: string; quoteInk: string };
export type MarkdownLink = { href: string; label: string };

function inlineText(parts: Inline[]): string {
  return parts
    .map((part) =>
      typeof part === "string" ? part : part.tag === "code" ? part.text : inlineText(part.children),
    )
    .join("");
}

function collectLinks(parts: Inline[], links: Map<string, MarkdownLink>) {
  for (const part of parts) {
    if (typeof part === "string" || part.tag === "code") continue;
    if (part.tag === "a") {
      if (!links.has(part.href)) {
        links.set(part.href, { href: part.href, label: inlineText(part.children).trim() });
      }
    }
    collectLinks(part.children, links);
  }
}

/** The unique safe links that the shared Markdown parser found in a message. */
export function markdownLinks(source: string): MarkdownLink[] {
  const links = new Map<string, MarkdownLink>();
  for (const block of parseMarkdown(source)) {
    if (block.tag === "pre") continue;
    if (block.tag === "p" || block.tag === "blockquote") collectLinks(block.children, links);
    else for (const item of block.items) collectLinks(item, links);
  }
  return [...links.values()];
}

/** Opens a URL that was already accepted by the shared Markdown parser. */
export function openMarkdownLink(href: string) {
  return Linking.openURL(href).catch(() => {});
}

/**
 * A message's Markdown as native text: the same parser as the widget and the web composer, so a
 * message reads the same everywhere. Links open on a tap and copy on a long press. Text stays text.
 */
export function MessageMarkdown({
  source,
  palette,
  tone,
  size = 16,
  lineHeight = 22,
}: {
  source: string;
  palette: Palette;
  tone: MarkdownTone;
  size?: number;
  lineHeight?: number;
}) {
  const base = { color: tone.ink, fontSize: size, lineHeight, fontFamily: fonts.body };
  const inline = (parts: Inline[], marks: Marks, key: string): React.ReactNode[] =>
    parts.map((part, index) => {
      const id = `${key}.${index}`;
      if (typeof part === "string") return part;
      if (part.tag === "code") {
        return (
          <Text
            key={id}
            style={{ fontFamily: mono, fontSize: size - 2, backgroundColor: palette.codeWash }}
          >
            {` ${part.text} `}
          </Text>
        );
      }
      if (part.tag === "a") {
        const href = part.href;
        const label = isBareLinkText(href, part.children) ? [displayLink(href)] : part.children;
        return (
          <Text
            accessibilityHint={t("mobileLinkHint")}
            accessibilityRole="link"
            key={id}
            onLongPress={() => {
              void Clipboard.setStringAsync(href)
                .then(() => AccessibilityInfo.announceForAccessibility(t("linkCopied")))
                .catch(() => {});
            }}
            onPress={() => void openMarkdownLink(href)}
            style={{ color: tone.link, textDecorationLine: "underline" }}
            suppressHighlighting={false}
          >
            {inline(label, marks, id)}
          </Text>
        );
      }
      const next = part.tag === "strong" ? { ...marks, bold: true } : { ...marks, italic: true };
      return (
        <Text
          key={id}
          style={{
            fontFamily: next.bold ? fonts.bold : fonts.body,
            fontStyle: next.italic ? "italic" : "normal",
          }}
        >
          {inline(part.children, next, id)}
        </Text>
      );
    });
  const plain = { bold: false, italic: false };
  return (
    <View style={markdownStyles.blocks}>
      {parseMarkdown(source).map((block, index) => {
        const key = String(index);
        if (block.tag === "p") {
          return (
            <Text key={key} style={base}>
              {inline(block.children, plain, key)}
            </Text>
          );
        }
        if (block.tag === "blockquote") {
          return (
            <View key={key} style={[markdownStyles.quote, { borderLeftColor: tone.quoteLine }]}>
              <Text style={[base, { color: tone.quoteInk }]}>
                {inline(block.children, plain, key)}
              </Text>
            </View>
          );
        }
        if (block.tag === "pre") {
          return (
            <View key={key} style={[markdownStyles.pre, { backgroundColor: palette.codeWash }]}>
              <Text
                selectable
                style={{
                  color: tone.ink,
                  fontFamily: mono,
                  fontSize: size - 3,
                  lineHeight: lineHeight - 4,
                }}
              >
                {block.text}
              </Text>
            </View>
          );
        }
        return (
          <View key={key} style={markdownStyles.list}>
            {block.items.map((item, itemIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: List items have no ids, and they never move.
              <View key={itemIndex} style={markdownStyles.item}>
                <Text style={[base, markdownStyles.marker]}>
                  {block.tag === "ol" ? `${block.start + itemIndex}.` : "•"}
                </Text>
                <Text style={[base, markdownStyles.itemText]}>
                  {inline(item, plain, `${key}.${itemIndex}`)}
                </Text>
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

const markdownStyles = StyleSheet.create({
  blocks: { gap: 8 },
  quote: { borderLeftWidth: 2.5, paddingLeft: 9 },
  pre: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 7 },
  list: { gap: 2 },
  item: { flexDirection: "row", gap: 6 },
  marker: { minWidth: 16 },
  // A bubble sizes to its text, so a list item may shrink but never takes a flex basis of zero.
  itemText: { flexShrink: 1 },
});
