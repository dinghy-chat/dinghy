import type { JSONContent } from "@tiptap/react";
import { expect, test } from "vitest";
import { markdownHtml } from "../../../packages/widget/src/markdown.ts";
import { hasMarkdown, linkHref, toMarkdown } from "./rich-text.ts";

const text = (words: string, ...marks: (string | [string, string])[]): JSONContent => ({
  type: "text",
  text: words,
  marks: marks.map((mark) =>
    typeof mark === "string" ? { type: mark } : { type: mark[0], attrs: { href: mark[1] } },
  ),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

test("marks become Markdown, with spaces kept outside them", () => {
  const markdown = toMarkdown(
    doc(
      paragraph(
        text("Pay "),
        text("the invoice ", "bold"),
        text("first", "italic"),
        text(", then "),
        text("npm i", "code"),
      ),
    ),
  );
  expect(markdown).toBe("Pay **the invoice** *first*, then `npm i`");
});

test("bold and italic together, and next to each other, read back as they were", () => {
  const markdown = toMarkdown(
    doc(
      paragraph(
        text("both", "bold", "italic"),
        text(" and "),
        text("bold ", "bold"),
        text("end", "bold", "italic"),
        text("plain"),
        text("a", "bold"),
        text("b", "italic"),
      ),
    ),
  );
  expect(markdownHtml(markdown)).toBe(
    "<p><strong><em>both</em></strong> and <strong>bold <em>end</em></strong>plain<strong>a</strong><em>b</em></p>",
  );
});

test("a link keeps its words, and a link whose words are its address stays bare", () => {
  const href = "https://dinghy.chat";
  expect(
    toMarkdown(
      doc(paragraph(text("Docs", ["link", href]), text(" or "), text(href, ["link", href]))),
    ),
  ).toBe(`[Docs](${href}) or ${href}`);
});

test("paragraphs, line breaks, lists, quotes and code blocks", () => {
  const markdown = toMarkdown(
    doc(
      paragraph(text("One"), { type: "hardBreak" }, text("two")),
      paragraph(),
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [
          { type: "listItem", content: [paragraph(text("Pay", "bold"))] },
          {
            type: "listItem",
            content: [
              paragraph(text("Send")),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [paragraph(text("inner"))] }],
              },
            ],
          },
        ],
      },
      { type: "blockquote", content: [paragraph(text("Quoted")), paragraph(text("twice"))] },
      { type: "codeBlock", content: [text("a *b*\nc")] },
    ),
  );
  expect(markdown).toBe(
    "One\ntwo\n\n3. **Pay**\n4. Send\n- inner\n\n> Quoted\n>\n> twice\n\n```\na *b*\nc\n```",
  );
});

test("pasted text counts as Markdown only when it has formatting", () => {
  expect(hasMarkdown("Click **Send transfer**.")).toBe(true);
  expect(hasMarkdown("1. Pay\n2. Send")).toBe(true);
  expect(hasMarkdown("Just words, 2 * 3 * 4")).toBe(false);
});

test("a typed link gets https, an empty one removes the link, and only safe ones are kept", () => {
  expect(linkHref(" dinghy.chat/docs ")).toBe("https://dinghy.chat/docs");
  expect(linkHref("mailto:hello@dinghy.chat")).toBe("mailto:hello@dinghy.chat");
  expect(linkHref("")).toBe("");
  expect(linkHref("javascript:alert(1)")).toBeUndefined();
  expect(linkHref("two words")).toBeUndefined();
});
