/** @jsxImportSource react */
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "./icons.tsx";
import { Keys, useShortcutsOn, withKey } from "./shortcuts.tsx";
import { t } from "./text.ts";
import { useModal } from "./ui.tsx";

type Side = "start" | "end";
/** Where a menu opens: under its button, over it, or placed in the window, out of any scrolling area. */
type Placement = "down" | "up" | "floating";

const TYPE_AHEAD_MS = 600;
/** A floating popup's distance from its button, and from the window's edges. */
const POPUP_GAP_PX = 6;
const WINDOW_MARGIN_PX = 12;
/** The height a popup may take before it scrolls, as `.popup` sets in the CSS. */
const POPUP_MAX_HEIGHT_PX = 320;

/** Closes an open popup when a press lands outside `wrap`, its button and the popup. */
function useOutsidePress(open: boolean, wrap: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, wrap, close]);
}

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
  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (open) popup.current?.focus();
  }, [open]);

  useOutsidePress(open, wrap, close);

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
    close,
    onButtonKey,
    onPopupKey,
    itemId,
    id,
  };
}

/** The nearest element around `element` that scrolls or clips what it holds, or null: the window. */
function clippingElement(element: Element): Element | null {
  for (let box = element.parentElement; box !== null; box = box.parentElement) {
    if (getComputedStyle(box).overflowY !== "visible") return box;
  }
  return null;
}

/**
 * Places an open popup in the window, out of any area that scrolls or clips it, such as the thread
 * above the reply field: under its button, or over it when there is more room there, lined up with
 * `side` of the button and kept inside the window. It follows its button when the thread scrolls,
 * as it does when a message arrives, and closes once the button scrolls out of view.
 */
function useFloating(
  open: boolean,
  button: RefObject<HTMLButtonElement | null>,
  popup: RefObject<HTMLDivElement | null>,
  side: Side,
  close: () => void,
) {
  useLayoutEffect(() => {
    if (!open || button.current === null) return;
    // Found once, as reading the styles on each scroll event would cost too much.
    const clipping = clippingElement(button.current);
    const place = () => {
      const element = popup.current;
      const anchor = button.current;
      if (element === null || anchor === null) return;
      const at = anchor.getBoundingClientRect();
      const view = clipping?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
      if (at.bottom < view.top || at.top > view.bottom) return close();
      const below = innerHeight - at.bottom - POPUP_GAP_PX - WINDOW_MARGIN_PX;
      const above = at.top - POPUP_GAP_PX - WINDOW_MARGIN_PX;
      const down = element.offsetHeight <= below || below >= above;
      const width = element.offsetWidth;
      const left = side === "end" ? at.right - width : at.left;
      Object.assign(element.style, {
        top: down ? `${at.bottom + POPUP_GAP_PX}px` : "auto",
        bottom: down ? "auto" : `${innerHeight - at.top + POPUP_GAP_PX}px`,
        left: `${Math.max(WINDOW_MARGIN_PX, Math.min(left, innerWidth - width - WINDOW_MARGIN_PX))}px`,
        maxHeight: `${Math.min(down ? below : above, POPUP_MAX_HEIGHT_PX)}px`,
      });
      // The inline position wins over the class's, which only picks the animation that rises.
      element.classList.toggle("up", !down);
    };
    place();
    const onScroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) place();
    };
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", close);
    return () => {
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", close);
    };
  }, [open, button, popup, side, close]);
}

