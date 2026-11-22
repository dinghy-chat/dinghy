// Pure numbers behind the shared sheet's motion, kept apart from React Native so tests can run them.
// iOS uses UIKit's own sheet. The spring and the drag rules move the Android panel.

/** Space between the last row of a sheet and the top of the keyboard. */
export const KEYBOARD_GAP = 8;

/**
 * A critically damped spring with a 0.45 second response, close to how UIKit moves sheets:
 * stiffness = (2π / response)², damping = 2 × √stiffness for a mass of 1.
 */
export const sheetSpring = { stiffness: 195, damping: 28, mass: 1 } as const;

/** A closing sheet unmounts once it is within half a percent of its height from the end. */
export const closingRest = { restDisplacementThreshold: 0.005, restSpeedThreshold: 0.1 } as const;

/**
 * Whether a released drag closes the sheet. The drag is projected 180 ms ahead, so a flick
 * closes it and a slow drag must pass a third of the sheet. A drag that ends moving up stays.
 * `velocity` is in points per millisecond, as PanResponder reports it.
 */
export function shouldDismissDrag(distance: number, velocity: number, sheetHeight: number) {
  if (velocity < -0.05) return false;
  const projected = distance + Math.max(0, velocity) * 180;
  return projected > Math.min(Math.max(sheetHeight, 240) / 3, 160);
}

/** The drag's release speed as the open progress changes per second, for the closing spring. */
export function closingVelocity(velocity: number, sheetHeight: number) {
  if (sheetHeight <= 0 || velocity <= 0) return 0;
  return -(velocity * 1000) / sheetHeight;
}
