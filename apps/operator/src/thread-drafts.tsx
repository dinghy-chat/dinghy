/** @jsxImportSource react */
import { createElement, useState } from "react";
import { renderMarkdown } from "../../../packages/widget/src/markdown.ts";
import type { Draft, Message, WorkspaceApi } from "./api.ts";
import { clockTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import type { Act } from "./message-actions.tsx";
import { t } from "./text.ts";

/**
 * The drafts that wait in a conversation, newest first, loaded again when one changes. Sending one
 * puts the sent message in the thread at once.
 */
export function useDrafts({
  api,
  conversationId,
  version,
  act,
  keep,
}: {
  api: WorkspaceApi;
  conversationId: string;
  /** Goes up when a draft here changed. */
  version: number;
  act: Act;
  keep(message: Message): void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a load.
  const loaded = useLoad(
    () => api.drafts(conversationId).then((answer) => answer.drafts),
    [api, conversationId, version],
  );
  const drop = (id: string) =>
    loaded.setData((current) => current?.filter((draft) => draft.id !== id) ?? null);
  /** Sends a draft as it is, or with the operator's edit. */
  const send = (draft: Draft, body?: string) =>
    act(async () => {
      keep(await api.sendDraft(conversationId, draft.id, body));
      drop(draft.id);
    });
  const discard = (draft: Draft) =>
    act(async () => {
      await api.discardDraft(conversationId, draft.id);
      drop(draft.id);
    });
  return { drafts: loaded.data ?? [], send, discard };
}

/** One suggested reply: who wrote it, its text, and Send, Edit and Discard. */
function DraftCard({
  draft,
  compact,
  canSend,
  onSend,
  onEdit,
  onDiscard,
}: {
  draft: Draft;
  /** One of several, so it takes less room. */
  compact: boolean;
  canSend: boolean;
  onSend(): Promise<boolean>;
  onEdit(): void;
  onDiscard(): Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  // A stale draft asks once before it goes.
  const [asking, setAsking] = useState(false);
  const isStale = draft.status === "stale";
  const run = async (work: () => Promise<boolean>) => {
    setBusy(true);
    // The card goes on success, so only a failure needs the buttons back.
    if (!(await work())) setBusy(false);
  };
  const className = ["draft-card", compact && "compact", isStale && "stale"]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={className} aria-label={t("draftLabel", { name: draft.authorName })}>
      <header className="draft-head">
        <Icon name="robot" size={16} />
        <strong className="card-author">{t("draftBy", { name: draft.authorName })}</strong>
        <time dateTime={draft.createdAt}>{clockTime(draft.createdAt)}</time>
      </header>
      {isStale && <p className="draft-stale">{t("draftStale")}</p>}
      {createElement(
        "div",
        { className: "draft-body" },
        ...renderMarkdown(draft.body, createElement),
      )}
      {asking ? (
        <div className="draft-actions" role="alert">
          <span className="draft-ask">{t("draftStaleAsk")}</span>
          <button
            type="button"
            className="pill dark small"
            disabled={busy}
            onClick={() => void run(onSend)}
          >
            {t("draftSendAnyway")}
          </button>
          <button type="button" className="pill small" onClick={() => setAsking(false)}>
            {t("cancel")}
          </button>
        </div>
      ) : (
        <div className="draft-actions">
          {canSend && (
            <>
              <button
                type="button"
                className="pill dark small"
                disabled={busy}
                onClick={() => (isStale ? setAsking(true) : void run(onSend))}
              >
                <Icon name="arrowUp" size={14} />
                {t("draftSend")}
              </button>
              <button type="button" className="pill small" disabled={busy} onClick={onEdit}>
                <Icon name="pencil" size={14} />
                {t("draftEdit")}
              </button>
            </>
          )}
          <button
            type="button"
            className="pill small"
            disabled={busy}
            onClick={() => void run(onDiscard)}
          >
            {t("draftDiscard")}
          </button>
        </div>
      )}
    </article>
  );
}

/** The suggested replies under the last message, newest first. */
export function DraftCards({
  drafts,
  canSend,
  onSend,
  onEdit,
  onDiscard,
}: {
  drafts: Draft[];
  /** The conversation is open and replies are on. */
  canSend: boolean;
  onSend(draft: Draft): Promise<boolean>;
  onEdit(draft: Draft): void;
  onDiscard(draft: Draft): Promise<boolean>;
}) {
  if (drafts.length === 0) return null;
  return (
    <div className="drafts">
      {drafts.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          compact={drafts.length > 1}
          canSend={canSend}
          onSend={() => onSend(draft)}
          onEdit={() => onEdit(draft)}
          onDiscard={() => onDiscard(draft)}
        />
      ))}
    </div>
  );
}

/** Above the message box while it holds a draft's text: sending it sends the draft. */
export function DraftChip({ draft, onCancel }: { draft: Draft; onCancel(): void }) {
  return (
    <div className="quote-chip">
      <Icon name="robot" size={16} />
      <span className="quote-chip-text">
        <strong>{t("draftEditing", { name: draft.authorName })}</strong>
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label={t("draftEditCancel")}
        title={t("draftEditCancel")}
        onClick={onCancel}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
