// The composer edits rich text, and messages and drafts stay in the small Markdown that
// packages/widget/src/markdown.ts reads. This writes the editor's content as that Markdown.
import type { JSONContent } from "@tiptap/react";
import { parseMarkdown, SAFE_LINK } from "../../../packages/widget/src/markdown.ts";

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

/**
 * Each level groups the runs that share one format and wraps the group once: a link outside,
 * then bold, then italic. Text that is bold and italic at once becomes `***text***`.
 */
const LEVELS: { key(run: Run): string | undefined; wrap(text: string, key: string): string }[] = [
  {
    key: hrefOf,
    wrap: (text, href) => (text.trim() === href ? text : around(text, "[", `](${href})`)),
  },
  {
    key: (run) => (hasMark(run, "bold") ? "**" : undefined),
    wrap: (text) => around(text, "**", "**"),
  },
  {
    key: (run) => (hasMark(run, "italic") ? "*" : undefined),
    wrap: (text) => around(text, "*", "*"),
  },
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
    const key = step.key(runs[at] as Run);
    let end = at + 1;
    while (end < runs.length && step.key(runs[end] as Run) === key) end += 1;
    const text = inline(runs.slice(at, end), level + 1);
    out += key === undefined ? text : step.wrap(text, key);
    at = end;
  }
  return out;
}

const runsOf = (node: JSONContent): Run[] =>
  (node.content ?? []).map((child) => ({
    text: child.type === "hardBreak" ? "\n" : (child.text ?? ""),
    marks: child.marks ?? [],
  }));

/** A list's items, one line each, as the parser reads only one line for an item. */
function listLines(list: JSONContent): string[] {
  const ordered = list.type === "orderedList";
  const start = Number(list.attrs?.start ?? 1);
  return (list.content ?? []).flatMap((item, index) => {
    const marker = ordered ? `${start + index}.` : "-";
    const words = (item.content ?? [])
      .filter((child) => child.type === "paragraph")
      .map((child) => inline(runsOf(child)).replace(/\s*\n\s*/g, " "))
      .join(" ");
    // The parser has no nested lists, so a nested item follows as an item of its own.
    const nested = (item.content ?? [])
      .filter((child) => child.type === "bulletList" || child.type === "orderedList")
      .flatMap(listLines);
    return [`${marker} ${words}`, ...nested];
  });
}

function block(node: JSONContent): string {
  switch (node.type) {
    case "bulletList":
    case "orderedList":
      return listLines(node).join("\n");
    case "codeBlock":
      return `\`\`\`\n${(node.content ?? []).map((child) => child.text ?? "").join("")}\n\`\`\``;
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

/** Whether pasted text has Markdown formatting, so it goes in formatted and not as typed marks. */
export const hasMarkdown = (text: string): boolean =>
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
  const href = /^[a-z][a-z+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return SAFE_LINK.test(href) ? href : undefined;
}
