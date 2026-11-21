import { useCallback, useEffect, useState } from "react";

/** A bot's suggestion whose text the operator edits in the composer. */
interface EditedSuggestion {
  id: string;
  authorName: string;
}

/**
 * An unsent message, and whether it is a note, so a note never comes back as a reply. With
 * `suggestion` it edits a bot's suggestion: the link lives with the text, so leaving the
 * conversation and coming back keeps both, and sending it still sends the suggestion once.
 */
export interface Draft {
  text: string;
  isNote: boolean;
  suggestion?: EditedSuggestion;
}

export const NO_DRAFT: Draft = { text: "", isNote: false };

/** A new draft, or a change to the current one, which a late answer uses to touch only its text. */
export type DraftUpdate = Draft | ((current: Draft) => Draft);

type Drafts = Record<string, Draft>;

const isSuggestion = (value: unknown): value is EditedSuggestion | undefined =>
  value === undefined ||
  (typeof value === "object" &&
    value !== null &&
    typeof (value as EditedSuggestion).id === "string" &&
    typeof (value as EditedSuggestion).authorName === "string");

const isDraft = (value: unknown): value is Draft =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Draft).text === "string" &&
  typeof (value as Draft).isNote === "boolean" &&
  isSuggestion((value as Draft).suggestion);

// sessionStorage, so a reload of the tab keeps them and a closed tab drops them. It throws in some
// private windows and with blocked site data, and then the drafts last until the page reloads.
function readDrafts(key: string): Drafts {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isDraft(value)));
  } catch {
    return {};
  }
}

function writeDrafts(key: string, drafts: Drafts) {
  try {
    if (Object.keys(drafts).length === 0) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(drafts));
  } catch {
    // Kept in memory only.
  }
}

/** The operator's unsent replies and notes by conversation, in this workspace. */
export function useDrafts(operatorId: string, workspaceId: string) {
  const key = `dinghy:drafts:${operatorId}:${workspaceId}`;
  const [drafts, setDrafts] = useState(() => readDrafts(key));
  useEffect(() => writeDrafts(key, drafts), [key, drafts]);
  // An empty note stays, so the Note tab stays chosen.
  const setDraft = useCallback((conversationId: string, update: DraftUpdate) => {
    setDrafts(({ [conversationId]: current = NO_DRAFT, ...rest }) => {
      const draft = typeof update === "function" ? update(current) : update;
      return draft.text === "" && !draft.isNote ? rest : { ...rest, [conversationId]: draft };
    });
  }, []);
  return [drafts, setDraft] as const;
}