interface Choice<V extends string> {
  value: V;
  label: string;
  /** A picture before the label, such as an avatar. */
  lead?: ReactNode;
  /** A second line under the label, in the list. */
  detail?: string;
  /** Small words at the end, in the button and the list, such as a role. */
  note?: string;
  /** A heading over the first choice of a group, such as "People". */
  group?: string;
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
  shortcut,
}: {
  /** What the choice is for. Screen readers read it with the chosen value. */
  label: string;
  /** The key that opens the choices from anywhere. */
  shortcut?: string;
  value: V;
  choices: Choice<V>[];
  onChange(value: V): void;
  disabled?: boolean;
  /** The edge of the button that the popup lines up with. */
  side?: Side;
  className?: string;
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
  const keysOn = useShortcutsOn();
  const choose = (index: number) => {
    const next = choices[index];
    popup.hide(true);
    if (next !== undefined && next.value !== value) onChange(next.value);
  };
  const labelId = `${popup.id}-label`;
  const valueId = `${popup.id}-value`;
  return (
    <div className={`select ${className}`} ref={popup.wrap}>
      <span id={labelId} className="visually-hidden">
        {label}
      </span>
      <button
        ref={popup.button}
        type="button"
        className="select-button"
        data-shortcut={shortcut}
        title={shortcut === undefined ? undefined : withKey(label, shortcut, keysOn)}
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
        {current?.note !== undefined && <small className="select-note">{current.note}</small>}
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
            <Fragment key={choice.value}>
              {choice.group !== undefined && choice.group !== choices[index - 1]?.group && (
                // Each option names itself, so the heading is only for the eye.
                <p className="menu-label" aria-hidden="true">
                  {choice.group}
                </p>
              )}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys. */}
              <div
                id={popup.itemId(index)}
                data-index={index}
                role="option"
                // Focus stays on the listbox, which names this option as its active one.
                tabIndex={-1}
                aria-selected={choice.value === value}
                aria-describedby={
                  choice.detail === undefined ? undefined : `${popup.itemId(index)}-detail`
                }
                className={index === popup.active ? "item active" : "item"}
                onPointerMove={() => popup.setActive(index)}
                onClick={() => choose(index)}
              >
                {choice.lead}
                <span className="item-label">
                  {choice.label}
                  {choice.detail !== undefined && (
                    <small id={`${popup.itemId(index)}-detail`}>{choice.detail}</small>
                  )}
                </span>
                {choice.note !== undefined && <small className="select-note">{choice.note}</small>}
                {choice.value === value && <Icon name="check" size={16} />}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export interface MenuItem {
  label: string;
  /** What choosing it does. An item with a submenu opens it instead. */
  onSelect?(): void;
  /** A picture before the label: an icon's name, or any node such as initials. */
  lead?: ReactNode;
  /** For a choice among items, such as the current workspace: a check, read as checked. */
  checked?: boolean;
  /** For an item that turns something on or off: a small switch that shows its state. */
  switched?: boolean;
  danger?: boolean;
  /** A line above this item, to set a group apart. */
  divider?: boolean;
  /** Something small after the label, such as a count. */
  trail?: ReactNode;
  /** The key that runs it from anywhere, drawn after the label. */
  shortcut?: string;
  /** Why it cannot be chosen now, shown under its label. */
  unavailable?: string;
  /**
   * Choices beside the menu, which open on hover with a mouse. On a touch screen or a narrow one
   * they take the menu's place when this item is chosen, under a row that goes back.
   */
  submenu?: MenuItem[];
}

/** A mouse, and room beside the menu for a submenu. */
const SUBMENU_BESIDE = "(hover: hover) and (pointer: fine) and (min-width: 761px)";

/** One row of a menu. */
function MenuRow({
  item,
  id,
  index,
  active,
  onPoint,
  onChoose,
}: {
  item: MenuItem;
  id: string;
  index: number;
  active: boolean;
  onPoint(): void;
  onChoose(): void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the menu handles the keys.
    // biome-ignore lint/a11y/noStaticElementInteractions: the role is a menu item's.
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is on the radio and checkbox items only.
    <div
      id={id}
      data-index={index}
      role={
        item.switched !== undefined
          ? "menuitemcheckbox"
          : item.checked === undefined
            ? "menuitem"
            : "menuitemradio"
      }
      tabIndex={-1}
      aria-checked={item.checked ?? item.switched}
      aria-disabled={item.unavailable === undefined ? undefined : true}
      aria-haspopup={item.submenu === undefined ? undefined : "menu"}
      className={[
        "item",
        active && "active",
        item.danger === true && "danger",
        item.divider === true && "divided",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerMove={onPoint}
      onClick={onChoose}
    >
      {item.lead}
      <span className="item-label">
        {item.label}
        {item.unavailable !== undefined && <small>{item.unavailable}</small>}
      </span>
      {item.trail}
      {item.shortcut !== undefined && <Keys keys={item.shortcut} />}
      {item.switched !== undefined && (
        <i className={item.switched ? "mini-switch on" : "mini-switch"} aria-hidden="true" />
      )}
      {item.checked === true && <Icon name="check" size={16} />}
      {item.submenu !== undefined && <Icon name="chevronRight" size={14} />}
    </div>
  );
}

/** A button that opens a menu of actions. */
export function Menu({
  label,
  items,
  children,
  buttonClass,
  side = "end",
  placement = "down",
  className = "",
  shortcut,
}: {
  /** The button's accessible name. */
  label: string;
  items: MenuItem[];
  /** What the button shows. */
  children: ReactNode;
  buttonClass: string;
  /** The key that opens the menu from anywhere. */
  shortcut?: string;
  side?: Side;
  placement?: Placement;
  className?: string;
}) {
  // The item whose submenu is open, beside the menu or in its place.
  const [opened, setOpened] = useState<number | null>(null);
  // The active choice of a submenu beside the menu, or null while the keys are on the menu.
  const [sub, setSub] = useState<number | null>(null);
  const [beside, setBeside] = useState(false);
  const keysOn = useShortcutsOn();
  const flyout = useRef<HTMLDivElement>(null);
  const submenu = opened === null ? undefined : items[opened];
  const inPlace = submenu !== undefined && !beside;
  const shown = inPlace ? (submenu.submenu ?? []) : items;
  const offset = inPlace ? 1 : 0;
  const popup = usePopup(
    [...(inPlace ? [t("back")] : []), ...shown.map((item) => item.label)],
    () => 0,
  );
  const floating = placement === "floating";
  useFloating(floating && popup.open, popup.button, popup.popup, side, popup.close);
  useEffect(() => {
    if (popup.open) setBeside(matchMedia(SUBMENU_BESIDE).matches);
    else {
      setOpened(null);
      setSub(null);
    }
  }, [popup.open]);
  // Lines the submenu up with its item, on the side of the menu away from the window's edge.
  useLayoutEffect(() => {
    const menu = popup.popup.current;
    const element = flyout.current;
    const row = menu?.querySelector<HTMLElement>(`[data-index="${opened}"]`);
    if (!beside || menu == null || element === null || row == null) return;
    const across = `${menu.offsetWidth + 4}px`;
    Object.assign(element.style, {
      top: `${menu.offsetTop + row.offsetTop - menu.scrollTop - 6}px`,
      [side === "end" ? "right" : "left"]: across,
    });
  }, [beside, opened, side, popup.popup]);

  const close = () => {
    setOpened(null);
    setSub(null);
  };
  const back = () => {
    popup.setActive(opened ?? 0);
    close();
  };
  const run = (item: MenuItem | undefined) => {
    if (item === undefined || item.unavailable !== undefined) return;
    popup.hide(true);
    item.onSelect?.();
  };
  const choose = (index: number) => {
    if (inPlace && index === 0) return back();
    const item = shown[index - offset];
    if (item?.submenu === undefined) return run(item);
    setOpened(index);
    if (beside) setSub(0);
    else popup.setActive(1);
  };
  const subItems = beside ? (submenu?.submenu ?? []) : [];
  const onSubKey = (event: KeyboardEvent, at: number) => {
    const moves: Record<string, number> = {
      ArrowDown: Math.min(at + 1, subItems.length - 1),
      ArrowUp: Math.max(at - 1, 0),
      Home: 0,
      End: subItems.length - 1,
    };
    const move = moves[event.key];
    if (move !== undefined) setSub(move);
    else if (event.key === "Enter" || event.key === " ") run(subItems[at]);
    else if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") return popup.hide(false);
    else return;
    event.preventDefault();
  };
  const onKey = (event: KeyboardEvent) => {
    if (sub !== null) return onSubKey(event, sub);
    const item = shown[popup.active - offset];
    if (event.key === "ArrowRight" && item?.submenu !== undefined) {
      event.preventDefault();
      choose(popup.active);
    } else if (inPlace && (event.key === "ArrowLeft" || event.key === "Escape")) {
      event.preventDefault();
      event.stopPropagation();
      back();
    } else {
      popup.onPopupKey(event, choose);
    }
  };
  /** The pointer on an item: it becomes the active one, and opens its submenu beside the menu. */
  const point = (index: number) => {
    popup.setActive(index);
    if (!beside) return;
    setSub(null);
    setOpened(items[index]?.submenu === undefined ? null : index);
  };
  const subId = (at: number) => `${popup.id}-sub-${at}`;
  return (
    <div className={`popup-wrap ${className}`} ref={popup.wrap}>
      <button
        ref={popup.button}
        type="button"
        className={buttonClass}
        aria-label={label}
        data-shortcut={shortcut}
        title={shortcut === undefined ? undefined : withKey(label, shortcut, keysOn)}
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
          className={floating ? "popup floating" : `popup side-${side} ${placement}`}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={sub === null ? popup.itemId(popup.active) : subId(sub)}
          onKeyDown={onKey}
        >
          {inPlace && (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the menu handles the keys.
            <div
              id={popup.itemId(0)}
              data-index={0}
              role="menuitem"
              tabIndex={-1}
              aria-label={t("back")}
              className={popup.active === 0 ? "item submenu-back active" : "item submenu-back"}
              onPointerMove={() => popup.setActive(0)}
              onClick={back}
            >
              <Icon name="back" size={16} />
              <span className="item-label">{submenu.label}</span>
            </div>
          )}
          {shown.map((item, at) => {
            const index = at + offset;
            return (
              <MenuRow
                key={`${inPlace}-${index}`}
                item={item}
                id={popup.itemId(index)}
                index={index}
                active={index === popup.active && (sub === null || index === opened)}
                onPoint={() => point(index)}
                onChoose={() => choose(index)}
              />
            );
          })}
        </div>
      )}
      {popup.open && submenu !== undefined && beside && (
        // The keys stay on the menu, which names the active choice here.
        <div ref={flyout} className="popup submenu" role="menu" aria-label={submenu.label}>
          {subItems.map((item, at) => (
            <MenuRow
              // biome-ignore lint/suspicious/noArrayIndexKey: the choices never move.
              key={at}
              item={item}
              id={subId(at)}
              index={at}
              active={at === sub}
              onPoint={() => setSub(at)}
              onChoose={() => run(item)}
            />
          ))}
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
  cancel = t("cancel"),
  onConfirm,
  onCancel,
  disabled = false,
  children,
}: {
  title: string;
  text: ReactNode;
  confirm: string;
  /** The safe choice's label. */
  cancel?: string;
  onConfirm(): void;
  onCancel(): void;
  /** The confirm button waits, as while the change runs or until a field is right. */
  disabled?: boolean;
  /** More, between the text and the buttons, such as a field or an error. */
  children?: ReactNode;
}) {
  const dialog = useModal();
  const titleId = useId();
  // A field is what the confirm waits for, so it takes the focus from a link or a button above it.
  useEffect(() => {
    dialog.current?.querySelector("input")?.focus();
  }, [dialog]);
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
            {cancel}
          </button>
          <button type="submit" className="pill danger" disabled={disabled}>
            {confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * A button that opens a small card of controls under it, such as the Inbox's filters. A click
 * outside, Escape or Tab past its last control closes it, and Escape gives the focus back.
 */
export function Popover({
  label,
  title,
  children,
  buttonClass,
  buttonContent,
  shortcut,
}: {
  /** The button's accessible name. */
  label: string;
  /** The card's heading. */
  title: string;
  children: ReactNode;
  buttonClass: string;
  buttonContent: ReactNode;
  /** The key that opens the card from anywhere. */
  shortcut?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const keysOn = useShortcutsOn();
  // A card with a field to type in starts there, and one of choices on the chosen one.
  useLayoutEffect(() => {
    if (open)
      card.current?.querySelector<HTMLElement>("input[type='text'], input:checked")?.focus();
  }, [open]);
  const close = useCallback(() => setOpen(false), []);
  useOutsidePress(open, wrap, close);

  return (
    <div className="popup-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={buttonClass}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-shortcut={shortcut}
        title={shortcut === undefined ? undefined : withKey(label, shortcut, keysOn)}
        onClick={() => setOpen(!open)}
      >
        {buttonContent}
      </button>
      {open && (
        <div
          ref={card}
          className="popup popover side-end"
          role="dialog"
          aria-labelledby={titleId}
          onBlur={(event) => {
            // Tab past the last control. A click on the card's padding moves the focus nowhere.
            const to = event.relatedTarget;
            if (to !== null && !wrap.current?.contains(to)) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
            button.current?.focus();
          }}
        >
          <h3 id={titleId} className="popover-title">
            {title}
          </h3>
          {children}
        </div>
      )}
    </div>
  );
}
