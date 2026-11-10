import { describe, expect, test } from "vitest";
import { type CodeLanguage, highlight } from "./highlight.ts";

const colored = (code: string, language: CodeLanguage) =>
  highlight(code, language).map((line) =>
    line.tokens.filter((token) => token.kind !== null).map((token) => [token.kind, token.text]),
  );

const SAMPLES: [CodeLanguage, string][] = [
  [
    "html",
    '<script src="https://chat.example.com/widget/loader.js" data-key="wk_1" async></script>',
  ],
  ["css", 'dinghy-chat {\n  --dinghy-radius: 12px; /* the corners */\n  font: "Inter";\n}'],
  [
    "js",
    'const stop = Dinghy.on("unread", (count) => count); // Stops.\nBuffer.from(`hello`, 300);',
  ],
  ["ts", 'import { init } from "@dinghy-chat/widget";\ntype Key = string;'],
  ["json", '{ "error": { "code": "too_many_requests", "retry": 30, "ok": false } }'],
  ["sh", '# A note\ncurl https://x \\\n  -H "Authorization: Bearer dk_..."   # the key'],
  ["nginx", "proxy_set_header Host $host; # keep it"],
  ["text", "script-src https://chat.example.com;"],
];

describe.each(SAMPLES)("%s", (language, code) => {
  test("the tokens give back the code exactly", () => {
    const text = highlight(code, language)
      .map((line) => line.tokens.map((token) => token.text).join(""))
      .join("\n");
    expect(text).toBe(code);
  });
});

test("html colors tags, attribute names with and without a value, and values", () => {
  expect(colored(SAMPLES[0]?.[1] ?? "", "html")[0]).toEqual([
    ["tag", "<script"],
    ["attr", "src"],
    ["string", '"https://chat.example.com/widget/loader.js"'],
    ["attr", "data-key"],
    ["string", '"wk_1"'],
    ["attr", "async"],
    ["tag", ">"],
    ["tag", "</script"],
    ["tag", ">"],
  ]);
});

test("html leaves an apostrophe in the text alone, and colors an inline script as JavaScript", () => {
  const lines = colored("<p>Don't wait</p>\n<script>\n  go(() => 1);\n</script>", "html");
  expect(lines[0]).toEqual([
    ["tag", "<p"],
    ["tag", ">"],
    ["tag", "</p"],
    ["tag", ">"],
  ]);
  expect(lines[2]).toEqual([["number", "1"]]);
});

test("json tells keys from values", () => {
  expect(colored(SAMPLES[4]?.[1] ?? "", "json")[0]).toEqual([
    ["key", '"error"'],
    ["key", '"code"'],
    ["string", '"too_many_requests"'],
    ["key", '"retry"'],
    ["number", "30"],
    ["key", '"ok"'],
    ["keyword", "false"],
  ]);
});

test("js colors keywords but not a method of the same name", () => {
  const [first, second] = colored(SAMPLES[2]?.[1] ?? "", "js");
  expect(first).toEqual([
    ["keyword", "const"],
    ["string", '"unread"'],
    ["comment", "// Stops."],
  ]);
  expect(second).toEqual([
    ["string", "`hello`"],
    ["number", "300"],
  ]);
});

test("a shell block gives each command a prompt, but not a note or the rest of a long command", () => {
  const lines = highlight(SAMPLES[5]?.[1] ?? "", "sh");
  expect(lines.map((line) => line.prompt)).toEqual(["none", "command", "continued"]);
  expect(colored(SAMPLES[5]?.[1] ?? "", "sh")[2]).toEqual([
    ["string", '"Authorization: Bearer dk_..."'],
    ["comment", "# the key"],
  ]);
});
