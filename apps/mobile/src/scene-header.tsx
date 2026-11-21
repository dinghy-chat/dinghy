import type { ReactNode } from "react";
import {
  Image,
  type ImageSourcePropType,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { fonts } from "./fonts";
import { BLINK_COLOR } from "./header-motion";
import { MovingPatch } from "./scene-motion";
import { night, type Palette } from "./theme";

// Each scene is drawn by scripts/render-header-scenes.ts from the web app's pixel sprites.
const SCENES = {
  contacts: {
    day: require("../assets/contacts-day.png") as ImageSourcePropType,
    night: require("../assets/contacts-night.png") as ImageSourcePropType,
    /** The gull blinks: its eye takes the white of its head for a moment. */
    moving: { day: BLINK_COLOR, night: BLINK_COLOR },
  },
  visitors: {
    day: require("../assets/visitors-day.png") as ImageSourcePropType,
    night: require("../assets/visitors-night.png") as ImageSourcePropType,
    /** The near skiff drifts: the patch frames come from the same script. */
    moving: {
      day: require("../assets/visitors-skiff-day.png") as ImageSourcePropType,
      night: require("../assets/visitors-skiff-night.png") as ImageSourcePropType,
    },
  },
};

/**
 * A tab's large title over its pixel scene, the same size and type as the Analytics header. The
 * sky continues above it when the page bounces, and behind the status bar (App.tsx).
 */
export function SceneHeader({
  scene,
  title,
  subtitle,
  palette,
}: {
  scene: keyof typeof SCENES;
  title: string;
  subtitle: ReactNode;
  palette: Palette;
}) {
  const largeText = useWindowDimensions().fontScale > 1.35;
  const sky = palette.analyticsSky;
  const mode = palette === night ? "night" : "day";
  return (
    <View style={[styles.header, largeText && styles.largeHeader, { backgroundColor: sky }]}>
      <View pointerEvents="none" style={[styles.bounce, { backgroundColor: sky }]} />
      <View pointerEvents="none" style={styles.art}>
        <Image accessible={false} source={SCENES[scene][mode]} style={styles.image} />
        <MovingPatch name={scene} source={SCENES[scene].moving[mode]} />
      </View>
      <Text accessibilityRole="header" style={[styles.title, { color: palette.coverInk }]}>
        {title}
      </Text>
      {subtitle !== null && (
        <Text
          style={[styles.subtitle, largeText && styles.wideSubtitle, { color: palette.coverSub }]}
        >
          {subtitle}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { height: 150, overflow: "visible", paddingStart: 20, paddingTop: 20 },
  largeHeader: { height: "auto", paddingEnd: 20, paddingBottom: 150 },
  wideSubtitle: { maxWidth: "100%" },
  bounce: { position: "absolute", left: 0, right: 0, top: -600, height: 600 },
  // 480 × 150 pt, anchored right, drawn at 3× so the pixels stay square on every width.
  art: { position: "absolute", right: 0, bottom: 0, width: 480, height: 150 },
  image: { width: "100%", height: "100%" },
  title: { fontFamily: fonts.displayBold, fontSize: 34, lineHeight: 38, letterSpacing: -0.6 },
  subtitle: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, marginTop: 2, maxWidth: 190 },
});
