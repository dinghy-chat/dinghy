/** @jsxImportSource react */
import { Icon, type IconName } from "./icons.tsx";

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
