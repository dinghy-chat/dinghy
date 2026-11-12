import { useCallback, useEffect, useState } from "react";

type Drafts = Record<string, string>;

// sessionStorage, so a reload of the tab keeps them and a closed tab drops them. It throws in some
// private windows and with blocked site data, and then the drafts last until the page reloads.
function readDrafts(key: string): Drafts {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Drafts) : {};
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

/** The operator's unsent replies by conversation, in this workspace. */
export function useDrafts(operatorId: string, workspaceId: string) {
  const key = `dinghy:drafts:${operatorId}:${workspaceId}`;
  const [drafts, setDrafts] = useState(() => readDrafts(key));
  useEffect(() => writeDrafts(key, drafts), [key, drafts]);
  const setDraft = useCallback((conversationId: string, text: string) => {
    setDrafts(({ [conversationId]: _, ...rest }) =>
      text === "" ? rest : { ...rest, [conversationId]: text },
    );
  }, []);
  return [drafts, setDraft] as const;
}
