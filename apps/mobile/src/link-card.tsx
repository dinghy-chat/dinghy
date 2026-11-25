import { useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import {
  type LinkCard,
  type LinkPreviewOptions,
  linkHost,
  useLinkPreviewWith,
} from "../../operator/src/link-preview.ts";
import { t } from "../../operator/src/text.ts";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { openMarkdownLink } from "./message-markdown";
import type { Palette } from "./theme";

const THUMBNAIL_PX = 44;

/** The composer's link card, on this app's React. */
export const useLinkPreview = (options: LinkPreviewOptions) =>
  useLinkPreviewWith({ useEffect, useRef, useState }, options);

/**
 * A link's card: a thumbnail, the page's title and the link's hostname. A tap opens the link.
 * `onImageError` reloads the thread once for a thumbnail address that failed, as one expires.
 */
export function LinkCardView({
  link,
  palette,
  onRemove,
  onImageError,
}: {
  link: LinkCard;
  palette: Palette;
  onRemove?: () => void;
  onImageError?: () => void | Promise<void>;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const image = link.image?.url === failedUrl ? null : link.image;
  return (
    <View style={[styles.card, { backgroundColor: palette.wash, borderColor: palette.line }]}>
      <Pressable
        accessibilityRole="link"
        onPress={() => void openMarkdownLink(link.url)}
        style={styles.open}
      >
        {image !== null && (
          <Image
            accessibilityIgnoresInvertColors
            onError={() => {
              setFailedUrl(image.url);
              void onImageError?.();
            }}
            source={{ uri: image.url }}
            style={styles.image}
          />
        )}
        <View style={styles.text}>
          <Text
            numberOfLines={1}
            style={[styles.title, { color: palette.ink, fontFamily: fonts.semibold }]}
          >
            {link.title}
          </Text>
          {/* Cut from the start, so the end of the name, which names the site, stays. */}
          <Text
            ellipsizeMode="head"
            numberOfLines={1}
            style={[styles.host, { color: palette.sub, fontFamily: fonts.body }]}
          >
            {linkHost(link.url)}
          </Text>
        </View>
      </Pressable>
      {onRemove !== undefined && (
        <Pressable
          accessibilityLabel={t("removeLinkPreview")}
          accessibilityRole="button"
          hitSlop={4}
          onPress={onRemove}
          style={styles.remove}
        >
          <Icon color={palette.sub} name="x" size={16} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  open: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, padding: 6, minHeight: 40 },
  image: { width: THUMBNAIL_PX, height: THUMBNAIL_PX, borderRadius: 8 },
  text: { flex: 1, minWidth: 0 },
  title: { fontSize: 14 },
  host: { fontSize: 13 },
  remove: { padding: 8 },
});
