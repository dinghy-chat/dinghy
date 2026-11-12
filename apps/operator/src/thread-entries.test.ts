import { expect, test } from "vitest";
import type { Note } from "./api.ts";
import { entriesOf } from "./thread-entries.ts";
import type { Line } from "./thread-lines.ts";

const line = (id: string, seq: bigint | null): Line => ({
  id,
  seq,
  body: id,
  image: null,
  imageRemoved: false,
  fromVisitor: false,
  authorOperatorId: null,
  authorApiKeyId: null,
  authorName: null,
  status: seq === null ? "sending" : "sent",
  replyTo: null,
  editedAt: null,
  deleted: false,
  via: null,
});

const note = (id: string, seq: string): Note => ({
  id,
  conversationId: "c",
  seq,
  authorKind: "operator",
  authorOperatorId: "o",
  authorName: "Ana",
  body: id,
  createdAt: "2026-11-12T10:00:00.000Z",
});

const order = (lines: Line[], notes: Note[]) =>
  entriesOf(lines, notes).map((entry) => (entry.kind === "note" ? entry.note.id : entry.line.id));

test("notes sit among the messages by their position, before the pending lines", () => {
  const lines = [line("m1", 1n), line("m4", 4n), line("pending", null)];
  const notes = [note("n2", "2"), note("n3", "3"), note("n9", "9")];
  expect(order(lines, notes)).toEqual(["m1", "n2", "n3", "m4", "n9", "pending"]);
});

test("each line keeps its index in the lines, for the meta under a run", () => {
  const entries = entriesOf([line("m1", 1n), line("m3", 3n)], [note("n2", "2")]);
  expect(entries.flatMap((entry) => (entry.kind === "line" ? [entry.index] : []))).toEqual([0, 1]);
});

test("a thread with only notes shows them all", () => {
  expect(order([], [note("n1", "1"), note("n2", "2")])).toEqual(["n1", "n2"]);
});
