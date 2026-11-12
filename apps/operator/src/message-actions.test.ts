import { expect, test } from "vitest";
import { editorAfterSave } from "./message-actions.tsx";

const editing = (draft: string) => ({ id: "m1", draft, problem: null });

test("a saved edit closes the editor that still holds the text it sent", () => {
  expect(editorAfterSave(editing("Hello there "), "m1", "Hello there")).toBeNull();
});

test("text typed while the edit saved keeps the editor open with it", () => {
  const newer = editing("Hello there, again");
  expect(editorAfterSave(newer, "m1", "Hello there")).toBe(newer);
});

test("a save of another line leaves the open editor alone", () => {
  const other = { ...editing("Hello there"), id: "m2" };
  expect(editorAfterSave(other, "m1", "Hello there")).toBe(other);
  expect(editorAfterSave(null, "m1", "Hello there")).toBeNull();
});
