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

/** The item the arrows chose, for the trigger at `from` and the word typed after it. */
export interface Chosen {
  from: number;
  word: string;
  index: number;
}

/**
 * The chosen item of the open list: the one the arrows chose for this trigger and word, within the
 * items it has now, or else the first. A new trigger or word starts at the first.
 */
export const chosenIndex = (chosen: Chosen, active: Typed, count: number): number =>
  chosen.from === active.from && chosen.word === active.word
    ? Math.min(chosen.index, Math.max(count - 1, 0))
    : 0;

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
  const [chosen, setChosen] = useState<Chosen>({ from: -1, word: "", index: 0 });
  // Where Escape closed it. Once the trigger is gone, after a space or a send, the next one opens.
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const isTyping = typed !== null;
  useEffect(() => {
    if (!isTyping) setClosedAt(null);
  }, [isTyping]);
  // The teammates `@` wrote in, by the name it wrote, so two members with one name stay apart.
  const [picked] = useState(() => new Map<string, string>());
  const listId = useId();
  const find = typed === null ? undefined : sources[typed.trigger];
  const active = typed !== null && find !== undefined && typed.from !== closedAt ? typed : null;
  const items = active === null || find === undefined ? [] : find(active.word).slice(0, SHOWN_MAX);
  const index = active === null ? 0 : chosenIndex(chosen, active, items.length);
  const optionId = (at: number) => `${listId}-${at}`;

  const insert = (item: PickerItem) => {
    if (active === null) return;
    item.insert(editor, active);
    if (active.trigger === "@") picked.set(item.label, item.id);
  };
  /** Takes a key while the picker is open. False lets the editor have it. */
  const press = (key: PickerKey): boolean => {
    if (active === null) return false;
    if (key === "Escape") {
      setClosedAt(active.from);
      return true;
    }
    const item = items[index];
    if (item === undefined) return false;
    if (key === "Enter" || key === "Tab") insert(item);
    else {
      const step = key === "ArrowDown" ? 1 : items.length - 1;
      setChosen({ from: active.from, word: active.word, index: (index + step) % items.length });
    }
    return true;
  };

  const list = active !== null && (
    <div
      className="popup up side-start picker"
      id={listId}
      role="listbox"
      aria-label={t(TEXT[active.trigger].list)}
    >
      {items.length === 0 ? (
        <p className="picker-none">{t(TEXT[active.trigger].none)}</p>
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
    picked,
    /** For the editor's ARIA attributes: the open list and its chosen item. */
    listId: active === null ? undefined : listId,
    activeId: items[index] === undefined ? undefined : optionId(index),
  };
}

/**
 * The saved replies whose shortcut holds the typed word, those that start with it first. Only the
 * shortcut, so Enter after ordinary text such as `/billing` sends it.
 */
const savedReplyItems =
  (replies: SavedReply[]) =>
  (typed: string): PickerItem[] => {
    const word = typed.toLowerCase();
    return replies
      .filter((reply) => reply.shortcut.includes(word))
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

// What follows a name that goes on, such as `Anna` in `@Annabel`.
const NAME_GOES_ON = /^[\p{L}\p{N}]/u;

/** Whether the text holds `@name` as a whole name, not the start of a longer one. */
const hasMention = (body: string, name: string) =>
  body
    .split(`@${name}`)
    .slice(1)
    .some((after) => !NAME_GOES_ON.test(after));

/** The text without its whole `@name` mentions. */
function withoutMention(body: string, name: string): string {
  const [first = "", ...rest] = body.split(`@${name}`);
  return rest.reduce(
    (text, after) => `${text}${NAME_GOES_ON.test(after) ? `@${name}` : ""}${after}`,
    first,
  );
}

/**
 * The teammates a note mentions: those whose `@Name` it holds. A name the picker wrote, by `picked`
 * (name to member), or one the note mentioned before an edit keeps its member, so two members with
 * one name stay apart. Only a name typed by hand goes to the first member with that name. Longer
 * names match first, and each match leaves the text, so `@Anna Smith` or `@Jean-Luc` never also
 * mentions Anna or Jean. The server keeps current members only, and alerts each of them.
 */
export function mentionsIn(
  body: string,
  members: Member[],
  picked: ReadonlyMap<string, string>,
  mentionedBefore: string[] = [],
): string[] {
  const known = new Map(
    members
      .filter((member) => mentionedBefore.includes(member.id))
      .map((one) => [one.name, one.id]),
  );
  for (const [name, id] of picked) known.set(name, id);
  const byHand = members.filter((member) => !known.has(member.name));
  const candidates = [...[...known].map(([name, id]) => ({ id, name })), ...byHand];
  let rest = body;
  const mentioned: string[] = [];
  for (const one of candidates.sort((a, b) => b.name.length - a.name.length)) {
    if (!hasMention(rest, one.name)) continue;
    mentioned.push(one.id);
    rest = withoutMention(rest, one.name);
  }
  return mentioned.slice(0, MENTIONS_MAX);
}
