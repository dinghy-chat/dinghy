import { describe, expect, test } from "vitest";
import { closingVelocity, sheetSpring, shouldDismissDrag } from "./src/sheet-motion";

describe("sheet spring", () => {
  test("is critically damped, so a sheet settles without a bounce", () => {
    const ratio = sheetSpring.damping / (2 * Math.sqrt(sheetSpring.stiffness * sheetSpring.mass));
    expect(ratio).toBeGreaterThanOrEqual(1);
    expect(ratio).toBeLessThan(1.01);
  });
});

describe("drag to close", () => {
  test("keeps the sheet open for a short slow drag", () => {
    expect(shouldDismissDrag(40, 0.1, 420)).toBe(false);
  });

  test("closes the sheet for a flick", () => {
    expect(shouldDismissDrag(30, 1.2, 420)).toBe(true);
  });

  test("closes the sheet for a slow drag past a third of it", () => {
    expect(shouldDismissDrag(150, 0, 420)).toBe(true);
  });

  test("keeps the sheet open when the finger ends moving up", () => {
    expect(shouldDismissDrag(200, -0.4, 420)).toBe(false);
  });

  test("caps the distance on a tall sheet", () => {
    expect(shouldDismissDrag(165, 0, 800)).toBe(true);
  });

  test("turns the release speed into open progress per second", () => {
    expect(closingVelocity(0.84, 420)).toBeCloseTo(-2);
    expect(closingVelocity(-0.2, 420)).toBe(0);
    expect(closingVelocity(1, 0)).toBe(0);
  });
});
