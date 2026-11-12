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
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { IMAGE_TYPES } from "../../../packages/widget/src/compose.ts";
import { markdownHtml, SAFE_LINK } from "../../../packages/widget/src/markdown.ts";
import { MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import { Icon, type IconName } from "./icons.tsx";
import { isMarkdownPaste, linkHref, toMarkdown } from "./rich-text.ts";
import { type TextId, t } from "./text.ts";
import { Choices, EmojiButton, type Option } from "./ui.tsx";

/** A reply goes to the visitor, and a note stays with the team. */
export type ComposeMode = "reply" | "note";

const MODES: Option<ComposeMode>[] = [
  { value: "reply", label: "composeReply" },
  { value: "note", label: "composeNote" },
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
}

/** Runs commands on the editor, which keeps the focus. */
const run = (editor: Editor, commands: (chain: ChainedCommands) => ChainedCommands) =>
  commands(editor.chain().focus()).run();

/** Several lines, or a code block already, toggle a code block, and words in a line inline code. */
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
        keys: ON_MAC ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`,
      });

/**
 * The composer's keys: Enter sends, Shift+Enter starts a line or a list item, Escape cancels, and
 * each format's key does what its button does. It also keeps the Markdown within a message's
 * length, as a textarea's maxLength did.
 */
const composerExtension = (latest: RefObject<Latest>) =>
  Extension.create({
    name: "composer",
    // Ahead of the lists', the code block's and the marks' own keys.
    priority: 1000,
    addKeyboardShortcuts: () => ({
      ...Object.fromEntries(
        FORMATS.flatMap((one) =>
          one.key === undefined
            ? []
            : [
                [
                  `Mod-${one.key}`,
                  ({ editor }: { editor: Editor }) => {
                    one.apply(editor, latest.current);
                    return true;
                  },
                ],
              ],
        ),
      ),
      Enter() {
        latest.current.send();
        return true;
      },
      "Shift-Enter": ({ editor }) =>
        editor.commands.first(({ commands }) => [
          () => commands.splitListItem("listItem"),
          () => commands.newlineInCode(),
          () => commands.setHardBreak(),
        ]),
      Escape() {
        const { onEscape } = latest.current;
        onEscape?.();
        return onEscape !== undefined;
      },
    }),
    addProseMirrorPlugins: () => [
      new Plugin({
        filterTransaction: (transaction) =>
          !transaction.docChanged || toMarkdown(transaction.doc.toJSON()).length <= MESSAGE_MAX,
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
      attributes: () => ({
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": latest.current.label,
        class: "compose-field",
      }),
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        const text = data?.getData("text/plain") ?? "";
        const { onFiles } = latest.current;
        // A copy from Word or Excel holds its text and a picture of it. The text is what is meant.
        if (text === "" && onFiles !== undefined && data?.files.length) {
          onFiles(data.files);
          return true;
        }
        // Code keeps its stars and dashes as they are.
        if (view.state.selection.$from.parent.type.spec.code) return false;
        if (!isMarkdownPaste(text, data?.getData("text/html") ?? "")) return false;
        // pasteHTML sends no paste event, so this handler does not run again.
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
  const now: Latest = {
    label: t(editing ? "editLabel" : isNote ? "composeNoteLabel" : "replyLabel"),
    placeholder: editing ? "" : t(isNote ? "composeNotePlaceholder" : "replyPlaceholder"),
    setDraft,
    send,
    onEscape,
    onFiles,
    openLink: () => setTypedLink(editor.getAttributes("link").href ?? ""),
  };
  const latest = useRef(now);
  latest.current = now;
  const editor = useComposerEditor(draft, latest, editing);
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      FORMATS.map((one) => one.active.some((name) => current.isActive(name))),
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
    run(editor, (chain) => {
      const link = chain.extendMarkRange("link");
      if (href === "") return link.unsetLink();
      if (isNew)
        return link.insertContent({
          type: "text",
          text: href,
          marks: [{ type: "link", attrs: { href } }],
        });
      return link.setLink({ href });
    });
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
                  onClick={() => one.apply(editor, latest.current)}
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
