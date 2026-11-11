/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import type { GetStarted as Steps, WorkspaceApi } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import type { SettingsPage } from "./settings.tsx";
import { type TextId, t } from "./text.ts";

type StepName = Exclude<keyof Steps, "dismissed">;

/** Each step, its words and the page that does it. A test chat starts on the site, from Install. */
const STEPS: { name: StepName; text: TextId; page: SettingsPage }[] = [
  { name: "install", text: "stepInstall", page: "install" },
  { name: "logo", text: "stepLogo", page: "workspace" },
  { name: "widget", text: "stepWidget", page: "appearance" },
  { name: "team", text: "stepTeam", page: "team" },
  { name: "notifications", text: "stepNotifications", page: "notifications" },
  { name: "chat", text: "stepChat", page: "install" },
];

const RING_RADIUS = 8;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** A small ring that fills as the steps get done. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  return (
    <svg className="progress-ring" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="ring-track" cx="10" cy="10" r={RING_RADIUS} />
      <circle
        className="ring-fill"
        cx="10"
        cy="10"
        r={RING_RADIUS}
        strokeDasharray={`${(RING_LENGTH * done) / total} ${RING_LENGTH}`}
      />
    </svg>
  );
}

/**
 * "Get started 2/6" at the foot of the sidebar, for owners and admins. It opens the steps, which the
 * server checks, until all are done or the member hides them, on every device.
 */
export function GetStarted({
  api,
  version,
  onOpen,
}: {
  api: WorkspaceApi;
  /** Goes up on changes in the workspace, so a step done elsewhere shows. */
  version: number;
  onOpen(page: SettingsPage): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Read again each time the steps open, as a step may have been done in Settings meanwhile.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version and open ask for a load.
  const steps = useLoad(() => api.getStarted(), [api, version, open]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const state = steps.data;
  if (state === null || state.dismissed) return null;
  const done = STEPS.filter((step) => state[step.name]).length;
  if (done === STEPS.length) return null;
  const total = STEPS.length;
  return (
    <div className="get-started" ref={root}>
      {open && (
        <section className="get-started-panel" aria-label={t("getStarted")}>
          <header>
            <div>
              <h2>{t("getStarted")}</h2>
              <p className="steps-progress">{t("getStartedDone", { done, total })}</p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t("getStartedClose")}
              onClick={() => setOpen(false)}
            >
              <Icon name="close" size={18} />
            </button>
          </header>
          <p className="hint">{t("getStartedHelp")}</p>
          <ol>
            {STEPS.map((step) => (
              <li key={step.name} className={state[step.name] ? "done" : undefined}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpen(step.page);
                  }}
                >
                  <span className="step-mark" aria-hidden="true">
                    {state[step.name] && <Icon name="check" size={14} />}
                  </span>
                  <span className="step-text">{t(step.text)}</span>
                  {state[step.name] ? (
                    <span className="visually-hidden">{t("stepDone")}</span>
                  ) : (
                    <Icon name="chevronRight" size={14} />
                  )}
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="text-button quiet"
            onClick={() => {
              void api.dismissGetStarted().then(() => steps.reload(), steps.reload);
              setOpen(false);
            }}
          >
            {t("getStartedDismiss")}
          </button>
        </section>
      )}
      <button
        type="button"
        className="get-started-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ProgressRing done={done} total={total} />
        <span>{t("getStarted")}</span>
        <span className="steps-count">{t("getStartedProgress", { done, total })}</span>
      </button>
    </div>
  );
}
