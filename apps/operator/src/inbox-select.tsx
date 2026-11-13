/** @jsxImportSource react */
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { BULK_MAX } from "../../../packages/widget/src/shared.ts";
import type { BulkAction, Conversation, Label, Member, WorkspaceApi } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { LabelDot } from "./labels.tsx";
import { Confirm, Menu, type MenuItem } from "./popup.tsx";
import { useShortcuts } from "./shortcuts.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Avatar, failureText } from "./ui.tsx";

/** How long a finger rests on a row before it starts a selection. */
const LONG_PRESS_MS = 500;

/** What a toast says once each action is done, for one conversation and for more. */
const DONE_TEXT: Record<BulkAction["action"], [TextId, TextId]> = {
  close: ["bulkClosedOne", "bulkClosedMany"],
  assign: ["bulkAssignedOne", "bulkAssignedMany"],
  label: ["bulkLabeledOne", "bulkLabeledMany"],
  mark_read: ["bulkReadOne", "bulkReadMany"],
  delete: ["bulkDeletedOne", "bulkDeletedMany"],
};

/**
 * The rows the operator picked, among those shown: a box on each row, X on the open one, Shift for
 * a range from the last one picked, and on a touch screen a long press, then taps. A row that
 * leaves the list leaves the selection. Escape clears it, also from a box, which owns its keys.
 */
export function useSelection(rows: Conversation[], current: string | null) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const chosen = rows.filter((row) => picked.has(row.id));
  // A row that comes back, such as under another filter, must not come back chosen.
  if (chosen.length < picked.size) setPicked(new Set(chosen.map((row) => row.id)));
  const toggle = (id: string, range: boolean) => {
    const from = rows.findIndex((row) => row.id === anchor.current);
    const to = rows.findIndex((row) => row.id === id);
    const span =
      range && from !== -1
        ? rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.id)
        : [id];
    const adding = !picked.has(id);
    setPicked((now) => {
      const next = new Set(now);
      for (const one of span) {
        if (adding) next.add(one);
        else next.delete(one);
      }
      return next;
    });
    anchor.current = id;
  };
  const clear = () => {
    setPicked(new Set());
    anchor.current = null;
  };
  const selectAll = () => setPicked(new Set(rows.map((row) => row.id)));
  useShortcuts({
    x: () => current !== null && toggle(current, false),
    ...(chosen.length > 0 && { Escape: clear }),
  });
  /** For a box's own keys: the shortcuts skip an input, so Escape is handled here. */
  const onBoxKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || chosen.length === 0) return;
    event.preventDefault();
    clear();
  };
  return { chosen, isPicked: (id: string) => picked.has(id), toggle, clear, selectAll, onBoxKey };
}
export type Selection = ReturnType<typeof useSelection>;

/**
 * A long press on a touch screen, which starts a selection, and the taps after it, which add rows.
 * The click that ends a long press is not a tap.
 */
export function useTouchSelect(selection: Selection, id: string) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touch = useRef(false);
  const pressed = useRef(false);
  const stop = () => clearTimeout(timer.current);
  return {
    onPointerDown(event: PointerEvent) {
      touch.current = event.pointerType === "touch";
      pressed.current = false;
      if (!touch.current) return;
      timer.current = setTimeout(() => {
        pressed.current = true;
        selection.toggle(id, false);
      }, LONG_PRESS_MS);
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
    onContextMenu(event: MouseEvent) {
      // A long press opens the phone's own menu, which a selection replaces.
      if (touch.current) event.preventDefault();
    },
    /** True when this click belongs to the selection, and must not open the conversation. */
    takesClick(): boolean {
      if (pressed.current) return true;
      if (!touch.current || selection.chosen.length === 0) return false;
      selection.toggle(id, false);
      return true;
    },
  };
}

/**
 * Runs one action on the chosen rows, and says how it went. Select all can choose more rows than
 * the server takes in one request, so they go in turns.
 */
async function runBulk(api: WorkspaceApi, ids: string[], change: BulkAction): Promise<boolean> {
  try {
    const results = [];
    for (let start = 0; start < ids.length; start += BULK_MAX) {
      results.push(...(await api.bulk(ids.slice(start, start + BULK_MAX), change)).results);
    }
    const skipped = results.filter(
      (one) => one.result === "not_found" || one.result === "not_allowed",
    ).length;
    const done = results.length - skipped;
    const [doneOne, doneMany] = DONE_TEXT[change.action];
    const sentences: TextId[] = [];
    if (done > 0) sentences.push(done === 1 ? doneOne : doneMany);
    if (skipped > 0) sentences.push(skipped === 1 ? "bulkSkippedOne" : "bulkSkippedMany");
    toast(sentences, skipped === 0, { done, skipped });
    return true;
  } catch (failure) {
    toast(failureText(failure, {}, "actionFailed"), false);
    return false;
  }
}

