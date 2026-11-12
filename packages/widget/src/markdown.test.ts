import { expect, test } from "vitest";
import { markdownHtml, markdownText, parseMarkdown, plainText } from "./markdown.ts";

test("bold, italic and inline code", () => {
  expect(markdownHtml("**Hi** *there* `npm i`")).toBe(
    "<p><strong>Hi</strong> <em>there</em> <code>npm i</code></p>",
  );
});

test("a star next to a space stays a star", () => {
  expect(markdownHtml("2 * 3 * 4")).toBe("<p>2 * 3 * 4</p>");
});

test("nothing is formatted inside inline code", () => {
  expect(markdownHtml("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
});

test("a fenced code block keeps its lines and formats nothing", () => {
  expect(parseMarkdown("Run:\n```\nfoo **bar**\n  baz\n```\nDone")).toEqual([
    { tag: "p", children: ["Run:"] },
    { tag: "pre", text: "foo **bar**\n  baz" },
    { tag: "p", children: ["Done"] },
  ]);
});

test("an unclosed fence runs to the end", () => {
  expect(parseMarkdown("```\ncode")).toEqual([{ tag: "pre", text: "code" }]);
});

test("links open in a new tab, and only http, https and mailto become links", () => {
  expect(markdownHtml("[Docs](https://dinghy.chat/docs) or [mail](mailto:hello@dinghy.chat)")).toBe(
    '<p><a target="_blank" rel="noopener noreferrer" href="https://dinghy.chat/docs">Docs</a> or <a target="_blank" rel="noopener noreferrer" href="mailto:hello@dinghy.chat">mail</a></p>',
  );
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,x",
    "JaVaScRiPt:alert(1)",
    "/relative",
    "vbscript:x",
  ]) {
    expect(markdownHtml(`[click](${href})`)).toBe(`<p>[click](${href})</p>`);
  }
});

test("a bare link becomes a link, without its trailing punctuation", () => {
  expect(markdownHtml("See https://dinghy.chat/docs.")).toBe(
    '<p>See <a target="_blank" rel="noopener noreferrer" href="https://dinghy.chat/docs">https://dinghy.chat/docs</a>.</p>',
  );
  expect(markdownHtml("xhttps://a.example")).toBe("<p>xhttps://a.example</p>");
});

test("lists, bulleted and numbered, with their start", () => {
  expect(parseMarkdown("- one\n* two\n\n3. three\n4) four")).toEqual([
    { tag: "ul", items: [["one"], ["two"]], start: 1 },
    { tag: "ol", items: [["three"], ["four"]], start: 3 },
  ]);
  expect(markdownHtml("3. a")).toBe('<ol start="3"><li>a</li></ol>');
});

test("lines that start with > make one quote, which keeps its formatting", () => {
  expect(markdownHtml("> so the request\n>goes **out**\n\nOk")).toBe(
    "<blockquote>so the request<br>goes <strong>out</strong></blockquote><p>Ok</p>",
  );
  expect(markdownHtml("a > b")).toBe("<p>a &gt; b</p>");
});

test("line breaks stay inside a paragraph, and a blank line starts a new one", () => {
  expect(markdownHtml("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
});

test("HTML, headings and images stay text", () => {
  expect(markdownHtml("<script>alert(1)</script>")).toBe(
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
  expect(markdownHtml("# Title")).toBe("<p># Title</p>");
  expect(markdownHtml("![x](https://a.example/x.png)")).toBe(
    '<p>!<a target="_blank" rel="noopener noreferrer" href="https://a.example/x.png">x</a></p>',
  );
});

test("an address cannot break out of its attribute", () => {
  const html = markdownHtml('[x](https://a.example/"onmouseover="alert(1))');
  expect(html).not.toContain('"onmouseover');
  expect(markdownHtml("https://a.example/<img>")).toContain("&lt;img&gt;");
});

test("code and link text are escaped", () => {
  expect(markdownHtml("`<b>`")).toBe("<p><code>&lt;b&gt;</code></p>");
  expect(markdownHtml("[<i>](https://a.example)")).toContain("&lt;i&gt;</a>");
});

test("hostile input parses quickly and stays bounded", () => {
  for (const hostile of [
    "**a".repeat(5000),
    "*".repeat(10_000),
    "[".repeat(10_000),
    "[a](".repeat(2500),
    "`".repeat(10_000),
    "https://".repeat(1200),
    "- ".repeat(5000),
    `${"*a ".repeat(3000)}*`,
  ]) {
    const started = performance.now();
    markdownHtml(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  }
  // Markers nest only a few levels deep.
  const nested = `${"*".repeat(40)}x${"*".repeat(40)}`;
  expect(() => markdownHtml(nested)).not.toThrow();
});

test("markdownText keeps the words and drops the marks, for a preview", () => {
  expect(markdownText("Yes, **both** and `x`.\n\n- one\n- two")).toBe("Yes, both and x. one two");
  expect(markdownText("[Docs](https://a.example) <b>")).toBe("Docs <b>");
});

test("a quote's text drops the marks, keeps link words, snake_case and line breaks, and is whole", () => {
  expect(plainText("**Bold** and *it* `code` [docs](https://x.y)\n- item_one\n- two")).toBe(
    "Bold and it code docs\nitem_one\ntwo",
  );
  expect(plainText("é".repeat(300))).toHaveLength(300);
});
