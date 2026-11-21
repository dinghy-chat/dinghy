import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { held } from "./src/analytics-leap";
import { MOVEMENTS, movementSteps } from "./src/header-motion";

/** Image pixels per art pixel in each scene's art and patch images. */
const SCALE = { inbox: 5, contacts: 9, visitors: 9, settings: 3 } as const;
const PATCH = {
  inbox: "inbox-boat",
  visitors: "visitors-skiff",
  settings: "settings-nod",
} as const;

const size = (file: string) => {
  const head = readFileSync(join(__dirname, "assets", `${file}.png`));
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
};

describe("the header movements", () => {
  for (const [name, movement] of Object.entries(MOVEMENTS)) {
    test(`${name} is short and occasional, and ends on the still art`, () => {
      const { ms, steps } = movementSteps(movement);
      expect(ms).toBeLessThanOrEqual(6000);
      expect(movement.gap.least).toBeGreaterThanOrEqual(ms);
      expect(steps.at(-1)).toEqual({ at: 1, frame: 0 });
      for (const [index, step] of steps.entries()) {
        expect(step.frame).toBeGreaterThanOrEqual(0);
        expect(step.frame).toBeLessThanOrEqual(movement.frames);
        expect(step.at).toBeGreaterThanOrEqual(steps[index - 1]?.at ?? 0);
      }
      const { inputRange, outputRange } = held(steps, (step) => step.frame);
      expect(outputRange.at(-1)).toBe(0);
      expect(inputRange.every((at, index) => at >= (inputRange[index - 1] ?? 0))).toBe(true);
    });

    test(`${name} has its patch inside its scene`, () => {
      const { grid, rect } = movement;
      expect(rect.x >= 0 && rect.y >= 0).toBe(true);
      expect(rect.x + rect.w).toBeLessThanOrEqual(grid.w);
      expect(rect.y + rect.h).toBeLessThanOrEqual(grid.h);
    });
  }

  for (const theme of ["day", "night"]) {
    test(`the ${theme} patch images match their patches`, () => {
      for (const [name, file] of Object.entries(PATCH)) {
        const { rect, frames } = MOVEMENTS[name as keyof typeof PATCH];
        const scale = SCALE[name as keyof typeof PATCH];
        expect(size(`${file}-${theme}`)).toEqual({ w: rect.w * frames * scale, h: rect.h * scale });
      }
      for (const [name, scene] of Object.entries({
        inbox: "inbox",
        contacts: "contacts",
        visitors: "visitors",
        settings: "settings",
      })) {
        const { grid } = MOVEMENTS[name as keyof typeof SCALE];
        const scale = SCALE[name as keyof typeof SCALE];
        expect(size(`${scene}-${theme}`)).toEqual({ w: grid.w * scale, h: grid.h * scale });
      }
    });
  }
});
