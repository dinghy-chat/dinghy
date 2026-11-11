// The composer's formatting: each one changes the text around the selection into the Markdown that
// messages use, and says what to select after.

/** The new text, and the selection in it. */
export interface Edit {
  value: string;
  start: number;
  end: number;
}

/** Wraps the selection in a mark such as `**`, or takes the mark away when it is already there. */
export function wrap(value: string, start: number, end: number, mark: string): Edit {
  const before = value.slice(start - mark.length, start);
  const after = value.slice(end, end + mark.length);
  if (before === mark && after === mark) {
    return {
      value:
        value.slice(0, start - mark.length) +
        value.slice(start, end) +
        value.slice(end + mark.length),
      start: start - mark.length,
      end: end - mark.length,
    };
  }
  return {
    value: value.slice(0, start) + mark + value.slice(start, end) + mark + value.slice(end),
    start: start + mark.length,
    end: end + mark.length,
  };
}

/** Inline code, or a fenced block for a selection of several lines. */
export function code(value: string, start: number, end: number): Edit {
  const selected = value.slice(start, end);
  if (!selected.includes("\n")) return wrap(value, start, end, "`");
  const fence = "```\n";
  const lead = start === 0 || value[start - 1] === "\n" ? "" : "\n";
  const inserted = `${lead}${fence}${selected}\n\`\`\``;
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    start: start + lead.length + fence.length,
    end: start + lead.length + fence.length + selected.length,
  };
}

const URL_PLACEHOLDER = "https://";

/** A link with the selection as its words, and the address selected to type over. */
export function link(value: string, start: number, end: number, words: string): Edit {
  const label = value.slice(start, end) || words;
  const inserted = `[${label}](${URL_PLACEHOLDER})`;
  const urlStart = start + label.length + 3;
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    start: urlStart,
    end: urlStart + URL_PLACEHOLDER.length,
  };
}

const LIST_MARK = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/;

/** Makes each selected line an item, or makes items plain lines again when all already are. */
export function list(value: string, start: number, end: number, ordered: boolean): Edit {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end);
  const to = lineEnd < 0 ? value.length : lineEnd;
  const lines = value.slice(from, to).split("\n");
  const marked = (line: string) => (ordered ? /^\s*\d{1,9}[.)]\s/ : /^\s*[-*+]\s/).test(line);
  const changed = lines.every(marked)
    ? lines.map((line) => line.replace(LIST_MARK, "$1"))
    : lines.map(
        (line, index) => `${ordered ? `${index + 1}.` : "-"} ${line.replace(LIST_MARK, "$1")}`,
      );
  const block = changed.join("\n");
  return {
    value: value.slice(0, from) + block + value.slice(to),
    start: from,
    end: from + block.length,
  };
}
