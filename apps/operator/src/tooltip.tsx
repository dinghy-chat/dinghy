/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How long the pointer rests before the first tooltip, and how soon after one the next is instant. */
const SHOW_MS = 450;
const CHAIN_MS = 300;
/** The tooltip's distance from its element, and from the window's edges. */
const GAP_PX = 6;
const EDGE_PX = 8;

/** Anything with a title, and a button or link with no text of its own, named by its aria-label. */
const TARGET = '[title], button[aria-label], a[aria-label], [role="button"][aria-label]';

/** The element under `node` that shows a tooltip, and what it says. A field keeps its own title. */
function find(node: EventTarget | null): { element: HTMLElement; text: string } | null {
  if (!(node instanceof Element)) return null;
  const element = node.closest<HTMLElement>(TARGET);
  if (element === null || element.matches("input, textarea, select")) return null;
  if (element.getAttribute("aria-expanded") === "true") return null;
  const title = element.title;
  if (title !== "") return { element, text: title };
  const label = element.getAttribute("aria-label") ?? "";
  if (label === "" || element.textContent?.trim() !== "") return null;
  return { element, text: label };
}

/**
 * One tooltip for the whole app, shown on hover with a mouse or on focus from the keyboard, so every
 * icon says what it does. It reads the element's title, or the aria-label of a button with only an
 * icon. While it shows, the title moves aside, so the browser's own tooltip does not show as well.
 */
export function Tooltips() {
  const [tip, setTip] = useState<{ element: HTMLElement; text: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown: HTMLElement | null = null;
    let hiddenAt = 0;
    const hide = () => {
      clearTimeout(timer);
      if (shown === null) return;
      // Back as it was, unless React wrote a new title meanwhile.
      if (shown.dataset.tip !== undefined && !shown.hasAttribute("title")) {
        shown.title = shown.dataset.tip;
      }
      delete shown.dataset.tip;
      shown = null;
      hiddenAt = Date.now();
      setTip(null);
    };
    const start = (target: EventTarget | null) => {
      const found = find(target);
      if (found?.element === shown) return;
      hide();
      if (found === null) return;
      const { element, text } = found;
      shown = element;
      if (element.title !== "") {
        element.dataset.tip = element.title;
        element.removeAttribute("title");
      }
      const show = () => setTip({ element, text });
      if (Date.now() - hiddenAt < CHAIN_MS) show();
      else timer = setTimeout(show, SHOW_MS);
    };
    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "mouse") start(event.target);
    };
    const onOut = (event: PointerEvent) => {
      if (shown !== null && !shown.contains(event.relatedTarget as Node | null)) hide();
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.matches(":focus-visible")) {
        start(event.target);
      }
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && hide();
    addEventListener("pointerover", onOver);
    addEventListener("pointerout", onOut);
    addEventListener("pointerdown", hide, true);
    addEventListener("focusin", onFocus);
    addEventListener("focusout", hide);
    addEventListener("keydown", onKey);
    addEventListener("scroll", hide, true);
    return () => {
      hide();
      removeEventListener("pointerover", onOver);
      removeEventListener("pointerout", onOut);
      removeEventListener("pointerdown", hide, true);
      removeEventListener("focusin", onFocus);
      removeEventListener("focusout", hide);
      removeEventListener("keydown", onKey);
      removeEventListener("scroll", hide, true);
    };
  }, []);

  // Under its element, or over it near the window's bottom, and kept inside the window.
  useLayoutEffect(() => {
    const element = box.current;
    if (tip === null || element === null) return;
    const at = tip.element.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = element;
    const below = at.bottom + GAP_PX + height + EDGE_PX <= innerHeight;
    const left = at.left + at.width / 2 - width / 2;
    Object.assign(element.style, {
      top: `${below ? at.bottom + GAP_PX : at.top - GAP_PX - height}px`,
      left: `${Math.max(EDGE_PX, Math.min(left, innerWidth - width - EDGE_PX))}px`,
    });
  }, [tip]);

  if (tip === null) return null;
  // Screen readers already have the label, so the tooltip is only for the eye.
  return (
    <div ref={box} className="tooltip" aria-hidden="true">
      {tip.text}
    </div>
  );
}
