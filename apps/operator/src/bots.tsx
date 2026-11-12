/** @jsxImportSource react */
import type { ApiKeyLevel, ReplyMode, WorkspaceApi } from "./api.ts";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import type { Option } from "./ui.tsx";

/** Drafts only comes first: it is the default, and a person reads each reply before it goes. */
export const REPLY_MODES: Option<ReplyMode>[] = [
  { value: "draft", label: "replyModeDraft" },
  { value: "send", label: "replyModeSend" },
];
export const LEVELS: Option<ApiKeyLevel>[] = [
  { value: "conversations", label: "apiKeyLevelConversations" },
  { value: "setup", label: "apiKeyLevelSetup" },
];

/** The hosts of an app on the operator's own computer, as the server names them. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
export const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host);

export const REPLY_MODE_HELP: Record<ReplyMode, TextId> = {
  draft: "replyModeDraftHelp",
  send: "replyModeSendHelp",
};

/**
 * Pauses or resumes every bot of the workspace. The server's workspace.changed event loads the
 * account again in every app, and `onChanged` does it here at once.
 */
export function pauseBots(api: WorkspaceApi, paused: boolean, onChanged: () => void) {
  return api.setBotsPaused(paused).then(
    () => {
      toast(paused ? "botsPausedToast" : "botsResumedToast");
      onChanged();
    },
    () => toast("actionFailed", false),
  );
}

/**
 * Above every page while the bots are paused, with who paused them. Owners and admins can resume
 * them here. A phone shows the short line.
 */
export function BotsPausedBanner({
  pausedBy,
  onResume,
}: {
  pausedBy: string | null;
  onResume: (() => void) | null;
}) {
  return (
    <div className="banner bots-banner" role="status">
      <span className="bots-banner-long">
        {t("botsPausedBanner")}
        {pausedBy !== null && ` ${t("botsPausedBy", { name: pausedBy })}.`}
      </span>
      <span className="bots-banner-short">{t("botsPausedShort")}</span>
      {onResume !== null && (
        <button type="button" className="pill dark small" onClick={onResume}>
          {t("botsResume")}
        </button>
      )}
    </div>
  );
}
