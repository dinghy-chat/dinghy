// The phone composer edits rich text in react-native-enriched-html, which reads and writes a small
// HTML: one <p> or <li> per line, <br> for an empty line, and <b>, <i>, <code> and <a> inside.
// Drafts and messages stay in the Markdown of packages/widget/src/markdown.ts. This turns one into
// the other through lines of runs. No React Native here, so tests run in Node.

import {
  type Block,
  escapeHtml,
  isBareLink,
  parseMarkdown,
} from "../../../packages/widget/src/markdown.ts";
import { toMarkdown } from "../../operator/src/rich-text.ts";

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

const isBare = (href: string, children: Inline[]) =>
  children.length === 1 && children[0] === href && isBareLink(href);

function runsOf(parts: Inline[], marks: Omit<Run, "text"> = {}): Run[] {
  return parts.flatMap((part): Run[] => {
    if (typeof part === "string") return [{ ...marks, text: part }];
    if (part.tag === "code") return [{ ...marks, code: true, text: part.text }];
    // A bare link stays text, as the editor finds links in text itself.
    if (part.tag === "a" && !isBare(part.href, part.children)) {
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

/** A Markdown draft as the editor's HTML, with an empty line between blocks as in the Markdown. */
export function draftHtml(markdown: string): string {
  if (markdown.trim() === "") return "";
  return `<html>${parseMarkdown(markdown).map(blockHtml).join("<br>")}</html>`;
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
      const href = hrefs.at(-1);
      if (href !== undefined && !isBare(href, [run.text])) run.href = href;
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

const isEmpty = (line: Line) => line.runs.every((run) => run.text.trim() === "");

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

function linesMarkdown(lines: Line[]): string {
  const out: string[] = [];
  let number = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as Line;
    const previous = lines[index - 1];
    // Blocks of different kinds need an empty line between them to stay apart.
    if (previous && previous.container !== line.container && !isEmpty(previous) && !isEmpty(line)) {
      out.push("");
    }
    if (line.container !== "ol" || previous?.container !== "ol") number = 0;
    const words = inlineMarkdown(line.runs);
    switch (line.container) {
      case "code": {
        const code: string[] = [];
        for (; lines[index]?.container === "code"; index += 1) {
          code.push((lines[index] as Line).runs.map((run) => run.text).join(""));
        }
        index -= 1;
        out.push("```", ...code, "```");
        break;
      }
      case "ul":
        out.push(`- ${words}`);
        break;
      case "ol":
        number += 1;
        out.push(`${number}. ${words}`);
        break;
      case "quote":
        out.push(words === "" ? ">" : `> ${words}`);
        break;
      default:
        out.push(words);
    }
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The editor's text as offsets count it: its lines joined by line breaks. */
const plainOf = (lines: Line[]) =>
  lines.map((line) => line.runs.map((run) => run.text).join("")).join("\n");

/** The editor's HTML as a Markdown draft, and its text as the editor counts it. */
export function draftMarkdown(html: string): { markdown: string; text: string } {
  const lines = linesOf(html);
  return { markdown: linesMarkdown(lines), text: plainOf(lines) };
}

/**
 * The editor's HTML again from its own Markdown, when its text holds Markdown marks that would
 * format it, as pasted `**words**` do. Null when the Markdown reads back the same.
 */
export function formattedHtml(html: string): string | null {
  const shape = (lines: Line[]) =>
    JSON.stringify(
      lines
        .map((line) => ({ ...line, runs: merged(line.runs) }))
        .filter((line, index, all) => !isEmpty(line) || (index > 0 && index < all.length - 1)),
    );
  const lines = linesOf(html);
  const next = draftHtml(linesMarkdown(lines));
  return shape(linesOf(next)) === shape(lines) ? null : next;
}

/**
 * Where the caret goes after the editor's text changed from `before` to `after` around it: after
 * the new words, before the text they both end with.
 */
export function caretAfter(before: string, after: string): number {
  let same = 0;
  const most = Math.min(before.length, after.length);
  while (same < most && before[before.length - 1 - same] === after[after.length - 1 - same])
    same += 1;
  return after.length - same;
}

const SAVED = "";

/**
 * The editor's HTML with a saved reply in place of the text from `from` to `to`, and the caret
 * after it. The reply's own formats come with it. With no place, the reply goes at the end, on a
 * line of its own.
 */
export function insertSaved(
  html: string,
  body: string,
  place: { from: number; to: number } | null,
): { html: string; caret: number } {
  const lines = linesOf(html);
  let at = 0;
  let placed = false;
  for (const line of place === null ? [] : lines) {
    const runs: Run[] = [];
    for (const run of line.runs) {
      const start = at;
      at += run.text.length;
      const from = Math.max((place?.from ?? 0) - start, 0);
      const to = Math.min((place?.to ?? 0) - start, run.text.length);
      if (placed || from > run.text.length || to < 0) {
        runs.push(run);
        continue;
      }
      runs.push(
        { ...run, text: run.text.slice(0, from) },
        { text: SAVED },
        { ...run, text: run.text.slice(to) },
      );
      placed = true;
    }
    if (!placed && at === place?.from) {
      runs.push({ text: SAVED });
      placed = true;
    }
    line.runs = merged(runs);
    at += 1;
  }
  const markdown = linesMarkdown(lines);
  const marked = placed
    ? markdown.replace(SAVED, body + SAVED)
    : `${markdown}${markdown === "" ? "" : "\n"}${body}${SAVED}`;
  const { text } = draftMarkdown(draftHtml(marked));
  const caret = text.indexOf(SAVED);
  return { html: draftHtml(marked.replace(SAVED, "")), caret: caret < 0 ? text.length : caret };
}
