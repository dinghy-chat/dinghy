/** @jsxImportSource react */
import { type Editor, useEditorState } from "@tiptap/react";
import { useEffect, useId, useState } from "react";
import { markdownHtml, plainText } from "../../../packages/widget/src/markdown.ts";
import { MENTIONS_MAX } from "../../../packages/widget/src/shared.ts";
import type { Member, SavedReply } from "./api.ts";
import { type TextId, t } from "./text.ts";

/** What opens the picker at the start of a word: `/` for saved replies, `@` for teammates. */
type Trigger = "/" | "@";

interface PickerItem {
  id: string;
  label: string;
  /** A quieter second line, such as the start of a saved reply. */
  detail: string | null;
  /** Puts it in the place of the trigger and the word typed after it. */
  insert(editor: Editor, place: { from: number; to: number }): void;
}

/** What each trigger offers for the words typed after it. A trigger left out opens nothing. */
export type PickerSources = Partial<Record<Trigger, (typed: string) => PickerItem[]>>;

/** The keys the picker takes while it is open. Any other key types as usual. */
export type PickerKey = "ArrowUp" | "ArrowDown" | "Enter" | "Tab" | "Escape";

// A trigger at the start of a line or after a space, and the word typed after it so far.
const TYPED = /(?:^|\s)([/@])([^\s/@]*)$/;
const SHOWN_MAX = 8;

const TEXT: Record<Trigger, { list: TextId; none: TextId }> = {
  "/": { list: "pickerSavedReplies", none: "pickerNoSavedReplies" },
  "@": { list: "pickerMembers", none: "pickerNoMembers" },
};

interface Typed {
  trigger: Trigger;
  word: string;
  /** Where the trigger starts and the word ends, in the document. */
  from: number;
  to: number;
}

const isTrigger = (text: string | undefined): text is Trigger => text === "/" || text === "@";

/** The trigger before the caret and the word after it, or null. */
function typedTrigger(editor: Editor): Typed | null {
  const { $from, empty } = editor.state.selection;
  // A code block keeps a slash or an at sign as typed.
  if (!empty || $from.parent.type.spec.code) return null;
  // A line break reads as one, so a trigger can start a line of its own.
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\n");
  const [, trigger, word = ""] = TYPED.exec(before) ?? [];
  if (!isTrigger(trigger)) return null;
  return { trigger, word, from: $from.pos - word.length - 1, to: $from.pos };
}

/**
 * The one picker that both `/` and `@` open in the composer: the items that match the word typed
 * after the trigger, and the keys that move through them. Enter or Tab inserts the chosen item, and
 * Escape closes the picker until the next trigger.
 */
export function usePicker(editor: Editor, sources: PickerSources) {
  const typed = useEditorState({
    editor,
    selector: ({ editor: current }) => typedTrigger(current),
  });
  const [chosen, setChosen] = useState({ word: "", index: 0 });
  // Where Escape closed it. Once the trigger is gone, after a space or a send, the next one opens.
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const isTyping = typed !== null;
  useEffect(() => {
    if (!isTyping) setClosedAt(null);
  }, [isTyping]);
  const listId = useId();
  const find = typed === null ? undefined : sources[typed.trigger];
  const open = typed !== null && find !== undefined && typed.from !== closedAt ? typed : null;
  const items = open === null || find === undefined ? [] : find(open.word).slice(0, SHOWN_MAX);
  // A new word starts at the first match.
  const index = open !== null && chosen.word === open.word ? chosen.index : 0;
  const optionId = (at: number) => `${listId}-${at}`;

  const insert = (item: PickerItem) => {
    if (open !== null) item.insert(editor, open);
  };
  /** Takes a key while the picker is open. False lets the editor have it. */
  const press = (key: PickerKey): boolean => {
    if (open === null) return false;
    if (key === "Escape") {
      setClosedAt(open.from);
      return true;
    }
    const item = items[index];
    if (item === undefined) return false;
    if (key === "Enter" || key === "Tab") insert(item);
    else {
      const step = key === "ArrowDown" ? 1 : items.length - 1;
      setChosen({ word: open.word, index: (index + step) % items.length });
    }
    return true;
  };

  const list = open !== null && (
    <div
      className="popup up side-start picker"
      id={listId}
      role="listbox"
      aria-label={t(TEXT[open.trigger].list)}
    >
      {items.length === 0 ? (
        <p className="picker-none">{t(TEXT[open.trigger].none)}</p>
      ) : (
        items.map((item, at) => (
          <div
            key={item.id}
            id={optionId(at)}
            role="option"
            tabIndex={-1}
            aria-selected={at === index}
            className={at === index ? "item active" : "item"}
            // The editor keeps the focus and the caret, as with the formatting buttons.
            onMouseDown={(event) => {
              event.preventDefault();
              insert(item);
            }}
          >
            <span className="item-label">
              {item.label}
              {item.detail !== null && <small>{item.detail}</small>}
            </span>
          </div>
        ))
      )}
    </div>
  );
  return {
    press,
    list,
    /** For the editor's ARIA attributes: the open list and its chosen item. */
    listId: open === null ? undefined : listId,
    activeId: items[index] === undefined ? undefined : optionId(index),
  };
}

/** The saved replies whose shortcut or text holds the typed word, those whose shortcut starts with it first. */
const savedReplyItems =
  (replies: SavedReply[]) =>
  (typed: string): PickerItem[] => {
    const word = typed.toLowerCase();
    return replies
      .filter((reply) => reply.shortcut.includes(word) || reply.body.toLowerCase().includes(word))
      .sort((a, b) => Number(b.shortcut.startsWith(word)) - Number(a.shortcut.startsWith(word)))
      .map((reply) => ({
        id: reply.id,
        label: `/${reply.shortcut}`,
        detail: plainText(reply.body),
        // As a paste of Markdown is, so a reply of one paragraph joins the line it is typed in.
        insert: (editor, place) => {
          editor.chain().focus().setTextSelection(place).run();
          editor.view.pasteHTML(markdownHtml(reply.body));
        },
      }));
  };

/** The teammates whose name holds the typed word. A pick writes `@Name`, which names the mention. */
const memberItems =
  (members: Member[]) =>
  (typed: string): PickerItem[] =>
    members
      .filter((member) => member.name.toLowerCase().includes(typed.toLowerCase()))
      .map((member) => ({
        id: member.id,
        label: member.name,
        detail: null,
        insert: (editor, place) =>
          editor
            .chain()
            .focus()
            .insertContentAt(place, { type: "text", text: `@${member.name} ` })
            .run(),
      }));

/** What `/` and `@` offer in a composer: the saved replies, and in a note the other teammates. */
export const composerPicks = (
  savedReplies: SavedReply[],
  members: Member[],
  meId: string,
  isNote: boolean,
): PickerSources => ({
  "/": savedReplyItems(savedReplies),
  ...(isNote && { "@": memberItems(members.filter((member) => member.id !== meId)) }),
});

/** Whether the text holds `@name` as a whole name, not the start of a longer one. */
const names = (body: string, name: string) =>
  body
    .split(`@${name}`)
    .slice(1)
    .some((after) => !/^[\p{L}\p{N}]/u.test(after));

/**
 * The teammates a note mentions: those whose `@Name` it holds, as the picker writes it or as typed.
 * The server keeps current members only, and alerts each of them.
 */
export const mentionsIn = (body: string, members: Member[]): string[] =>
  members
    .filter((member) => names(body, member.name))
    .map((member) => member.id)
    .slice(0, MENTIONS_MAX);