/** The bar's round button for one action. */
function BarButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: IconName;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="round"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={18} />
    </button>
  );
}

/**
 * The bar that takes the search's place while rows are chosen, on one row of the same height so
 * the list does not move: the box that chooses every row, the count, the actions, and the clear.
 * Mark read and Delete sit in a menu, so the bar fits the list's narrowest width. A read-only or
 * suspended workspace only reads, so the bar has Mark read alone. Delete is for owners and admins,
 * and asks first with the count.
 */
export function BulkBar({
  api,
  selection,
  total,
  members,
  labels,
  isWritable,
  mayDelete,
  onDone,
}: {
  api: WorkspaceApi;
  selection: Selection;
  /** The rows shown, which the box beside the count chooses. */
  total: number;
  members: Member[];
  labels: Label[];
  /** False while the workspace is read-only or suspended. */
  isWritable: boolean;
  mayDelete: boolean;
  onDone(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const allBox = useRef<HTMLInputElement>(null);
  const count = selection.chosen.length;
  const allChosen = count === total;
  useEffect(() => {
    if (allBox.current !== null) allBox.current.indeterminate = count > 0 && !allChosen;
  }, [count, allChosen]);
  const run = async (change: BulkAction) => {
    // The menus have no disabled state, so a second choice while one runs does nothing.
    if (busy) return;
    setBusy(true);
    const ids = selection.chosen.map((row) => row.id);
    if (await runBulk(api, ids, change)) selection.clear();
    setBusy(false);
    setConfirming(false);
    onDone();
  };
  const markRead = () => void run({ action: "mark_read" });
  const more: MenuItem[] = [
    { label: t("bulkMarkRead"), lead: <Icon name="checks" size={18} />, onSelect: markRead },
    ...(mayDelete
      ? [
          {
            label: t("deleteConversation"),
            lead: <Icon name="trash" size={18} />,
            danger: true,
            onSelect: () => setConfirming(true),
          },
        ]
      : []),
  ];
  return (
    <div className="bulk-bar" role="toolbar" aria-label={t("bulkBarLabel")} aria-busy={busy}>
      <label className="bulk-all">
        <input
          ref={allBox}
          type="checkbox"
          checked={allChosen}
          onChange={() => (allChosen ? selection.clear() : selection.selectAll())}
          onKeyDown={selection.onBoxKey}
          aria-label={t("selectAll")}
        />
        <span aria-hidden="true">{count}</span>
        <span className="visually-hidden" aria-live="polite">
          {t("bulkCount", { count })}
        </span>
      </label>
      {isWritable ? (
        <>
          <BarButton
            label={t("close")}
            icon="done"
            disabled={busy}
            onClick={() => void run({ action: "close" })}
          />
          <Menu
            label={t("bulkAssign")}
            buttonClass="round"
            side="start"
            placement="floating"
            items={[
              {
                label: t("unassigned"),
                onSelect: () => void run({ action: "assign", operatorId: null }),
              },
              ...members.map((member) => ({
                label: member.name,
                lead: <Avatar name={member.name} pictureUrl={member.pictureUrl} />,
                onSelect: () => void run({ action: "assign", operatorId: member.id }),
              })),
            ]}
          >
            <Icon name="user" size={18} />
          </Menu>
          {labels.length > 0 && (
            <Menu
              label={t("bulkLabel")}
              buttonClass="round"
              side="start"
              placement="floating"
              items={labels.map((one) => ({
                label: one.name,
                lead: <LabelDot color={one.color} />,
                onSelect: () => void run({ action: "label", labelId: one.id }),
              }))}
            >
              <Icon name="tag" size={18} />
            </Menu>
          )}
          <Menu label={t("moreActions")} items={more} buttonClass="round" placement="floating">
            <Icon name="dots" size={18} />
          </Menu>
        </>
      ) : (
        <BarButton label={t("bulkMarkRead")} icon="checks" disabled={busy} onClick={markRead} />
      )}
      <button
        type="button"
        className="icon-button bulk-clear"
        aria-label={t("bulkClear")}
        title={t("bulkClear")}
        onClick={selection.clear}
      >
        <Icon name="close" size={18} />
      </button>
      {confirming && (
        <Confirm
          title={count === 1 ? t("bulkDeleteOne") : t("bulkDeleteMany", { count })}
          text={t("bulkDeleteText")}
          confirm={t("deleteYes")}
          disabled={busy}
          onConfirm={() => void run({ action: "delete" })}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
