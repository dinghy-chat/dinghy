/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Icon } from "./icons.tsx";
import { type TextId, t } from "./text.ts";

/** How long a toast stays. A screen reader reads it from its live region at once. */
const TOAST_MS = 3500;

interface Toast {
  id: number;
  text: string;
  ok: boolean;
}

let next = 0;
const shown = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];

const publish = (list: Toast[]) => {
  toasts = list;
  for (const listener of shown) listener(list);
};

/**
 * A short message at the bottom of the screen, such as "Saved.", which goes by itself. A failure
 * that the operator must fix stays next to its field instead.
 */
export function toast(
  text: TextId | TextId[],
  ok = true,
  values: Record<string, number> = {},
): void {
  const id = next++;
  const sentences = (Array.isArray(text) ? text : [text]).map((one) => t(one, values));
  // One at a time: a second save replaces the first message.
  publish([{ id, text: sentences.join(" "), ok }]);
  setTimeout(() => publish(toasts.filter((one) => one.id !== id)), TOAST_MS);
}

/** Where toasts show. The app renders it once. */
export function Toaster() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    shown.add(setList);
    return () => {
      shown.delete(setList);
    };
  }, []);
  return (
    // The region is live while empty, so a screen reader reads each toast. Only a toast is a
    // status, so an empty region is not one more on the page.
    <div className="toasts" aria-live="polite">
      {list.map((one) => (
        <p key={one.id} className={one.ok ? "toast" : "toast bad-toast"} role="status">
          <Icon name={one.ok ? "check" : "warning"} size={16} />
          {one.text}
        </p>
      ))}
    </div>
  );
}
