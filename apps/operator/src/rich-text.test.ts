import type { JSONContent } from "@tiptap/react";
import { expect, test } from "vitest";
import { markdownHtml } from "../../../packages/widget/src/markdown.ts";
import { hasFormatting, linkHref, toMarkdown } from "./rich-text.ts";

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

test("a link keeps its words, and only an address the parser links by itself stays bare", () => {
  expect(toMarkdown(doc(paragraph(text("Boats", ["link", "https://w.org/Boat_(small)"]))))).toBe(
    "[Boats](https://w.org/Boat_%28small%29)",
  );
  const link = (href: string) => text(href, ["link", href]);
  const href = "https://dinghy.chat";
  const mail = "mailto:hello@dinghy.chat";
  expect(
    toMarkdown(
      doc(paragraph(text("Docs", ["link", href]), text(" or "), link(href), text(" "), link(mail))),
    ),
  ).toBe(`[Docs](${href}) or ${href} [${mail}](${mail})`);
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
          {
            type: "listItem",
            content: [
              paragraph(text("Pay", "bold")),
              { type: "codeBlock", content: [text("4417")] },
            ],
          },
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
    "One\ntwo\n\n3. **Pay** `4417`\n4. Send\n- inner\n\n> Quoted\n>\n> twice\n\n```\na *b*\nc\n```",
  );
});

test("pasted HTML has formatting of its own only with formatting tags", () => {
  expect(hasFormatting("<b>Pay</b> now")).toBe(true);
  expect(hasFormatting('<a href="https://dinghy.chat">Docs</a>')).toBe(true);
  expect(hasFormatting('<span style="color:red">**Pay** now</span><br>')).toBe(false);
});

test("a typed link gets https, an empty one removes the link, and only safe ones are kept", () => {
  expect(linkHref(" dinghy.chat/docs ")).toBe("https://dinghy.chat/docs");
  expect(linkHref("mailto:hello@dinghy.chat")).toBe("mailto:hello@dinghy.chat");
  expect(linkHref("hello@dinghy.chat")).toBe("mailto:hello@dinghy.chat");
  expect(linkHref("localhost:3000/inbox")).toBe("https://localhost:3000/inbox");
  expect(linkHref("")).toBe("");
  expect(linkHref("javascript:alert(1)")).toBeUndefined();
  expect(linkHref("two words")).toBeUndefined();
});
