/** @jsxImportSource react */
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { readStored, store } from "./stored.ts";
import { type TextId, t } from "./text.ts";
import { DocLink, useModal } from "./ui.tsx";

// Single keys run the app, as in Gmail. A button with `data-shortcut` runs on its key, so the key
// and the button that shows it cannot drift apart. Speech input types letters too, so the operator
// can turn the keys off (WCAG 2.1.4).

const KEY = "dinghy:shortcuts";
/** How long the second key of a pair such as G then I may wait. */
const SEQUENCE_MS = 1000;

let isOn = readStored(KEY) !== "off";
const listeners = new Set<() => void>();
const showState = () => {
  document.documentElement.dataset.shortcuts = isOn ? "on" : "off";
};
showState();

function setShortcutsOn(on: boolean): void {
  isOn = on;
  store(KEY, on ? null : "off");
  showState();
  for (const listener of listeners) listener();
}

export function useShortcutsOn(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => isOn,
  );
}

const shown = (element: Element) => element.getClientRects().length > 0;

/** Where a key types or picks something itself: a field, the composer, a menu or a dialog. */
const OWNS_KEYS =
  "input, textarea, select, [contenteditable='true'], [role='menu'], [role='listbox'], dialog";
/** Open over the page, so Escape is for it, even when a click left the focus elsewhere. */
const OPEN_OVER = "[role='menu'], [role='listbox'], dialog[open]";

/** A plain key, pressed outside anything that takes keys itself, with nothing open over the page. */
function isShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  // A page that hides the Inbox keeps its open menus mounted, so only a visible one counts.
  if ([...document.querySelectorAll(OPEN_OVER)].some(shown)) return false;
  return !(event.target instanceof Element && event.target.closest(OWNS_KEYS) !== null);
}

/** A key, or two in a row such as "g i", and what it does. */
type Keys = Record<string, () => void>;
const registered = new Set<{ current: Keys }>();
let first: { key: string; at: number } | null = null;

function onKey(event: KeyboardEvent) {
  if (!isOn || event.defaultPrevented || !isShortcut(event)) return;
  const { key } = event;
  const pair = first !== null && Date.now() - first.at < SEQUENCE_MS ? `${first.key} ${key}` : null;
  first = null;
  const maps = [...registered].map((keys) => keys.current);
  for (const combo of pair === null ? [key] : [pair, key]) {
    const run = maps.find((keys) => keys[combo] !== undefined)?.[combo];
    const button = [
      ...document.querySelectorAll<HTMLElement>(`[data-shortcut="${CSS.escape(combo)}"]`),
    ].find(shown);
    if (run === undefined && button === undefined) continue;
    event.preventDefault();
    if (run !== undefined) run();
    else button?.click();
    return;
  }
  if (maps.some((keys) => Object.keys(keys).some((combo) => combo.startsWith(`${key} `)))) {
    first = { key, at: Date.now() };
  }
}

/** Runs each key's action while the component shows. The latest actions run, with no re-render. */
export function useShortcuts(keys: Keys): void {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    if (registered.size === 0) document.addEventListener("keydown", onKey);
    registered.add(latest);
    return () => {
      registered.delete(latest);
      if (registered.size === 0) document.removeEventListener("keydown", onKey);
    };
  }, []);
}

const KEY_NAMES: Record<string, string> = { Escape: "Esc", ArrowDown: "↓", ArrowUp: "↑" };
const keyName = (key: string) => KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);

/** "Close (E)", for a button's tooltip, while the keys are on. */
export function withKey(name: string, key: string, on: boolean): string {
  return on ? t("withShortcut", { name, keys: key.split(" ").map(keyName).join(" ") }) : name;
}

/**
 * A key drawn as a small cap, such as G I. Only for the eye: the help sheet and the tooltips say
 * the keys in words. CSS hides it on a touch screen and while the keys are off.
 */
export function Keys({ keys }: { keys: string }) {
  return (
    <span className="keys" aria-hidden="true">
      {keys.split(" ").map((key) => (
        // The CSS draws the letter, so it stays out of the button's text.
        <kbd key={key} data-key={keyName(key)} />
      ))}
    </span>
  );
}

const GROUPS: { title: TextId; rows: [keys: string, text: TextId][] }[] = [
  {
    title: "keysGroupAnywhere",
    rows: [
      ["?", "keysHelp"],
      ["/", "keysSearch"],
      ["g i", "keysGoInbox"],
      ["g c", "keysGoContacts"],
      ["g v", "keysGoVisitors"],
      ["g a", "keysGoAnalytics"],
      ["g s", "keysGoSettings"],
    ],
  },
  {
    title: "keysGroupInbox",
    rows: [
      ["j", "keysNext"],
      ["k", "keysPrevious"],
      ["Escape", "keysBack"],
    ],
  },
  {
    title: "keysGroupConversation",
    rows: [
      ["r", "keysReply"],
      ["n", "keysNote"],
      ["e", "keysClose"],
      ["a", "keysAssign"],
      ["i", "keysAssignMe"],
      [".", "keysMore"],
      ["p", "keysPanel"],
    ],
  },
  {
    title: "keysGroupComposer",
    rows: [
      ["Enter", "keysSend"],
      ["Escape", "keysLeaveComposer"],
    ],
  },
];

/** Every key, and the switch that turns the single keys off. */
export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const dialog = useModal();
  const titleId = useId();
  const on = useShortcutsOn();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a dialog.
    <dialog
      ref={dialog}
      className="dialog shortcuts"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className="dialog-body">
        <h2 id={titleId}>{t("keysTitle")}</h2>
        <div className={on ? "keys-groups" : "keys-groups off"}>
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{t(group.title)}</h3>
              <dl>
                {group.rows.map(([keys, text]) => (
                  <div key={keys + text}>
                    <dt>{t(text)}</dt>
                    <dd>
                      {/* The Keys chip hides with the keys off, so the sheet keeps its own. */}
                      {keys.split(" ").map((key) => (
                        <kbd key={key}>{keyName(key)}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <label className="check">
          <span className="setting-label">
            {t("keysOn")}
            <small className="hint">{t("keysOnHelp")}</small>
          </span>
          <input
            type="checkbox"
            checked={on}
            onChange={(event) => setShortcutsOn(event.target.checked)}
          />
        </label>
        <div className="dialog-actions">
          <DocLink path="operator-guide#keyboard-shortcuts" text="keysDocsLink" />
          <button type="button" className="pill dark" onClick={() => dialog.current?.close()}>
            {t("infoDone")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
