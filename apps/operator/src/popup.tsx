/** @jsxImportSource react */
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { t } from "./text.ts";
import { Icon, useModal } from "./ui.tsx";

type Side = "start" | "end";
type Direction = "down" | "up";

const TYPE_AHEAD_MS = 600;

/**
 * The shared part of a dropdown and a menu: a button that opens a popup of items, the keyboard
 * (arrows, Home, End, type to jump, Enter, Escape, Tab) and a click outside that closes it. The
 * popup keeps the focus and names its active item with aria-activedescendant.
 */
function usePopup(labels: string[], start: () => number) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();

  const show = (at = start()) => {
    setActive(Math.max(0, Math.min(at, labels.length - 1)));
    setOpen(true);
  };
  const hide = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useLayoutEffect(() => {
    if (open) popup.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (open)
      popup.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const jump = (key: string) => {
    const now = Date.now();
    const text = (
      (now - typed.current.at > TYPE_AHEAD_MS ? "" : typed.current.text) + key
    ).toLowerCase();
    typed.current = { text, at: now };
    const count = labels.length;
    // A repeated letter steps through the items that start with it.
    const repeat = [...text].every((character) => character === text[0]);
    const from = repeat ? active + 1 : active;
    for (let step = 0; step < count; step += 1) {
      const index = (from + step) % count;
      const label = (labels[index] ?? "").toLowerCase();
      if (label.startsWith(repeat ? (text[0] ?? "") : typed.current.text)) {
        setActive(index);
        return;
      }
    }
  };

  const onButtonKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show(event.key === "ArrowUp" && start() === 0 ? labels.length - 1 : start());
    }
  };

  /** Handles the popup's keys, and calls `choose` for Enter and Space. */
  const onPopupKey = (event: KeyboardEvent, choose: (index: number) => void) => {
    const last = labels.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(active + 1, last),
      ArrowUp: Math.max(active - 1, 0),
      // A menu's row of icons reads left to right.
      ArrowRight: Math.min(active + 1, last),
      ArrowLeft: Math.max(active - 1, 0),
      Home: 0,
      End: last,
      PageDown: Math.min(active + 5, last),
      PageUp: Math.max(active - 5, 0),
    };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      setActive(move);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide(true);
    } else if (event.key === "Tab") {
      hide(false);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      jump(event.key);
    }
  };

  const itemId = (index: number) => `${id}-${index}`;
  return {
    open,
    active,
    setActive,
    wrap,
    button,
    popup,
    show,
    hide,
    onButtonKey,
    onPopupKey,
    itemId,
    id,
  };
}

interface Choice<V extends string> {
  value: V;
  label: string;
  /** A picture before the label, such as an avatar. */
  lead?: ReactNode;
}

/**
 * The app's dropdown, in place of a native select: a button, and a listbox of choices with a check
 * on the chosen one.
 */
