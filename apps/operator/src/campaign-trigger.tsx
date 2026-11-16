/** @jsxImportSource react */
import { useMemo } from "react";
import { WEEKDAYS, type Weekday } from "../../../packages/widget/src/shared.ts";
import type { CampaignTrigger } from "./api.ts";
import { zoneChoices } from "./business-hours.tsx";
import { withPart } from "./campaign-draft.ts";
import { DurationField } from "./campaign-rules.tsx";
import { browserTimeZone, weekdayNames } from "./format.ts";
import { CodeBlock } from "./install.tsx";
import { Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { Choices, Field, type Option } from "./ui.tsx";

type TriggerType = CampaignTrigger["type"];
type Schedule = Extract<CampaignTrigger, { type: "schedule" }>;

const TRIGGER_TEXT: Record<TriggerType, TextId> = {
  match: "triggerMatch",
  schedule: "triggerSchedule",
  event: "triggerEvent",
  page: "triggerPage",
  api: "triggerApi",
};

const TRIGGERS: Option<TriggerType>[] = (Object.keys(TRIGGER_TEXT) as TriggerType[]).map(
  (value) => ({ value, label: TRIGGER_TEXT[value] }),
);

const REPEATS: Option<Schedule["repeat"]>[] = [
  { value: "once", label: "repeatOnce" },
  { value: "daily", label: "repeatDaily" },
  { value: "weekly", label: "repeatWeekly" },
  { value: "monthly", label: "repeatMonthly" },
];

/** How long a page campaign waits on the page by default. */
const PAGE_SECONDS = 20;
const PAGE_SECONDS_MAX = 3600;
const DAY_NAMES = weekdayNames("short");
const today = () => new Date().toLocaleDateString("en-CA");

/** A trigger of a new type, with what it needs filled in. */
function triggerOf(type: TriggerType): CampaignTrigger {
  if (type === "schedule") {
    return {
      type,
      repeat: "once",
      time: "09:00",
      startDate: today(),
      timeZone: browserTimeZone(),
    };
  }
  if (type === "event") return { type, name: "" };
  if (type === "page") return { type, url: "", seconds: PAGE_SECONDS };
  return { type };
}

/** The SDK call that runs a campaign for one person, from the customer's server. */
export const sendCode = (key: string) =>
  `// server\nawait dinghy.campaigns.send(${JSON.stringify(key)}, {\n  visitor: { userId: user.id },\n});`;

/** A trigger in plain words, for the list: "On a page: /pricing* after 20 s". */
export function triggerWords(trigger: CampaignTrigger): string {
  const kind = t(TRIGGER_TEXT[trigger.type]);
  if (trigger.type === "event") return `${kind}: ${trigger.name}`;
  if (trigger.type === "page") return `${kind}: ${trigger.url}`;
  if (trigger.type === "schedule") {
    const repeat = REPEATS.find((one) => one.value === trigger.repeat)?.label ?? "repeatOnce";
    return `${kind}: ${t(repeat)}, ${trigger.time}`;
  }
  return kind;
}

/** A weekly schedule's days, as pills to check. */
function DayPicks({
  days,
  onChange,
}: {
  days: Weekday[];
  onChange(days: Weekday[] | undefined): void;
}) {
  return (
    <fieldset className="choices outlined">
      <legend className="visually-hidden">{t("scheduleDays")}</legend>
      {WEEKDAYS.map((day, index) => (
        <label key={day}>
          <input
            type="checkbox"
            checked={days.includes(day)}
            onChange={(event) => {
              const next = WEEKDAYS.filter((one) =>
                one === day ? event.target.checked : days.includes(one),
              );
              onChange(next.length === 0 ? undefined : next);
            }}
          />
          {DAY_NAMES[index]}
        </label>
      ))}
    </fieldset>
  );
}

function ScheduleFields({
  trigger,
  onChange,
}: {
  trigger: Schedule;
  onChange(trigger: Schedule): void;
}) {
  const zones = useMemo(() => zoneChoices(trigger.timeZone), [trigger.timeZone]);
  const change = (next: Partial<Schedule>) => onChange({ ...trigger, ...next });
  return (
    <>
      <Choices<Schedule["repeat"]>
        label={t("scheduleRepeat")}
        variant="outlined"
        value={trigger.repeat}
        options={REPEATS}
        onChange={(repeat) =>
          // Only a weekly schedule has days, and it needs one at least.
          onChange(
            withPart(
              { ...trigger, repeat },
              "days",
              repeat === "weekly" ? (trigger.days ?? ["mon"]) : undefined,
            ),
          )
        }
      />
      {trigger.repeat === "weekly" && (
        <DayPicks
          days={trigger.days ?? []}
          onChange={(days) => onChange(withPart(trigger, "days", days))}
        />
      )}
      <div className="field-row">
        <Field
          label={t("scheduleTime")}
          type="time"
          required
          value={trigger.time}
          onChange={(time) => change({ time })}
        />
        <Field
          label={t("scheduleStart")}
          type="date"
          required
          value={trigger.startDate}
          onChange={(startDate) => change({ startDate })}
        />
        <Field
          label={t("scheduleEnd")}
          type="date"
          value={trigger.endDate ?? ""}
          onChange={(endDate) =>
            onChange(withPart(trigger, "endDate", endDate === "" ? undefined : endDate))
          }
        />
      </div>
      <div className="field">
        <span>{t("businessHoursZone")}</span>
        <Select
          label={t("businessHoursZone")}
          value={trigger.timeZone}
          choices={zones}
          onChange={(timeZone) => change({ timeZone })}
        />
      </div>
    </>
  );
}

/** The fields of the chosen trigger. */
function TriggerDetails({
  trigger,
  campaignKey,
  onChange,
}: {
  trigger: CampaignTrigger;
  campaignKey: string;
  onChange(trigger: CampaignTrigger): void;
}) {
  switch (trigger.type) {
    case "match":
      return (
        <DurationField
          label={t("triggerDelay")}
          value={trigger.delay}
          onChange={(delay) => onChange(withPart(trigger, "delay", delay))}
        />
      );
    case "schedule":
      return <ScheduleFields trigger={trigger} onChange={onChange} />;
    case "event":
      return (
        <div className="field-row">
          <Field
            label={t("conditionEventName")}
            hint={t("triggerEventHelp")}
            required
            placeholder="export.finished"
            value={trigger.name}
            onChange={(name) => onChange({ ...trigger, name })}
          />
          <DurationField
            label={t("triggerDelay")}
            value={trigger.delay}
            onChange={(delay) => onChange(withPart(trigger, "delay", delay))}
          />
        </div>
      );
    case "page":
      return (
        <div className="field-row">
          <Field
            label={t("triggerPageUrl")}
            hint={t("triggerPageUrlHelp")}
            required
            placeholder="/pricing*"
            value={trigger.url}
            onChange={(url) => onChange({ ...trigger, url })}
          />
          <Field
            label={t("triggerPageSeconds")}
            type="number"
            min={0}
            max={PAGE_SECONDS_MAX}
            required
            value={String(trigger.seconds)}
            onChange={(seconds) => onChange({ ...trigger, seconds: Number(seconds) })}
          />
        </div>
      );
    case "api":
      return <CodeBlock value={sendCode(campaignKey)} language="ts" title={t("triggerApiCode")} />;
  }
}

/** When a contact gets the message: the trigger's type, then its own fields. */
export function TriggerFields({
  trigger,
  campaignKey,
  onChange,
}: {
  trigger: CampaignTrigger;
  campaignKey: string;
  onChange(trigger: CampaignTrigger): void;
}) {
  return (
    <>
      <Choices<TriggerType>
        label={t("campaignTrigger")}
        variant="outlined"
        value={trigger.type}
        options={TRIGGERS}
        onChange={(type) => onChange(triggerOf(type))}
      />
      <TriggerDetails trigger={trigger} campaignKey={campaignKey} onChange={onChange} />
    </>
  );
}
