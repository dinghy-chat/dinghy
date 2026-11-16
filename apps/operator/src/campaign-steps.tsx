/** @jsxImportSource react */
import { type ReactNode, useId, useState } from "react";
import { Icon } from "./icons.tsx";
import { t } from "./text.ts";

// The cards of the campaign editor: a numbered step that stays open, and a part folded to one line
// that opens in place. Each body is a fieldset, so a member reads it and changes nothing, while a
// fold still opens for them.

function StepCard({
  mark,
  title,
  aside,
  disabled,
  children,
}: {
  mark: ReactNode;
  title: string;
  aside: ReactNode;
  disabled: boolean;
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
      {children !== null && (
        <fieldset className="step-body" disabled={disabled}>
          <legend className="visually-hidden">{title}</legend>
          {children}
        </fieldset>
      )}
    </section>
  );
}

/** One numbered step of the editor, always open. `aside` sits at the end of its header. */
export function Step({
  number,
  title,
  aside,
  disabled,
  children,
}: {
  number: number;
  title: string;
  aside?: ReactNode;
  disabled: boolean;
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
      disabled={disabled}
    >
      {children}
    </StepCard>
  );
}

/** A part folded to its title and one line of summary, with Edit to open it in place. */
export function Fold({
  title,
  summary,
  disabled,
  children,
}: {
  title: string;
  summary: string;
  disabled: boolean;
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
    <StepCard mark={mark} title={title} aside={toggle} disabled={disabled}>
      {isOpen ? children : null}
    </StepCard>
  );
}
