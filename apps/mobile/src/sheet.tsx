import { requireNativeView, requireOptionalNativeModule } from "expo";
import { type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Modal,
  type NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../../operator/src/text.ts";
import { SheetCloseButton } from "./common";
import { fonts } from "./fonts";
import {
  closingRest,
  closingVelocity,
  KEYBOARD_GAP,
  sheetSpring,
  shouldDismissDrag,
} from "./sheet-motion";
import { night, type Palette } from "./theme";

type SheetProps = {
  visible: boolean;
  onClose(): void;
  onDismiss?(): void;
  palette: Palette;
  title?: string;
  children: ReactNode;
  /**
   * False while `onClose` would refuse, for example while the sheet saves. On iOS the sheet then
   * resists a drag and calls `onClose` instead of closing.
   */
  dismissible?: boolean;
  /** Android only. An iOS sheet takes its bottom inset from UIKit. */
  bottomInset?: number;
  /** Android only. iOS dims behind a sheet in the system color. */
  scrimColor?: string;
  /** The first child starts at the top edge, under the grabber, for art that fills the sheet. */
  fullBleed?: boolean;
};

// Message rows can each offer a sheet. Subscribe to native events only while one is on screen.
export function Sheet(props: SheetProps) {
  const [mounted, setMounted] = useState(props.visible);
  if (!mounted && !props.visible) return null;
  if (!mounted) setMounted(true);
  const Panel = Platform.OS === "ios" ? NativeSheet : SheetPanel;
  return (
    <Panel
      {...props}
      onDismiss={() => {
        setMounted(false);
        props.onDismiss?.();
      }}
    />
  );
}

function SheetHeading({
  title,
  palette,
  onClose,
}: {
  title: string | undefined;
  palette: Palette;
  onClose(): void;
}) {
  if (!title) return null;
  return (
    <View style={sheet.heading}>
      <Text accessibilityRole="header" style={[sheet.title, { color: palette.ink }]}>
        {title}
      </Text>
      <SheetCloseButton onPress={onClose} palette={palette} />
    </View>
  );
}

type NativeSheetViewProps = ViewProps & {
  dark: boolean;
  onSheetLayout(event: NativeSyntheticEvent<{ maxHeight: number }>): void;
  onKeyboardInset(event: NativeSyntheticEvent<{ availableHeight: number }>): void;
  onWindow(event: NativeSyntheticEvent<{ attached: boolean }>): void;
};

function findNativeSheetView(): ComponentType<NativeSheetViewProps> | null {
  if (Platform.OS !== "ios" || requireOptionalNativeModule("ExpoNativeSheet") === null) return null;
  try {
    return requireNativeView<NativeSheetViewProps>("ExpoNativeSheet", "ExpoNativeSheetView");
  } catch {
    return null;
  }
}

// A dev build from before the module existed still shows a system sheet, at full height.
const NativeSheetView = findNativeSheetView();

/**
 * iOS: a UIKit page sheet. The system runs the presentation, the drag to close, the dimming,
 * the move above the keyboard and Reduce Motion. The native view fits the sheet to its content.
 */
function NativeSheet({
  visible,
  onClose,
  onDismiss,
  palette,
  title,
  children,
  dismissible = true,
  fullBleed = false,
}: SheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // UIKit's tallest sheet, reported by the native view. Until then, a close estimate.
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [keyboardRoom, setKeyboardRoom] = useState(0);
  const offScreen = useRef(false);
  const finished = useRef(false);
  const latest = useRef({ visible, onDismiss });
  latest.current = { visible, onDismiss };

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    latest.current.onDismiss?.();
  };

  // A drag closes the sheet before the parent hides it. React Native then has nothing left to
  // dismiss, so the sheet finishes here rather than waiting for the modal's onDismiss.
  useEffect(() => {
    if (!visible && offScreen.current) finish();
  });

  // UIKit draws the sheet's bottom safe area under the content, so only a phone without a home
  // indicator needs padding of its own. Above the keyboard, the content keeps a small gap.
  const bottomPadding = keyboardRoom > 0 ? KEYBOARD_GAP : Math.max(0, 14 - insets.bottom);
  const style = {
    maxHeight: Math.min(
      maxHeight ?? height - insets.top - insets.bottom - 10,
      keyboardRoom || Infinity,
    ),
    paddingBottom: bottomPadding,
  };
  const body = (
    <>
      {!fullBleed && <View style={sheet.grabberRoom} />}
      <SheetHeading title={title} palette={palette} onClose={onClose} />
      {children}
    </>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={dismissible}
      backdropColor={palette.sheet}
      onRequestClose={onClose}
      onShow={() => {
        offScreen.current = false;
        finished.current = false;
      }}
      onDismiss={finish}
    >
      {NativeSheetView ? (
        // No flex: the view keeps the height of its content even when the sheet is shorter, so
        // the sheet can grow to fit it.
        <NativeSheetView
          dark={palette === night}
          onSheetLayout={(event) => setMaxHeight(event.nativeEvent.maxHeight)}
          onKeyboardInset={(event) => setKeyboardRoom(event.nativeEvent.availableHeight)}
          onWindow={(event) => {
            offScreen.current = !event.nativeEvent.attached;
            if (offScreen.current && !latest.current.visible) finish();
          }}
          onAccessibilityEscape={onClose}
          style={style}
        >
          {body}
        </NativeSheetView>
      ) : (
        <View onAccessibilityEscape={onClose} style={[style, sheet.fill]}>
          {body}
        </View>
      )}
    </Modal>
  );
}