export function Select<V extends string>({
  label,
  value,
  choices,
  onChange,
  disabled = false,
  side = "start",
  className = "",
  hideLabel = true,
}: {
  /** What the choice is for. Screen readers read it with the chosen value. */
  label: string;
  value: V;
  choices: Choice<V>[];
  onChange(value: V): void;
  disabled?: boolean;
  /** The edge of the button that the popup lines up with. */
  side?: Side;
  className?: string;
  /** False shows the label above the button, as a field. */
  hideLabel?: boolean;
}) {
  const chosen = Math.max(
    0,
    choices.findIndex((choice) => choice.value === value),
  );
  const popup = usePopup(
    choices.map((choice) => choice.label),
    () => chosen,
  );
  const current = choices[chosen];
  const choose = (index: number) => {
    const next = choices[index];
    popup.hide(true);
    if (next !== undefined && next.value !== value) onChange(next.value);
  };
  const labelId = `${popup.id}-label`;
  const valueId = `${popup.id}-value`;
  return (
    <div className={`select ${className}`} ref={popup.wrap}>
      <span id={labelId} className={hideLabel ? "visually-hidden" : "select-label"}>
        {label}
      </span>
      <button
        ref={popup.button}
        type="button"
        className="select-button"
        aria-haspopup="listbox"
        aria-expanded={popup.open}
        aria-labelledby={`${labelId} ${valueId}`}
        disabled={disabled}
        onClick={() => (popup.open ? popup.hide(false) : popup.show())}
        onKeyDown={popup.onButtonKey}
      >
        {current?.lead}
        <span id={valueId} className="select-value">
          {current?.label}
        </span>
        {/* A locked choice shows a lock: the page says why next to it. */}
        <Icon name={disabled ? "lock" : "chevron"} size={disabled ? 14 : 12} />
      </button>
      {popup.open && (
        <div
          ref={popup.popup}
          className={`popup side-${side}`}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelId}
          aria-activedescendant={popup.itemId(popup.active)}
          onKeyDown={(event) => popup.onPopupKey(event, choose)}
        >
          {choices.map((choice, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys.
            <div
              key={choice.value}
              id={popup.itemId(index)}
              data-index={index}
              role="option"
              // Focus stays on the listbox, which names this option as its active one.
              tabIndex={-1}
              aria-selected={choice.value === value}
              className={index === popup.active ? "item active" : "item"}
              onPointerMove={() => popup.setActive(index)}
              onClick={() => choose(index)}
            >
              {choice.lead}
              <span className="item-label">{choice.label}</span>
              {choice.value === value && <Icon name="check" size={16} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect(): void;
  /** A picture before the label: an icon's name, or any node such as initials. */
  lead?: ReactNode;
  /** For a choice among items, such as the current workspace: a check, read as checked. */
  checked?: boolean;
  danger?: boolean;
  /** A line above this item, to set a group apart. */
  divider?: boolean;
}

/** A labeled row of choices shown as their icons alone, such as the theme. */
export interface MenuRow {
  label: string;
  lead?: ReactNode;
  /** Each choice's label stays its accessible name and its tooltip. */
  choices: MenuItem[];
  divider?: boolean;
}

/** A button that opens a menu of actions. */
export function Menu({
  label,
  items,
  children,
  buttonClass,
  side = "end",
  direction = "down",
  className = "",
}: {
  /** The button's accessible name. */
  label: string;
  /** The items, top to bottom. */
  items: (MenuItem | MenuRow)[];
  /** What the button shows. */
  children: ReactNode;
  buttonClass: string;
  side?: Side;
  direction?: Direction;
  className?: string;
}) {
  // The keys move through the items in order, rows included.
  const flat = items.flatMap((entry) => ("choices" in entry ? entry.choices : entry));
  const popup = usePopup(
    flat.map((item) => item.label),
    () => 0,
  );
  const choose = (index: number) => {
    popup.hide(true);
    flat[index]?.onSelect();
  };
  const renderItem = (item: MenuItem, inRow = false) => {
    const index = flat.indexOf(item);
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the menu handles the keys.
      // biome-ignore lint/a11y/noStaticElementInteractions: the role is menuitem or menuitemradio.
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is on menuitemradio only.
      <div
        key={index}
        id={popup.itemId(index)}
        data-index={index}
        role={item.checked === undefined ? "menuitem" : "menuitemradio"}
        tabIndex={-1}
        aria-checked={item.checked}
        aria-label={inRow ? item.label : undefined}
        title={inRow ? item.label : undefined}
        className={[
          "item",
          index === popup.active && "active",
          item.danger === true && "danger",
          item.divider === true && !inRow && "divided",
        ]
          .filter(Boolean)
          .join(" ")}
        onPointerMove={() => popup.setActive(index)}
        onClick={() => choose(index)}
      >
        {item.lead}
        {!inRow && <span className="item-label">{item.label}</span>}
        {item.checked === true && !inRow && <Icon name="check" size={16} />}
      </div>
    );
  };
  return (
    <div className={`menu-wrap ${className}`} ref={popup.wrap}>
      <button
        ref={popup.button}
        type="button"
        className={buttonClass}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={popup.open}
        onClick={() => (popup.open ? popup.hide(false) : popup.show())}
        onKeyDown={popup.onButtonKey}
      >
        {children}
      </button>
      {popup.open && (
        <div
          ref={popup.popup}
          className={`popup side-${side} ${direction}`}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={popup.itemId(popup.active)}
          onKeyDown={(event) => popup.onPopupKey(event, choose)}
        >
          {items.map((entry) =>
            "choices" in entry ? (
              // biome-ignore lint/a11y/useSemanticElements: a menu holds menu items and groups, not a fieldset.
              <div
                key={entry.label}
                className={entry.divider === true ? "item-row divided" : "item-row"}
                role="group"
                aria-label={entry.label}
              >
                {entry.lead}
                <span className="item-label" aria-hidden="true">
                  {entry.label}
                </span>
                <span className="item-choices">
                  {entry.choices.map((item) => renderItem(item, true))}
                </span>
              </div>
            ) : (
              renderItem(entry)
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A small modal that asks before something that cannot be undone. The safe choice comes first, so
 * it has the focus unless a field does, and Escape or a click outside keeps things as they were.
 */
export function Confirm({
  title,
  text,
  confirm,
  onConfirm,
  onCancel,
  disabled = false,
  children,
}: {
  title: string;
  text: ReactNode;
  confirm: string;
  onConfirm(): void;
  onCancel(): void;
  /** The confirm button waits, as while the change runs or until a field is right. */
  disabled?: boolean;
  /** More, between the text and the buttons, such as a field or an error. */
  children?: ReactNode;
}) {
  const dialog = useModal();
  const titleId = useId();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a dialog.
    <dialog
      ref={dialog}
      className="dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      onClose={onCancel}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself.
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-text">{text}</div>
        {children}
        <div className="dialog-actions">
          <button type="button" className="pill" onClick={() => dialog.current?.close()}>
            {t("cancel")}
          </button>
          <button type="submit" className="pill danger" disabled={disabled}>
            {confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}
