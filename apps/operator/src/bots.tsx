/** @jsxImportSource react */
import type { ReplyMode, WorkspaceApi } from "./api.ts";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import type { Option } from "./ui.tsx";

/** Drafts only comes first: it is the default, and a person reads each reply before it goes. */
export const REPLY_MODES: Option<ReplyMode>[] = [
  { value: "draft", label: "replyModeDraft" },
  { value: "send", label: "replyModeSend" },
];
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

/** Above every page while the bots are paused. Owners and admins can resume them here. */
export function BotsPausedBanner({ onResume }: { onResume: (() => void) | null }) {
  return (
    <div className="banner bots-banner" role="status">
      <span>{t("botsPausedBanner")}</span>
      {onResume !== null && (
        <button type="button" className="pill small" onClick={onResume}>
          {t("botsResume")}
        </button>
      )}
    </div>
  );
}
