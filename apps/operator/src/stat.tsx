/** @jsxImportSource react */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { plural, type TextId, t } from "./text.ts";

// The key numbers of Analytics, Visitors and a campaign's results: a band of stats, each with its
// change against the period before, and the card that a chart's part or an "i" shows.

export const percent = (share: number) =>
  new Intl.NumberFormat([], { style: "percent", maximumFractionDigits: 0 }).format(share);

/** A part of a total, from 0 to 1; 0 when the total is 0. */
export const shareOf = (count: number, total: number) => (total === 0 ? 0 : count / total);

/** A number with its label, or the words behind an "i" button. */
type TipContent = { value: string; label: string } | { text: string };

type Tip = TipContent & { x: number; y: number };

/** The card for the part of `area` at `target`, placed above it, or null off every part. */
function tipAt(area: HTMLElement | null, target: EventTarget | null): Tip | null {
  const part =
    target instanceof Element ? target.closest<HTMLElement>("[data-value], [data-tip]") : null;
  if (part === null || area === null) return null;
  const outer = area.getBoundingClientRect();
  const inner = part.getBoundingClientRect();
  const { tip, value, label } = part.dataset;
  return {
    ...(tip === undefined ? { value: value ?? "", label: label ?? "" } : { text: tip }),
    x: inner.left + inner.width / 2 - outer.left,
    y: inner.top - outer.top,
  };
}

/**
 * An area whose parts carry data-value and data-label, or data-tip. The pointer over a part, or
 * the focus on it, shows them in a card above it, kept inside the area. Escape hides the card.
 * The words for screen readers are in each figure's caption, or in each button's label.
 */
export function Tipped({ className, children }: { className: string; children: ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    const width = box.current?.clientWidth ?? 0;
    if (tip === null || element === null) return;
    const half = element.offsetWidth / 2;
    element.style.left = `${Math.min(Math.max(tip.x, half), width - half)}px`;
  }, [tip]);
  // Focus and Escape, for the keys. Listened to here, as the area itself takes no focus.
  useEffect(() => {
    const area = box.current;
    if (area === null) return;
    const focus = (event: FocusEvent) => setTip(tipAt(area, event.target));
    const hide = () => setTip(null);
    const hideOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    area.addEventListener("focusin", focus);
    area.addEventListener("focusout", hide);
    document.addEventListener("keydown", hideOnEscape);
    return () => {
      area.removeEventListener("focusin", focus);
      area.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", hideOnEscape);
    };
  }, []);
  return (
    <div
      ref={box}
      className={`tipped ${className}`}
      onPointerOver={(event) => setTip(tipAt(box.current, event.target))}
      onPointerLeave={() => setTip(null)}
    >
      {children}
      {tip !== null && (
        <div
          ref={card}
          className={"text" in tip ? "chart-tip words" : "chart-tip"}
          style={{ top: tip.y }}
          aria-hidden="true"
        >
          {"text" in tip ? (
            tip.text
          ) : (
            <>
              <b>{tip.value}</b>
              <span>{tip.label}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A small "i" whose words show in the Tipped card. Screen readers read them as its label. */
function Info({ text }: { text: TextId }) {
  return (
    <button type="button" className="info-tip" aria-label={t(text)} data-tip={t(text)}>
      i
    </button>
  );
}

/** One cell of a `.stats` band: its title, with an "i" when it has help, then its numbers. */
export function Stat({
  title,
  help,
  children,
}: {
  title: TextId;
  help?: TextId;
  children: ReactNode;
}) {
  return (
    <article className="stat">
      <h3>
        {t(title)}
        {help !== undefined && <Info text={help} />}
      </h3>
      {children}
    </article>
  );
}

/** Better, worse, or neither, as the change's color says. */
type Direction = "better" | "worse" | "neutral";

/** A change against the previous period, and the words that name that period. */
export function Change({
  words,
  direction,
  compared,
}: {
  words: string;
  direction: Direction;
  compared: string;
}) {
  return (
    <p className={`stat-change ${direction}`}>
      {words} <span>{compared}</span>
    </p>
  );
}

/** A count's change in percent, neither better nor worse. Nothing when there was none before. */
export function CountChange({
  count,
  before,
  compared,
}: {
  count: number;
  before: number;
  compared: string;
}) {
  if (before === 0) return null;
  const change = count / before - 1;
  // A change that rounds to 0% reads as none, not as "↑ 0%".
  const words =
    percent(Math.abs(change)) === percent(0)
      ? t("changeSame")
      : t(change > 0 ? "changeUp" : "changeDown", { change: percent(Math.abs(change)) });
  return <Change words={words} direction="neutral" compared={compared} />;
}

/** A share's change in points, where more is better. Nothing when either share is unknown. */
export function ShareChange({
  share,
  before,
  compared,
}: {
  share: number | null;
  before: number | null;
  compared: string;
}) {
  if (share === null || before === null) return null;
  const points = Math.round((share - before) * 100);
  if (points === 0)
    return <Change words={t("changeSame")} direction="neutral" compared={compared} />;
  return (
    <Change
      words={
        points > 0
          ? plural(points, "pointUp", "pointsUp", { points })
          : plural(-points, "pointDown", "pointsDown", { points: -points })
      }
      direction={points > 0 ? "better" : "worse"}
      compared={compared}
    />
  );
}

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 32;

/**
 * The values as a small line over its own area, oldest first. With a label it is an image that
 * screen readers name; without, the numbers beside it say the same.
 */
export function Sparkline({
  values,
  className = "spark",
  label,
}: {
  values: number[];
  className?: string;
  label?: string;
}) {
  const most = Math.max(1, ...values);
  const last = Math.max(1, values.length - 1);
  const line = `M${values
    .map((value, index) => {
      const x = (index / last) * SPARK_WIDTH;
      const y = SPARK_HEIGHT - (value / most) * (SPARK_HEIGHT - 2);
      return `${x},${y}`;
    })
    .join("L")}`;
  const paths = (
    <>
      <path
        className="spark-area"
        d={`${line}L${SPARK_WIDTH},${SPARK_HEIGHT}L0,${SPARK_HEIGHT}Z`}
      />
      <path className="spark-line" d={line} />
    </>
  );
  const box = `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`;
  return label === undefined ? (
    <svg className={className} viewBox={box} preserveAspectRatio="none" aria-hidden="true">
      {paths}
    </svg>
  ) : (
    <svg
      className={className}
      viewBox={box}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {paths}
    </svg>
  );
}

const RING_RADIUS = 18;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** A share from 0 to 1 as a ring that fills clockwise. */
export function Ring({ share }: { share: number }) {
  return (
    <svg className="ring" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r={RING_RADIUS} className="ring-back" />
      {share > 0 && (
        <circle
          cx="22"
          cy="22"
          r={RING_RADIUS}
          className="ring-front"
          strokeDasharray={`${share * RING_LENGTH} ${RING_LENGTH}`}
        />
      )}
    </svg>
  );
}
