import { useEffect, useState } from "react";
import { AccessibilityInfo, AppState, Image, StyleSheet, View } from "react-native";
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg";

const inboxDay = require("./assets/inbox-day.png");
const inboxNight = require("./assets/inbox-night.png");
const frameDurationMs = 320;
const logicalPixelSize = 2;
const minimumLogicalHeight = 143;

const FAR = { fill: "#8fc5ff", crest: "#c2e0ff" };
const MIDDLE = { fill: "#2f7dff", crest: "#7fb2ff" };
const NEAR = { fill: "#0f47b4", crest: "#3f75d9" };
const CREAM = "#fff8df";

const patterns = [
  [0, -1, -2, -1, 0, 1, 2, 1],
  [1, 0, -1, -1, 0, 1, 1, 0],
  [0, 1, 2, 1, 0, -1, -2, -1],
] as const;

function swellLine(width: number, level: number, phase: number, layer: number) {
  const pattern = patterns[layer] ?? patterns[0];
  const step = layer === 0 ? 7 : layer === 1 ? 6 : 5;
  let y = level + (pattern[phase % pattern.length] ?? 0);
  let path = `M0 ${y}`;
  let point = 0;
  for (let x = step; x <= width + step; x += step) {
    point += 1;
    y = level + (pattern[(point + phase) % pattern.length] ?? 0);
    path += `H${Math.min(width, x)}V${y}`;
  }
  return path;
}

function wavelets(width: number, top: number, bottom: number, phase: number, layer: number) {
  const count = Math.max(4, Math.ceil(width / 23));
  const span = width + 18;
  return Array.from({ length: count }, (_, index) => {
    const direction = index % 2 === 0 ? 1 : -1;
    const x =
      ((((index * 29 + layer * 17 + direction * phase * (layer + 2)) % span) + span) % span) - 9;
    const y = top + 7 + ((index * 11 + layer * 7) % Math.max(8, bottom - top - 10));
    const length = 4 + ((index + layer) % 3) * 3;
    // biome-ignore lint/suspicious/noArrayIndexKey: each wavelet has one stable, stateless slot.
    return <Rect key={`${layer}-${index}`} x={x} y={y} width={length} height={1} />;
  });
}

function Cloud({ x, y, opacity }: { x: number; y: number; opacity: number }) {
  return (
    <G transform={`translate(${x} ${y}) scale(.35)`} fill={CREAM} opacity={opacity}>
      <Rect x={4} y={32} width={112} height={24} rx={12} />
      <Circle cx={32} cy={30} r={18} />
      <Circle cx={58} cy={22} r={22} />
      <Circle cx={86} cy={32} r={16} />
    </G>
  );
}

