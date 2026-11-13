/** @jsxImportSource react */
import { useId, useState } from "react";
import { plainText } from "../../../packages/widget/src/markdown.ts";
import {
  SAVED_REPLY_BODY_MAX,
  SAVED_REPLY_LIMIT,
  SAVED_REPLY_SHORTCUT,
} from "../../../packages/widget/src/shared.ts";
import type { SavedReply, WorkspaceApi } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useAction, useLoad } from "./load.ts";
import { Confirm } from "./popup.tsx";
import { t } from "./text.ts";
import { AddForm, EditForm, ErrorNote, Field, Loading, Page, StatusNote } from "./ui.tsx";

// The longest shortcut SAVED_REPLY_SHORTCUT takes, so the field stops there.
const SHORTCUT_MAX = 32;

type SavedReplyInput = { shortcut: string; body: string };
const EMPTY: SavedReplyInput = { shortcut: "", body: "" };

/** The shortcut and the text of a saved reply, new or changed. */
function ReplyFields({
  value,
  onChange,
}: {
  value: SavedReplyInput;
  onChange(value: SavedReplyInput): void;
}) {
  const bodyId = useId();
  const hintId = useId();
  return (
    <>
      <Field
        label={t("savedReplyShortcut")}
        hint={t("savedReplyShortcutHint")}
        placeholder={t("savedReplyShortcutPlaceholder")}
        maxLength={SHORTCUT_MAX}
        required
        autoComplete="off"
        value={value.shortcut}
        onChange={(shortcut) => onChange({ ...value, shortcut: shortcut.toLowerCase() })}
      />
      {/* Not a Field: a saved reply keeps its line breaks, as a reply does. */}
      <label className="field" htmlFor={bodyId}>
        <span>{t("savedReplyBody")}</span>
        <textarea
          id={bodyId}
          rows={5}
          maxLength={SAVED_REPLY_BODY_MAX}
          required
          aria-describedby={hintId}
          value={value.body}
          onChange={(event) => onChange({ ...value, body: event.target.value })}
        />
        <small className="hint" id={hintId}>
          {t("savedReplyBodyHint")}
        </small>
      </label>
    </>
  );
}

const isComplete = (input: SavedReplyInput) =>
  SAVED_REPLY_SHORTCUT.test(input.shortcut) && input.body.trim() !== "";

/** Settings > Saved replies: every member adds, changes and deletes the team's replies. */
export function SavedRepliesPage({ api }: { api: WorkspaceApi }) {
  const replies = useLoad(() => api.savedReplies(), [api]);
  const [adding, setAdding] = useState<SavedReplyInput | null>(null);
  const [editing, setEditing] = useState<{ id: string; input: SavedReplyInput } | null>(null);
  const [deleting, setDeleting] = useState<SavedReply | null>(null);
  const { busy, failure, run: act } = useAction(replies.reload);
  const add = async (input: SavedReplyInput) => {
    if (await act(() => api.addSavedReply(input))) setAdding(null);
  };
  const save = async (id: string, input: SavedReplyInput) => {
    if (await act(() => api.changeSavedReply(id, input))) setEditing(null);
  };
  const remove = async (reply: SavedReply) => {
    if (await act(() => api.deleteSavedReply(reply.id))) setDeleting(null);
  };

  const list = replies.data?.savedReplies;
  const isFull = list !== undefined && list.length >= SAVED_REPLY_LIMIT;
  return (
    <Page title={t("pageSavedReplies")} context={t("savedRepliesContext")}>
      {list === undefined ? (
        <Loading failure={replies.failure} />
      ) : list.length === 0 ? (
        <p className="sec-empty">{t("savedRepliesNone")}</p>
      ) : (
        <ul className="items">
          {list.map((reply) =>
            editing?.id === reply.id ? (
              <li key={reply.id} className="item-row">
                <EditForm
                  label={t("savedReplyEditLabel", { shortcut: reply.shortcut })}
                  canSubmit={!busy && isComplete(editing.input)}
                  onCancel={() => setEditing(null)}
                  onSubmit={() => void save(reply.id, editing.input)}
                >
                  <ReplyFields
                    value={editing.input}
                    onChange={(input) => setEditing({ id: reply.id, input })}
                  />
                </EditForm>
              </li>
            ) : (
              <li key={reply.id} className="item-row">
                <span className="item-ic">
                  <Icon name="reply" size={20} />
                </span>
                <div className="item-text">
                  <strong className="item-name">/{reply.shortcut}</strong>
                  <span className="item-line saved-reply-line">{plainText(reply.body)}</span>
                </div>
                <div className="item-tools">
                  <button
                    type="button"
                    className="pill small"
                    aria-label={t("savedReplyEditLabel", { shortcut: reply.shortcut })}
                    onClick={() => {
                      setAdding(null);
                      setEditing({
                        id: reply.id,
                        input: { shortcut: reply.shortcut, body: reply.body },
                      });
                    }}
                  >
                    {t("edit")}
                  </button>
                  <button
                    type="button"
                    className="pill small"
                    aria-label={t("savedReplyDeleteLabel", { shortcut: reply.shortcut })}
                    onClick={() => setDeleting(reply)}
                  >
                    {t("delete")}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {isFull ? (
        <StatusNote text="savedReplyLimit" />
      ) : (
        <AddForm
          isOpen={adding !== null}
          newLabel={t("savedReplyNew")}
          submitLabel={t("savedReplyAdd")}
          canSubmit={!busy && adding !== null && isComplete(adding)}
          onOpen={() => {
            setEditing(null);
            setAdding(EMPTY);
          }}
          onCancel={() => setAdding(null)}
          onSubmit={() => {
            if (adding !== null) void add(adding);
          }}
        >
          {adding !== null && <ReplyFields value={adding} onChange={setAdding} />}
        </AddForm>
      )}
      <ErrorNote text={failure} />
      {deleting !== null && (
        <Confirm
          title={t("savedReplyDeleteTitle", { shortcut: deleting.shortcut })}
          text={t("savedReplyDeleteText")}
          confirm={t("delete")}
          disabled={busy}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Page>
  );
}
