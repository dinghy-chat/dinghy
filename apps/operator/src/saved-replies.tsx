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
import { useLoad } from "./load.ts";
import { Confirm } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { AddForm, ErrorNote, Field, failureText, Loading, Page, StatusNote } from "./ui.tsx";

// The longest shortcut SAVED_REPLY_SHORTCUT takes, so the field stops there.
const SHORTCUT_MAX = 32;

type Typed = { shortcut: string; body: string };
const EMPTY: Typed = { shortcut: "", body: "" };

/** The shortcut and the text of a saved reply, new or changed. */
function ReplyFields({ value, onChange }: { value: Typed; onChange(value: Typed): void }) {
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

const isComplete = (typed: Typed) =>
  SAVED_REPLY_SHORTCUT.test(typed.shortcut) && typed.body.trim() !== "";

/** Settings > Saved replies: every member adds, changes and deletes the team's replies. */
export function SavedRepliesPage({ api }: { api: WorkspaceApi }) {
  const replies = useLoad(() => api.savedReplies(), [api]);
  const [adding, setAdding] = useState<Typed | null>(null);
  const [editing, setEditing] = useState<{ id: string; typed: Typed } | null>(null);
  const [deleting, setDeleting] = useState<SavedReply | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (work: () => Promise<unknown>) => {
    setFailure(null);
    setBusy(true);
    try {
      await work();
      replies.reload();
      return true;
    } catch (error) {
      setFailure(failureText(error, {}));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (typed: Typed) => {
    if (await act(() => api.addSavedReply(typed))) setAdding(null);
  };
  const save = async (id: string, typed: Typed) => {
    if (await act(() => api.changeSavedReply(id, typed))) setEditing(null);
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
              <li key={reply.id} className="item-row saved-reply-edit">
                <form
                  className="stack"
                  aria-label={t("savedReplyEditLabel", { shortcut: reply.shortcut })}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(reply.id, editing.typed);
                  }}
                >
                  <ReplyFields
                    value={editing.typed}
                    onChange={(typed) => setEditing({ id: reply.id, typed })}
                  />
                  <div className="actions">
                    <button
                      type="submit"
                      className="pill dark"
                      disabled={busy || !isComplete(editing.typed)}
                    >
                      {t("save")}
                    </button>
                    <button type="button" className="pill" onClick={() => setEditing(null)}>
                      {t("cancel")}
                    </button>
                  </div>
                </form>
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
                        typed: { shortcut: reply.shortcut, body: reply.body },
                      });
                    }}
                  >
                    {t("savedReplyEdit")}
                  </button>
                  <button
                    type="button"
                    className="pill small"
                    aria-label={t("savedReplyDeleteLabel", { shortcut: reply.shortcut })}
                    onClick={() => setDeleting(reply)}
                  >
                    {t("savedReplyDelete")}
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
          confirm={t("savedReplyDelete")}
          disabled={busy}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Page>
  );
}