/** Android: a panel the app moves itself, over a dimmed scrim. */
function SheetPanel({
  visible,
  onClose,
  onDismiss,
  palette,
  title,
  children,
  bottomInset,
  scrimColor = palette.scrim,
  fullBleed = false,
}: SheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [presented, setPresented] = useState(visible);
  const [shown, setShown] = useState(false);
  const [panelHeight, setPanelHeight] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const reduceMotion = useRef(false);
  const releaseVelocity = useRef(0);
  const bottomPadding = Math.max(bottomInset ?? insets.bottom, 14);
  const latest = useRef({ onClose, onDismiss, visible, panelHeight });
  latest.current = { onClose, onDismiss, visible, panelHeight };

  useEffect(() => {
    if (!presented) return;
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) reduceMotion.current = value;
    });
    const change = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      reduceMotion.current = value;
    });
    return () => {
      alive = false;
      change.remove();
    };
  }, [presented]);

  const measured = panelHeight > 0;
  useEffect(() => {
    if (visible && !presented) {
      drag.setValue(0);
      setPresented(true);
      return;
    }
    // Start only once the panel has a height, so it rises from its own bottom edge at once.
    if (!presented || (visible && !(shown && measured))) return;
    const velocity = visible ? 0 : releaseVelocity.current;
    releaseVelocity.current = 0;
    const toValue = visible ? 1 : 0;
    const motion = reduceMotion.current
      ? Animated.timing(progress, { toValue, duration: 0, useNativeDriver: true })
      : Animated.spring(progress, {
          toValue,
          velocity,
          ...sheetSpring,
          ...(visible ? {} : closingRest),
          useNativeDriver: true,
        });
    const animation = visible ? Animated.parallel([motion, settle(drag, 0)]) : motion;
    animation.start(({ finished }) => {
      if (finished && !visible) {
        setPresented(false);
        setShown(false);
        requestAnimationFrame(() => latest.current.onDismiss?.());
      }
    });
    return () => animation.stop();
  }, [visible, presented, shown, measured, progress, drag]);

  const handle = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && g.dy > Math.abs(g.dx),
        onPanResponderGrant: () => drag.stopAnimation(),
        // Once the sheet follows the finger, a scroll view must not take the gesture back.
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, gesture) => drag.setValue(Math.max(0, gesture.dy)),
        onPanResponderRelease: (_, gesture) => {
          const sheetHeight = latest.current.panelHeight;
          if (!shouldDismissDrag(Math.max(0, gesture.dy), gesture.vy, sheetHeight)) {
            settle(drag, gesture.vy * 1000, reduceMotion.current).start();
            return;
          }
          // The closing spring starts from the finger's position and speed.
          releaseVelocity.current = closingVelocity(gesture.vy, sheetHeight);
          latest.current.onClose();
          // A parent can keep the sheet open, for example while it saves.
          setTimeout(() => {
            if (!latest.current.visible) return;
            releaseVelocity.current = 0;
            settle(drag, 0, reduceMotion.current).start();
          }, 0);
        },
        onPanResponderTerminate: () => settle(drag, 0, reduceMotion.current).start(),
      }),
    [drag],
  );

  const travel = panelHeight || height;
  const motion = useMemo(
    () => ({
      translateY: Animated.add(
        drag,
        progress.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] }),
      ),
      // The dimming fades as the sheet is dragged down.
      scrim: Animated.multiply(
        progress,
        drag.interpolate({ inputRange: [0, travel], outputRange: [1, 0], extrapolate: "clamp" }),
      ),
    }),
    [drag, progress, travel],
  );

  return (
    <Modal
      transparent
      visible={presented}
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      onShow={() => setShown(true)}
    >
      <View style={sheet.fill}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: scrimColor, opacity: motion.scrim }]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("mobileDismiss")}
            onPress={onClose}
            style={sheet.fill}
          />
        </Animated.View>
        <View pointerEvents="box-none" style={[sheet.container, { paddingTop: insets.top + 8 }]}>
          <Animated.View
            onLayout={(event) => setPanelHeight(event.nativeEvent.layout.height)}
            style={[
              sheet.panel,
              {
                backgroundColor: palette.sheet,
                paddingBottom: bottomPadding,
                transform: [{ translateY: motion.translateY }],
              },
            ]}
          >
            <View {...handle.panHandlers} collapsable={false} style={fullBleed && sheet.overArt}>
              <View style={sheet.handleArea}>
                <View style={[sheet.handle, { backgroundColor: palette.sub }]} />
              </View>
              <SheetHeading title={title} palette={palette} onClose={onClose} />
            </View>
            {children}
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

/** Springs the drag offset back, carrying the finger's speed in points per second. */
function settle(drag: Animated.Value, velocity: number, instant = false) {
  if (instant) return Animated.timing(drag, { toValue: 0, duration: 0, useNativeDriver: true });
  return Animated.spring(drag, { toValue: 0, velocity, ...sheetSpring, useNativeDriver: true });
}

const sheet = StyleSheet.create({
  fill: { flex: 1 },
  // Keeps the title clear of the system grabber.
  grabberRoom: { height: 22 },
  container: { flex: 1, justifyContent: "flex-end" },
  panel: {
    maxHeight: "98%",
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    overflow: "hidden",
  },
  overArt: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 1 },
  handleArea: { height: 22, alignItems: "center", justifyContent: "center" },
  handle: { width: 34, height: 4, borderRadius: 2, opacity: 0.55 },
  heading: {
    paddingLeft: 22,
    paddingRight: 14,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  title: { fontFamily: fonts.display, fontSize: 24, lineHeight: 29, letterSpacing: -0.65, flex: 1 },
});
