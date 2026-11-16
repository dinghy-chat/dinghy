/** @jsxImportSource react */
import { percent, shareOf } from "./analytics.tsx";
import type { Campaign } from "./api.ts";
import { deleteBlock } from "./campaign-dialogs.tsx";
import { campaignSentence } from "./campaign-summary.ts";
import { StatusChip } from "./campaign-tile.tsx";
import { TriggerTile } from "./campaign-trigger.tsx";
import { Icon } from "./icons.tsx";
import { Menu, type MenuItem } from "./popup.tsx";
import { type TextId, t } from "./text.ts";

/** One result of a row: its number, its words and a thin bar of its share. */
function RowStat({
  value,
  label,
  share,
  isGoal = false,
}: {
  value: string;
  label: string;
  share: number;
  isGoal?: boolean;
}) {
  return (
    <span className="row-stat">
      <b>{value}</b>
      <small className="row-label" title={label}>
        {label}
      </small>
      <span className={isGoal ? "row-bar goal" : "row-bar"} aria-hidden="true">
        <span style={{ width: `${share * 100}%` }} />
      </span>
    </span>
  );
}

/** A share of the messages sent, as a percent with its bar. */
function RowRate({ count, sent, label }: { count: number; sent: number; label: TextId }) {
  const share = shareOf(count, sent);
  return <RowStat value={percent(share)} label={t(label)} share={share} />;
}

/** A campaign that went live: sent, read, replied, and its goal. */
function RowStats({ campaign }: { campaign: Campaign }) {
  const { totals } = campaign;
  const { goal } = campaign.definition.rules;
  return (
    <span className="row-stats">
      <RowStat
        value={String(totals.sent)}
        label={t("resultSentLower")}
        share={totals.sent > 0 ? 1 : 0}
      />
      <RowRate count={totals.read} sent={totals.sent} label="resultReadLower" />
      <RowRate count={totals.replied} sent={totals.sent} label="resultRepliedLower" />
      {goal !== undefined && (
        // The goal counts the control group too, so its share is of everyone who entered.
        <RowStat
          value={String(totals.goalReached)}
          label={t("resultGoalLower")}
          share={shareOf(totals.goalReached, totals.entered)}
          isGoal
        />
      )}
    </span>
  );
}

/** What a row's menu asks the list to do with its campaign. */
export type RowAction = "rename" | "end" | "delete";

/** The row's menu: a new name, an end, and a delete for a campaign that never sent. */
function rowItems(campaign: Campaign, onAction: (action: RowAction) => void): MenuItem[] {
  const block = deleteBlock(campaign);
  const ended = campaign.status === "ended";
  return [
    ...(ended
      ? []
      : [
          {
            label: t("campaignRename"),
            lead: <Icon name="pencil" size={18} />,
            onSelect: () => onAction("rename"),
          },
          {
            label: t("campaignEnd"),
            lead: <Icon name="prohibit" size={18} />,
            danger: true,
            divider: true,
            onSelect: () => onAction("end"),
          },
        ]),
    {
      label: t("campaignDelete"),
      lead: <Icon name="trash" size={18} />,
      danger: true,
      ...(block !== null && { unavailable: t(block) }),
      onSelect: () => onAction("delete"),
    },
  ];
}

/**
 * A campaign in the list: its trigger's tile, its name and sentence, its status and results, and
 * for an owner or an admin, a menu beside it.
 */
export function CampaignRow({
  campaign,
  onOpen,
  onAction,
}: {
  campaign: Campaign;
  onOpen(): void;
  /** Null for a member, who reads campaigns only. */
  onAction: ((action: RowAction) => void) | null;
}) {
  const { definition } = campaign;
  return (
    <li className="campaign-item">
      <button type="button" className="campaign-row" onClick={onOpen}>
        <TriggerTile type={definition.trigger.type} />
        <span className="row-lines">
          <b>{definition.name}</b>
          <span className="row-sentence">{campaignSentence(definition)}</span>
        </span>
        <StatusChip status={campaign.status} />
        {campaign.status === "draft" ? (
          <span className="row-quiet">{t("campaignNotLive")}</span>
        ) : (
          <RowStats campaign={campaign} />
        )}
        {onAction === null && <Icon name="chevronRight" size={16} />}
      </button>
      {onAction !== null && (
        <Menu
          label={t("campaignActions", { name: definition.name })}
          buttonClass="round row-menu"
          items={rowItems(campaign, onAction)}
        >
          <Icon name="dots" />
        </Menu>
      )}
    </li>
  );
}
