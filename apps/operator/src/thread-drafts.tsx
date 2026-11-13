/** @jsxImportSource react */
import { createElement, useLayoutEffect, useRef, useState } from "react";
import { renderMarkdown } from "../../../packages/widget/src/markdown.ts";
import type { Message, SuggestedReply, WorkspaceApi } from "./api.ts";
import { clockTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import type { Act } from "./message-actions.tsx";
import { plural, t } from "./text.ts";

/**
 * The suggested replies that keys in draft mode wrote and that wait in a conversation, oldest first
 * as the thread reads, loaded again when one changes. Sending one puts the sent message in the thread at once.
 */
export function useSuggestedReplies({
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
    () =>
      api
        .drafts(conversationId)
        .then((answer) =>
          [...answer.drafts].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        ),
    [api, conversationId, version],
  );
  const drop = (id: string) =>
    loaded.setData((current) => current?.filter((draft) => draft.id !== id) ?? null);
  /** Sends a draft as it is, or with the operator's edit. */
  const send = (draft: SuggestedReply, body?: string) =>
    act(async () => {
      keep(await api.sendDraft(conversationId, draft.id, body));
      drop(draft.id);
    });
  const discard = (draft: SuggestedReply) =>
    act(async () => {
      await api.discardDraft(conversationId, draft.id);
      drop(draft.id);
    });
  return { drafts: loaded.data ?? [], send, discard };
}

/**
 * A draft's text. One of several is cut short, with a button that shows all of it, and it shows all
 * of it while the keyboard is on a button of its card, so nobody sends words they did not see.
 */
function DraftBody({ body, compact }: { body: string; compact: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [isCut, setIsCut] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new body asks for a new measure.
  useLayoutEffect(() => {
    const element = ref.current;
    setIsCut(compact && element !== null && element.scrollHeight > element.clientHeight);
  }, [body, compact]);
  return (
    <>
      {createElement(
        "div",
        { ref, className: isOpen ? "draft-body open" : "draft-body" },
        ...renderMarkdown(body, createElement),
      )}
      {isCut && !isOpen && (
        <button type="button" className="draft-more" onClick={() => setIsOpen(true)}>
          {t("draftShowAll")}
        </button>
      )}
    </>
  );
}

/** A suggested reply's buttons: Discard, Edit and Send. A stale one asks once before it goes. */
function DraftActions({
  isStale,
  canSend,
  busy,
  onSend,
  onEdit,
  onDiscard,
}: {
  isStale: boolean;
  canSend: boolean;
  busy: boolean;
  onSend(): void;
  onEdit(): void;
  onDiscard(): void;
}) {
  const [asking, setAsking] = useState(false);
  // Keys keep React from turning one button into another, which showed a half-drawn pill.
  if (asking) {
    return (
      <div key="ask" className="sugg-actions" role="alert">
        <span className="draft-ask">{t("draftStaleAsk")}</span>
        <button type="button" className="pill small" onClick={() => setAsking(false)}>
          {t("cancel")}
        </button>
        <button type="button" className="pill dark small" disabled={busy} onClick={onSend}>
          {t("draftSendAnyway")}
        </button>
      </div>
    );
  }
  return (
    <div key="actions" className="sugg-actions">
      <button type="button" className="sugg-discard" disabled={busy} onClick={onDiscard}>
        {t("draftDiscard")}
      </button>
      {canSend && (
        <>
          <button type="button" className="pill small" disabled={busy} onClick={onEdit}>
            <Icon name="pencil" size={15} />
            {t("draftEdit")}
          </button>
          <button
            type="button"
            className="pill dark small"
            disabled={busy}
            onClick={isStale ? () => setAsking(true) : onSend}
          >
            <Icon name="arrowUp" size={15} />
            {t("draftSend")}
          </button>
        </>
      )}
    </div>
  );
}

/** What a suggested reply's card needs from the thread. */
interface DraftHandlers {
  /** The visitor's name, as the card says who cannot see it yet. */
  visitor: string;
  /** The conversation is open and replies are on. */
  canSend: boolean;
  onSend(draft: SuggestedReply): Promise<boolean>;
  onEdit(draft: SuggestedReply): void;
  onDiscard(draft: SuggestedReply): Promise<boolean>;
}

/**
 * One suggested reply, on the operator's side, shaped like the reply it becomes but pale: who wrote
 * it and when, a line that says the visitor cannot see it, its text, and Discard, Edit and Send.
 */
function DraftCard({
  draft,
  compact,
  handlers,
}: {
  draft: SuggestedReply;
  /** One of several, so it takes less room. */
  compact: boolean;
  handlers: DraftHandlers;
}) {
  const [busy, setBusy] = useState(false);
  const isStale = draft.status === "stale";
  const run = async (work: () => Promise<boolean>) => {
    setBusy(true);
    // The card goes on success, so only a failure needs the buttons back.
    if (!(await work())) setBusy(false);
  };
  return (
    <article
      className={isStale ? "sugg stale" : "sugg"}
      aria-label={t("draftLabel", { name: draft.authorName })}
    >
      <header className="sugg-head">
        <span className="sugg-mark">
          <Icon name="robot" size={11} />
        </span>
        {t("draftBy", { name: draft.authorName })}
        <time className="sugg-time" dateTime={draft.createdAt}>
          · {clockTime(draft.createdAt)}
        </time>
      </header>
      <div className={compact ? "sugg-bubble compact" : "sugg-bubble"}>
        <p className="sugg-private">
          <Icon name="eyeOff" size={13} />
          {isStale ? t("draftStale") : t("draftPrivate", { name: handlers.visitor })}
        </p>
        <DraftBody body={draft.body} compact={compact} />
      </div>
      <DraftActions
        isStale={isStale}
        canSend={handlers.canSend}
        busy={busy}
        onSend={() => void run(() => handlers.onSend(draft))}
        onEdit={() => handlers.onEdit(draft)}
        onDiscard={() => void run(() => handlers.onDiscard(draft))}
      />
    </article>
  );
}

/** The suggested replies that answer the newest message, under it, oldest first. */
export function DraftCards({ drafts, ...handlers }: DraftHandlers & { drafts: SuggestedReply[] }) {
  const waiting = drafts.filter((draft) => draft.status !== "stale");
  if (waiting.length === 0) return null;
  return (
    <div className="drafts">
      {waiting.map((draft) => (
        <DraftCard key={draft.id} draft={draft} compact={waiting.length > 1} handlers={handlers} />
      ))}
    </div>
  );
}

/**
 * The suggestions that a newer visitor message made stale, folded into one stacked card where they
 * were written. It opens to show them.
 */
export function OlderDrafts({ drafts, ...handlers }: DraftHandlers & { drafts: SuggestedReply[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const stale = drafts.filter((draft) => draft.status === "stale");
  if (stale.length === 0) return null;
  return (
    <div className="drafts older">
      <button
        type="button"
        className="sugg-stack"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="sugg-mark">
          <Icon name="robot" size={13} />
        </span>
        {plural(stale.length, "draftsOlderOne", "draftsOlder")}
        <small className="sugg-why">{t("draftsOlderWhy", { name: handlers.visitor })}</small>
        <span className="sugg-caret">
          <Icon name="chevron" size={12} />
        </span>
      </button>
      {isOpen &&
        stale.map((draft) => (
          <DraftCard key={draft.id} draft={draft} compact handlers={handlers} />
        ))}
    </div>
  );
}

/** Where the folded suggestions go: before the visitor message that made them stale. */
export function staleBefore(drafts: SuggestedReply[]): string | null {
  const stale = drafts.filter((draft) => draft.status === "stale");
  return stale.at(-1)?.createdAt ?? null;
}

/** Above the message box while it holds a draft's text: sending it sends the draft. */
export function DraftChip({ draft, onCancel }: { draft: SuggestedReply; onCancel(): void }) {
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
