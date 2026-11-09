import { expect, test } from "vitest";
import { t } from "./text.ts";

test("t fills each {name} in the text", () => {
  expect(t("searchMany", { count: 3 })).toBe("3 conversations match.");
  expect(t("searchNone")).toBe("No conversations match.");
});
