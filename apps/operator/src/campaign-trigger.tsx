/** @jsxImportSource react */
import { useMemo } from "react";
import {
  PAGE_SECONDS_DEFAULT,
  PAGE_SECONDS_MAX,
  WEEKDAYS,
  type Weekday,
} from "../../../packages/widget/src/shared.ts";
import type { CampaignTrigger } from "./api.ts";
import { zoneChoices } from "./business-hours.tsx";
import { dateInput, withPart } from "./campaign-draft.ts";
import { DAY_NAMES, durationWords } from "./campaign-summary.ts";
import { TINT, Tile, type Tint } from "./campaign-tile.tsx";
import { browserTimeZone } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { CodeBlock } from "./install.tsx";
import { Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { Choices, Field, type Option, type OptionCard, OptionCards } from "./ui.tsx";

type TriggerType = CampaignTrigger["type"];
type Schedule = Extract<CampaignTrigger, { type: "schedule" }>;

/** Each trigger's words, help and tile, for its card in the editor and its row in the list. */
const TRIGGERS: Record<TriggerType, { label: TextId; hint: TextId; icon: IconName; tint: Tint }> = {
  match: { label: "triggerMatch", hint: "triggerMatchHelp", icon: "user", tint: TINT.mint },
  schedule: {
    label: "triggerSchedule",
    hint: "triggerScheduleHelp",
    icon: "clock",
    tint: TINT.yellow,
  },
  event: { label: "triggerEvent", hint: "triggerEventHelp", icon: "webhook", tint: TINT.blue },
  page: { label: "triggerPage", hint: "triggerPageHelp", icon: "globe", tint: TINT.peach },
  api: { label: "triggerApi", hint: "triggerApiHelp", icon: "code", tint: TINT.blue },
};

export const TriggerTile = ({ type }: { type: TriggerType }) => (
  <Tile icon={TRIGGERS[type].icon} tint={TRIGGERS[type].tint} />
);

const TRIGGER_CARDS: OptionCard<TriggerType>[] = (Object.keys(TRIGGERS) as TriggerType[]).map(
  (value) => ({
    value,
    label: TRIGGERS[value].label,
    hint: TRIGGERS[value].hint,
    art: <Icon name={TRIGGERS[value].icon} size={18} />,
  }),
);

/** The waits a trigger offers, from none to a month. */
const DELAYS = ["10m", "30m", "1h", "2h", "6h", "12h", "1d", "2d", "3d", "7d", "14d", "30d"];
const NO_DELAY = "none";

const REPEATS: Option<Schedule["repeat"]>[] = [
  { value: "once", label: "repeatOnce" },
  { value: "daily", label: "repeatDaily" },
  { value: "weekly", label: "repeatWeekly" },
  { value: "monthly", label: "repeatMonthly" },
];

/** A trigger of a new type, with what it needs filled in. */
function triggerOf(type: TriggerType): CampaignTrigger {
  if (type === "schedule") {
    return {
      type,
      repeat: "once",
      time: "09:00",
      startDate: dateInput(new Date()),
      timeZone: browserTimeZone(),
    };
  }
  if (type === "event") return { type, name: "" };
  if (type === "page") return { type, url: "", seconds: PAGE_SECONDS_DEFAULT };
  return { type };
}

/** The SDK call that runs a campaign for one person, from the customer's server. */
export const sendCode = (key: string) =>
  `// server\nawait dinghy.campaigns.send(${JSON.stringify(key)}, {\n  visitor: { userId: user.id },\n});`;

/**
 * "Wait 1 hour after they match": a wait from a short list, plus the one code saved if it is not
 * on it.
 */
function DelayField({
  after,
  delay,
  onChange,
}: {
  after: TextId;
  delay: string | undefined;
  onChange(delay: string | undefined): void;
}) {
  const value = delay ?? NO_DELAY;
  const delays = DELAYS.includes(value) || value === NO_DELAY ? DELAYS : [...DELAYS, value];
  return (
    <p className="trigger-delay">
      {t("triggerWait")}
      <Select
        label={t("triggerDelay")}
        value={value}
        choices={[
          { value: NO_DELAY, label: durationWords("0m") },
          ...delays.map((one) => ({ value: one, label: durationWords(one) })),
        ]}
        onChange={(next) => onChange(next === NO_DELAY ? undefined : next)}
      />
      {t(after)}
    </p>
  );
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
        <DelayField
          after="triggerAfterMatch"
          delay={trigger.delay}
          onChange={(delay) => onChange(withPart(trigger, "delay", delay))}
        />
      );
    case "schedule":
      return <ScheduleFields trigger={trigger} onChange={onChange} />;
    case "event":
      return (
        <>
          <Field
            label={t("conditionEventName")}
            hint={t("triggerEventNameHelp")}
            required
            placeholder="export.finished"
            value={trigger.name}
            onChange={(name) => onChange({ ...trigger, name })}
          />
          <DelayField
            after="triggerAfterEvent"
            delay={trigger.delay}
            onChange={(delay) => onChange(withPart(trigger, "delay", delay))}
          />
        </>
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

/** When a contact gets the message: the trigger's cards, then its own fields under them. */
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
      <OptionCards<TriggerType>
        label={t("campaignTrigger")}
        value={trigger.type}
        options={TRIGGER_CARDS}
        onChange={(type) => onChange(triggerOf(type))}
      />
      <TriggerDetails trigger={trigger} campaignKey={campaignKey} onChange={onChange} />
    </>
  );
}
