/** @jsxImportSource react */
import { type ReactNode, useId, useState } from "react";
import { Icon } from "./icons.tsx";
import { t } from "./text.ts";

// The cards of the campaign editor: a numbered step that stays open, and a part folded to one line
// that opens in place. The read-only overview uses the same steps.

function StepCard({
  mark,
  title,
  aside,
  children,
}: {
  mark: ReactNode;
  title: string;
  aside: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="step" aria-labelledby={titleId}>
      <header className="step-head">
        {mark}
        <h3 id={titleId}>{title}</h3>
        {aside}
      </header>
      {children !== null && <div className="step-body">{children}</div>}
    </section>
  );
}

/** One numbered step of the editor, always open. `aside` sits at the end of its header. */
export function Step({
  number,
  title,
  aside,
  children,
}: {
  number: number;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const mark = (
    <span className="step-index" aria-hidden="true">
      {number}
    </span>
  );
  return (
    <StepCard
      mark={mark}
      title={title}
      aside={aside !== undefined && <div className="step-aside">{aside}</div>}
    >
      {children}
    </StepCard>
  );
}

/** A part folded to its title and one line of summary, with Edit to open it in place. */
export function Fold({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  const [isOpen, setOpen] = useState(false);
  const mark = (
    <span className="step-index done" aria-hidden="true">
      <Icon name="check" size={14} />
    </span>
  );
  const toggle = (
    <>
      {!isOpen && <p className="step-summary">{summary}</p>}
      <button
        type="button"
        className="text-button step-aside"
        aria-expanded={isOpen}
        aria-label={t(isOpen ? "foldClosePart" : "foldEditPart", { part: title })}
        onClick={() => setOpen(!isOpen)}
      >
        {t(isOpen ? "foldClose" : "foldEdit")}
      </button>
    </>
  );
  return (
    <StepCard mark={mark} title={title} aside={toggle}>
      {isOpen ? children : null}
    </StepCard>
  );
}
