import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** Whether the phone asks for less motion, kept current while the screen is open. */
export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduce(value);
    });
    const change = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      alive = false;
      change.remove();
    };
  }, []);
  return reduce;
}
