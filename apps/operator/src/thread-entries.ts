import type { Note } from "./api.ts";
import type { Line } from "./thread-lines.ts";

/** A thread's rows in order: messages, and the team's notes among them by position. */
export type Entry = { kind: "line"; line: Line; index: number } | { kind: "note"; note: Note };

/** Puts each note before the first message that came after it. Pending lines stay last. */
export function entriesOf(lines: Line[], notes: Note[]): Entry[] {
  const entries: Entry[] = [];
  let next = 0;
  const notesBefore = (seq: bigint | null) => {
    while (next < notes.length) {
      const note = notes[next];
      if (note === undefined || (seq !== null && BigInt(note.seq) > seq)) return;
      entries.push({ kind: "note", note });
      next += 1;
    }
  };
  lines.forEach((line, index) => {
    notesBefore(line.seq);
    entries.push({ kind: "line", line, index });
  });
  notesBefore(null);
  return entries;
}
