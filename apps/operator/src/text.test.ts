import { expect, test } from "vitest";
import { t } from "./text.ts";

test("t fills each {name} in the text", () => {
  expect(t("searchMany", { count: 3 })).toBe("3 conversations match.");
  expect(t("searchNone")).toBe("No conversations match.");
});

test("t shows a value as it is, even with $ patterns or a placeholder in it", () => {
  expect(t("isReplying", { names: "R$$D" })).toBe("R$$D is replying");
  expect(t("isReplying", { names: "{names}" })).toBe("{names} is replying");
});
