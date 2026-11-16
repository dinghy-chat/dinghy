/** @jsxImportSource react */
import type { Campaign } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { type TextId, t } from "./text.ts";

/** The tile colors of app.css, by name. */
export const TINT = { blue: "tint-0", peach: "tint-1", yellow: "tint-2", mint: "tint-3" } as const;
export type Tint = (typeof TINT)[keyof typeof TINT];

/** An icon on a tile of color, for a campaign's trigger or a template. */
export function Tile({ icon, tint }: { icon: IconName; tint: Tint }) {
  return (
    <span className={`campaign-tile ${tint}`} aria-hidden="true">
      <Icon name={icon} size={20} />
    </span>
  );
}

const STATUS_TEXT: Record<Campaign["status"], TextId> = {
  draft: "campaignDraft",
  live: "campaignLive",
  paused: "campaignPaused",
  ended: "campaignEnded",
};

const STATUS_TONE: Record<Campaign["status"], string> = {
  draft: "chip warn",
  live: "chip campaign-live",
  paused: "chip",
  ended: "chip",
};

/** A status as a chip: live in green with its dot in a ring, a draft in cream. */
export function StatusChip({ status }: { status: Campaign["status"] }) {
  return <span className={STATUS_TONE[status]}>{t(STATUS_TEXT[status])}</span>;
}
