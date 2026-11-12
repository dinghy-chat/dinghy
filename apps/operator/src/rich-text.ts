// The composer edits rich text, and messages and drafts stay in the small Markdown that
// packages/widget/src/markdown.ts reads. This writes the editor's content as that Markdown.
import type { JSONContent } from "@tiptap/react";
import { BARE_LINK, parseMarkdown, SAFE_LINK } from "../../../packages/widget/src/markdown.ts";

type Mark = NonNullable<JSONContent["marks"]>[number];

/** A run of text and the formats on it, with a line break as "\n". */
interface Run {
  text: string;
  marks: Mark[];
}

const hasMark = (run: Run, type: string) => run.marks.some((mark) => mark.type === type);
const hrefOf = (run: Run): string | undefined => {
  const href = run.marks.find((mark) => mark.type === "link")?.attrs?.href;
  return typeof href === "string" ? href : undefined;
};

/**
 * Puts marks around text, with its spaces outside them: the parser reads `**bold **` as stars,
 * as Markdown does.
 */
function around(text: string, open: string, close: string): string {
  const [, lead = "", core = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];
  return core === "" ? text : `${lead}${open}${core}${close}${trail}`;
}

/** Whether the parser reads the whole address as a link with no brackets. */
function isBareLink(href: string): boolean {
  BARE_LINK.lastIndex = 0;
  return BARE_LINK.exec(href)?.[0] === href;
}

/** Bold or italic: a group of the runs with the mark, between `mark`s. */
const emphasis = (type: string, mark: string) => ({
  group: (run: Run) => (hasMark(run, type) ? mark : undefined),
  wrap: (text: string) => around(text, mark, mark),
});

/**
 * Each level groups the runs that share one format and wraps the group once: a link outside,
 * then bold, then italic. Text that is bold and italic at once becomes `***text***`.
 */
const LEVELS: { group(run: Run): string | undefined; wrap(text: string, group: string): string }[] =
  [
    {
      group: hrefOf,
      wrap: (text, href) =>
        text.trim() === href && isBareLink(href) ? text : around(text, "[", `](${href})`),
    },
    emphasis("bold", "**"),
    emphasis("italic", "*"),
  ];

function inline(runs: Run[], level = 0): string {
  const step = LEVELS[level];
  if (step === undefined) {
    return runs
      .map((run) => (hasMark(run, "code") ? around(run.text, "`", "`") : run.text))
      .join("");
  }
  let out = "";
  for (let at = 0; at < runs.length; ) {
    const group = step.group(runs[at] as Run);
    let end = at + 1;
    while (end < runs.length && step.group(runs[end] as Run) === group) end += 1;
    const text = inline(runs.slice(at, end), level + 1);
    out += group === undefined ? text : step.wrap(text, group);
    at = end;
  }
  return out;
}

const runsOf = (node: JSONContent): Run[] =>
  (node.content ?? []).map((child) => ({
    text: child.type === "hardBreak" ? "\n" : (child.text ?? ""),
    marks: child.marks ?? [],
  }));

const codeOf = (node: JSONContent) =>
  (node.content ?? []).map((child) => child.text ?? "").join("");

const isList = (node: JSONContent) => node.type === "bulletList" || node.type === "orderedList";

/** A list's items, one line each, as the parser reads only one line for an item. */
function listLines(list: JSONContent): string[] {
  const ordered = list.type === "orderedList";
  const start = Number(list.attrs?.start ?? 1);
  return (list.content ?? []).flatMap((item, index) => {
    const marker = ordered ? `${start + index}.` : "-";
    const children = item.content ?? [];
    const words = children
      .filter((child) => !isList(child))
      // A list item holds one line, so its code block becomes inline code.
      .map((child) => (child.type === "codeBlock" ? around(codeOf(child), "`", "`") : block(child)))
      .map((part) => part.replace(/\s*\n\s*/g, " "))
      .join(" ");
    // The parser has no nested lists, so a nested item follows as an item of its own.
    return [`${marker} ${words}`, ...children.filter(isList).flatMap(listLines)];
  });
}

function block(node: JSONContent): string {
  switch (node.type) {
    case "bulletList":
    case "orderedList":
      return listLines(node).join("\n");
    case "codeBlock":
      return `\`\`\`\n${codeOf(node)}\n\`\`\``;
    case "blockquote":
      return (node.content ?? [])
        .map(block)
        .join("\n\n")
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    default:
      return inline(runsOf(node));
  }
}

/** The editor's document as Markdown, with empty paragraphs left out. */
export function toMarkdown(doc: JSONContent): string {
  return (doc.content ?? [])
    .map(block)
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

const FORMATTED_HTML = /<(strong|b|em|i|a|code|pre|ul|ol|blockquote)[\s>]/i;

/**
 * Whether a paste goes in as Markdown: its text has Markdown formatting, and its HTML, if any,
 * has none of its own, as a copy from a code editor holds the marks as plain text.
 */
export const isMarkdownPaste = (text: string, html: string): boolean =>
  !FORMATTED_HTML.test(html) &&
  parseMarkdown(text).some(
    (part) => part.tag !== "p" || part.children.some((child) => typeof child !== "string"),
  );

/**
 * The address for a typed link: https:// in front when it has no scheme, "" to remove the link,
 * or undefined when no message could hold it.
 */
export function linkHref(typed: string): string | undefined {
  const trimmed = typed.trim();
  if (trimmed === "") return "";
  // A scheme, but not the port in "localhost:3000".
  const href = /^[a-z][a-z+.-]*:(?!\d)/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return SAFE_LINK.test(href) ? href : undefined;
}
