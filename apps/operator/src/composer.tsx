/** @jsxImportSource react */
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import {
  type ChainedCommands,
  type Editor,
  EditorContent,
  Extension,
  useEditor,
  useEditorState,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { IMAGE_TYPES } from "../../../packages/widget/src/compose.ts";
import { markdownHtml, SAFE_LINK } from "../../../packages/widget/src/markdown.ts";
import { MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import { Icon, type IconName } from "./icons.tsx";
import { hasMarkdown, linkHref, toMarkdown } from "./rich-text.ts";
import { type TextId, t } from "./text.ts";
import { Choices, EmojiButton, type Option } from "./ui.tsx";

/** A reply goes to the visitor, and a note stays with the team. */
export type ComposeMode = "reply" | "note";

const MODES: Option<ComposeMode>[] = [
  { value: "reply", label: "composeReply" },
  { value: "note", label: "composeNote" },
];

/** Runs a format on the editor, which keeps the focus. */
const run = (command: (chain: ChainedCommands) => ChainedCommands) => (editor: Editor) =>
  command(editor.chain().focus()).run();

/** A selection over several lines becomes a code block, and one inside a line inline code. */
const toggleCode = (editor: Editor) => {
  const { $from, $to } = editor.state.selection;
  return run((chain) => ($from.sameParent($to) ? chain.toggleCode() : chain.toggleCodeBlock()))(
    editor,
  );
};

/**
 * Each formatting button: its text, its icon, the key that Tiptap or the composer binds to it
 * with Cmd or Ctrl, the node or mark it shows as on, and what it does.
 */
const FORMATS: {
  name: TextId;
  icon: IconName;
  key?: string;
  active: string;
  apply(editor: Editor, openLink: () => void): void;
}[] = [
  {
    name: "formatBold",
    icon: "textBold",
    key: "b",
    active: "bold",
    apply: run((chain) => chain.toggleBold()),
  },
  {
    name: "formatItalic",
    icon: "textItalic",
    key: "i",
    active: "italic",
    apply: run((chain) => chain.toggleItalic()),
  },
  { name: "formatCode", icon: "code", key: "e", active: "code", apply: toggleCode },
  {
    name: "formatLink",
    icon: "link",
    key: "k",
    active: "link",
    apply: (_, openLink) => openLink(),
  },
  {
    name: "formatBulleted",
    icon: "listBullets",
    active: "bulletList",
    apply: run((chain) => chain.toggleBulletList()),
  },
  {
    name: "formatNumbered",
    icon: "listNumbers",
    active: "orderedList",
    apply: run((chain) => chain.toggleOrderedList()),
  },
];

const ON_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** "Bold (⌘B)" on a Mac and "Bold (Ctrl+B)" elsewhere. */
const shortcutLabel = (name: TextId, key: string | undefined) =>
  key === undefined
    ? t(name)
    : t("withShortcut", {
        name: t(name),
        keys: ON_MAC ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`,
      });

/** What the editor's keys and paste call, from the composer's latest render. */
interface Handlers {
  label: string;
  placeholder: string;
  setDraft(draft: string): void;
  send(): void;
  onEscape: (() => void) | undefined;
  onFiles: ((files: Iterable<File>) => void) | undefined;
  openLink(): void;
}

/**
 * Enter sends, Shift+Enter starts a line or a list item, Escape cancels, Cmd+E formats code as the
 * button does, and Cmd+K adds a link.
 */
const composerKeys = (handlers: RefObject<Handlers>) =>
  Extension.create({
    name: "composerKeys",
    // Ahead of the lists', the code block's and inline code's own keys.
    priority: 1000,
    addKeyboardShortcuts: () => ({
      Enter() {
        handlers.current.send();
        return true;
      },
      "Shift-Enter": ({ editor }) =>
        editor.commands.first(({ commands }) => [
          () => commands.splitListItem("listItem"),
          () => commands.newlineInCode(),
          () => commands.setHardBreak(),
        ]),
      Escape() {
        const { onEscape } = handlers.current;
        onEscape?.();
        return onEscape !== undefined;
      },
      "Mod-e": ({ editor }) => toggleCode(editor),
      "Mod-k"() {
        handlers.current.openLink();
        return true;
      },
    }),
  });

/** The rich text editor, kept in step with the draft, which stays Markdown. */
function useComposerEditor(draft: string, handlers: RefObject<Handlers>, autofocus: boolean) {
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
      Placeholder.configure({ placeholder: () => handlers.current.placeholder }),
      CharacterCount.configure({ limit: MESSAGE_MAX }),
      composerKeys(handlers),
    ],
    // The app's content security policy refuses inline styles, so app.css holds Tiptap's.
    injectCSS: false,
    content: markdownHtml(draft),
    autofocus: autofocus && "end",
    editorProps: {
      attributes: () => ({
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": handlers.current.label,
        class: "compose-field",
      }),
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        const text = data?.getData("text/plain") ?? "";
        const { onFiles } = handlers.current;
        // A copy from Word or Excel holds its text and a picture of it. The text is what is meant.
        if (text === "" && onFiles !== undefined && data?.files.length) {
          onFiles(data.files);
          return true;
        }
        if (!hasMarkdown(text)) return false;
        // With no event of its own, so this handler does not take the paste again.
        view.pasteHTML(markdownHtml(text));
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      shown.current = toMarkdown(editor.getJSON());
      handlers.current.setDraft(shown.current);
    },
  });
  useEffect(() => {
    if (draft === shown.current) return;
    shown.current = draft;
    editor.commands.setContent(markdownHtml(draft), { emitUpdate: false });
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
}: {
  draft: string;
  setDraft(draft: string): void;
  onSend(body: string): void;
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
}) {
  const picker = useRef<HTMLInputElement>(null);
  // A phone keeps the formatting buttons behind one toggle, so the field gets the row.
  const [showsFormats, setShowsFormats] = useState(false);
  const formatsId = useId();
  // The address being typed for a link, or null while the link field is closed.
  const [typedLink, setTypedLink] = useState<string | null>(null);
  const isNote = mode?.value === "note";

  const send = () => {
    // From the editor itself, as the draft may not have drawn the last key yet.
    const body = toMarkdown(editor.getJSON()).trim();
    if (body === "") return;
    // An edit keeps its text until the server takes it, so a failed save loses nothing.
    if (!editing) setDraft("");
    onSend(body);
  };
  const latest: Handlers = {
    label: t(editing ? "editLabel" : isNote ? "composeNoteLabel" : "replyLabel"),
    placeholder: editing ? "" : t(isNote ? "composeNotePlaceholder" : "replyPlaceholder"),
    setDraft,
    send,
    onEscape,
    onFiles,
    openLink: () => setTypedLink(editor.getAttributes("link").href ?? ""),
  };
  const handlers = useRef(latest);
  handlers.current = latest;
  const editor = useComposerEditor(draft, handlers, editing);
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => FORMATS.map((one) => current.isActive(one.active)),
  });
  // The label and placeholder follow Reply and Note once the editor draws again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isNote is what changes them.
  useEffect(() => editor.view.dispatch(editor.state.tr), [editor, isNote]);

  const href = typedLink === null ? undefined : linkHref(typedLink);
  const closeLink = () => {
    setTypedLink(null);
    editor.commands.focus();
  };
  const saveLink = () => {
    if (href === undefined) return;
    const isNew = editor.state.selection.empty && !editor.isActive("link");
    run((chain) => {
      const link = chain.extendMarkRange("link");
      if (href === "") return link.unsetLink();
      if (isNew)
        return link.insertContent({
          type: "text",
          text: href,
          marks: [{ type: "link", attrs: { href } }],
        });
      return link.setLink({ href });
    })(editor);
    setTypedLink(null);
  };

  return (
    <form
      className={[
        "compose",
        editing && "editing",
        isNote && "note",
        showsFormats && "formatting",
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
          variant="tabs"
          value={mode.value}
          options={MODES}
          onChange={mode.onChange}
        />
      )}
      <div className="box">
        {above}
        <EditorContent editor={editor} className="compose-text" />
        {typedLink !== null && (
          <div className="link-field">
            <input
              type="url"
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
            <button type="button" className="pill dark" onClick={saveLink}>
              {t("save")}
            </button>
          </div>
        )}
        <div className="compose-tools">
          {onFiles !== undefined && (
            <>
              <input
                ref={picker}
                className="file"
                type="file"
                multiple
                accept={IMAGE_TYPES.join(",")}
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
                onClick={() => picker.current?.click()}
              >
                <Icon name="clip" size={18} />
              </button>
            </>
          )}
          <EmojiButton onPick={(emoji) => editor.chain().focus().insertContent(emoji).run()} />
          <button
            type="button"
            className="icon-button format-toggle"
            aria-label={t("formatTools")}
            title={t("formatTools")}
            aria-pressed={showsFormats}
            aria-controls={formatsId}
            onClick={() => setShowsFormats((shows) => !shows)}
          >
            <Icon name="textAa" size={18} />
          </button>
          <span className="tools-divider" aria-hidden="true" />
          <fieldset id={formatsId} className="format-tools" aria-label={t("formatTools")}>
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
                  onClick={() => one.apply(editor, handlers.current.openLink)}
                >
                  <Icon name={one.icon} size={18} />
                </button>
              );
            })}
          </fieldset>
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
