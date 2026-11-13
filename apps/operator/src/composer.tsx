/** @jsxImportSource react */
import { Placeholder } from "@tiptap/extensions";
import { Plugin } from "@tiptap/pm/state";
import {
  type ChainedCommands,
  type Editor,
  EditorContent,
  Extension,
  useEditor,
  useEditorState,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { acceptedFiles } from "../../../packages/widget/src/compose.ts";
import { markdownHtml, SAFE_LINK } from "../../../packages/widget/src/markdown.ts";
import { MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import { Icon, type IconName } from "./icons.tsx";
import { type PickerKey, type PickerSources, usePicker } from "./picker.tsx";
import { hasFormatting, linkHref, toMarkdown } from "./rich-text.ts";
import { Keys } from "./shortcuts.tsx";
import { type TextId, t } from "./text.ts";
import { Choices, EmojiButton, type Option } from "./ui.tsx";

/** A reply goes to the visitor, and a note stays with the team. */
export type ComposeMode = "reply" | "note";

const MODES: Option<ComposeMode>[] = [
  { value: "reply", label: "composeReply", icon: "reply" },
  { value: "note", label: "composeNote", icon: "lock" },
];

/** What the editor's keys, paste and formats read from the composer's latest render. */
interface Latest {
  label: string;
  placeholder: string;
  setDraft(draft: string): void;
  send(): void;
  onEscape: (() => void) | undefined;
  onFiles: ((files: Iterable<File>) => void) | undefined;
  openLink(): void;
  /** Gives a key to the picker of saved replies and teammates. False when it is closed. */
  pick(key: PickerKey): boolean;
  /** The picker's list and its chosen item, for screen readers. Set once the picker has drawn. */
  picking: { listId?: string | undefined; activeId?: string | undefined };
}

/** Runs commands on the editor, which keeps the focus. */
const run = (editor: Editor, commands: (chain: ChainedCommands) => ChainedCommands) =>
  commands(editor.chain().focus()).run();

/**
 * Code over several lines, or in a code block already, toggles code blocks, and code inside a line
 * toggles inline code.
 */
function toggleCode(editor: Editor) {
  const { from, to } = editor.state.selection;
  const isBlock =
    editor.isActive("codeBlock") ||
    editor.state.doc.textBetween(from, to, "\n", "\n").includes("\n");
  run(editor, (chain) => (isBlock ? chain.toggleCodeBlock() : chain.toggleCode()));
}

/**
 * Each formatting button: its text, its icon, its key with Cmd or Ctrl, the marks or nodes that
 * show it as on, and what it does.
 */
const FORMATS: {
  name: TextId;
  icon: IconName;
  key?: string;
  active: string[];
  apply(editor: Editor, latest: Latest): void;
}[] = [
  {
    name: "formatBold",
    icon: "textBold",
    key: "b",
    active: ["bold"],
    apply: (editor) => run(editor, (chain) => chain.toggleBold()),
  },
  {
    name: "formatItalic",
    icon: "textItalic",
    key: "i",
    active: ["italic"],
    apply: (editor) => run(editor, (chain) => chain.toggleItalic()),
  },
  { name: "formatCode", icon: "code", key: "e", active: ["code", "codeBlock"], apply: toggleCode },
  {
    name: "formatLink",
    icon: "link",
    key: "k",
    active: ["link"],
    apply: (_, latest) => latest.openLink(),
  },
  {
    name: "formatBulleted",
    icon: "listBullets",
    active: ["bulletList"],
    apply: (editor) => run(editor, (chain) => chain.toggleBulletList()),
  },
  {
    name: "formatNumbered",
    icon: "listNumbers",
    active: ["orderedList"],
    apply: (editor) => run(editor, (chain) => chain.toggleOrderedList()),
  },
];

const ON_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** "Bold (⌘B)" on a Mac and "Bold (Ctrl+B)" elsewhere. */
const shortcutLabel = (name: TextId, key: string | undefined) =>
  key === undefined
    ? t(name)
    : t("withShortcut", {
        name: t(name),
        keys: `${ON_MAC ? "⌘" : "Ctrl+"}${key.toUpperCase()}`,
      });

/**
 * The composer's keys: Enter sends, Shift+Enter starts a line or a list item, Escape cancels, and
 * each format's key does what its button does. While the picker is open, it takes the arrows,
 * Enter, Tab and Escape first. It also keeps the Markdown within a message's length, so a reply
 * cannot fail on the server for its size.
 */
const composerExtension = (latest: RefObject<Latest>) =>
  Extension.create({
    name: "composer",
    // Ahead of the lists', the code block's and the marks' own keys.
    priority: 1000,
    addKeyboardShortcuts: () => ({
      ...Object.fromEntries(
        FORMATS.filter((one) => one.key !== undefined).map((one) => [
          `Mod-${one.key}`,
          ({ editor }: { editor: Editor }) => {
            one.apply(editor, latest.current);
            return true;
          },
        ]),
      ),
      Enter() {
        if (!latest.current.pick("Enter")) latest.current.send();
        return true;
      },
      Tab() {
        return latest.current.pick("Tab");
      },
      ArrowUp() {
        return latest.current.pick("ArrowUp");
      },
      ArrowDown() {
        return latest.current.pick("ArrowDown");
      },
      "Shift-Enter": ({ editor }) =>
        editor.commands.first(({ commands }) => [
          () => commands.newlineInCode(),
          () => commands.splitListItem("listItem"),
          () => commands.setHardBreak(),
        ]),
      // With nothing to cancel, Escape leaves the box, so the app's single keys work again.
      Escape({ editor }) {
        const { onEscape } = latest.current;
        if (latest.current.pick("Escape")) return true;
        if (onEscape === undefined) editor.commands.blur();
        else onEscape();
        return true;
      },
    }),
    addProseMirrorPlugins: () => [
      new Plugin({
        // A change that does not lengthen the Markdown, such as a deletion, always goes through.
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged) return true;
          const length = toMarkdown(transaction.doc.toJSON()).length;
          return length <= MESSAGE_MAX || length <= toMarkdown(state.doc.toJSON()).length;
        },
      }),
    ],
  });

