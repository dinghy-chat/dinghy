/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { WorkspaceApi } from "./api.ts";
import type { SettingsTab } from "./settings.tsx";
import { type TextId, t } from "./text.ts";
import { Icon } from "./ui.tsx";

const STEPS: { text: TextId; tab: SettingsTab }[] = [
  { text: "startSite", tab: "sites" },
  { text: "startInstall", tab: "install" },
  { text: "startLogo", tab: "install" },
  { text: "startTexts", tab: "install" },
  { text: "startTeam", tab: "team" },
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
 * operator hides them. Nothing is required: each step opens its settings tab. It is per device.
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
  onOpen(tab: SettingsTab): void;
}) {
  const [hidden, setHidden] = useState(() => wasHidden(workspaceId));
  // Null until the closed list answers: a workspace whose conversations are all closed is in use.
  const [closedNone, setClosedNone] = useState<boolean | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a new check.
  useEffect(() => {
    if (hidden) return;
    if (hasConversations) {
      hide(workspaceId);
      setHidden(true);
      return;
    }
    let current = true;
    api
      .list("closed", 1, () => !current)
      .then(
        (page) => {
          if (!current) return;
          if (page.conversations.length === 0) setClosedNone(true);
          else {
            hide(workspaceId);
            setHidden(true);
          }
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [api, hidden, hasConversations, workspaceId, version]);
  if (hidden || hasConversations || closedNone !== true) return null;
  return (
    <section className="start" aria-labelledby="start-title">
      <h3 id="start-title">{t("startTitle")}</h3>
      <ol>
        {STEPS.map((step) => (
          <li key={step.text}>
            <button type="button" className="text-button" onClick={() => onOpen(step.tab)}>
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
