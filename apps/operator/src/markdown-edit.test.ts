import { expect, test } from "vitest";
import { code, link, list, wrap } from "./markdown-edit.ts";

test("wrap adds the mark around the selection, and a second time takes it away", () => {
  const bold = wrap("say hi now", 4, 6, "**");
  expect(bold).toEqual({ value: "say **hi** now", start: 6, end: 8 });
  expect(wrap(bold.value, bold.start, bold.end, "**")).toEqual({
    value: "say hi now",
    start: 4,
    end: 6,
  });
});

test("wrap with no selection puts the cursor between the marks", () => {
  expect(wrap("", 0, 0, "*")).toEqual({ value: "**", start: 1, end: 1 });
});

test("code is inline for one line and fenced for several", () => {
  expect(code("run npm i", 4, 9)).toEqual({ value: "run `npm i`", start: 5, end: 10 });
  const fenced = code("Try:\na\nb", 5, 8);
  expect(fenced.value).toBe("Try:\n```\na\nb\n```");
  expect(fenced.value.slice(fenced.start, fenced.end)).toBe("a\nb");
});

test("link keeps the selection as its words and selects the address", () => {
  const made = link("see docs", 4, 8, "link");
  expect(made.value).toBe("see [docs](https://)");
  expect(made.value.slice(made.start, made.end)).toBe("https://");
  expect(link("", 0, 0, "link").value).toBe("[link](https://)");
});

test("list marks each selected line, and a second time takes the marks away", () => {
  const bullets = list("intro\none\ntwo", 7, 12, false);
  expect(bullets.value).toBe("intro\n- one\n- two");
  expect(list(bullets.value, bullets.start, bullets.end, false).value).toBe("intro\none\ntwo");
  expect(list("a\nb", 0, 3, true).value).toBe("1. a\n2. b");
  expect(list("- a\n- b", 0, 7, true).value).toBe("1. a\n2. b");
});
