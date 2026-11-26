// The phone composer edits rich text in react-native-enriched-html, which reads and writes a small
// HTML: one <p> or <li> per line, <br> for an empty line, and <b>, <i>, <code> and <a> inside.
// Drafts and messages stay in the Markdown of packages/widget/src/markdown.ts. This turns one into
// the other through lines of runs. No React Native here, so tests run in Node.

import {
  type Block,
  escapeHtml,
  FENCE,
  isBareLinkText,
  parseMarkdown,
} from "../../../packages/widget/src/markdown.ts";
import { linkHref, toMarkdown } from "../../operator/src/rich-text.ts";

type Inline = Extract<Block, { tag: "p" }>["children"][number];

/** Text and the formats on it. */
type Run = { text: string; bold?: true; italic?: true; code?: true; href?: string };
type Container = "p" | "ul" | "ol" | "quote" | "code";
/** One line of the editor. An empty line has no runs. */
type Line = { container: Container; runs: Run[] };

const sameMarks = (a: Run, b: Run) =>
  a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.href === b.href;

/** Runs with no empty text and no two neighbours with the same formats. */
function merged(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.text === "") continue;
    const last = out.at(-1);
    if (last && sameMarks(last, run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

// Markdown to the editor's HTML

function runsOf(parts: Inline[], marks: Omit<Run, "text"> = {}): Run[] {
  return parts.flatMap((part): Run[] => {
    if (typeof part === "string") return [{ ...marks, text: part }];
    if (part.tag === "code") return [{ ...marks, code: true, text: part.text }];
    // A bare link stays text, as the editor finds links in text itself.
    if (part.tag === "a" && !isBareLinkText(part.href, part.children)) {
      return runsOf(part.children, { ...marks, href: part.href });
    }
    if (part.tag === "a") return runsOf(part.children, marks);
    return runsOf(part.children, { ...marks, [part.tag === "strong" ? "bold" : "italic"]: true });
  });
}

/** Runs cut at their line breaks. */
function splitLines(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]];
  for (const run of runs) {
    run.text.split("\n").forEach((text, index) => {
      if (index > 0) lines.push([]);
      lines.at(-1)?.push({ ...run, text });
    });
  }
  return lines.map(merged);
}

function runHtml(run: Run): string {
  let html = escapeHtml(run.text);
  if (run.code) html = `<code>${html}</code>`;
  if (run.italic) html = `<i>${html}</i>`;
  if (run.bold) html = `<b>${html}</b>`;
  if (run.href) html = `<a href="${escapeHtml(run.href)}">${html}</a>`;
  return html;
}

const lineHtml = (runs: Run[], tag = "p") =>
  runs.length === 0 && tag === "p" ? "<br>" : `<${tag}>${runs.map(runHtml).join("")}</${tag}>`;

function blockHtml(block: Block): string {
  switch (block.tag) {
    case "p":
      return splitLines(runsOf(block.children))
        .map((runs) => lineHtml(runs))
        .join("");
    case "blockquote":
      return `<blockquote>${splitLines(runsOf(block.children))
        .map((runs) => lineHtml(runs))
        .join("")}</blockquote>`;
    case "pre":
      return `<codeblock>${block.text
        .split("\n")
        .map((text) => lineHtml(text === "" ? [] : [{ text }]))
        .join("")}</codeblock>`;
    default:
      // A list item holds one line.
      return `<${block.tag}>${block.items
        .map((item) =>
          lineHtml(
            merged(runsOf(item).map((run) => ({ ...run, text: run.text.replace(/\n/g, " ") }))),
            "li",
          ),
        )
        .join("")}</${block.tag}>`;
  }
}

/** A Markdown draft as the editor's HTML. */
export function draftHtml(markdown: string): string {
  if (markdown.trim() === "") return "";
  const blocks = parseMarkdown(markdown);
  // Two blocks of one kind in a row need the empty line between them to stay apart.
  const html = blocks.map(
    (block, index) => (blocks[index - 1]?.tag === block.tag ? "<br>" : "") + blockHtml(block),
  );
  return `<html>${html.join("")}</html>`;
}

// The editor's HTML to Markdown

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decode = (text: string) =>
  text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
    const code =
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  });

const TOKEN = /<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/gi;
const MARK_TAGS: Record<string, keyof Omit<Run, "text" | "href">> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  code: "code",
};
const LINE_TAGS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);
const CONTAINERS: Record<string, Container> = {
  ul: "ul",
  ol: "ol",
  blockquote: "quote",
  codeblock: "code",
};

