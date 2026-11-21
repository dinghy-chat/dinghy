// Formatting for the phone composer. The field holds the small Markdown that
// packages/widget/src/markdown.ts reads, so each format edits that text around the selection,
// and the caret or selection comes back on the same words. No React Native here, so tests run in Node.

export type Selection = { start: number; end: number };
export type Edit = { text: string; selection: Selection };
export type InlineFormat = "bold" | "italic" | "code";
export type ListFormat = "bulleted" | "numbered";

const MARK: Record<InlineFormat, string> = { bold: "**", italic: "*", code: "`" };
const WORD = /[\p{L}\p{N}_'’-]/u;
const BULLET = /^(\s*)[-*+]\s+/;
const NUMBER = /^(\s*)\d{1,9}[.)]\s+/;

/** How many `char`s sit just before `at`, and just from `at` on. */
function run(text: string, at: number, char: string, forward: boolean): number {
  let count = 0;
  while (text[forward ? at + count : at - count - 1] === char) count += 1;
  return count;
}

/** Whether the words sit between this format's marks already, as `**words**` or `` `words` ``. */
function wrappedIn(text: string, from: number, to: number, format: InlineFormat): boolean {
  if (format === "code") return text[from - 1] === "`" && text[to] === "`";
  const before = run(text, from, "*", false);
  const after = run(text, to, "*", true);
  // `***both***` is bold around italic, so either format can come off it.
  if (format === "bold") return before >= 2 && after >= 2;
  return before % 2 === 1 && after % 2 === 1;
}

/**
 * Bold, italic or code on the selection, or off it when the selection already has it. The marks go
 * inside any spaces at the edges, as the parser reads `** words**` as stars. With only a caret
 * inside a word, the word gets the format. With a caret anywhere else, an empty pair of marks goes
 * in with the caret between, so the next words typed get it, and a second press takes that empty
 * pair out. Code over several lines becomes a fenced block.
 */
export function toggleInline(text: string, selection: Selection, format: InlineFormat): Edit {
  const mark = MARK[format];
  let start = Math.min(selection.start, selection.end);
  let end = Math.max(selection.start, selection.end);

  if (start === end) {
    // A pair this button put in a moment ago, with nothing typed in it yet.
    if (
      text.slice(start - mark.length, start) === mark &&
      text.slice(end, end + mark.length) === mark
    ) {
      const out = text.slice(0, start - mark.length) + text.slice(end + mark.length);
      const at = start - mark.length;
      return { text: out, selection: { start: at, end: at } };
    }
    const inWord = WORD.test(text[start - 1] ?? "") && WORD.test(text[start] ?? "");
    if (!inWord) {
      const out = text.slice(0, start) + mark + mark + text.slice(end);
      const at = start + mark.length;
      return { text: out, selection: { start: at, end: at } };
    }
    while (start > 0 && WORD.test(text[start - 1] ?? "")) start -= 1;
    while (end < text.length && WORD.test(text[end] ?? "")) end += 1;
  }

  // The marks are part of the selection when the operator selected `**words**` whole.
  const selected = text.slice(start, end);
  if (
    selected.length > mark.length * 2 &&
    selected.startsWith(mark) &&
    selected.endsWith(mark) &&
    wrappedIn(text, start + mark.length, end - mark.length, format)
  ) {
    start += mark.length;
    end -= mark.length;
  }

  // Spaces at the edges stay outside the marks.
  while (start < end && /\s/.test(text[start] ?? "")) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
  if (start === end) return { text, selection };

  if (wrappedIn(text, start, end, format)) {
    const out =
      text.slice(0, start - mark.length) + text.slice(start, end) + text.slice(end + mark.length);
    return {
      text: out,
      selection: { start: start - mark.length, end: end - mark.length },
    };
  }

  const core = text.slice(start, end);
  if (format === "code" && core.includes("\n")) {
    const before = start === 0 || text[start - 1] === "\n" ? "" : "\n";
    const after = end === text.length || text[end] === "\n" ? "" : "\n";
    const open = `${before}\`\`\`\n`;
    const out = `${text.slice(0, start)}${open}${core}\n\`\`\`${after}${text.slice(end)}`;
    return { text: out, selection: { start: start + open.length, end: end + open.length } };
  }
  const out = text.slice(0, start) + mark + core + mark + text.slice(end);
  return { text: out, selection: { start: start + mark.length, end: end + mark.length } };
}

/**
 * A bulleted or numbered list over the lines the selection touches. When every line with words is
 * that kind of item already, the list comes off. Otherwise each line becomes an item, and an item of
 * the other kind changes kind. The edited lines stay selected, or the caret stays on its words.
 */
export function toggleList(text: string, selection: Selection, format: ListFormat): Edit {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const from = text.lastIndexOf("\n", start - 1) + 1;
  // A selection that ends at the start of a line does not take that line.
  const lastAt = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const next = text.indexOf("\n", lastAt);
  const to = next < 0 ? text.length : next;
  const lines = text.slice(from, to).split("\n");
  const own = format === "bulleted" ? BULLET : NUMBER;
  const filled = lines.filter((line) => line.trim() !== "");
  const remove = filled.length > 0 && filled.every((line) => own.test(line));

  let number = 0;
  // How the caret moves: the length change of the lines before it and of its own line's marker.
  let shift = 0;
  let lineAt = from;
  const edited = lines.map((line) => {
    const bare = line.replace(BULLET, "$1").replace(NUMBER, "$1");
    let out = bare;
    if (!remove && (line.trim() !== "" || lines.length === 1)) {
      number += 1;
      const [, indent = ""] = /^(\s*)/.exec(bare) ?? [];
      out = `${indent}${format === "bulleted" ? "- " : `${number}. `}${bare.slice(indent.length)}`;
    }
    if (lineAt <= start) shift += out.length - line.length;
    lineAt += line.length + 1;
    return out;
  });

  const block = edited.join("\n");
  const out = text.slice(0, from) + block + text.slice(to);
  if (start === end) {
    // The caret keeps its words, but never lands inside the new marker.
    const caret = Math.max(start + shift, out.lastIndexOf("\n", start + shift - 1) + 1);
    const lineStart = out.lastIndexOf("\n", caret - 1) + 1;
    const marker = (BULLET.exec(out.slice(lineStart)) ?? NUMBER.exec(out.slice(lineStart)))?.[0];
    const at = marker ? Math.max(caret, lineStart + marker.length) : caret;
    return { text: out, selection: { start: at, end: at } };
  }
  return { text: out, selection: { start: from, end: from + block.length } };
}
