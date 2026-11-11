/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { WorkspaceApi } from "./api.ts";
import type { SettingsPage } from "./settings.tsx";
import { type TextId, t } from "./text.ts";
import { Icon } from "./ui.tsx";

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
      .list("closed", null, 1, () => !current)
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