/** The editor's lines. Underline, strikethrough, headings, mentions and images keep only their text. */
function linesOf(html: string): Line[] {
  const lines: Line[] = [];
  let container: Container = "p";
  let line: Run[] | null = null;
  const counts: Record<string, number> = {};
  const hrefs: string[] = [];
  const endLine = () => {
    if (line !== null) lines.push({ container, runs: merged(line) });
    line = null;
  };
  // The editor writes a line break around its tags for reading, and a line is never a break.
  for (const token of html.replace(/[\r\n]/g, "").matchAll(TOKEN)) {
    const [, closing, rawTag = "", attributes = "", text] = token;
    if (text !== undefined) {
      const run: Run = { text: decode(text) };
      for (const [tag, mark] of Object.entries(MARK_TAGS)) if (counts[tag]) run[mark] = true;
      // A pasted link with no scheme, such as "example.com", gets one, or the message shows its
      // Markdown, as the message only links a web or email address.
      const href = linkHref(hrefs.at(-1) ?? "");
      if (href && !isBareLinkText(href, [run.text])) run.href = href;
      line ??= [];
      line.push(run);
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (tag in MARK_TAGS) {
      counts[tag] = (counts[tag] ?? 0) + (closing ? -1 : 1);
    } else if (tag === "a") {
      if (closing) hrefs.pop();
      else hrefs.push(decode(/href\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? ""));
    } else if (LINE_TAGS.has(tag)) {
      endLine();
      if (!closing) line = [];
    } else if (tag in CONTAINERS) {
      endLine();
      container = closing ? "p" : (CONTAINERS[tag] as Container);
    } else if (tag === "br") {
      if (line === null) lines.push({ container, runs: [] });
      else line.push({ text: "\n" });
    }
  }
  endLine();
  return lines;
}

/** One line's formats in Markdown, by the web composer's rules. */
function inlineMarkdown(runs: Run[]): string {
  return toMarkdown({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: runs.map((run) => ({
          type: "text",
          text: run.text,
          marks: [
            ...(run.href ? [{ type: "link", attrs: { href: run.href } }] : []),
            ...(run.bold ? [{ type: "bold" }] : []),
            ...(run.italic ? [{ type: "italic" }] : []),
            ...(run.code ? [{ type: "code" }] : []),
          ],
        })),
      },
    ],
  });
}

const runsText = (runs: Run[]) => runs.map((run) => run.text).join("");

/**
 * The lines as Markdown. An empty list item or quote line has no Markdown, so it becomes an empty
 * line, and empty lines in a row become one, except in code.
 */
function linesMarkdown(lines: Line[]): string {
  const out: string[] = [];
  let number = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as Line;
    if (line.container === "code") {
      const code: string[] = [];
      for (; lines[index]?.container === "code"; index += 1) {
        code.push(runsText((lines[index] as Line).runs));
      }
      index -= 1;
      out.push("```", ...code, "```");
      continue;
    }
    number = line.container === "ol" && lines[index - 1]?.container === "ol" ? number + 1 : 1;
    const words = inlineMarkdown(line.runs);
    if (words.trim() === "") {
      if (out.at(-1) !== "") out.push("");
      continue;
    }
    const marker = { p: "", ul: "- ", ol: `${number}. `, quote: "> " }[line.container];
    out.push(marker + words);
  }
  return out.join("\n");
}

/** The character the editor keeps on an empty line of a list, quote or code block. */
const HIDDEN = "\u200B";

/** The editor's text as its selection counts it: its lines, joined by line breaks. */
const plainOf = (lines: Line[]) =>
  lines
    .map((line) => {
      const text = runsText(line.runs);
      return text === "" && line.container !== "p" ? HIDDEN : text;
    })
    .join("\n");

/** An offset in the editor's text as `setSelection` counts it, which skips hidden characters. */
export const visibleOffset = (text: string, at: number) =>
  at - (text.slice(0, at).split(HIDDEN).length - 1);

/** A visible offset, as Android's selection counts it, in the editor's text with hidden characters. */
export function hiddenOffset(text: string, visible: number): number {
  let at = 0;
  for (let seen = 0; at < text.length && seen < visible; at++) if (text[at] !== HIDDEN) seen++;
  return at;
}

/** The editor's HTML as a Markdown draft, and its text as the editor's selection counts it. */
export function draftMarkdown(html: string): { markdown: string; text: string } {
  const lines = linesOf(html);
  return { markdown: linesMarkdown(lines), text: plainOf(lines) };
}

const CARET = "\uE000";
const INLINE = ["bold", "italic", "code"] as const;

export type InlineFormat = (typeof INLINE)[number];

