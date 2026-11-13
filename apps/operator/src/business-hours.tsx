/** @jsxImportSource react */
import { type FormEvent, useState } from "react";
import {
  type BusinessHours,
  DAY_RANGES_MAX,
  WEEKDAYS,
} from "../../../packages/widget/src/shared.ts";
import type { BusinessHoursSettings, WorkspaceApi } from "./api.ts";
import { SettingRow, Switch } from "./appearance.tsx";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import { Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { ErrorNote, failureText, Loading, Page } from "./ui.tsx";

type Range = [string, string];
type Week = BusinessHours["week"];

// A time input has no 24:00, so its midnight ends a day when it closes a range.
const MIDNIGHT = "00:00";
const END_OF_DAY = "24:00";
// Monday, 1 January 2024, for each day's name.
const A_MONDAY_MS = Date.UTC(2024, 0, 1);
const DAY_MS = 86_400_000;
// A new day's hours, and a weekday's before the first save.
const DEFAULT_RANGE: Range = ["09:00", "17:00"];

/** Every zone the browser knows, and the saved one first when the browser does not know it. */
function zoneChoices(saved: string) {
  // An older browser cannot list them, and then offers the saved zone only.
  const known = Intl.supportedValuesOf?.("timeZone") ?? [];
  return (known.includes(saved) ? known : [saved, ...known]).map((zone) => ({
    value: zone,
    label: zone.replaceAll("_", " "),
  }));
}

/** What the page shows before the first save: off, in the browser's zone, on weekdays from 9 to 5. */
function firstHours(): BusinessHoursSettings {
  const weekday: Range[] = [DEFAULT_RANGE];
  return {
    enabled: false,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    week: {
      mon: weekday,
      tue: weekday,
      wed: weekday,
      thu: weekday,
      fri: weekday,
      sat: [],
      sun: [],
    },
  };
}

const dayName = (index: number) =>
  new Date(A_MONDAY_MS + index * DAY_MS).toLocaleDateString([], {
    weekday: "long",
    timeZone: "UTC",
  });

/** Each range ends after it starts, and the next one starts after it ends. */
const isValidWeek = (week: Week) =>
  WEEKDAYS.every((day) =>
    week[day].every(
      ([start, end], index, ranges) => start < end && (ranges[index + 1]?.[0] ?? end) >= end,
    ),
  );

/** The server takes each day's ranges in order. */
const sortedWeek = (week: Week): Week =>
  Object.fromEntries(
    WEEKDAYS.map((day) => [day, [...week[day]].sort(([one], [other]) => one.localeCompare(other))]),
  ) as Week;

/** One day's ranges, each with its two times, or "Closed". */
function DayHours({
  name,
  ranges,
  onChange,
}: {
  name: string;
  ranges: Range[];
  onChange(ranges: Range[]): void;
}) {
  const last = ranges.at(-1)?.[1];
  const set = (index: number, range: Range) =>
    onChange(ranges.map((one, at) => (at === index ? range : one)));
  return (
    <div className="day-hours">
      {ranges.length === 0 && <span className="hint">{t("businessHoursClosed")}</span>}
      {ranges.map(([start, end], index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a range has no ID, and its place is its name.
        <span className="day-range" key={index}>
          <input
            type="time"
            aria-label={t("businessHoursOpens", { day: name })}
            value={start}
            required
            onChange={(event) => set(index, [event.target.value, end])}
          />
          <span aria-hidden="true">–</span>
          <input
            type="time"
            aria-label={t("businessHoursCloses", { day: name })}
            value={end === END_OF_DAY ? MIDNIGHT : end}
            required
            onChange={(event) =>
              set(index, [start, event.target.value === MIDNIGHT ? END_OF_DAY : event.target.value])
            }
          />
          <button
            type="button"
            className="round"
            aria-label={t("businessHoursRemove", { day: name, start, end })}
            onClick={() => onChange(ranges.filter((_, at) => at !== index))}
          >
            <Icon name="close" size={16} />
          </button>
        </span>
      ))}
      {ranges.length < DAY_RANGES_MAX && last !== END_OF_DAY && (
        <button
          type="button"
          className="text-button"
          onClick={() =>
            onChange([...ranges, last === undefined ? DEFAULT_RANGE : [last, END_OF_DAY]])
          }
        >
          {t("businessHoursAdd")}
        </button>
      )}
    </div>
  );
}

/**
 * Settings > Business hours: a switch, the time zone and each day's ranges. Outside them the widget
 * shows the away message from Appearance. Owners and admins only.
 */
export function BusinessHoursPage({ api }: { api: WorkspaceApi }) {
  const loaded = useLoad(() => api.businessHours().then((saved) => saved ?? firstHours()), [api]);
  // Null until the first change, so the page shows what is saved until then.
  const [edited, setEdited] = useState<BusinessHoursSettings | null>(null);
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = loaded.data;
  if (saved === null) {
    return (
      <Page title={t("pageBusinessHours")}>
        <Loading failure={loaded.failure} />
      </Page>
    );
  }
  const hours = edited ?? saved;
  const change = (next: Partial<BusinessHoursSettings>) => {
    setEdited({ ...hours, ...next });
    setError(null);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const week = sortedWeek(hours.week);
    if (!isValidWeek(week)) {
      setError("businessHoursInvalid");
      return;
    }
    setBusy(true);
    try {
      loaded.setData(await api.setBusinessHours({ ...hours, week }));
      setEdited(null);
      toast("businessHoursSaved");
    } catch (failure) {
      setError(failureText(failure, {}));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title={t("pageBusinessHours")} context={t("businessHoursContext")}>
      <form className="widget-form" onSubmit={save}>
        <div className="setting-rows">
          <div className="setting-row setting-switch">
            <Switch
              label={t("businessHoursOn")}
              hint={t("businessHoursOnHelp")}
              checked={hours.enabled}
              onChange={(enabled) => change({ enabled })}
            />
          </div>
          <SettingRow label={t("businessHoursZone")} hint={t("businessHoursZoneHelp")}>
            {() => (
              <Select
                label={t("businessHoursZone")}
                side="end"
                value={hours.timeZone}
                choices={zoneChoices(hours.timeZone)}
                onChange={(timeZone) => change({ timeZone })}
              />
            )}
          </SettingRow>
          {WEEKDAYS.map((day, index) => {
            const name = dayName(index);
            return (
              <SettingRow key={day} label={name}>
                {() => (
                  <DayHours
                    name={name}
                    ranges={hours.week[day]}
                    onChange={(ranges) => change({ week: { ...hours.week, [day]: ranges } })}
                  />
                )}
              </SettingRow>
            );
          })}
        </div>
        <div className="widget-save">
          <button type="submit" className="pill dark" disabled={busy || edited === null}>
            {t("save")}
          </button>
          <ErrorNote text={error} />
        </div>
      </form>
    </Page>
  );
}