/** The same sailboat used by the web sign-in scene, reduced onto the harbor's logical grid. */
function Boat({ x, y, frame }: { x: number; y: number; frame: number }) {
  const bob = [0, -1, -1, 0, 1, 1][frame % 6] ?? 0;
  const tilt = [-1, 0, 0, 1, 0, 0][frame % 6] ?? 0;
  return (
    <G transform={`translate(${x} ${y + bob}) rotate(${tilt} 21 18) scale(.307)`}>
      <Path fill={CREAM} d="M65 22C52 37 36 56 24 74H65z" />
      <Path
        d="M65 38C56 49 47 60 39 72M65 56C60 62 56 68 52 73"
        fill="none"
        stroke="#0b2239"
        strokeOpacity={0.14}
        strokeWidth={1.5}
      />
      <Path fill="#e5352b" d="M73 12C98 28 116 52 121 74H73z" />
      <Path
        d="M73 32C88 42 100 56 106 73M73 52C82 58 88 66 92 73"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.32}
        strokeWidth={1.5}
      />
      <Rect fill="#0b2239" x={67} y={4} width={5} height={84} rx={2} />
      <Rect fill="#0b2239" x={70} y={74} width={54} height={3.5} rx={1.7} />
      <Circle fill="#ffd9b3" cx={46} cy={76} r={5.5} />
      <Path fill="#0b2239" d="M40 75a6 6 0 0 1 12 0z" />
      <Rect fill="#1f6bff" x={42} y={80} width={8} height={7} rx={2} />
      <Path
        fill="#0b2239"
        d="M8 85C40 90 100 90 132 80 127 101 110 114 88 114H50C30 114 15 103 8 85z"
      />
      <Path fill={CREAM} d="M8 85C40 90 100 90 132 80L130.5 85C100 95 40 95 9.5 90z" />
      <Circle fill={CREAM} cx={58} cy={100} r={3.5} />
      <Circle fill={CREAM} cx={74} cy={100} r={3.5} />
      <Circle fill={CREAM} cx={90} cy={99} r={3.5} />
      <Path fill="#1f6bff" d="M72 5 90 10 72 15z" />
    </G>
  );
}

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
    const timer = setInterval(() => setFrame((value) => (value + 1) % 24), frameDurationMs);
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

  const logicalWidth = Math.max(1, Math.round(size.width / logicalPixelSize));
  const logicalHeight = Math.max(minimumLogicalHeight, Math.round(size.height / logicalPixelSize));
  const farLevel = logicalHeight - 78;
  const middleLevel = logicalHeight - 48;
  const nearLevel = logicalHeight - 21;
  const phases = [frame, Math.floor(frame / 2) + 2, frame + 5];
  const farLine = swellLine(logicalWidth, farLevel, phases[0] ?? 0, 0);
  const middleLine = swellLine(logicalWidth, middleLevel, phases[1] ?? 0, 1);
  const nearLine = swellLine(logicalWidth, nearLevel, phases[2] ?? 0, 2);
  const boatX = Math.max(6, Math.round(logicalWidth * 0.16 - 21));
  const boatY = middleLevel - 35;
  const cloudOpacity = night ? 0.12 : 1;

  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={[styles.scene, { backgroundColor: night ? "#0d2036" : "#ffe27a" }]}
      onLayout={({ nativeEvent: { layout } }) => {
        if (layout.width !== size.width || layout.height !== size.height) {
          setSize({ width: layout.width, height: layout.height });
        }
      }}
    >
      {size.width > 0 && size.height > 0 ? (
        <Svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${logicalWidth} ${logicalHeight}`}
          preserveAspectRatio="xMidYMax meet"
        >
          <Rect width={logicalWidth} height={logicalHeight} fill={night ? "#0d2036" : "#ffe27a"} />
          <Cloud x={logicalWidth - 52} y={15} opacity={cloudOpacity} />
          <Cloud x={Math.round(logicalWidth * 0.52)} y={38} opacity={cloudOpacity} />

          <Path fill={FAR.fill} d={`${farLine}V${logicalHeight}H0Z`} />
          <Path fill="none" stroke={FAR.crest} strokeWidth={1} d={farLine} />
          <G fill={FAR.crest} opacity={0.62}>
            {wavelets(logicalWidth, farLevel, middleLevel, frame, 0)}
          </G>

          <Path fill={MIDDLE.fill} d={`${middleLine}V${logicalHeight}H0Z`} />
          <Path fill="none" stroke={MIDDLE.crest} strokeWidth={1} d={middleLine} />
          <G fill={MIDDLE.crest} opacity={0.62}>
            {wavelets(logicalWidth, middleLevel, nearLevel, frame, 1)}
          </G>

          <Ellipse
            cx={boatX + 21}
            cy={middleLevel + 3}
            rx={18}
            ry={2}
            fill="#0b2239"
            opacity={0.22}
          />
          <Boat x={boatX} y={boatY} frame={frame} />

          <Path fill={NEAR.fill} d={`${nearLine}V${logicalHeight}H0Z`} />
          <Path fill="none" stroke={NEAR.crest} strokeWidth={1} d={nearLine} />
          <G fill={NEAR.crest} opacity={0.62}>
            {wavelets(logicalWidth, nearLevel, logicalHeight - 1, frame, 2)}
          </G>
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scene: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  inbox: { position: "absolute", width: "100%", height: "100%" },
});
