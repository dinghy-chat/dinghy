import { useWindowDimensions } from "react-native";

const LARGE_TEXT_SCALE = 1.35;
const COMPACT_SCREEN_HEIGHT = 440;
const LARGE_TEXT_COMPACT_SCREEN_HEIGHT = 600;

/** Hides a pinned scene when it would leave too little height for the refreshable list. */
export function usePinnedHeaderLayout() {
  const { fontScale, height } = useWindowDimensions();
  const hasLargeText = fontScale > LARGE_TEXT_SCALE;
  const compactHeight = hasLargeText ? LARGE_TEXT_COMPACT_SCREEN_HEIGHT : COMPACT_SCREEN_HEIGHT;
  return { hasLargeText, hideScene: height < compactHeight };
}
