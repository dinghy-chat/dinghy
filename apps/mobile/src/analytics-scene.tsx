import { useMemo, useRef } from "react";
import { Animated, Image, StyleSheet, View } from "react-native";
import {
  ENTRY_X,
  FISH_CELL,
  held,
  LAUNCH_X,
  LEAP_MS,
  LEAP_REST,
  type LeapStep,
  leapSteps,
  SHEET_H,
  SHEET_W,
  SPLASH_H,
  SPLASH_W,
  SURFACE,
} from "./analytics-leap";
import { type Occasional, useOccasional } from "./scene-motion";

/** One art pixel of the scene is 3 pt, so its pixels stay square on every phone. */
const ART = 3;
const SCENE = {
  day: require("../assets/analytics-day.png"),
  night: require("../assets/analytics-night.png"),
};
const SHEET = require("../assets/analytics-leap.png");
const STEPS = leapSteps();
/**
 * The first leap waits for the screen to settle. The rest come at uneven, unhurried times. With
 * Reduce Motion on, the scene holds the fish mid-leap instead, so it still shows the fish.
 */
const LEAP: Occasional = {
  ms: LEAP_MS,
  firstMs: 1200,
  gap: { least: 7000, more: 6000 },
  still: LEAP_REST,
};

/** The Analytics header picture: sun or moon, the gull, the buoy and a fish that leaps. */
export function AnalyticsScene({ dark }: { dark: boolean }) {
  const progress = useRef(new Animated.Value(0)).current;
  useOccasional(progress, LEAP);
  const motion = useMemo(() => {
    const at = (value: (step: LeapStep) => number) => progress.interpolate(held(STEPS, value));
    return {
      fish: {
        transform: [
          { translateX: at((step) => step.x * ART) },
          { translateY: at((step) => step.y * ART) },
        ],
      },
      fishFrame: { transform: [{ translateX: at((step) => -step.frame * FISH_CELL * ART) }] },
      launch: {
        transform: [
          { translateX: at((step) => -step.launch * SPLASH_W * ART) },
          { translateY: -FISH_CELL * ART },
        ],
      },
      entry: {
        transform: [
          { translateX: at((step) => -step.entry * SPLASH_W * ART) },
          { translateY: -FISH_CELL * ART },
        ],
      },
    };
  }, [progress]);
  return (
    <View pointerEvents="none" style={styles.scene}>
      <Image accessible={false} source={dark ? SCENE.night : SCENE.day} style={styles.art} />
      {/* The sky ends at the water, so the fish rises out of it and sinks back in. */}
      <View style={styles.sky}>
        <Animated.View style={[styles.fish, motion.fish]}>
          <Animated.Image source={SHEET} style={[styles.sheet, motion.fishFrame]} />
        </Animated.View>
      </View>
      <View style={[styles.splash, { left: LAUNCH_X * ART }]}>
        <Animated.Image source={SHEET} style={[styles.sheet, motion.launch]} />
      </View>
      <View style={[styles.splash, { left: ENTRY_X * ART }]}>
        <Animated.Image source={SHEET} style={[styles.sheet, motion.entry]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 480 × 150 pt, anchored right like the other headers, so the scene never scales.
  scene: { position: "absolute", right: 0, bottom: 0, width: 480, height: 150 },
  art: { position: "absolute", left: 0, top: 0, width: 480, height: 150 },
  sky: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 480,
    height: SURFACE * ART,
    overflow: "hidden",
  },
  fish: {
    position: "absolute",
    left: 0,
    top: 0,
    width: FISH_CELL * ART,
    height: FISH_CELL * ART,
    overflow: "hidden",
  },
  splash: {
    position: "absolute",
    top: (SURFACE + 1 - SPLASH_H) * ART,
    width: SPLASH_W * ART,
    height: SPLASH_H * ART,
    overflow: "hidden",
  },
  sheet: { width: SHEET_W * ART, height: SHEET_H * ART },
});
