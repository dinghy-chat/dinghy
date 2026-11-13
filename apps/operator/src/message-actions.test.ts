import { expect, test } from "vitest";
import { editorAfterSave, lineMenu, quoteOf } from "./message-actions.tsx";
import type { Line } from "./thread-lines.ts";

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

const mine = (kind: "text" | "note"): Line => ({
  id: "m1",
  seq: 5n,
  body: "Hello",
  attachment: null,
  fromVisitor: false,
  kind,
  createdAt: "2026-11-12T10:00:00.000Z",
  authorOperatorId: "me",
  authorApiKeyId: null,
  authorName: "Me",
  status: "sent",
  replyTo: null,
  editedAt: null,
  deleted: false,
  via: null,
  handoff: null,
  mentions: [],
});
const who = { meId: "me", mayDeleteAnyone: false, canWrite: true, canReply: true };
// The visitor read past the line.
const readPast = { readSeq: "9", emails: [] };
const noop = () => {};
const act = { reply: noop, copyText: noop, edit: noop, info: noop, copyLink: noop, remove: noop };
const menuOf = (line: Line) =>
  lineMenu(line, who, readPast, act).map(({ label, unavailable }) => ({ label, unavailable }));

test("a note offers no quote in a reply, and its author edits it after the visitor read past it", () => {
  const items = menuOf(mine("note"));
  expect(items.map((item) => item.label)).toEqual([
    "Copy text",
    "Edit",
    "Info",
    "Copy link",
    "Delete",
  ]);
  expect(items.find((item) => item.label === "Edit")?.unavailable).toBeUndefined();
});

test("a reply the visitor read offers a quote, and no longer an edit", () => {
  const items = menuOf(mine("text"));
  expect(items.map((item) => item.label)).toContain("Reply");
  expect(items.find((item) => item.label === "Edit")?.unavailable).toBe("Already read");
});

test("a file's quote shows its name", () => {
  const file: Line = {
    ...mine("text"),
    body: "",
    kind: "file",
    attachment: {
      type: "file",
      name: "invoice.pdf",
      size: 2048,
      url: "https://chat.example.com/f",
    },
  };
  expect(quoteOf(file, "Me").text).toBe("invoice.pdf");
  const removed: Line = { ...file, attachment: { type: "file", removed: true } };
  expect(quoteOf(removed, "Me").text).toBe("");
});
