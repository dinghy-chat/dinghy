/** @jsxImportSource react */
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { IMAGE_TYPES, isComposing } from "../../../packages/widget/src/compose.ts";
import { MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import { Icon, type IconName } from "./icons.tsx";
import { code, type Edit, link, list, wrap } from "./markdown-edit.ts";
import { type TextId, t } from "./text.ts";
import { Choices, EmojiButton, type Option } from "./ui.tsx";

/** A reply goes to the visitor. A note stays with the team. */
export type ComposeMode = "reply" | "note";

const MODES: Option<ComposeMode>[] = [
  { value: "reply", label: "composeReply", icon: "reply" },
  { value: "note", label: "composeNote", icon: "note" },
];

/** Each formatting button: its text, its icon, its key with Cmd or Ctrl, and what it does. */
const FORMATS: {
  name: TextId;
  icon: IconName;
  key?: string;
  apply(value: string, start: number, end: number): Edit;
}[] = [
  { name: "formatBold", icon: "textBold", key: "b", apply: (v, s, e) => wrap(v, s, e, "**") },
  { name: "formatItalic", icon: "textItalic", key: "i", apply: (v, s, e) => wrap(v, s, e, "*") },
  { name: "formatCode", icon: "code", key: "e", apply: code },
  { name: "formatLink", icon: "link", key: "k", apply: (v, s, e) => link(v, s, e, t("linkWords")) },
  { name: "formatBulleted", icon: "listBullets", apply: (v, s, e) => list(v, s, e, false) },
  { name: "formatNumbered", icon: "listNumbers", apply: (v, s, e) => list(v, s, e, true) },
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

export function Composer({
  draft,
  setDraft,
  onSend,
  onFiles,
  onEscape,
  above,
  editing = false,
  mode = "reply",
  onMode,
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
  /** It edits a sent reply, in place of its bubble. */
  editing?: boolean;
  mode?: ComposeMode;
  /** Shows the Reply and Note tabs. */
  onMode?: ((mode: ComposeMode) => void) | undefined;
}) {
  const isNote = mode === "note";
  const hintId = useId();
  const picker = useRef<HTMLInputElement>(null);
  // A phone keeps the formatting buttons behind one toggle, so the field gets the row.
  const [showsFormats, setShowsFormats] = useState(false);
  const formatsId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  // The selection a format asked for, set once the new text is on screen.
  const selection = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const field = input.current;
    if (selection.current === null || field === null) return;
    field.focus();
    field.setSelectionRange(...selection.current);
    selection.current = null;
  });

  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const body = draft.trim();
    if (body === "") return;
    // An edit keeps its text until the server takes it, so a failed save loses nothing.
    if (!editing) setDraft("");
    onSend(body);
  };

  const format = (apply: (typeof FORMATS)[number]["apply"]) => {
    const field = input.current;
    if (field === null) return;
    const edit = apply(field.value, field.selectionStart, field.selectionEnd);
    selection.current = [edit.start, edit.end];
    setDraft(edit.value);
  };

  return (
    <form
      className={["compose", editing && "editing", showsFormats && "formatting", isNote && "note"]
        .filter(Boolean)
        .join(" ")}
      onSubmit={submit}
    >
      {onMode !== undefined && (
        <div className="compose-modes">
          <Choices label={t("composeMode")} value={mode} options={MODES} onChange={onMode} />
          {isNote && (
            <span id={hintId} className="compose-hint">
              <Icon name="lock" size={14} />
              {t("noteHint")}
            </span>
          )}
        </div>
      )}
      <div className="box">
        {above}
        <textarea
          ref={input}
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: the operator chose Edit, so the text is what they want.
          autoFocus={editing}
          onPaste={(event) => {
            // A copy from Word or Excel holds its text and a picture of it. The text is what is meant.
            const { clipboardData: data } = event;
            if (onFiles === undefined || data.files.length === 0) return;
            if (data.getData("text/plain") !== "") return;
            event.preventDefault();
            onFiles(data.files);
          }}
          aria-label={t(editing ? "editLabel" : isNote ? "noteLabelField" : "replyLabel")}
          aria-describedby={isNote ? hintId : undefined}
          placeholder={
            editing ? undefined : t(isNote ? "threadNotePlaceholder" : "replyPlaceholder")
          }
          maxLength={MESSAGE_MAX}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isComposing(event.nativeEvent)) {
              submit(event);
              return;
            }
            if (event.key === "Escape" && onEscape !== undefined) {
              event.preventDefault();
              onEscape();
              return;
            }
            if (!(ON_MAC ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
            const found = FORMATS.find((one) => one.key === event.key.toLowerCase());
            if (found === undefined) return;
            event.preventDefault();
            format(found.apply);
          }}
        />
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
          <EmojiButton field={input} onPick={setDraft} />
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
            {FORMATS.map((one) => {
              const label = shortcutLabel(one.name, one.key);
              return (
                <button
                  key={one.name}
                  type="button"
                  className="icon-button"
                  aria-label={label}
                  title={label}
                  // The field keeps its selection while the button is pressed.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => format(one.apply)}
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
          ) : (
            <button
              type="submit"
              className="send"
              aria-label={t(isNote ? "noteSave" : "send")}
              title={t(isNote ? "noteSave" : "send")}
            >
              <Icon name="arrowUp" size={16} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