/** The field's new HTML, where its caret goes, and the formats that end just before the caret. */
export type Rewrite = { html: string; caret: number; ended: InlineFormat[] };

/** The formats on the text just before the caret mark that the mark itself does not have. */
function endedAt(lines: Line[]): Rewrite["ended"] {
  for (const line of lines) {
    const index = line.runs.findIndex((run) => run.text.includes(CARET));
    const run = line.runs[index];
    if (run === undefined) continue;
    const before = run.text.startsWith(CARET) ? line.runs[index - 1] : run;
    return INLINE.filter((mark) => before?.[mark] && !run[mark]);
  }
  return [];
}

/**
 * The lines' Markdown with `insert` in place of the text from `from` to `to`, as the editor's HTML,
 * and the caret after `insert`.
 */
function replaced(
  lines: Line[],
  place: { from: number; to: number } | null,
  insert: string,
): Rewrite {
  // With no place, `insert` goes after the last line.
  const { from, to } = place ?? { from: -1, to: -1 };
  let at = 0;
  let placed = false;
  const marked = lines.map((line): Line => {
    const runs: Run[] = [];
    // A bare caret takes the formats of the words around it, so their marks stay whole. Inserted
    // Markdown goes outside them, so its own marks stay whole.
    const place = (run?: Run) => {
      if (!placed) runs.push({ ...(insert === "" ? run : undefined), text: CARET });
      placed = true;
    };
    const hidden = line.runs.length === 0 && line.container !== "p";
    if (from === at || (hidden && from === at + 1)) place(line.runs[0]);
    line.runs.forEach((run, index) => {
      const start = at;
      at += run.text.length;
      if (at <= from || start >= to) {
        // Between two runs, the caret goes on with the formats of the words before it.
        if (start === from) place(line.runs[index - 1] ?? run);
        runs.push(run);
        return;
      }
      runs.push({ ...run, text: run.text.slice(0, Math.max(from - start, 0)) });
      if (from >= start) place(run);
      runs.push({ ...run, text: run.text.slice(Math.max(to - start, 0)) });
    });
    if (at === from) place(line.runs.at(-1));
    at += hidden ? 2 : 1;
    return { ...line, runs: merged(runs) };
  });
  const markdown = linesMarkdown(marked);
  const withCaret = placed
    ? markdown.replace(CARET, () => insert + CARET)
    : markdown + insert + CARET;
  const caretLines = linesOf(draftHtml(withCaret));
  const text = plainOf(caretLines);
  const caret = text.indexOf(CARET);
  return {
    html: draftHtml(withCaret.replace(CARET, "")),
    caret: caret < 0 ? text.length : caret,
    ended: endedAt(caretLines),
  };
}

/** Where a change from `before` to `after` starts and ends in `after`. */
function changed(before: string, after: string): { start: number; end: number } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let same = 0;
  const most = Math.min(before.length, after.length) - start;
  while (same < most && before[before.length - 1 - same] === after[after.length - 1 - same]) same++;
  return { start, end: after.length - same };
}

/**
 * The editor's HTML with the Markdown marks of pasted words, such as `**words**`, shown as their
 * formats, and the caret after the paste. Null when the change from `before` is not a paste or
 * has no marks to format. A typed mark stays text, as the field formats with its buttons.
 */
export function formatPaste(html: string, before: string): Rewrite | null {
  const lines = linesOf(html);
  const text = plainOf(lines);
  const paste = changed(before, text);
  if (paste.end - paste.start < 2) return null;
  // Markdown cannot hold a code line that starts with a fence.
  if (lines.some((line) => line.container === "code" && FENCE.test(runsText(line.runs)))) {
    return null;
  }
  const words = (value: string) => value.replace(/\s/g, "").replaceAll(HIDDEN, "");
  // Formats only take marks away, so a text that would not get shorter has none.
  const next = words(plainOf(linesOf(draftHtml(linesMarkdown(lines)))));
  if (next.length >= words(text).length) return null;
  return replaced(lines, { from: paste.end, to: paste.end }, "");
}

/**
 * The editor's HTML with a saved reply in place of the text from `from` to `to`, and the caret
 * after it. The reply's own formats come with it. With no place, the reply goes after the text,
 * on a line of its own when the text has words already.
 */
export function insertSaved(
  html: string,
  body: string,
  place: { from: number; to: number } | null,
): Rewrite {
  const lines = linesOf(html);
  if (place !== null) return replaced(lines, place, body);
  const empty = plainOf(lines).replaceAll(HIDDEN, "").trim() === "";
  return replaced(lines, null, empty ? body : `\n${body}`);
}
