/** @jsxImportSource react */
import { ApiError, type Campaign, type WorkspaceApi } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Confirm, type MenuItem } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { failureText } from "./ui.tsx";

// What a campaign's page and its row in the list both do to it: stop it for good, by an end or a
// delete, and say why a change failed.

/**
 * Why a save or an action failed. The editor checks the text's variables itself, so a definition
 * the server still refuses gets one general line.
 */
export function campaignFailure(error: unknown): TextId {
  if (error instanceof ApiError) {
    if (error.code === "invalid_request") return "campaignInvalid";
    if (error.code === "campaign_key_taken") return "campaignKeyTaken";
    if (error.code === "campaign_ended") return "campaignEndedRefused";
    if (error.code === "campaign_sent") return "campaignSentRefused";
  }
  return failureText(error, { 403: "campaignForbidden" }, "actionFailed");
}

const ENDINGS = {
  end: {
    label: "campaignEnd",
    icon: "prohibit",
    title: "campaignEndTitle",
    text: "campaignEndText",
    done: "campaignEndedToast",
  },
  delete: {
    label: "campaignDelete",
    icon: "trash",
    title: "campaignDeleteTitle",
    text: "campaignDeleteText",
    done: "campaignDeleted",
  },
} as const;

/** The two ways to stop a campaign for good. */
export type Ending = keyof typeof ENDINGS;

/**
 * The one ending a campaign's menu offers: a delete while it never sent, since nothing is lost,
 * and an end once it did, so it keeps its results. Null for one that sent and ended.
 */
export function endingItem(campaign: Campaign, onSelect: (kind: Ending) => void): MenuItem | null {
  const kind: Ending | null =
    campaign.totals.sent === 0 ? "delete" : campaign.status === "ended" ? null : "end";
  if (kind === null) return null;
  const { label, icon } = ENDINGS[kind];
  return {
    label: t(label),
    lead: <Icon name={icon} size={18} />,
    danger: true,
    onSelect: () => onSelect(kind),
  };
}

/**
 * Ends or deletes a campaign. Answers it as it is after an end, or null once deleted. The server
 * deletes no live campaign, so a delete pauses it first.
 */
export async function stopCampaign(
  api: WorkspaceApi,
  campaign: Campaign,
  kind: Ending,
): Promise<Campaign | null> {
  if (kind === "end") return (await api.setCampaignStatus(campaign.id, "end")).campaign;
  if (campaign.status === "live") await api.setCampaignStatus(campaign.id, "pause");
  await api.deleteCampaign(campaign.id);
  return null;
}

/** The toast once an ending is done. */
export const endedText = (kind: Ending): TextId => ENDINGS[kind].done;

/** "End {name}?" or "Delete {name}?", which cannot be undone. */
export function EndingConfirm({
  kind,
  name,
  onConfirm,
  onCancel,
}: {
  kind: Ending;
  name: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const { title, text, label } = ENDINGS[kind];
  return (
    <Confirm
      title={t(title, { name })}
      text={t(text)}
      confirm={t(label)}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
