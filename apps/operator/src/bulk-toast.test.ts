import { expect, test } from "vitest";
import { bulkToast } from "./bulk-toast.ts";
import { t } from "./text.ts";

const said = (toast: ReturnType<typeof bulkToast>) =>
  toast.sentences.map((one) => t(one, toast.values)).join(" ");

test("a row that was as asked already does not count as done", () => {
  const toast = bulkToast(["ok", "unchanged", "unchanged"], "close", null);
  expect(said(toast)).toBe("Closed 1 conversation. 2 needed no change.");
  expect(toast.ok).toBe(true);
});

test("rows that all were as asked already say only that", () => {
  expect(said(bulkToast(["unchanged"], "close", null))).toBe("1 needed no change.");
});

test("a failure after a turn went through says what was done before it, and that the rest may not have changed", () => {
  const toast = bulkToast(["ok", "ok", "not_found"], "label", "actionFailed");
  expect(said(toast)).toBe(
    "Labeled 2 conversations. Skipped 1: it was deleted already, or your role does not allow it. That did not work. Check the connection and try again. The rest may not have changed. Reload the page to see which did.",
  );
  expect(toast.ok).toBe(false);
});

test("a failure on the first turn says only the failure", () => {
  expect(said(bulkToast([], "close", "actionFailed"))).toBe(
    "That did not work. Check the connection and try again.",
  );
});