/** The rich text editor, kept in step with the draft, which stays Markdown. */
function useComposerEditor(draft: string, latest: RefObject<Latest>, autofocus: boolean) {
  // The Markdown the editor shows, so a draft that changes elsewhere replaces its content.
  const shown = useRef(draft);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        dropcursor: false,
        gapcursor: false,
        trailingNode: false,
        link: {
          openOnClick: false,
          defaultProtocol: "https",
          isAllowedUri: (url) => SAFE_LINK.test(url),
        },
      }),
      Placeholder.configure({ placeholder: () => latest.current.placeholder }),
      composerExtension(latest),
    ],
    // The app's content security policy refuses inline styles, so app.css holds Tiptap's.
    injectCSS: false,
    content: markdownHtml(draft),
    autofocus: autofocus && "end",
    editorProps: {
      attributes: (): Record<string, string> => {
        const { listId, activeId } = latest.current.picking;
        return {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": latest.current.label,
          "aria-autocomplete": "list",
          class: "compose-field",
          ...(listId !== undefined && { "aria-controls": listId }),
          ...(activeId !== undefined && { "aria-activedescendant": activeId }),
        };
      },
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        const text = data?.getData("text/plain") ?? "";
        const { onFiles } = latest.current;
        // A copy from Word or Excel holds its text and a picture of it. The text is what is meant.
        if (text === "" && onFiles !== undefined && data?.files.length) {
          onFiles(data.files);
          return true;
        }
        // pasteHTML below pastes again with an empty event, which the default paste takes.
        if (text === "") return false;
        const { selection } = view.state;
        const keepsDefault =
          // Code keeps its stars and dashes, as typed.
          selection.$from.parent.type.spec.code ||
          hasFormatting(data?.getData("text/html") ?? "") ||
          // A link pasted over words makes them a link.
          (!selection.empty && SAFE_LINK.test(text.trim()));
        if (keepsDefault) return false;
        // As Markdown, which also keeps the text's single line breaks.
        view.pasteHTML(markdownHtml(text));
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      shown.current = toMarkdown(editor.getJSON());
      latest.current.setDraft(shown.current);
    },
  });
  useEffect(() => {
    if (draft === shown.current) return;
    shown.current = draft;
    // Outside the undo history, so Cmd+Z after a send cannot bring the sent text back.
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(markdownHtml(draft), { emitUpdate: false })
      .run();
  }, [draft, editor]);
  return editor;
}

