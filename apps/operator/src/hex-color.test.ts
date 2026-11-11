import { describe, expect, test } from "vitest";
import { hexColor } from "./hex-color.ts";

describe("a typed or pasted color", () => {
  test.each([
    ["#7b2723", "#7b2723"],
    ["#7B2723", "#7b2723"],
    ["7b2723", "#7b2723"],
    [" #7b2723 \n", "#7b2723"],
    ["#7b2723;", "#7b2723"],
  ])("reads %j as %s", (text, color) => {
    expect(hexColor(text)).toBe(color);
  });

  test.each(["", "#7b272", "#7b27231", "#7g2723", "red"])("refuses %j", (text) => {
    expect(hexColor(text)).toBeNull();
  });
});
