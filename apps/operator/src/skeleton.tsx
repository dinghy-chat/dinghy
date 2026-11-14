/** @jsxImportSource react */
import type { ReactNode } from "react";
import { t } from "./text.ts";

/**
 * Placeholders in the shape of what loads, so a screen keeps its layout when the data arrives.
 * They fade in only after a moment, so a quick load shows nothing at all. app.css draws them.
 */

/** One grey bar, or a circle with `round`. Sizes are in pixels, or any CSS length. */
export function Bone({
  width,
  height = 12,
  round = false,
}: {
  width: number | string;
  height?: number | string;
  round?: boolean;
}) {
  return <span className={round ? "bone round" : "bone"} style={{ width, height }} />;
}

/** Says "Loading" once to a screen reader, and hides the bones from it. */
function Skeleton({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={className === undefined ? "skeleton" : `skeleton ${className}`}>
      <p className="visually-hidden" role="status">
        {t("loading")}
      </p>
      <div className="skeleton-bones" aria-hidden="true">
        {children}
      </div>
    </div>
  );
}

// Widths that differ from row to row, so the bones read as text and not as a grid.
const NAMES = [112, 86, 128, 98, 120, 76, 104];
const LINES = ["88%", "64%", "76%", "92%", "58%", "82%", "70%"];

/** The Inbox's conversation rows. */
export function RowsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <Skeleton className="rows-skeleton">
      {NAMES.slice(0, count).map((name, index) => (
        <div key={name} className="bone-row">
          <Bone width={38} height={38} round />
          <div className="bone-lines">
            <div className="bone-top">
              <Bone width={name} height={13} />
              <Bone width={38} height={11} />
            </div>
            <Bone width={LINES[index] ?? "80%"} />
            {index % 2 === 0 && <Bone width={104} height={18} />}
          </div>
        </div>
      ))}
    </Skeleton>
  );
}

// A conversation's bubbles: who wrote each one, and how wide it is.
const BUBBLES: { visitor: boolean; width: string; lines: number }[] = [
  { visitor: true, width: "46%", lines: 2 },
  { visitor: false, width: "38%", lines: 1 },
  { visitor: true, width: "30%", lines: 1 },
  { visitor: false, width: "52%", lines: 3 },
  { visitor: true, width: "36%", lines: 1 },
];

/** An open conversation: its header, a few bubbles and the composer. */
export function ThreadSkeleton() {
  return (
    <Skeleton className="thread-skeleton">
      <div className="bone-head">
        <Bone width={38} height={38} round />
        <div className="bone-lines">
          <Bone width={140} height={14} />
          <Bone width={90} height={11} />
        </div>
      </div>
      <div className="bone-bubbles">
        {BUBBLES.map((bubble) => (
          <div
            key={`${bubble.width}-${bubble.lines}`}
            className={bubble.visitor ? "bone bone-bubble visitor" : "bone bone-bubble"}
            style={{ width: bubble.width, height: 18 + bubble.lines * 20 }}
          />
        ))}
      </div>
      <div className="bone-composer" />
    </Skeleton>
  );
}

/** A settings page's rows: a title and its help on the left, a control on the right. */
export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Skeleton>
      {NAMES.slice(0, rows).map((name, index) => (
        <div key={name} className="page-row">
          <div className="bone-lines">
            <Bone width={name} height={15} />
            <Bone width="92%" />
            <Bone width={LINES[index] ?? "70%"} />
          </div>
          <Bone width="100%" height={46} />
        </div>
      ))}
    </Skeleton>
  );
}

/** The Contacts table: a face and a name, then the other columns. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Skeleton className="table-skeleton">
      {NAMES.slice(0, rows).map((name, index) => (
        <div key={name} className="bone-row">
          <Bone width={32} height={32} round />
          <div className="bone-lines">
            <Bone width={name} height={13} />
            {index % 2 === 1 && <Bone width={name + 30} height={11} />}
          </div>
          <span className="wide-cell">
            <Bone width={84} />
          </span>
          <Bone width={24} />
          <span className="wide-cell">
            <Bone width={96} />
          </span>
        </div>
      ))}
    </Skeleton>
  );
}

/** Analytics: the four numbers, then the charts. */
export function AnalyticsSkeleton() {
  return (
    <Skeleton className="analytics">
      <div className="stats">
        {NAMES.slice(0, 4).map((name) => (
          <div key={name} className="stat bone-lines">
            <Bone width={name} height={12} />
            <Bone width={72} height={30} />
            <Bone width="60%" height={11} />
          </div>
        ))}
      </div>
      <div className="charts">
        <div className="chart-card bone-lines">
          <Bone width={170} height={15} />
          <div className="bone-bars">
            {[30, 46, 38, 62, 54, 80, 44, 70, 58, 90, 66, 48].map((height, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list that never changes.
              <Bone key={index} width="100%" height={height * 1.8} />
            ))}
          </div>
        </div>
        <div className="chart-card bone-lines">
          <Bone width={150} height={15} />
          {[100, 62, 40, 24].map((width) => (
            <div key={width} className="bone-lines">
              <Bone width={110} />
              <Bone width={`${width}%`} height={8} />
            </div>
          ))}
        </div>
      </div>
    </Skeleton>
  );
}

/** Visitors: the map, and the people beside it. */
export function VisitorsSkeleton() {
  return (
    <Skeleton className="live-layout">
      <div className="bone-map" />
      <div className="bone-lines">
        <Bone width={80} height={13} />
        <RowsBones count={4} />
      </div>
    </Skeleton>
  );
}

/** Rows of a face, a name and a line, for lists inside another skeleton. */
function RowsBones({ count }: { count: number }) {
  return (
    <>
      {NAMES.slice(0, count).map((name, index) => (
        <div key={name} className="bone-row">
          <Bone width={32} height={32} round />
          <div className="bone-lines">
            <Bone width={name} height={13} />
            <Bone width={LINES[index] ?? "70%"} height={11} />
          </div>
        </div>
      ))}
    </>
  );
}

/** A short list, such as a webhook's deliveries. */
export function ListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <Skeleton>
      <RowsBones count={count} />
    </Skeleton>
  );
}

/** The sidebar's menu, while the app loads. On a phone, app.css moves it to the top and bottom bars. */
export function SideSkeleton() {
  return (
    <div className="side-skeleton" aria-hidden="true">
      <span className="bone-workspace">
        <Bone width="100%" height="100%" />
      </span>
      <div className="nav">
        {[58, 74, 62, 70, 64].map((width) => (
          <div key={width} className="bone-nav">
            <Bone width={18} height={18} />
            <Bone width={width} height={13} />
          </div>
        ))}
      </div>
      <span className="bone-me">
        <Bone width="100%" height="100%" />
      </span>
    </div>
  );
}
