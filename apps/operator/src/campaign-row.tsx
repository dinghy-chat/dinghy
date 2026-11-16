/** @jsxImportSource react */
import { percent, shareOf } from "./analytics.tsx";
import type { Campaign } from "./api.ts";
import { campaignSentence } from "./campaign-summary.ts";
import { StatusChip } from "./campaign-tile.tsx";
import { TriggerTile } from "./campaign-trigger.tsx";
import { Icon } from "./icons.tsx";
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

/** A campaign in the list: its trigger's tile, its name and sentence, its status and results. */
export function CampaignRow({ campaign, onOpen }: { campaign: Campaign; onOpen(): void }) {
  const { definition } = campaign;
  return (
    <li>
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
        <Icon name="chevronRight" size={16} />
      </button>
    </li>
  );
}
