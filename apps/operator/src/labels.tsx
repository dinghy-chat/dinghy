/** @jsxImportSource react */
import { useId, useState } from "react";
import { LABEL_NAME_MAX } from "../../../packages/widget/src/shared.ts";
import type { Label, LabelColor } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Popover } from "./popup.tsx";
import { type TextId, t } from "./text.ts";

/** Every color a label can have, in the order Settings offers them. */
export const COLOR_TEXT: Record<LabelColor, TextId> = {
  gray: "colorGray",
  red: "colorRed",
  orange: "colorOrange",
  yellow: "colorYellow",
  green: "colorGreen",
  teal: "colorTeal",
  blue: "colorBlue",
  purple: "colorPurple",
};

/** A label's color, for the eye only: its name is always next to it. */
export function LabelDot({ color }: { color: LabelColor }) {
  return <i className="label-dot" data-color={color} aria-hidden="true" />;
}

/** The labels a conversation has, by name. An ID whose label was just deleted shows nothing. */
export function LabelPills({ labelIds, labels }: { labelIds: string[]; labels: Label[] }) {
  const shown = labels.filter((one) => labelIds.includes(one.id));
  if (shown.length === 0) return null;
  return (
    <span className="label-pills">
      {shown.map((one) => (
        <span key={one.id} className="label-pill" data-color={one.color}>
          {one.name}
        </span>
      ))}
    </span>
  );
}

const sameName = (one: string, other: string) => one.toLowerCase() === other.toLowerCase();

/** The team's labels, and what putting one on a conversation, taking it off or adding one does. */
export interface LabelPicks {
  all: Label[];
  onChange(labelId: string, added: boolean): void;
  onCreate(name: string): void;
}

/**
 * The button that opens the labels of a conversation: a field that finds a label or names a new
 * one, and a box for each label. Enter puts on or takes off the label of that name, or adds it.
 */
export function LabelPicker({ picks, labelIds }: { picks: LabelPicks; labelIds: string[] }) {
  const { all: labels, onChange, onCreate } = picks;
  const [typed, setTyped] = useState("");
  const fieldId = useId();
  const name = typed.trim();
  const matches = labels.filter((one) => one.name.toLowerCase().includes(name.toLowerCase()));
  const exact = labels.find((one) => sameName(one.name, name));
  const toggle = (labelId: string) => onChange(labelId, !labelIds.includes(labelId));
  const create = () => {
    onCreate(name);
    setTyped("");
  };
  return (
    <Popover
      label={t("labelsButton")}
      title={t("labelsTitle")}
      buttonClass="round"
      buttonContent={<Icon name="tag" />}
      shortcut="l"
    >
      <label className="visually-hidden" htmlFor={fieldId}>
        {t("labelFind")}
      </label>
      <input
        id={fieldId}
        type="text"
        className="label-find"
        placeholder={t("labelFind")}
        maxLength={LABEL_NAME_MAX}
        autoComplete="off"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || name === "") return;
          event.preventDefault();
          if (exact === undefined) create();
          else toggle(exact.id);
        }}
      />
      <div className="label-choices">
        {matches.map((one) => (
          <label key={one.id} className="label-choice">
            <input
              type="checkbox"
              checked={labelIds.includes(one.id)}
              onChange={() => toggle(one.id)}
            />
            <LabelDot color={one.color} />
            {one.name}
          </label>
        ))}
        {name !== "" && exact === undefined && (
          <button type="button" className="text-button label-create" onClick={create}>
            <Icon name="plus" size={14} />
            {t("labelCreate", { name })}
          </button>
        )}
        {labels.length === 0 && name === "" && <p className="hint">{t("labelsNone")}</p>}
      </div>
    </Popover>
  );
}
