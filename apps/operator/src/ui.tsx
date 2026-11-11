/** @jsxImportSource react */
import {
  type FormEvent,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { EMOJIS, insertEmoji } from "../../../packages/widget/src/emoji.ts";
import { ApiError, type Role } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { navigate } from "./nav.ts";
import { Pond } from "./scene.tsx";
import { type TextId, t } from "./text.ts";

export const ROLE_TEXT: Record<Role, TextId> = {
  owner: "roleOwner",
  admin: "roleAdmin",
  member: "roleMember",
};

/** Answers that mean the same thing wherever they come from, by the server's error code. */
const BY_CODE: Record<string, TextId> = {
  operator_limit: "operatorLimit",
  storage_full: "imageNoRoom",
  suspended: "suspendedRefused",
  read_only: "readOnlyRefused",
  payment_required: "paymentRequiredRefused",
  last_workspace: "deleteWorkspaceOnly",
  sole_owner: "deleteAccountSoleOwner",
  email_mismatch: "emailMismatch",
};

/**
 * The text for a failed request: by its code, then by its status, then 429 as too many requests.
 * Any other answer reads as a general failure, and a request with no answer (offline, timed out)
 * reads as `noAnswer`.
 */
export function failureText(
  failure: unknown,
  byStatus: Partial<Record<number, TextId>>,
  noAnswer: TextId = "somethingFailed",
): TextId {
  if (!(failure instanceof ApiError)) return noAnswer;
  return (
    (failure.code === null ? undefined : BY_CODE[failure.code]) ??
    byStatus[failure.status] ??
    (failure.status === 429 ? "tooManyRequests" : "somethingFailed")
  );
}

/** Opens a dialog as a modal when it mounts. */
export function useModal(): RefObject<HTMLDialogElement | null> {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return dialog;
}

export function ErrorNote({ text }: { text: TextId | null }) {
  if (text === null) return null;
  return (
    <p className="bad" role="alert">
      {t(text)}
    </p>
  );
}

export function StatusNote({ text }: { text: TextId | null }) {
  if (text === null) return null;
  return (
    <p className="note" role="status">
      {t(text)}
    </p>
  );
}

/** The outcome of a save: a status when it worked, an alert when it failed. */
export type Note = { ok: boolean; text: TextId } | null;

export function SaveNote({ note }: { note: Note }) {
  if (note === null) return null;
  return note.ok ? <StatusNote text={note.text} /> : <ErrorNote text={note.text} />;
}

const IMAGE_TYPES = "image/png,image/jpeg,image/webp";

/** The words of one image upload, such as the logo's. */
export interface UploadText {
  upload: TextId;
  replace: TextId;
  remove: TextId;
  preview: TextId;
  tooLarge: TextId;
}

/**
 * An image that saves as soon as it is picked or removed: the logo, or an operator's picture. The
 * image shows a success, so only a failure has a note.
 */
export function ImageUpload({
  url,
  text,
  onUpload,
  onRemove,
}: {
  url: string | null;
  text: UploadText;
  onUpload(file: File): Promise<unknown>;
  onRemove(): Promise<unknown>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const change = async (save: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await save();
    } catch (failure) {
      setNote({
        ok: false,
        text: failureText(failure, { 400: "uploadWrongType", 413: text.tooLarge }),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="logo-row">
        {url !== null && (
          <span className="logo-frame">
            <img className="logo-preview" src={url} alt={t(text.preview)} />
            <button
              type="button"
              className="logo-remove"
              aria-label={t(text.remove)}
              disabled={busy}
              onClick={() => void change(onRemove)}
            >
              <Icon name="close" size={14} />
            </button>
          </span>
        )}
        <input
          ref={picker}
          type="file"
          accept={IMAGE_TYPES}
          hidden
          aria-label={t(text.upload)}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            // Cleared, so picking the same file again uploads it again.
            event.currentTarget.value = "";
            if (file !== undefined) void change(() => onUpload(file));
          }}
        />
        <button
          type="button"
          className="pill dark"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          {t(url === null ? text.upload : text.replace)}
        </button>
      </div>
      <SaveNote note={note} />
    </>
  );
}

/** How long a copy control says it copied. */
const COPIED_MS = 2000;

/** Copies `value` on demand, and is true for a moment after. */
function useCopy(value: string): [done: boolean, copy: () => void] {
  const [done, setDone] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(value).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), COPIED_MS);
    });
  return [done, copy];
}

