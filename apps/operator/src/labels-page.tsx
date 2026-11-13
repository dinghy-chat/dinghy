/** @jsxImportSource react */
import { useState } from "react";
import { LABEL_LIMIT, LABEL_NAME_MAX } from "../../../packages/widget/src/shared.ts";
import type { Label, LabelColor, WorkspaceApi } from "./api.ts";
import { COLOR_TEXT, LabelDot } from "./labels.tsx";
import { useAction, useLoad } from "./load.ts";
import { Confirm, Select } from "./popup.tsx";
import { t } from "./text.ts";
import { AddForm, EditForm, ErrorNote, Field, Loading, Page, StatusNote } from "./ui.tsx";

type Typed = { name: string; color: LabelColor };
const EMPTY: Typed = { name: "", color: "gray" };

const COLOR_CHOICES = Object.entries(COLOR_TEXT).map(([color, text]) => ({
  value: color as LabelColor,
  label: t(text),
  lead: <LabelDot color={color as LabelColor} />,
}));

/** A label's name and color, new or changed. */
function LabelFields({ value, onChange }: { value: Typed; onChange(value: Typed): void }) {
  return (
    <>
      <Field
        label={t("labelName")}
        maxLength={LABEL_NAME_MAX}
        required
        autoComplete="off"
        value={value.name}
        onChange={(name) => onChange({ ...value, name })}
      />
      <div className="field">
        <span aria-hidden="true">{t("labelColor")}</span>
        <Select
          label={t("labelColor")}
          value={value.color}
          choices={COLOR_CHOICES}
          onChange={(color) => onChange({ ...value, color })}
        />
      </div>
    </>
  );
}

/** Settings > Labels: owners and admins add, rename, recolor and delete the team's labels. */
export function LabelsPage({ api }: { api: WorkspaceApi }) {
  const labels = useLoad(() => api.labels(), [api]);
  const [adding, setAdding] = useState<Typed | null>(null);
  const [editing, setEditing] = useState<{ id: string; typed: Typed } | null>(null);
  const [deleting, setDeleting] = useState<Label | null>(null);
  const { busy, failure, run: act } = useAction(labels.reload);
  const add = async (typed: Typed) => {
    if (await act(() => api.addLabel(typed))) setAdding(null);
  };
  const save = async (id: string, typed: Typed) => {
    if (await act(() => api.changeLabel(id, typed))) setEditing(null);
  };
  const remove = async (label: Label) => {
    if (await act(() => api.deleteLabel(label.id))) setDeleting(null);
  };

  const list = labels.data?.labels;
  const isFull = list !== undefined && list.length >= LABEL_LIMIT;
  return (
    <Page title={t("pageLabels")} context={t("labelsContext")}>
      {list === undefined ? (
        <Loading failure={labels.failure} />
      ) : list.length === 0 ? (
        <p className="sec-empty">{t("labelsPageNone")}</p>
      ) : (
        <ul className="items">
          {list.map((label) =>
            editing?.id === label.id ? (
              <li key={label.id} className="item-row label-row">
                <EditForm
                  label={t("labelEditLabel", { name: label.name })}
                  canSubmit={!busy && editing.typed.name.trim() !== ""}
                  onCancel={() => setEditing(null)}
                  onSubmit={() => void save(label.id, editing.typed)}
                >
                  <LabelFields
                    value={editing.typed}
                    onChange={(typed) => setEditing({ id: label.id, typed })}
                  />
                </EditForm>
              </li>
            ) : (
              <li key={label.id} className="item-row label-row">
                <span className="label-pill" data-color={label.color}>
                  {label.name}
                </span>
                <div className="item-tools">
                  <button
                    type="button"
                    className="pill small"
                    aria-label={t("labelEditLabel", { name: label.name })}
                    onClick={() => {
                      setAdding(null);
                      setEditing({ id: label.id, typed: { name: label.name, color: label.color } });
                    }}
                  >
                    {t("labelEdit")}
                  </button>
                  <button
                    type="button"
                    className="pill small"
                    aria-label={t("labelDeleteLabel", { name: label.name })}
                    onClick={() => setDeleting(label)}
                  >
                    {t("labelDelete")}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {isFull ? (
        <StatusNote text="labelLimit" />
      ) : (
        <AddForm
          isOpen={adding !== null}
          newLabel={t("labelNew")}
          submitLabel={t("labelAdd")}
          canSubmit={!busy && adding !== null && adding.name.trim() !== ""}
          onOpen={() => {
            setEditing(null);
            setAdding(EMPTY);
          }}
          onCancel={() => setAdding(null)}
          onSubmit={() => {
            if (adding !== null) void add(adding);
          }}
        >
          {adding !== null && <LabelFields value={adding} onChange={setAdding} />}
        </AddForm>
      )}
      <ErrorNote text={failure} />
      {deleting !== null && (
        <Confirm
          title={t("labelDeleteTitle", { name: deleting.name })}
          text={t("labelDeleteText")}
          confirm={t("labelDelete")}
          disabled={busy}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Page>
  );
}
