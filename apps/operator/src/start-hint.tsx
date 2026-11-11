/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { WorkspaceApi } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import type { SettingsPage } from "./settings.tsx";
import { type TextId, t } from "./text.ts";

const STEPS: { text: TextId; page: SettingsPage }[] = [
  { text: "startSite", page: "install" },
  { text: "startInstall", page: "install" },
  { text: "startLogo", page: "workspace" },
  { text: "startTexts", page: "appearance" },
  { text: "startTeam", page: "team" },
];

const key = (workspaceId: string) => `dinghy.started.${workspaceId}`;

function wasHidden(workspaceId: string): boolean {
  try {
    return localStorage.getItem(key(workspaceId)) !== null;
  } catch {
    return false;
  }
}

function hide(workspaceId: string) {
  try {
    localStorage.setItem(key(workspaceId), "1");
  } catch {
    // It shows again on the next page load.
  }
}

/**
 * The first steps, in an empty inbox of a workspace that never had a conversation, until the
 * operator hides them. Nothing is required: each step opens its Settings page. It is per device.
 */
export function StartHint({
  api,
  workspaceId,
  hasConversations,
  version,
  onOpen,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  /** The open list has a conversation, so the workspace is in use and the hint goes for good. */
  hasConversations: boolean;
  /** Goes up when the inbox catches up, so a conversation closed meanwhile is found. */
  version: number;
  onOpen(page: SettingsPage): void;
}) {
  const [hidden, setHidden] = useState(() => wasHidden(workspaceId));
  // A workspace whose conversations are all closed is in use too. One page of one fits in one read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a new check.
  const closed = useLoad(
    () => (hidden || hasConversations ? null : api.list("closed", null, 1, () => false)),
    [api, hidden, hasConversations, version],
  );
  const inUse = hasConversations || (closed.data?.conversations.length ?? 0) > 0;
  useEffect(() => {
    if (!inUse || hidden) return;
    hide(workspaceId);
    setHidden(true);
  }, [inUse, hidden, workspaceId]);
  if (hidden || inUse || closed.data === null) return null;
  return (
    <section className="start" aria-labelledby="start-title">
      <h3 id="start-title">{t("startTitle")}</h3>
      <ol>
        {STEPS.map((step) => (
          <li key={step.text}>
            <button type="button" className="text-button" onClick={() => onOpen(step.page)}>
              {t(step.text)}
              <Icon name="chevronRight" size={14} />
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="text-button quiet"
        onClick={() => {
          hide(workspaceId);
          setHidden(true);
        }}
      >
        {t("startHide")}
      </button>
    </section>
  );
}
