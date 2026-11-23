import { describe, expect, test } from "vitest";
import {
  caretAfter,
  draftHtml,
  draftMarkdown,
  formattedHtml,
  insertSaved,
} from "./src/rich-draft.ts";

const roundTrip = (markdown: string) => draftMarkdown(draftHtml(markdown)).markdown;

describe("draftHtml", () => {
  test("writes the editor's tags, one line each", () => {
    expect(draftHtml("Hi **Fight** and *it* `x`\nline two")).toBe(
      "<html><p>Hi <b>Fight</b> and <i>it</i> <code>x</code></p><p>line two</p></html>",
    );
    expect(draftHtml("- one\n- two\n\n1. a\n2. b")).toBe(
      "<html><ul><li>one</li><li>two</li></ul><br><ol><li>a</li><li>b</li></ol></html>",
    );
    expect(draftHtml("```\nlet a = 1;\n```")).toBe(
      "<html><codeblock><p>let a = 1;</p></codeblock></html>",
    );
  });

  test("escapes the text and keeps links", () => {
    expect(draftHtml("[a <b>](https://example.com/?a=1&b=2)")).toBe(
      '<html><p><a href="https://example.com/?a=1&amp;b=2">a &lt;b&gt;</a></p></html>',
    );
  });

  test("is empty for an empty draft", () => {
    expect(draftHtml("  ")).toBe("");
  });
});

describe("draftMarkdown", () => {
  test("reads the editor's own HTML, with its line breaks around tags", () => {
    const html =
      "<html>\n<p>Hello <b>world</b> &amp; <i>you</i></p>\n<br>\n<ul>\n<li>one</li>\n<li><code>two</code></li>\n</ul>\n</html>";
    expect(draftMarkdown(html)).toEqual({
      markdown: "Hello **world** & *you*\n\n- one\n- `two`",
      text: "Hello world & you\n\none\ntwo",
    });
  });

  test("numbers lists and fences code blocks", () => {
    const html =
      "<html><ol><li>a</li><li>b</li></ol><codeblock><p>x</p><p>y</p></codeblock><blockquote><p>q</p></blockquote></html>";
    expect(draftMarkdown(html).markdown).toBe("1. a\n2. b\n\n```\nx\ny\n```\n\n> q");
  });

  test("keeps the text of tags Markdown has no form for", () => {
    expect(
      draftMarkdown("<html><h1>Title</h1><p><u>under</u> <s>gone</s></p></html>").markdown,
    ).toBe("Title\nunder gone");
  });

  test("goes back to the same Markdown", () => {
    for (const markdown of [
      "Hi **Fight**",
      "***both*** and [link](https://a.example)",
      "a\nb\n\nc",
      "- one\n- two",
      "1. a\n2. b",
      "> quoted\n> twice",
      "```\ncode\n\nmore\n```",
      "Text\n\n- item\n\nAfter",
    ]) {
      expect(roundTrip(markdown)).toBe(markdown);
    }
  });
});

describe("formattedHtml", () => {
  test("formats pasted Markdown", () => {
    expect(formattedHtml("<html><p>**Fight** now</p></html>")).toBe(
      "<html><p><b>Fight</b> now</p></html>",
    );
    expect(formattedHtml("<html><p>- one</p><p>- two</p></html>")).toBe(
      "<html><ul><li>one</li><li>two</li></ul></html>",
    );
  });

  test("leaves text with no Markdown alone", () => {
    expect(formattedHtml("<html><p><b>Fight</b> 2 * 3</p><br><p>next</p></html>")).toBeNull();
    expect(formattedHtml("<html><p>see https://a.example</p></html>")).toBeNull();
  });
});

test("caretAfter puts the caret after the new words", () => {
  expect(caretAfter("ab", "a**x**b")).toBe(6);
  expect(caretAfter("ab", "axb")).toBe(2);
  expect(caretAfter("", "Fight")).toBe(5);
});

describe("insertSaved", () => {
  test("replaces the typed /word and keeps the formats around it", () => {
    const html = "<html><p><b>Hi</b> /thanks</p></html>";
    expect(insertSaved(html, "Thanks for **writing**", { from: 3, to: 10 })).toEqual({
      html: "<html><p><b>Hi</b> Thanks for <b>writing</b></p></html>",
      caret: 21,
    });
  });

  test("goes at the end, on its own line, with no place", () => {
    expect(insertSaved("<html><p>Hello</p></html>", "Bye", null)).toEqual({
      html: "<html><p>Hello</p><p>Bye</p></html>",
      caret: 9,
    });
    expect(insertSaved("", "Bye", null)).toEqual({ html: "<html><p>Bye</p></html>", caret: 3 });
  });
});
