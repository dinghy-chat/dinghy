import { useEffect, useState } from "react";
import { AccessibilityInfo, AppState, Image, StyleSheet, View } from "react-native";

const day = require("./assets/harbor-day.png");
const nightScene = require("./assets/harbor-night.png");
const inboxDay = require("./assets/inbox-day.png");
const inboxNight = require("./assets/inbox-night.png");
const columns = 6;
const rows = 4;
const frameDurationMs = 400;

export function Harbor({
  night,
  animated,
  paused = false,
}: {
  night: boolean;
  animated: boolean;
  paused?: boolean;
}) {
  const [reduceMotion, setReduceMotion] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [frame, setFrame] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    let subscribed = true;
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    const state = AppState.addEventListener("change", (value) => setForeground(value === "active"));
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (subscribed) setReduceMotion(value);
    });
    return () => {
      subscribed = false;
      motion.remove();
      state.remove();
    };
  }, []);
  useEffect(() => {
    if (!animated || paused || reduceMotion || !foreground) return;
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % (columns * rows)),
      frameDurationMs,
    );
    return () => clearInterval(timer);
  }, [animated, paused, reduceMotion, foreground]);
  if (!animated) {
    return (
      <Image
        accessible={false}
        source={night ? inboxNight : inboxDay}
        resizeMode="stretch"
        style={styles.inbox}
      />
    );
  }
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={styles.scene}
      onLayout={({ nativeEvent: { layout } }) =>
        setSize({ width: layout.width, height: layout.height })
      }
    >
      <Image
        accessible={false}
        source={night ? nightScene : day}
        fadeDuration={0}
        resizeMode="stretch"
        resizeMethod="scale"
        style={{
          position: "absolute",
          width: size.width * columns,
          height: size.height * rows,
          left: -(frame % columns) * size.width,
          top: -Math.floor(frame / columns) * size.height,
        }}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  scene: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  inbox: { position: "absolute", width: "100%", height: "100%" },
});