/** A value in running text, in bold, that copies itself when clicked. */
function CopyText({ value }: { value: string }) {
  const [done, copy] = useCopy(value);
  return (
    <button
      type="button"
      className="copy-text"
      title={done ? t("copied") : t("copy")}
      onClick={copy}
    >
      {value}
      {done && <small role="status">{t("copied")}</small>}
    </button>
  );
}

export function CopyButton({ value, label = t("copy") }: { value: string; label?: string }) {
  const [done, copy] = useCopy(value);
  return (
    <button
      type="button"
      className="pill small copy"
      aria-label={done ? t("copied") : label}
      onClick={copy}
    >
      <Icon name={done ? "check" : "copy"} size={16} />
      {done ? t("copied") : t("copy")}
    </button>
  );
}

/** The longest name the server takes, for a workspace or an operator. */
const NAME_MAX_LENGTH = 100;

/** A name with its own Save, such as the workspace's or the operator's. */
export function NameField({
  label,
  name,
  autoComplete,
  onSave,
}: {
  label: string;
  /** The saved name, which Save stays off for. */
  name: string;
  autoComplete: "name" | "organization";
  onSave(name: string): Promise<unknown>;
}) {
  const [typed, setTyped] = useState(name);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = typed.trim();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSave(trimmed);
      setTyped(trimmed);
      setNote({ ok: true, text: "saved" });
    } catch (failure) {
      setNote({ ok: false, text: failureText(failure, {}) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={save}>
      <div className="inline-field">
        <input
          aria-label={label}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            setNote(null);
          }}
          required
          maxLength={NAME_MAX_LENGTH}
          autoComplete={autoComplete}
        />
        <button
          type="submit"
          className="pill dark"
          disabled={busy || trimmed === "" || trimmed === name}
        >
          {t("save")}
        </button>
      </div>
      <SaveNote note={note} />
    </form>
  );
}

/** A value to copy, such as a secret shown once or an invite link, under a line about it. */
export function CopyField({
  hint,
  label,
  copyLabel = label,
  value,
}: {
  hint: string;
  /** The field's name, which the copy button takes too unless it has its own. */
  label: string;
  copyLabel?: string;
  value: string;
}) {
  return (
    <div className="created" role="status">
      <p className="hint">{hint}</p>
      <div className="copy-field">
        <input
          className="mono"
          readOnly
          aria-label={label}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onFocus={(event) => event.target.select()}
        />
        <CopyButton value={value} label={copyLabel} />
      </div>
    </div>
  );
}

/**
 * A "New ..." button that opens a form in its place, such as for an API key or a webhook. Cancel
 * closes the form, and the caller clears what it held.
 */
