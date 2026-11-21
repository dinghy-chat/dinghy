import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../../operator/src/text.ts";
import { fonts } from "./fonts";
import type { Palette } from "./theme";
import { menuPlacement, type Rect } from "./thread-logic";

export type MenuItem = {
  label: string;
  icon(color: string): ReactNode;
  /** Why the item cannot run now. The item shows, greyed, with this under its label. */
  disabled?: string | undefined;
  danger?: boolean;
  /** Items of the second group follow a thicker divider: the actions that change the message. */
  group?: 0 | 1;
  run(): void;
};

const MENU_WIDTH = 248;
const ROW = 46;
const ROW_WITH_REASON = 60;
const DIVIDER = 7;

/** Runs the chosen item once the menu has gone, so it may open a sheet of its own. */
function runAfterClose(afterClose: { current: (() => void) | null }) {
  const next = afterClose.current;
  afterClose.current = null;
  if (next) requestAnimationFrame(next);
}

const estimatedHeight = (items: MenuItem[]) =>
  items.reduce((sum, item) => sum + (item.disabled ? ROW_WITH_REASON : ROW), 0) +
  (items.some((item) => item.group === 1) && items.some((item) => item.group !== 1) ? DIVIDER : 0);

/**
 * A menu that opens next to what it acts on, over a dimmed screen. With `lift`, a copy of the anchor
 * rises above the dim at its own place, so the operator sees which message the menu is for. A tap
 * outside, the back button or the VoiceOver escape gesture closes it. An item runs once the menu has
 * gone, so it can open a sheet of its own.
 */
export function AnchoredMenu({
  anchor,
  items,
  label,
  lift,
  onClose,
  palette,
  side,
  visible,
}: {
  anchor: Rect | null;
  items: MenuItem[];
  label: string;
  lift?: ReactNode;
  onClose(): void;
  palette: Palette;
  side: "start" | "end";
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const [presented, setPresented] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const afterClose = useRef<(() => void) | null>(null);
  const reduceMotion = useRef(false);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) reduceMotion.current = value;
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      reduceMotion.current = value;
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, [visible]);

  useEffect(() => {
    if (visible && !presented) {
      setMeasured(null);
      setPresented(true);
      return;
    }
    if (!visible && !presented) return;
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: reduceMotion.current ? 0 : visible ? 180 : 140,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!finished || visible) return;
      setPresented(false);
      if (Platform.OS !== "ios") runAfterClose(afterClose);
    });
    return () => animation.stop();
  }, [visible, presented, progress]);

  // The Modal stays mounted once used: iOS calls onDismiss only for a Modal that closes, not one
  // that unmounts, and the chosen item runs from there.
  if (anchor === null) return null;
  const menuHeight = measured ?? estimatedHeight(items);
  const place = menuPlacement(
    anchor,
    { width: MENU_WIDTH, height: menuHeight },
    { width: screen.width, height: screen.height, top: insets.top, bottom: insets.bottom },
    side,
  );
  const tall = place.liftTop !== anchor.y;
  const liftScale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });
  const menuScale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] });
  const select = (item: MenuItem) => {
    if (item.disabled) return;
    afterClose.current = item.run;
    onClose();
  };
  let shownGroup: number | undefined;
  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onDismiss={() => {
        if (Platform.OS === "ios") runAfterClose(afterClose);
      }}
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={presented}
    >
      <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={menuStyles.fill}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim, opacity: progress }]}
        >
          <Pressable
            accessibilityLabel={t("mobileDismiss")}
            accessibilityRole="button"
            onPress={onClose}
            style={menuStyles.fill}
          />
        </Animated.View>
        {lift && (
          <View
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            style={[
              menuStyles.liftClip,
              tall ? { top: insets.top, height: place.liftBottom - insets.top } : menuStyles.noClip,
            ]}
          >
            <Animated.View
              style={[
                menuStyles.lift,
                {
                  left: anchor.x,
                  top: tall ? place.liftTop - insets.top : place.liftTop,
                  width: anchor.width,
                  transform: [{ scale: liftScale }],
                },
              ]}
            >
              {lift}
            </Animated.View>
          </View>
        )}
        <Animated.View
          accessibilityLabel={label}
          accessibilityRole="menu"
          onLayout={(event) => {
            const height = Math.round(event.nativeEvent.layout.height);
            if (height !== menuHeight) setMeasured(height);
          }}
          style={[
            menuStyles.menu,
            {
              top: place.top,
              left: place.left,
              backgroundColor: palette.sheet,
              opacity: progress,
              transform: [{ scale: menuScale }],
              transformOrigin: `${side === "start" ? "left" : "right"} ${place.above ? "bottom" : "top"}`,
            },
          ]}
        >
          {items.map((item, index) => {
            const divider = shownGroup !== undefined && (item.group ?? 0) !== shownGroup;
            shownGroup = item.group ?? 0;
            const color = item.disabled ? palette.sub : item.danger ? palette.danger : palette.ink;
            const last = index === items.length - 1;
            return (
              <View key={item.label}>
                {divider && (
                  <View style={[menuStyles.divider, { backgroundColor: palette.wash }]} />
                )}
                <Pressable
                  accessibilityHint={item.disabled}
                  accessibilityRole="menuitem"
                  accessibilityState={{ disabled: Boolean(item.disabled) }}
                  disabled={Boolean(item.disabled)}
                  onPress={() => select(item)}
                  style={({ pressed }) => [
                    menuStyles.item,
                    {
                      backgroundColor: pressed ? palette.wash : "transparent",
                      borderBottomColor: palette.line,
                      borderBottomWidth:
                        last || items[index + 1]?.group !== item.group
                          ? 0
                          : StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <View style={menuStyles.itemCopy}>
                    <Text style={[menuStyles.itemLabel, { color, fontFamily: fonts.medium }]}>
                      {item.label}
                    </Text>
                    {item.disabled && (
                      <Text
                        style={[menuStyles.reason, { color: palette.sub, fontFamily: fonts.body }]}
                      >
                        {item.disabled}
                      </Text>
                    )}
                  </View>
                  {item.icon(color)}
                </Pressable>
              </View>
            );
          })}
        </Animated.View>
      </View>
    </Modal>
  );
}

const menuStyles = StyleSheet.create({
  fill: { flex: 1 },
  liftClip: { position: "absolute", left: 0, right: 0, overflow: "hidden" },
  noClip: { top: 0, bottom: 0, overflow: "visible" },
  lift: {
    position: "absolute",
    shadowColor: "#000000",
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  menu: {
    position: "absolute",
    width: MENU_WIDTH,
    borderRadius: 16,
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
  divider: { height: DIVIDER },
  item: {
    minHeight: ROW,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  itemCopy: { flex: 1, minWidth: 0 },
  itemLabel: { fontSize: 16.5, lineHeight: 21 },
  reason: { fontSize: 12, lineHeight: 16, marginTop: 1 },
});
