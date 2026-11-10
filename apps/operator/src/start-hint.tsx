/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { SettingsTab } from "./settings.tsx";
import { type TextId, t } from "./text.ts";
import { Icon } from "./ui.tsx";

const STEPS: { text: TextId; tab: SettingsTab }[] = [
  { text: "startSite", tab: "sites" },
  { text: "startInstall", tab: "install" },
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
 * The first steps, in an empty inbox, until the operator hides them or the first conversation
 * arrives. Nothing is required: each step opens its settings tab. It is per device.
 */
export function StartHint({
  workspaceId,
  hasConversations,
  onOpen,
}: {
  workspaceId: string;
  /** The open list has a conversation, so the workspace is in use and the hint goes for good. */
  hasConversations: boolean;
  onOpen(tab: SettingsTab): void;
}) {
  const [hidden, setHidden] = useState(() => wasHidden(workspaceId));
  useEffect(() => {
    if (!hasConversations) return;
    hide(workspaceId);
    setHidden(true);
  }, [hasConversations, workspaceId]);
  if (hidden || hasConversations) return null;
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
