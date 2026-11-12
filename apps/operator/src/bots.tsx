/** @jsxImportSource react */
import type { ReactNode } from "react";
import type { ApiKeyLevel, ReplyMode, WorkspaceApi } from "./api.ts";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Choices, type Option } from "./ui.tsx";

/** Drafts only comes first: it is the default, and a person reads each reply before it goes. */
export const REPLY_MODES: Option<ReplyMode>[] = [
  { value: "draft", label: "replyModeDraft" },
  { value: "send", label: "replyModeSend" },
];
export const LEVEL_LABEL: Record<ApiKeyLevel, TextId> = {
  conversations: "apiKeyLevelConversations",
  setup: "apiKeyLevelSetup",
};
const LEVELS: Option<ApiKeyLevel>[] = [
  { value: "conversations", label: LEVEL_LABEL.conversations },
  { value: "setup", label: LEVEL_LABEL.setup },
];
const LEVEL_HELP: Record<ApiKeyLevel, TextId> = {
  conversations: "apiKeyLevelConversationsHelp",
  setup: "apiKeyLevelSetupHelp",
};
const REPLY_MODE_HELP: Record<ReplyMode, TextId> = {
  draft: "replyModeDraftHelp",
  send: "replyModeSendHelp",
};

interface ChoiceProps<T extends string> {
  /** The block's class, which sets its layout on the page. */
  className: string;
  /** The choices span the block. */
  full?: boolean;
  value: T;
  onChange(value: T): void;
  /** More lines under the hint. */
  children?: ReactNode;
}

/** A labeled choice with one line on what the chosen option does. */
function HelpedChoice<T extends string>({
  title,
  options,
  help,
  className,
  full = false,
  value,
  onChange,
  children,
}: ChoiceProps<T> & { title: TextId; options: Option<T>[]; help: Record<T, TextId> }) {
  return (
    <div className={className}>
      {/* The control's own label names it for screen readers. */}
      <span className="setting-label" aria-hidden="true">
        {t(title)}
      </span>
      <Choices<T>
        label={t(title)}
        variant="outlined"
        full={full}
        value={value}
        options={options}
        onChange={onChange}
      />
      <p className="hint">{t(help[value])}</p>
      {children}
    </div>
  );
}

/** The access a new key or a connected app gets. */
export const LevelChoice = (props: ChoiceProps<ApiKeyLevel>) => (
  <HelpedChoice title="apiKeyLevel" options={LEVELS} help={LEVEL_HELP} {...props} />
);

/** Whether a new key's or a connected app's replies wait for a person. */
export const ReplyModeChoice = (props: ChoiceProps<ReplyMode>) => (
  <HelpedChoice title="replyMode" options={REPLY_MODES} help={REPLY_MODE_HELP} {...props} />
);

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
