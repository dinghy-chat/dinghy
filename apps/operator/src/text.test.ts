import { expect, test } from "vitest";
import { FILE_EXTENSIONS } from "../../../packages/widget/src/compose.ts";
import { t as widgetText } from "../../../packages/widget/src/text.ts";
import { t } from "./text.ts";

test("t fills each {name} in the text", () => {
  expect(t("searchMany", { count: 3 })).toBe("3 conversations match.");
  expect(t("searchNone")).toBe("No conversations match.");
});

test("t shows a value as it is, even with $ patterns or a placeholder in it", () => {
  expect(t("isReplying", { names: "R$$D" })).toBe("R$$D has this conversation open");
  expect(t("isReplying", { names: "{names}" })).toBe("{names} has this conversation open");
});

test("both apps name every type a file may have when they refuse one", () => {
  for (const extension of FILE_EXTENSIONS) {
    expect(t("fileWrongType")).toContain(extension.toUpperCase());
    expect(widgetText("fileWrongType")).toContain(extension.toUpperCase());
  }
});
