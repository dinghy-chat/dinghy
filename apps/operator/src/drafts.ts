import { useCallback, useEffect, useState } from "react";

/** An unsent message, and whether it is a note, so a note never comes back as a reply. */
export interface Draft {
  text: string;
  isNote: boolean;
}

export const NO_DRAFT: Draft = { text: "", isNote: false };

type Drafts = Record<string, Draft>;

const isDraft = (value: unknown): value is Draft =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Draft).text === "string" &&
  typeof (value as Draft).isNote === "boolean";

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
  const setDraft = useCallback((conversationId: string, draft: Draft) => {
    setDrafts(({ [conversationId]: _, ...rest }) =>
      draft.text === "" && !draft.isNote ? rest : { ...rest, [conversationId]: draft },
    );
  }, []);
  return [drafts, setDraft] as const;
}
