import { useEffect, useMemo, useRef } from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  Image,
  type ImageSourcePropType,
  StyleSheet,
  View,
} from "react-native";
import { held } from "./analytics-leap";
import { MOVEMENTS, type MovementName, movementSteps, patchBox } from "./header-motion";

export type Occasional = {
  /** One movement runs progress from 0 to 1 over this time. */
  ms: number;
  /** The first movement waits this long after the scene appears or the app comes back. */
  firstMs: number;
  gap: { least: number; more: number };
  /** The progress a still scene holds, with Reduce Motion on. */
  still?: number;
};

/**
 * Runs a header movement now and then. It holds still with Reduce Motion on and while the app is
 * not in front. Every frame runs on the native driver: JavaScript only starts each movement.
 */
export function useOccasional(progress: Animated.Value, motion: Occasional) {
  useEffect(() => {
    let alive = true;
    let reduce: boolean | null = null;
    let active = AppState.currentState === "active";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let run: Animated.CompositeAnimation | undefined;
    const start = () => {
      progress.setValue(0);
      run = Animated.timing(progress, {
        toValue: 1,
        duration: motion.ms,
        easing: Easing.linear,
        useNativeDriver: true,
      });
      run.start(({ finished }) => {
        if (finished && alive && reduce === false && active) {
          timer = setTimeout(start, motion.gap.least + Math.random() * motion.gap.more);
        }
      });
    };
    const settle = () => {
      if (!alive || reduce === null) return;
      clearTimeout(timer);
      run?.stop();
      progress.setValue(reduce ? (motion.still ?? 0) : 0);
      if (!reduce && active) timer = setTimeout(start, motion.firstMs);
    };
    const setReduce = (value: boolean) => {
      reduce = value;
      settle();
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce, () => setReduce(false));
    const motionChange = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    const appChange = AppState.addEventListener("change", (state) => {
      if (active === (state === "active")) return;
      active = state === "active";
      settle();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      run?.stop();
      motionChange.remove();
      appChange.remove();
    };
  }, [progress, motion]);
}

const TIMING = Object.fromEntries(
  Object.entries(MOVEMENTS).map(([name, movement]) => {
    const { ms, steps } = movementSteps(movement);
    return [name, { motion: { ms, firstMs: movement.firstMs, gap: movement.gap }, steps }];
  }),
) as Record<MovementName, { motion: Occasional; steps: ReturnType<typeof movementSteps>["steps"] }>;

/**
 * A header movement from header-motion.ts, placed over its scene's art in a parent the art fills.
 * `source` holds the patch frames side by side, or is a color for a one-color patch.
 */
export function MovingPatch({
  name,
  source,
}: {
  name: MovementName;
  source: ImageSourcePropType | string;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const movement = MOVEMENTS[name];
  const { motion, steps } = TIMING[name];
  useOccasional(progress, motion);
  const frames = useMemo(
    () =>
      Array.from({ length: movement.frames }, (_, index) => ({
        frame: index + 1,
        opacity: progress.interpolate(held(steps, (step) => (step.frame === index + 1 ? 1 : 0))),
      })),
    [progress, movement.frames, steps],
  );
  return (
    <View pointerEvents="none" style={[styles.patch, patchBox(movement)]}>
      {frames.map(({ frame, opacity }) => (
        <Animated.View key={frame} style={[styles.frame, { opacity }]}>
          {typeof source === "string" ? (
            <View style={[styles.frame, { backgroundColor: source }]} />
          ) : (
            <Image
              accessible={false}
              source={source}
              resizeMode="stretch"
              style={[
                styles.strip,
                { width: `${movement.frames * 100}%`, left: `${(1 - frame) * 100}%` },
              ]}
            />
          )}
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  patch: { position: "absolute" },
  frame: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, overflow: "hidden" },
  strip: { position: "absolute", top: 0, height: "100%" },
});
