import { describe, expect, test } from "vitest";
import { FISH_ANGLES, FISH_CELL, held, LEAP_REST, leapSteps, SURFACE } from "./src/analytics-leap";

const steps = leapSteps();
const center = (step: { y: number }) => step.y + (FISH_CELL - 1) / 2;
const angle = (step: { frame: number }) => FISH_ANGLES[step.frame] ?? Number.NaN;

describe("the Analytics fish leap", () => {
  test("starts and ends with the fish under water and no splash", () => {
    for (const step of [steps[0], steps.at(-1)]) {
      expect(step?.y).toBeGreaterThanOrEqual(SURFACE);
      expect(step?.launch).toBe(0);
      expect(step?.entry).toBe(0);
    }
  });

  test("climbs above the surface and moves in small whole-pixel steps", () => {
    expect(Math.min(...steps.map(center))).toBeLessThan(SURFACE - FISH_CELL / 2);
    steps.slice(1).forEach((step, index) => {
      const last = steps[index];
      if (last === undefined) return;
      expect(Number.isInteger(step.x) && Number.isInteger(step.y)).toBe(true);
      expect(Math.abs(step.x - last.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(step.y - last.y)).toBeLessThanOrEqual(2);
    });
  });

  test("turns its nose from up to down along the arc, through level at the top", () => {
    const angles = steps.map(angle);
    angles.slice(1).forEach((value, index) => {
      expect(value).toBeLessThanOrEqual(angles[index] ?? Number.NaN);
    });
    const top = steps.reduce((best, step) => (step.y < best.y ? step : best));
    expect(Math.abs(angle(top))).toBeLessThanOrEqual(30);
  });

  test("splashes once where it comes out and once where it goes in", () => {
    const launch = steps.findIndex((step) => step.launch > 0);
    const entry = steps.findIndex((step) => step.entry > 0);
    expect(launch).toBeGreaterThan(0);
    expect(entry).toBeGreaterThan(launch);
    expect(angle(steps[launch] ?? { frame: -1 })).toBeGreaterThan(0);
    expect(angle(steps[entry] ?? { frame: -1 })).toBeLessThan(0);
  });

  test("holds a climbing fish clear of the water when motion is reduced", () => {
    const rest = steps.filter((step) => step.at <= LEAP_REST).at(-1);
    expect(rest).toBeDefined();
    if (rest === undefined) return;
    expect(center(rest)).toBeLessThan(SURFACE - FISH_CELL / 2);
    expect(angle(rest)).toBeGreaterThan(0);
  });

  test("holds each value until the next step", () => {
    const range = held(steps, (step) => step.x);
    expect(range.inputRange).toHaveLength(range.outputRange.length);
    expect(range.inputRange[0]).toBe(0);
    expect(range.inputRange.at(-1)).toBe(1);
    range.inputRange.slice(1).forEach((value, index) => {
      expect(value).toBeGreaterThanOrEqual(range.inputRange[index] ?? Number.NaN);
    });
    expect(range.outputRange[0]).toBe(range.outputRange[1]);
  });
});
