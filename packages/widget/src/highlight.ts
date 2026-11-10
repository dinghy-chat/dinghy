// Colors the code in the docs pages (site/build-docs.ts) and in the operator app's Settings, so both
// show a snippet the same way. A few regular expressions a line are enough for the short snippets
// Dinghy shows, and need no dependency. The widget itself never imports this file.

export type CodeLanguage = "html" | "css" | "js" | "ts" | "json" | "sh" | "nginx" | "text";

export type TokenKind = "tag" | "attr" | "string" | "keyword" | "comment" | "number" | "key";

export interface Token {
  /** Null for text that keeps the block's own color. */
  kind: TokenKind | null;
  text: string;
}

export interface CodeLine {
  /** In a shell block, a command shows a prompt, and the next lines of a long command line up after it. */
  prompt: "command" | "continued" | "none";
  tokens: Token[];
}

const JS_KEYWORDS =
  "import|from|export|function|const|let|return|async|await|new|if|else|true|false|null|undefined|typeof";
const NUMBER = String.raw`\b\d+(?:\.\d+)?\b`;
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;

/** Each named group is a token kind. The first group that matches names the token. */
const PATTERNS: Record<Exclude<CodeLanguage, "sh" | "text">, RegExp> = {
  html: new RegExp(
    [
      "(?<comment><!--.*?(?:-->|$))",
      String.raw`(?<tag><\/?[a-zA-Z][\w-]*|\/?>)`,
      // A name followed by =, or a bare one such as async before the end of the tag.
      String.raw`(?<attr>(?<=\s)[\w:-]+(?==|\s*\/?>))`,
      // A value after =, and not an apostrophe in the page's text.
      `(?<string>(?<==)(?:${QUOTED}))`,
    ].join("|"),
    "g",
  ),
  css: new RegExp(
    [
      String.raw`(?<comment>\/\*.*?(?:\*\/|$))`,
      `(?<string>${QUOTED})`,
      String.raw`(?<attr>--[\w-]+|[a-z-]+(?=\s*:))`,
      String.raw`(?<number>-?\d+(?:\.\d+)?(?:px|rem|em|%|s|ms)?\b)`,
      String.raw`(?<tag>^[^\s{][^{]*?(?=\s*\{))`,
    ].join("|"),
    "g",
  ),
  js: new RegExp(
    [
      String.raw`(?<comment>\/\/.*$|\/\*.*?(?:\*\/|$))`,
      `(?<string>${QUOTED}|\`[^\`]*\`)`,
      `(?<keyword>(?<!\\.)\\b(?:${JS_KEYWORDS})\\b)`,
      `(?<number>${NUMBER})`,
    ].join("|"),
    "g",
  ),
  ts: new RegExp(
    [
      String.raw`(?<comment>\/\/.*$|\/\*.*?(?:\*\/|$))`,
      `(?<string>${QUOTED}|\`[^\`]*\`)`,
      `(?<keyword>(?<!\\.)\\b(?:${JS_KEYWORDS}|type|interface)\\b)`,
      `(?<number>${NUMBER})`,
    ].join("|"),
    "g",
  ),
  json: new RegExp(
    [
      String.raw`(?<key>"(?:[^"\\]|\\.)*"(?=\s*:))`,
      String.raw`(?<string>"(?:[^"\\]|\\.)*")`,
      String.raw`(?<keyword>\b(?:true|false|null)\b)`,
      String.raw`(?<number>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)`,
    ].join("|"),
    "g",
  ),
  nginx: /(?<comment>#.*$)|(?<keyword>^\s*[a-z_]+(?=\s))|(?<string>\$[a-z_]+|"[^"]*")/g,
};

/** A shell command: quoted text, and a comment after a space. */
const SHELL = /(?<string>"[^"]*"|'[^']*')|(?<comment>(?<=\s)#\s.*$)/g;

function tokenize(line: string, pattern: RegExp): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index;
    if (index > last) tokens.push({ kind: null, text: line.slice(last, index) });
    const [kind = null] =
      Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined) ?? [];
    tokens.push({ kind: kind as TokenKind | null, text: match[0] });
    last = index + match[0].length;
  }
  if (last < line.length) tokens.push({ kind: null, text: line.slice(last) });
  return tokens;
}

function shellLines(lines: string[]): CodeLine[] {
  return lines.map((line, index) => {
    if (line.startsWith("#")) return { prompt: "none", tokens: [{ kind: "comment", text: line }] };
    const isContinued = lines[index - 1]?.endsWith("\\") ?? false;
    return { prompt: isContinued ? "continued" : "command", tokens: tokenize(line, SHELL) };
  });
}

/** Splits `code` into lines of colored tokens. Joined, the tokens give back `code` exactly. */
export function highlight(code: string, language: CodeLanguage): CodeLine[] {
  const lines = code.split("\n");
  if (language === "sh") return shellLines(lines);
  if (language === "text")
    return lines.map((text) => ({ prompt: "none", tokens: [{ kind: null, text }] }));
  if (language === "html") return htmlLines(lines);
  const pattern = PATTERNS[language];
  return lines.map((line) => ({ prompt: "none", tokens: tokenize(line, pattern) }));
}

/** An inline script's own lines are JavaScript, between a line that opens it and one that closes it. */
const SCRIPT_OPEN = /<script(?![^>]*\ssrc=)[^>]*>\s*$/;
const SCRIPT_CLOSE = /^\s*<\/script>/;

function htmlLines(lines: string[]): CodeLine[] {
  let isScript = false;
  return lines.map((line) => {
    if (SCRIPT_CLOSE.test(line)) isScript = false;
    const tokens = tokenize(line, isScript ? PATTERNS.js : PATTERNS.html);
    if (SCRIPT_OPEN.test(line)) isScript = true;
    return { prompt: "none", tokens };
  });
}

export const isCodeLanguage = (name: string): name is CodeLanguage =>
  name === "sh" || name === "text" || Object.hasOwn(PATTERNS, name);
