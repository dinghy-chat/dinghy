import { describe, expect, test } from "vitest";
import {
  draftHtml,
  draftMarkdown,
  formatMarks,
  insertSaved,
  visibleOffset,
} from "./src/rich-draft.ts";

const roundTrip = (markdown: string) => draftMarkdown(draftHtml(markdown)).markdown;

describe("draftHtml", () => {
  test("writes the editor's tags, one line each", () => {
    expect(draftHtml("Hi **Fight** and *it* `x`\nline two")).toBe(
      "<html><p>Hi <b>Fight</b> and <i>it</i> <code>x</code></p><p>line two</p></html>",
    );
    expect(draftHtml("- one\n- two\n\n1. a\n2. b")).toBe(
      "<html><ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol></html>",
    );
    expect(draftHtml("one\n\ntwo")).toBe("<html><p>one</p><br><p>two</p></html>");
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

  test("counts the hidden character of an empty list item, and sends no empty item", () => {
    const html = "<html><ul><li>one</li><li></li></ul></html>";
    expect(draftMarkdown(html)).toEqual({ markdown: "- one\n", text: "one\n\u200B" });
    expect(visibleOffset("one\n\u200B\nx", 6)).toBe(5);
  });

  test("numbers lists and fences code blocks", () => {
    const html =
      "<html><ol><li>a</li><li>b</li></ol><codeblock><p>x</p><p>y</p></codeblock><blockquote><p>q</p></blockquote></html>";
    expect(draftMarkdown(html).markdown).toBe("1. a\n2. b\n```\nx\ny\n```\n> q");
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
      "```\ncode\n\n\nmore\n```",
      "Text\n- item\nAfter",
    ]) {
      expect(roundTrip(markdown)).toBe(markdown);
    }
  });
});

describe("formatMarks", () => {
  test("formats pasted Markdown and puts the caret after it", () => {
    expect(formatMarks("<html><p>**Fight** now</p></html>", "")).toEqual({
      html: "<html><p><b>Fight</b> now</p></html>",
      caret: 9,
    });
    expect(formatMarks("<html><p>- one</p><p>- two</p></html>", "")).toEqual({
      html: "<html><ul><li>one</li><li>two</li></ul></html>",
      caret: 7,
    });
  });

  test("finds the caret when the pasted words repeat the text", () => {
    expect(formatMarks("<html><p>Hi there **there**</p></html>", "Hi there")).toEqual({
      html: "<html><p>Hi there <b>there</b></p></html>",
      caret: 14,
    });
    expect(formatMarks("<html><p>a **x** b</p></html>", "a  b")).toEqual({
      html: "<html><p>a <b>x</b> b</p></html>",
      caret: 3,
    });
  });

  test("formats a mark typed to close a format, inside other formats", () => {
    expect(formatMarks("<html><p><b>bold</b> *it*</p></html>", "bold *it")).toEqual({
      html: "<html><p><b>bold</b> <i>it</i></p></html>",
      caret: 7,
    });
  });

  test("leaves text with no Markdown alone, spaces and empty lines too", () => {
    expect(formatMarks("<html><p><b>Fight</b> 2 * 3</p><br><br><p>next</p></html>", "")).toBeNull();
    expect(formatMarks("<html><p>see https://a.example </p></html>", "")).toBeNull();
    expect(formatMarks("<html><p>Steps:</p><ul><li>one</li></ul></html>", "")).toBeNull();
  });
});

describe("insertSaved", () => {
  test("replaces the typed /word and keeps the formats around it", () => {
    const html = "<html><p><b>Hi</b> /thanks</p></html>";
    expect(insertSaved(html, "Thanks for **writing**", { from: 3, to: 10 })).toEqual({
      html: "<html><p><b>Hi</b> Thanks for <b>writing</b></p></html>",
      caret: 21,
    });
  });

  test("replaces a /word split over formats, and keeps $ in the reply", () => {
    const html = "<html><p><b>Hi </b>/tha<i>nks</i></p></html>";
    expect(insertSaved(html, "Pay $$5", { from: 3, to: 10 })).toEqual({
      html: "<html><p><b>Hi</b> Pay $$5</p></html>",
      caret: 10,
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
