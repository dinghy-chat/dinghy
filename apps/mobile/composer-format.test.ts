import { describe, expect, test } from "vitest";
import { parseMarkdown } from "../../packages/widget/src/markdown.ts";
import { type Edit, toggleInline, toggleList } from "./src/composer-format.ts";

/** Text with `[` and `]` for the selection, or one `|` for the caret, as an edit. */
function at(marked: string): Edit {
  const caret = marked.indexOf("|");
  if (caret >= 0) {
    return { text: marked.replace("|", ""), selection: { start: caret, end: caret } };
  }
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { text: marked.replace("[", "").replace("]", ""), selection: { start, end } };
}

/** An edit written back with its selection marks, to compare with `at`. */
function show({ text, selection }: Edit): string {
  if (selection.start === selection.end) {
    return `${text.slice(0, selection.start)}|${text.slice(selection.start)}`;
  }
  return `${text.slice(0, selection.start)}[${text.slice(selection.start, selection.end)}]${text.slice(selection.end)}`;
}

const inline = (marked: string, format: "bold" | "italic" | "code") => {
  const { text, selection } = at(marked);
  return show(toggleInline(text, selection, format));
};
const list = (marked: string, format: "bulleted" | "numbered") => {
  const { text, selection } = at(marked);
  return show(toggleList(text, selection, format));
};

describe("bold, italic and code", () => {
  test("wrap the selection and keep it on the same words", () => {
    expect(inline("say [hello] now", "bold")).toBe("say **[hello]** now");
    expect(inline("say [hello] now", "italic")).toBe("say *[hello]* now");
    expect(inline("run [npm i] now", "code")).toBe("run `[npm i]` now");
  });

  test("keep spaces at the edges outside the marks, so the parser reads them", () => {
    const edit = toggleInline("say hello now", { start: 3, end: 10 }, "bold");
    expect(edit.text).toBe("say **hello** now");
    expect(parseMarkdown(edit.text)).toEqual([
      { tag: "p", children: ["say ", { tag: "strong", children: ["hello"] }, " now"] },
    ]);
  });

  test("come off text that has them, selected with or without its marks", () => {
    expect(inline("say **[hello]** now", "bold")).toBe("say [hello] now");
    expect(inline("say [**hello**] now", "bold")).toBe("say [hello] now");
    expect(inline("say *[hello]* now", "italic")).toBe("say [hello] now");
    expect(inline("run `[x]` now", "code")).toBe("run [x] now");
  });

  test("tell italic from bold, and take either off bold italic", () => {
    expect(inline("**[hello]**", "italic")).toBe("***[hello]***");
    expect(inline("***[hello]***", "bold")).toBe("*[hello]*");
    expect(inline("***[hello]***", "italic")).toBe("**[hello]**");
  });

  test("format the word around a caret inside it", () => {
    expect(inline("say hel|lo now", "bold")).toBe("say **[hello]** now");
  });

  test("put an empty pair at a caret outside a word, and take it out on a second press", () => {
    expect(inline("hello |", "bold")).toBe("hello **|**");
    expect(inline("hello **|**", "bold")).toBe("hello |");
    expect(inline("|", "italic")).toBe("*|*");
  });

  test("leave a selection of only spaces as it is", () => {
    expect(inline("a[   ]b", "bold")).toBe("a[   ]b");
  });

  test("fence code over several lines", () => {
    expect(inline("see:\n[a = 1\nb = 2]\nok", "code")).toBe("see:\n```\n[a = 1\nb = 2]\n```\nok");
    expect(inline("x [a\nb] y", "code")).toBe("x \n```\n[a\nb]\n```\n y");
  });
});

describe("lists", () => {
  test("turn each selected line with words into an item", () => {
    expect(list("[one\ntwo]", "bulleted")).toBe("[- one\n- two]");
    expect(list("[one\n\ntwo]", "numbered")).toBe("[1. one\n\n2. two]");
  });

  test("take the list off when every line is that kind of item", () => {
    expect(list("[- one\n- two]", "bulleted")).toBe("[one\ntwo]");
    expect(list("[1. one\n2. two]", "numbered")).toBe("[one\ntwo]");
  });

  test("change a list to the other kind", () => {
    expect(list("[- one\n- two]", "numbered")).toBe("[1. one\n2. two]");
    expect(list("[1. one\n2. two]", "bulleted")).toBe("[- one\n- two]");
  });

  test("act on the caret's line and keep the caret on its words", () => {
    expect(list("intro\nbuy mi|lk\nend", "bulleted")).toBe("intro\n- buy mi|lk\nend");
    expect(list("intro\n- buy mi|lk\nend", "bulleted")).toBe("intro\nbuy mi|lk\nend");
    expect(list("|", "bulleted")).toBe("- |");
    expect(list("|hello", "numbered")).toBe("1. |hello");
  });

  test("leave out a line the selection only reaches the start of", () => {
    expect(list("[one\n]two", "bulleted")).toBe("[- one]\ntwo");
  });

  test("write lists the parser reads", () => {
    const edit = toggleList("one\ntwo", { start: 0, end: 7 }, "numbered");
    expect(parseMarkdown(edit.text)).toEqual([{ tag: "ol", items: [["one"], ["two"]], start: 1 }]);
  });
});
