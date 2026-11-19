import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../../operator/src/text.ts";
import { SheetCloseButton } from "./common";
import { fonts } from "./fonts";
import type { Palette } from "./theme";

type SheetProps = {
  visible: boolean;
  onClose(): void;
  onDismiss?(): void;
  palette: Palette;
  title?: string;
  children: ReactNode;
  bottomInset?: number;
};

// Message rows can each offer a sheet. Subscribe to native events only while one is on screen.
export function Sheet(props: SheetProps) {
  const [mounted, setMounted] = useState(props.visible);
  if (!mounted && !props.visible) return null;
  if (!mounted) setMounted(true);
  return (
    <SheetPanel
      {...props}
      onDismiss={() => {
        setMounted(false);
        props.onDismiss?.();
      }}
    />
  );
}

function SheetPanel({
  visible,
  onClose,
  onDismiss,
  palette,
  title,
  children,
  bottomInset,
}: SheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [presented, setPresented] = useState(visible);
  const [panelHeight, setPanelHeight] = useState(0);
  const drag = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useRef(false);
  const callbacks = useRef({ onClose, onDismiss });
  callbacks.current = { onClose, onDismiss };

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

  useEffect(() => {
    if (visible && !presented) {
      drag.setValue(0);
      setPresented(true);
      return;
    }
    if (!presented || (!shown && visible)) return;
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: reduceMotion.current ? 0 : visible ? 280 : 190,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) {
        setPresented(false);
        setShown(false);
        if (Platform.OS !== "ios") requestAnimationFrame(() => callbacks.current.onDismiss?.());
      }
    });
    return () => animation.stop();
  }, [visible, presented, shown, progress, drag]);

  const handle = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && g.dy > Math.abs(g.dx),
      onPanResponderMove: (_, gesture) => drag.setValue(Math.max(0, gesture.dy)),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > 54 || gesture.vy > 0.65) callbacks.current.onClose();
        Animated.spring(drag, {
          toValue: 0,
          damping: 28,
          stiffness: 320,
          mass: 1,
          useNativeDriver: true,
        }).start();
      },
      onPanResponderTerminate: () => drag.setValue(0),
    }),
  ).current;
  return (
    <Modal
      transparent
      visible={presented}
      animationType="none"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      onShow={() => setShown(true)}
      onDismiss={() => {
        if (Platform.OS === "ios") callbacks.current.onDismiss?.();
      }}
    >
      <View style={sheet.fill}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim, opacity: progress }]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("mobileDismiss")}
            onPress={onClose}
            style={sheet.fill}
          />
        </Animated.View>
        <KeyboardAvoidingView
          pointerEvents="box-none"
          style={[sheet.container, { paddingTop: insets.top + 8 }]}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Animated.View
            onLayout={(event) => setPanelHeight(event.nativeEvent.layout.height)}
            accessibilityViewIsModal
            onAccessibilityEscape={onClose}
            style={[
              sheet.panel,
              {
                backgroundColor: palette.sheet,
                paddingBottom: Math.max(bottomInset ?? insets.bottom, 14),
                transform: [
                  {
                    translateY: Animated.add(
                      drag,
                      progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [panelHeight || height, 0],
                      }),
                    ),
                  },
                ],
              },
            ]}
          >
            <View {...handle.panHandlers} style={sheet.handleArea}>
              <View style={[sheet.handle, { backgroundColor: palette.sub }]} />
            </View>
            {title && (
              <View style={sheet.heading}>
                <Text accessibilityRole="header" style={[sheet.title, { color: palette.ink }]}>
                  {title}
                </Text>
                <SheetCloseButton onPress={onClose} palette={palette} />
              </View>
            )}
            {children}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const sheet = StyleSheet.create({
  fill: { flex: 1 },
  container: { flex: 1, justifyContent: "flex-end" },
  panel: {
    maxHeight: "98%",
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    overflow: "hidden",
  },
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
