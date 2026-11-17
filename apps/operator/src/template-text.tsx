/** @jsxImportSource react */
import { type Ref, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { templateParts } from "../../../packages/widget/src/template.ts";

// A campaign's text with each variable drawn as a token in words, such as "first name", while the
// value stays the template, such as `{{ firstName | default: "there" }}`. A token is one character
// for the caret: arrows step over it, and Backspace removes it whole. A tag that does not read
// stays as typed, so it can be fixed, and one typed whole turns into a token when the box loses
// focus.

export interface TemplateTextHandle {
  /** Puts a tag in place of what was last selected, or at the end. */
  insert(tag: string): void;
  focus(): void;
}

/** The box's nodes for the text: words as text, and each tag that reads as a token. */
function nodesOf(text: string, wordsOf: (path: string) => string): Node[] {
  return templateParts(text).map((part) => {
    if (part.kind === "text" || part.path === null) {
      return document.createTextNode(part.kind === "text" ? part.text : part.tag);
    }
    const token = document.createElement("span");
    token.className = "variable-token";
    token.contentEditable = "false";
    token.dataset.tag = part.tag;
    token.title = part.tag;
    token.textContent = wordsOf(part.path);
    return token;
  });
}

/** The template that the box's nodes hold. A browser may break lines with elements. */
function textOf(parent: Node): string {
  let text = "";
  for (const node of parent.childNodes) {
    if (node instanceof HTMLElement && node.dataset.tag !== undefined) text += node.dataset.tag;
    else if (node.nodeName === "BR") {
      // The last line's break only holds the caret on an empty line.
      if (node !== parent.lastChild || !text.endsWith("\n")) text += "\n";
    } else if (node instanceof HTMLElement) {
      text += (text === "" ? "" : "\n") + textOf(node);
    } else text += node.textContent ?? "";
  }
  return text;
}

/** The selection in the box, or null when it is elsewhere. */
function selectionIn(box: HTMLElement): Range | null {
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return box.contains(range.startContainer) && box.contains(range.endContainer) ? range : null;
}

/** Where the selection starts and ends in the template, or null when it is elsewhere. */
function selectedSpan(box: HTMLElement): [number, number] | null {
  const range = selectionIn(box);
  if (range === null) return null;
  const before = document.createRange();
  before.selectNodeContents(box);
  before.setEnd(range.startContainer, range.startOffset);
  const start = textOf(before.cloneContents()).length;
  return [start, start + textOf(range.cloneContents()).length];
}

/** Puts the caret in the box after `offset` characters of the template. */
function placeCaret(box: HTMLElement, offset: number) {
  const place = document.createRange();
  place.selectNodeContents(box);
  place.collapse(false);
  let left = offset;
  for (const node of box.childNodes) {
    const length =
      node instanceof HTMLElement
        ? (node.dataset.tag?.length ?? 0)
        : (node.textContent?.length ?? 0);
    if (left <= length && !(node instanceof HTMLElement)) {
      place.setStart(node, left);
      place.collapse(true);
      break;
    }
    if (left === 0) {
      place.setStartBefore(node);
      place.collapse(true);
      break;
    }
    left -= length;
  }
  box.focus();
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(place);
}

export function TemplateText({
  ref,
  labelId,
  value,
  placeholder,
  describedBy,
  wordsOf,
  onChange,
}: {
  ref: Ref<TemplateTextHandle>;
  labelId: string;
  value: string;
  placeholder: string;
  describedBy: string | undefined;
  wordsOf(path: string): string;
  onChange(value: string): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The value the box's nodes hold, so a change typed in it does not draw them again.
  const drawn = useRef<string | null>(null);
  // What was selected when the box lost focus, as offsets in the template.
  const lastSpan = useRef<[number, number] | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const draw = (text: string) => {
    box.current?.replaceChildren(...nodesOf(text, wordsOf));
    drawn.current = text;
  };
  useLayoutEffect(() => {
    const current = box.current;
    if (current === null) return;
    if (value !== drawn.current) draw(value);
    if (pendingCaret.current !== null) {
      placeCaret(current, pendingCaret.current);
      pendingCaret.current = null;
    }
    // React types no "plaintext-only", so the box takes it here.
    current.contentEditable = "plaintext-only";
  });
  const changed = () => {
    if (box.current === null) return;
    const text = textOf(box.current);
    drawn.current = text;
    onChange(text);
  };
  const copy = (event: ClipboardEvent, cut: boolean) => {
    const range = box.current === null ? null : selectionIn(box.current);
    if (range === null || event.clipboardData === null) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", textOf(range.cloneContents()));
    if (!cut) return;
    range.deleteContents();
    changed();
  };
  useImperativeHandle(ref, () => ({
    insert(tag) {
      const [start, end] = (lastSpan.current ?? [value.length, value.length]).map((at) =>
        Math.min(at, value.length),
      ) as [number, number];
      pendingCaret.current = start + tag.length;
      onChange(value.slice(0, start) + tag + value.slice(end));
    },
    focus: () => box.current?.focus(),
  }));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a textarea cannot draw a variable as a token.
    <div
      ref={box}
      role="textbox"
      tabIndex={0}
      aria-multiline="true"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-invalid={describedBy !== undefined}
      data-placeholder={placeholder}
      className="template-text"
      onInput={changed}
      // The clipboard gets the tags, not the tokens' words, so a pasted copy keeps its variables.
      onCopy={(event) => copy(event.nativeEvent, false)}
      onCut={(event) => copy(event.nativeEvent, true)}
      onBlur={() => {
        if (box.current !== null) lastSpan.current = selectedSpan(box.current);
        // A tag typed whole becomes a token.
        draw(value);
      }}
    />
  );
}
