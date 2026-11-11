// The small Markdown that messages use: **bold**, *italic*, `code`, fenced code, [links](url), bare
// links, lists and line breaks. No HTML, images or headings. The parser builds a tree of plain
// values, and each renderer writes text as text, so nothing in a message can become markup.

/** A run of text, or a formatted part of it. Text keeps its line breaks, for `white-space`. */
type Inline =
  | string
  | { tag: "strong" | "em"; children: Inline[] }
  | { tag: "code"; text: string }
  | { tag: "a"; href: string; children: Inline[] };

export type Block =
  | { tag: "p"; children: Inline[] }
  | { tag: "pre"; text: string }
  | { tag: "ul" | "ol"; items: Inline[][]; start: number };

/** Bold inside italic inside a link is plenty, and a limit stops a stack of markers. */
const MAX_DEPTH = 4;
const SAFE_LINK = /^(https?:\/\/|mailto:)[^\s]+$/i;
// A bare link stops before trailing punctuation, so "see https://a.example." keeps its period.
const BARE_LINK = /https?:\/\/[^\s<>"]*[^\s<>"'.,;:!?)\]]/iy;
const FENCE = /^\s*```/;
const LIST_ITEM = /^\s*(?:[-*+]|(\d{1,9})[.)])\s+(.*)$/;

/** Reads the formatting inside one paragraph or list item. */
function inline(source: string, depth = 0): Inline[] {
  const parts: Inline[] = [];
  let text = "";
  const add = (part: Inline) => {
    if (text !== "") parts.push(text);
    text = "";
    parts.push(part);
  };
  for (let at = 0; at < source.length; ) {
    const char = source[at];
    if (char === "`") {
      const end = source.indexOf("`", at + 1);
      if (end > at + 1) {
        add({ tag: "code", text: source.slice(at + 1, end) });
        at = end + 1;
        continue;
      }
    } else if (char === "*" && depth < MAX_DEPTH) {
      const mark = source[at + 1] === "*" ? "**" : "*";
      const from = at + mark.length;
      const end = source.indexOf(mark, from + 1);
      // Like Markdown, a marker next to a space is a plain star, as in "2 * 3 * 4".
      if (end > 0 && source[from]?.trim() && source[end - 1]?.trim()) {
        add({
          tag: mark === "**" ? "strong" : "em",
          children: inline(source.slice(from, end), depth + 1),
        });
        at = end + mark.length;
        continue;
      }
    } else if (char === "[" && depth < MAX_DEPTH) {
      const middle = source.indexOf("](", at);
      const end = middle < 0 ? -1 : source.indexOf(")", middle);
      const label = source.slice(at + 1, middle);
      const href = source.slice(middle + 2, end);
      if (end > 0 && label !== "" && !label.includes("]") && SAFE_LINK.test(href)) {
        add({ tag: "a", href, children: inline(label, depth + 1) });
        at = end + 1;
        continue;
      }
    } else if ((char === "h" || char === "H") && !/\w/.test(source[at - 1] ?? "")) {
      BARE_LINK.lastIndex = at;
      const found = BARE_LINK.exec(source)?.[0];
      if (found !== undefined) {
        add({ tag: "a", href: found, children: [found] });
        at += found.length;
        continue;
      }
    }
    text += char;
    at += 1;
  }
  if (text !== "") parts.push(text);
  return parts;
}

/** Splits a message into paragraphs, code blocks and lists. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push({ tag: "p", children: inline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE.test(line)) {
      endParagraph();
      const code: string[] = [];
      while (index + 1 < lines.length && !FENCE.test(lines[index + 1] ?? "")) {
        index += 1;
        code.push(lines[index] ?? "");
      }
      index += 1;
      blocks.push({ tag: "pre", text: code.join("\n") });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      endParagraph();
      const tag = item[1] === undefined ? "ul" : "ol";
      const last = blocks.at(-1);
      const content = inline(item[2] ?? "");
      if (last?.tag === tag) last.items.push(content);
      else blocks.push({ tag, items: [content], start: Number(item[1] ?? 1) });
      continue;
    }
    if (line.trim() === "") endParagraph();
    else paragraph.push(line);
  }
  endParagraph();
  return blocks;
}

/** createElement from Preact or React: a tag, its props and its children. */
export type CreateElement<Node> = (
  tag: string,
  props: Record<string, unknown> | null,
  ...children: (Node | string)[]
) => Node;

const LINK_PROPS = { target: "_blank", rel: "noopener noreferrer" };

/** The message as elements, for the widget and the operator app. Text stays text. */
export function renderMarkdown<Node>(source: string, h: CreateElement<Node>): (Node | string)[] {
  const inlines = (parts: Inline[]): (Node | string)[] =>
    parts.map((part) =>
      typeof part === "string"
        ? part
        : part.tag === "code"
          ? h("code", null, part.text)
          : part.tag === "a"
            ? h("a", { ...LINK_PROPS, href: part.href }, ...inlines(part.children))
            : h(part.tag, null, ...inlines(part.children)),
    );
  return parseMarkdown(source).map((block) =>
    block.tag === "p"
      ? h("p", null, ...inlines(block.children))
      : block.tag === "pre"
        ? h("pre", null, h("code", null, block.text))
        : h(
            block.tag,
            block.tag === "ol" && block.start !== 1 ? { start: block.start } : null,
            ...block.items.map((item) => h("li", null, ...inlines(item))),
          ),
  );
}

/** The message's words without their marks, for a one-line preview. */
export function markdownText(source: string): string {
  const h: CreateElement<string> = (tag, _props, ...children) =>
    `${children.join("")}${tag === "li" ? " " : ""}`;
  return renderMarkdown(source, h).join(" ").replace(/\s+/g, " ").trim();
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text for HTML, with every character that could start markup escaped. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? "");

/** The message as HTML, for an email. Every character of the message's own text is escaped. */
export function markdownHtml(source: string): string {
  type Html = { html: string };
  const text = (part: string | Html) =>
    typeof part === "string" ? escapeHtml(part).replace(/\n/g, "<br>") : part.html;
  const h: CreateElement<Html> = (tag, props, ...children) => {
    const attributes = Object.entries(props ?? {})
      .map(([name, value]) => ` ${name}="${escapeHtml(String(value))}"`)
      .join("");
    return { html: `<${tag}${attributes}>${children.map(text).join("")}</${tag}>` };
  };
  return renderMarkdown(source, h).map(text).join("");
}

const QUOTE_EXCERPT_CHARACTERS = 140;

/** A quoted message's start as plain text, on one line: links keep their words, marks go. */
export function quoteExcerpt(body: string): string {
  const plain = body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\*+|`+|~~|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(plain).slice(0, QUOTE_EXCERPT_CHARACTERS).join("");
}