export function AddForm({
  isOpen,
  newLabel,
  submitLabel,
  canSubmit,
  onOpen,
  onCancel,
  onSubmit,
  children,
}: {
  isOpen: boolean;
  newLabel: string;
  submitLabel: string;
  canSubmit: boolean;
  onOpen(): void;
  onCancel(): void;
  onSubmit(): void;
  children: ReactNode;
}) {
  if (!isOpen) {
    return (
      <div className="actions">
        <button type="button" className="pill dark" onClick={onOpen}>
          <Icon name="plusBold" size={14} />
          {newLabel}
        </button>
      </div>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <div className="actions">
        <button type="submit" className="pill dark" disabled={!canSubmit}>
          {submitLabel}
        </button>
        <button type="button" className="pill" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/** Where the docs live. Each link names a page and, often, a section on it. */
const DOCS_URL = "https://dinghy.chat/docs/";

/** A link to the docs, in a new tab, such as `api#webhooks`. */
export function DocLink({ path, text }: { path: string; text: TextId }) {
  return (
    <a
      className="text-button doc-link"
      href={`${DOCS_URL}${path}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {t(text)}
    </a>
  );
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  /** Text, or text with a control in it, such as a name to copy. */
  label: ReactNode;
  /** A short line under the field, which a screen reader reads after the label. */
  hint?: string;
  /** A sentence or two, which a one-line box would cut off on a phone. */
  multiline?: boolean;
  /** A button that puts an emoji in the text. */
  emoji?: boolean;
  value: string;
  onChange(value: string): void;
}

export function Field({
  label,
  hint,
  multiline = false,
  emoji = false,
  value,
  onChange,
  ...input
}: FieldProps) {
  const hintId = useId();
  const controlId = useId();
  const control = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const describedBy = hint === undefined ? undefined : hintId;
  const box = multiline ? (
    // One line of text that wraps: the server takes no line breaks, so Enter saves as in a box.
    <textarea
      ref={control}
      id={controlId}
      rows={2}
      placeholder={input.placeholder}
      maxLength={input.maxLength}
      aria-describedby={describedBy}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/g, " "))}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }}
    />
  ) : (
    <input
      {...input}
      ref={control}
      id={controlId}
      aria-describedby={describedBy}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  const note = hint !== undefined && (
    <small className="hint" id={hintId}>
      {hint}
    </small>
  );
  // A label may hold no button, so with the emoji button the label wraps the name alone.
  if (emoji) {
    return (
      <div className="field">
        <label htmlFor={controlId}>
          <span>{label}</span>
        </label>
        <div className="emoji-field">
          {box}
          <EmojiButton field={control} onPick={onChange} />
        </div>
        {note}
      </div>
    );
  }
  return (
    <label className="field" htmlFor={controlId}>
      <span>{label}</span>
      {box}
      {note}
    </label>
  );
}

/**
 * The field a delete waits for. The value to type sits in the label, where it copies itself, and
 * the text names its place, so each language puts it where its grammar needs it.
 */
export function TypeToConfirm({
  text,
  value,
  typed,
  onChange,
  type,
}: {
  /** A sentence with one placeholder, such as "Type {name} to confirm". */
  text: TextId;
  value: string;
  typed: string;
  onChange(typed: string): void;
  type?: "email";
}) {
  const [before, after = ""] = t(text).split(/\{\w+\}/);
  return (
    <Field
      label={
        <>
          {before}
          <CopyText value={value} />
          {after}
        </>
      }
      type={type}
      value={typed}
      onChange={onChange}
      autoComplete="off"
    />
  );
}

/** A button that opens the shared emoji grid, and puts the chosen emoji in the field at its caret. */
export function EmojiButton({
  field,
  onPick,
}: {
  field: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  onPick(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div className="emoji-picker" ref={root}>
      <button
        type="button"
        className="icon-button"
        aria-label={t("emoji")}
        title={t("emoji")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="smiley" />
      </button>
      {open && (
        <fieldset
          className="emoji-grid"
          aria-label={t("emoji")}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // Escape closes the grid, and nothing behind it.
            event.stopPropagation();
            setOpen(false);
          }}
        >
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                if (field.current !== null) onPick(insertEmoji(field.current, emoji));
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** A click that moves in place: not one that asks for a new tab with a modifier key or button. */
const isPlainClick = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * A link to another screen of the app. It moves in place, as the app's buttons do, and still
 * opens a new tab with a modifier key or the middle button.
 */
export function AppLink({
  href,
  className,
  current = false,
  onOpen = () => navigate(href),
  children,
}: {
  href: string;
  className?: string;
  /** The link to the page on screen, for aria-current. */
  current?: boolean;
  /** What a plain click does in place of loading the page. */
  onOpen?(): void;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      aria-current={current ? "page" : undefined}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen();
      }}
    >
      {children}
    </a>
  );
}

/** The loading state, or why the load failed once it has. */
export function Loading({ failure = null }: { failure?: TextId | null }) {
  if (failure !== null) {
    return (
      <div className="nothing">
        <ErrorNote text={failure} />
      </div>
    );
  }
  return (
    <div className="nothing loading">
      <Pond />
      <p>{t("loading")}</p>
    </div>
  );
}

const TINT_COUNT = 4;

/** Up to two initials: "Maya Chen" gives "MC", and "maya@example.com" gives "M". */
export function initials(name: string): string {
  const words = name.split(/[\s@._-]+/).filter((word) => word !== "");
  const first = words[0] ?? name;
  const second = name.includes("@") ? undefined : words[1];
  return [first, second]
    .flatMap((word) => [...(word ?? "")].slice(0, 1))
    .join("")
    .toUpperCase();
}

/** A round tile with a picture, or with initials. The same name always gets the same tint. */
export function Avatar({
  name,
  letters,
  pictureUrl = null,
}: {
  name: string;
  letters?: string | undefined;
  pictureUrl?: string | null;
}) {
  if (pictureUrl !== null) return <img className="avatar" src={pictureUrl} alt="" />;
  const sum = [...name].reduce((total, character) => total + (character.codePointAt(0) ?? 0), 0);
  return (
    <span className={`avatar tint-${sum % TINT_COUNT}`} aria-hidden="true">
      {letters ?? initials(name)}
    </span>
  );
}

/**
 * A short label that shows above its control on hover and on keyboard focus, which a native
 * title does not do for a disabled button. The control names the tip with the given ID when the
 * tip says more than its own label.
 */
export function Tip({ text, children }: { text: string; children(tipId: string): ReactNode }) {
  const id = useId();
  return (
    <span className="tip">
      {children(id)}
      <span className="tip-text" role="tooltip" id={id}>
        {text}
      </span>
    </span>
  );
}

/**
 * A page inside the white panel: a large title, one line of context, and the page's actions on the
 * right as pills.
 */
export function Page({
  title,
  context,
  actions,
  children,
}: {
  title: string;
  context?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page" aria-label={title}>
      <PageHead title={title} context={context} actions={actions} />
      <div className="page-body">{children}</div>
    </section>
  );
}

/** One choice of a Choices control, with an icon before its words if it has one. */
export type Option<T> = { value: T; label: TextId; icon?: IconName };

/**
 * Radio buttons drawn as pills, named by a legend for screen readers. Outlined draws them as one
 * segmented control, and quiet as small words.
 */
export function Choices<T extends string>({
  label,
  variant,
  describedBy,
  value,
  options,
  onChange,
}: {
  label: string;
  variant?: "outlined" | "quiet";
  /** The ID of a hint that says more about the choice. */
  describedBy?: string | undefined;
  value: T;
  options: readonly Option<T>[];
  onChange(value: T): void;
}) {
  const name = useId();
  return (
    <fieldset
      className={variant === undefined ? "choices" : `choices ${variant}`}
      aria-describedby={describedBy}
    >
      <legend className="visually-hidden">{label}</legend>
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name={name}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.icon !== undefined && <Icon name={option.icon} size={16} />}
          {t(option.label)}
        </label>
      ))}
    </fieldset>
  );
}

/** The title, its line of context and the actions, at the top of a page or of the inbox list. */
export function PageHead({
  title,
  context,
  actions,
}: {
  title: string;
  context?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-title">
        <h2>{title}</h2>
        {context !== undefined && <p>{context}</p>}
      </div>
      {actions !== undefined && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/**
 * One row of a page: a title and its help on the left, the controls on the right, and a thin line
 * between rows. A danger row, for what cannot be undone, has a red outline.
 */
export function PageRow({
  title,
  help,
  danger = false,
  children,
}: {
  title: ReactNode;
  help?: string | undefined;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={danger ? "page-row danger-zone" : "page-row"}>
      <div className="page-about">
        <h3>{title}</h3>
        {help !== undefined && <p className="hint">{help}</p>}
      </div>
      <div className="page-controls">{children}</div>
    </section>
  );
}