export function Composer({
  draft,
  setDraft,
  onSend,
  onFiles,
  onEscape,
  above,
  mode,
  editing = false,
  picks,
}: {
  draft: string;
  setDraft(draft: string): void;
  /** The text, and the teammates `@` wrote in it, by name. */
  onSend(body: string, picked: ReadonlyMap<string, string>): void;
  /** Undefined when only text can go, as in a read-only workspace's welcome chat. */
  onFiles: ((files: Iterable<File>) => void) | undefined;
  /** Escape in the box: cancels a quote or an edit. */
  onEscape?: (() => void) | undefined;
  /** Above the text, such as the quote a reply carries. */
  above?: ReactNode;
  /** Reply or Note, for a new message. With no onChange it is fixed, as in a closed conversation. */
  mode?: { value: ComposeMode; onChange?(mode: ComposeMode): void } | undefined;
  /** It edits a sent reply, in place of its bubble. */
  editing?: boolean;
  /** What `/` and `@` offer here: saved replies, and teammates in a note. */
  picks: PickerSources;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  // The address being typed for a link, or null while the link field is closed.
  const [typedLink, setTypedLink] = useState<string | null>(null);
  const isNote = mode?.value === "note";

  const send = () => {
    // From the editor itself, as the draft may not have drawn the last key yet.
    const body = toMarkdown(editor.getJSON()).trim();
    if (body === "") return;
    // An edit keeps its text until the server takes it, so a failed save loses nothing.
    if (!editing) setDraft("");
    onSend(body, new Map(picker.picked));
    if (!editing) picker.picked.clear();
  };
  const now: Latest = {
    label: t(editing ? "editLabel" : isNote ? "composeNoteLabel" : "replyLabel"),
    placeholder: editing ? "" : t(isNote ? "composeNotePlaceholder" : "replyPlaceholder"),
    setDraft,
    send,
    onEscape,
    onFiles,
    openLink: () => setTypedLink(editor.getAttributes("link").href ?? ""),
    pick: (key) => picker.press(key),
    picking: {},
  };
  const latest = useRef(now);
  latest.current = now;
  const editor = useComposerEditor(draft, latest, editing);
  const picker = usePicker(editor, picks);
  now.picking = { listId: picker.listId, activeId: picker.activeId };
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      FORMATS.map((one) => one.active.some((name) => current.isActive(name))),
  });
  // The label, the placeholder and the picker's chosen item show once the editor draws again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isNote and the chosen item change them.
  useEffect(() => editor.view.dispatch(editor.state.tr), [editor, isNote, picker.activeId]);

  const href = typedLink === null ? undefined : linkHref(typedLink);
  const closeLink = () => {
    setTypedLink(null);
    editor.commands.focus();
  };
  const saveLink = () => {
    if (href === undefined) return;
    const { empty } = editor.state.selection;
    const isNew = empty && !editor.isActive("link");
    run(editor, (chain) => {
      // A caret inside a link changes the whole link, and a selection changes what it selects.
      const target = empty ? chain.extendMarkRange("link") : chain;
      if (href === "") return target.unsetLink();
      if (isNew) {
        const text = { type: "text", text: href, marks: [{ type: "link", attrs: { href } }] };
        return target.insertContent(text);
      }
      return target.setLink({ href });
    });
    // The caret goes after the link, and the link ends there: a Tiptap link takes in the words
    // typed at its end.
    run(editor, (chain) => chain.setTextSelection(editor.state.selection.to).unsetMark("link"));
    setTypedLink(null);
  };

  return (
    <form
      className={[
        "compose",
        editing && "editing",
        isNote && "note",
        typedLink !== null && "linking",
      ]
        .filter(Boolean)
        .join(" ")}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {mode?.onChange !== undefined && (
        <Choices
          label={t("composeMode")}
          value={mode.value}
          options={MODES}
          onChange={mode.onChange}
        />
      )}
      <div className="box">
        {above}
        {/* The key that comes back here, while the box is empty and has no focus. */}
        {!editing && draft === "" && <Keys keys={isNote ? "n" : "r"} />}
        {picker.list}
        <EditorContent editor={editor} className="compose-text" />
        {typedLink !== null && (
          <div className="link-field">
            <input
              // Text, not url, so the browser's own check cannot stop the form's Send.
              type="text"
              inputMode="url"
              autoComplete="off"
              // biome-ignore lint/a11y/noAutofocus: the operator asked for a link, so its address is next.
              autoFocus
              aria-label={t("linkAddress")}
              placeholder={t("linkPlaceholder")}
              aria-invalid={href === undefined}
              value={typedLink}
              onChange={(event) => setTypedLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveLink();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  closeLink();
                }
              }}
            />
            <button type="button" className="pill" onClick={closeLink}>
              {t("cancel")}
            </button>
            <button
              type="button"
              className="pill dark"
              disabled={href === undefined}
              onClick={saveLink}
            >
              {t("save")}
            </button>
          </div>
        )}
        <div className="compose-tools">
          <div className="more-tools">
            {onFiles !== undefined && (
              <>
                <input
                  ref={fileInput}
                  className="file"
                  type="file"
                  multiple
                  accept={acceptedFiles(true)}
                  aria-label={t("attach")}
                  tabIndex={-1}
                  onChange={(event) => {
                    onFiles(event.target.files ?? []);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("attach")}
                  title={t("attach")}
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="clip" size={18} />
                </button>
              </>
            )}
            <EmojiButton onPick={(emoji) => run(editor, (chain) => chain.insertContent(emoji))} />
            <span className="tools-divider" aria-hidden="true" />
            <fieldset className="format-tools" aria-label={t("formatTools")}>
              {FORMATS.map((one, index) => {
                const label = shortcutLabel(one.name, one.key);
                return (
                  <button
                    key={one.name}
                    type="button"
                    className="icon-button"
                    aria-label={label}
                    title={label}
                    aria-pressed={active[index]}
                    // The editor keeps its selection while the button is pressed.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => one.apply(editor, latest.current)}
                  >
                    <Icon name={one.icon} size={18} />
                  </button>
                );
              })}
            </fieldset>
          </div>
          {editing ? (
            <span className="edit-actions">
              <button type="button" className="pill" onClick={onEscape}>
                {t("cancel")}
              </button>
              <button type="submit" className="pill dark">
                {t("saveEdit")}
              </button>
            </span>
          ) : isNote ? (
            <button type="submit" className="pill dark send-note">
              {t("addNote")}
            </button>
          ) : (
            <button type="submit" className="send" aria-label={t("send")} title={t("send")}>
              <Icon name="arrowUp" size={16} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
