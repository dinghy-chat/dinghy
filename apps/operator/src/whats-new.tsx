/** @jsxImportSource react */
import { useEffect, useId, useState } from "react";

import { dayName } from "./analytics.tsx";
import { Icon } from "./icons.tsx";
import { type TextId, t } from "./text.ts";
import { DocLink, Modal } from "./ui.tsx";
import {
  markUpdatesSeen,
  onSeenElsewhere,
  UPDATES,
  type Update,
  type UpdateKind,
  unseenCount,
} from "./updates.ts";

const CHANGELOG_URL = "https://dinghy.chat/changelog/";

/** "November 23, 2026". */
const longDay = (date: string) => dayName(date, { month: "long", day: "numeric", year: "numeric" });

const KIND_TEXT: Record<UpdateKind, TextId> = {
  feature: "updateFeature",
  improvement: "updateImprovement",
  fix: "updateFix",
};

/** The updates in runs of one day, newest first. */
function byDay(): { date: string; updates: (Update & { index: number })[] }[] {
  const days: { date: string; updates: (Update & { index: number })[] }[] = [];
  UPDATES.forEach((update, index) => {
    const last = days.at(-1);
    if (last?.date === update.date) last.updates.push({ ...update, index });
    else days.push({ date: update.date, updates: [{ ...update, index }] });
  });
  return days;
}

/** A sheet on the right with the updates by day, newest first. The first `freshCount` get a New tag. */
function UpdatesSheet({ freshCount, onClose }: { freshCount: number; onClose(): void }) {
  const titleId = useId();
  return (
    <Modal className="dialog updates" labelledBy={titleId} onClose={onClose}>
      {(close) => (
        <div className="dialog-body">
          <div className="updates-head">
            <h2 id={titleId}>{t("whatsNew")}</h2>
            <button type="button" className="icon-button" aria-label={t("close")} onClick={close}>
              <Icon name="close" size={18} />
            </button>
          </div>
          <div className="updates-days">
            {byDay().map((day) => (
              <section key={day.date} className="updates-day">
                <h3>
                  <time dateTime={day.date}>{longDay(day.date)}</time>
                </h3>
                <ul>
                  {day.updates.map((update) => (
                    <li key={update.id} className="update">
                      <p className="update-tags">
                        <span className={`update-kind ${update.kind}`}>
                          {t(KIND_TEXT[update.kind])}
                        </span>
                        {update.index < freshCount && (
                          <span className="update-new">{t("updatesNew")}</span>
                        )}
                      </p>
                      <h4>{update.title}</h4>
                      <p>{update.text}</p>
                      {update.docs !== undefined && (
                        <p className="update-docs">
                          <DocLink path={update.docs} text="updatesDocs" />
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="updates-foot">
            <a className="doc-link" href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer">
              {t("updatesAll")}
              <Icon name="arrowUpRight" size={14} />
            </a>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** What's new, above Help, with a red dot until the operator opens the newest updates. */
export function WhatsNew({ operatorId }: { operatorId: string }) {
  const [unseen, setUnseen] = useState(() => unseenCount(operatorId));
  // Null while closed. An operator who never opened it sees no New tags, as all would have one.
  const [freshCount, setFreshCount] = useState<number | null>(null);
  useEffect(() => {
    setUnseen(unseenCount(operatorId));
    return onSeenElsewhere(operatorId, () => setUnseen(unseenCount(operatorId)));
  }, [operatorId]);
  const openUpdates = () => {
    setFreshCount(unseen < UPDATES.length ? unseen : 0);
    markUpdatesSeen(operatorId);
    setUnseen(0);
  };
  return (
    // The dialog stays inside, so Help still follows this item in the sidebar.
    <div className="whats-new">
      <button
        type="button"
        className="help"
        aria-label={t(unseen > 0 ? "whatsNewUnseen" : "whatsNew")}
        onClick={openUpdates}
      >
        <Icon name="gift" size={20} />
        <span className="help-text">{t("whatsNew")}</span>
        {unseen > 0 && <i className="whats-new-dot" aria-hidden="true" />}
      </button>
      {freshCount !== null && (
        <UpdatesSheet freshCount={freshCount} onClose={() => setFreshCount(null)} />
      )}
    </div>
  );
}
