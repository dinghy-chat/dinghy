/** @jsxImportSource react */
import type { CampaignDefinition, Condition } from "./api.ts";
import { localTime } from "./campaign-conditions.ts";
import { withPart } from "./campaign-draft.ts";
import { ConditionBuilder } from "./condition-builder.tsx";
import { type TextId, t } from "./text.ts";
import { Choices, Field, type Option, SettingRow, Switch } from "./ui.tsx";

type Presentation = CampaignDefinition["presentation"];
type Delivery = CampaignDefinition["delivery"];
type Rules = CampaignDefinition["rules"];
type Goal = NonNullable<Rules["goal"]>;

/** A duration as the server takes it: 1 to 9999 with m, h or d. */
const DURATION_PATTERN = "[1-9][0-9]{0,3}[mhd]";
const GOAL_WITHIN = "7d";
const FREQUENCY_EVERY = "7d";
const SEND_WINDOW = { from: "09:00", to: "18:00" };

/** A duration, such as "7d", or nothing when the box is empty. */
export function DurationField({
  label,
  hint = t("durationHint"),
  required = false,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  value: string | undefined;
  onChange(value: string | undefined): void;
}) {
  return (
    <Field
      label={label}
      hint={hint}
      placeholder={t("durationPlaceholder")}
      pattern={DURATION_PATTERN}
      required={required}
      value={value ?? ""}
      onChange={(text) => onChange(text.trim() === "" ? undefined : text.trim())}
    />
  );
}

/** One choice of the presentation, on its own line with its hint. */
function ChoiceRow<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: TextId;
  hint: TextId;
  value: T;
  options: Option<T>[];
  onChange(value: T): void;
}) {
  return (
    <SettingRow label={t(label)} hint={t(hint)} stacked>
      {(hintId) => (
        <Choices<T>
          label={t(label)}
          describedBy={hintId}
          variant="outlined"
          value={value}
          options={options}
          onChange={onChange}
        />
      )}
    </SettingRow>
  );
}

const STARTS: Option<Presentation["startConversation"]>[] = [
  { value: "on_reply", label: "startOnReply" },
  { value: "now", label: "startNow" },
];
const SHOWS: Option<Presentation["show"]>[] = [
  { value: "badge", label: "showBadge" },
  { value: "preview", label: "showPreview" },
  { value: "chat", label: "showChat" },
];
const IF_OPEN: Option<Presentation["ifConversationOpen"]>[] = [
  { value: "hold", label: "ifOpenHold" },
  { value: "join", label: "ifOpenJoin" },
  { value: "skip", label: "ifOpenSkip" },
];

/** How the message shows. A page campaign never opens the chat, nor starts a conversation first. */
export function PresentationFields({
  presentation,
  isPage,
  onChange,
}: {
  presentation: Presentation;
  isPage: boolean;
  onChange(presentation: Presentation): void;
}) {
  const change = (next: Partial<Presentation>) => onChange({ ...presentation, ...next });
  return (
    <div className="setting-rows">
      <ChoiceRow
        label="campaignShow"
        hint={isPage ? "campaignShowPageHelp" : "campaignShowHelp"}
        value={presentation.show}
        options={isPage ? SHOWS.filter((one) => one.value !== "chat") : SHOWS}
        onChange={(show) => change({ show })}
      />
      <ChoiceRow
        label="campaignStart"
        hint="campaignStartHelp"
        value={presentation.startConversation}
        options={isPage ? STARTS.filter((one) => one.value !== "now") : STARTS}
        onChange={(startConversation) => change({ startConversation })}
      />
      <ChoiceRow
        label="campaignIfOpen"
        hint="campaignIfOpenHelp"
        value={presentation.ifConversationOpen}
        options={IF_OPEN}
        onChange={(ifConversationOpen) => change({ ifConversationOpen })}
      />
    </div>
  );
}

/** Email, the assignment on a reply, and how long each message waits. */
export function DeliveryFields({
  delivery,
  onChange,
}: {
  delivery: Delivery;
  onChange(delivery: Delivery): void;
}) {
  return (
    <div className="setting-rows">
      <div className="setting-row setting-switch">
        <Switch
          label={t("campaignSendEmail")}
          hint={t("campaignSendEmailHelp")}
          checked={delivery.sendEmail}
          onChange={(sendEmail) => onChange({ ...delivery, sendEmail })}
        />
      </div>
      <div className="setting-row setting-switch">
        <Switch
          label={t("campaignAssignOnReply")}
          hint={t("campaignAssignOnReplyHelp")}
          checked={delivery.assignOnReply ?? true}
          onChange={(assignOnReply) => onChange({ ...delivery, assignOnReply })}
        />
      </div>
      <DurationField
        label={t("campaignExpiresIn")}
        hint={t("campaignExpiresInHelp")}
        value={delivery.expiresIn}
        onChange={(expiresIn) => onChange(withPart(delivery, "expiresIn", expiresIn))}
      />
    </div>
  );
}

/** The goal's condition, without its time. */
function goalCondition(goal: Goal | undefined): Condition | undefined {
  if (goal === undefined) return undefined;
  const { within: _within, ...condition } = goal;
  return condition as Condition;
}

/** At most once, or at most once in a time. */
function FrequencyField({
  frequency,
  onChange,
}: {
  frequency: Rules["frequency"];
  onChange(frequency: Rules["frequency"]): void;
}) {
  return (
    <SettingRow label={t("campaignFrequency")} hint={t("campaignFrequencyHelp")} stacked>
      {(hintId) => (
        <>
          <Choices<"once" | "every">
            label={t("campaignFrequency")}
            describedBy={hintId}
            variant="outlined"
            value={frequency === "once" ? "once" : "every"}
            options={[
              { value: "once", label: "frequencyOnce" },
              { value: "every", label: "frequencyEvery" },
            ]}
            onChange={(choice) => onChange(choice === "once" ? "once" : { every: FREQUENCY_EVERY })}
          />
          {frequency !== "once" && (
            <DurationField
              label={t("frequencyEveryLabel")}
              required
              value={frequency.every}
              onChange={(every) => onChange({ every: every ?? "" })}
            />
          )}
        </>
      )}
    </SettingRow>
  );
}

/** Times on the visitor's own clock, within which messages go. */
function SendWindowField({
  window,
  onChange,
}: {
  window: Rules["sendWindow"];
  onChange(window: Rules["sendWindow"]): void;
}) {
  return (
    <div className="setting-row setting-stacked">
      <Switch
        label={t("campaignSendWindow")}
        hint={t("campaignSendWindowHelp")}
        checked={window !== undefined}
        onChange={(on) => onChange(on ? SEND_WINDOW : undefined)}
      />
      {window !== undefined && (
        <div className="field-row">
          <Field
            label={t("sendWindowFrom")}
            type="time"
            required
            value={window.from}
            onChange={(from) => onChange({ ...window, from })}
          />
          <Field
            label={t("sendWindowTo")}
            type="time"
            required
            value={window.to}
            onChange={(to) => onChange({ ...window, to })}
          />
        </div>
      )}
    </div>
  );
}

/** Frequency, hours, the end, who leaves the campaign, its goal and the email fallback. */
export function RulesFields({
  rules,
  delivery,
  onRules,
  onDelivery,
}: {
  rules: Rules;
  delivery: Delivery;
  onRules(rules: Rules): void;
  onDelivery(delivery: Delivery): void;
}) {
  const change = (next: Partial<Rules>) => onRules({ ...rules, ...next });
  const goal = goalCondition(rules.goal);
  const within = rules.goal?.within ?? GOAL_WITHIN;
  const setGoal = (condition: Condition | undefined, time: string) =>
    onRules(
      withPart(rules, "goal", condition === undefined ? undefined : { ...condition, within: time }),
    );
  return (
    <div className="setting-rows">
      <FrequencyField frequency={rules.frequency} onChange={(frequency) => change({ frequency })} />
      <div className="setting-row setting-switch">
        <Switch
          label={t("campaignBusinessHours")}
          hint={t("campaignBusinessHoursHelp")}
          checked={rules.businessHours}
          onChange={(businessHours) => change({ businessHours })}
        />
      </div>
      <SendWindowField
        window={rules.sendWindow}
        onChange={(window) => onRules(withPart(rules, "sendWindow", window))}
      />
      <Field
        label={t("campaignEndsAt")}
        hint={t("campaignEndsAtHelp")}
        type="datetime-local"
        value={rules.endsAt === null ? "" : localTime(rules.endsAt)}
        onChange={(text) => change({ endsAt: text === "" ? null : new Date(text).toISOString() })}
      />
      <SettingRow label={t("campaignExitWhen")} hint={t("campaignExitWhenHelp")} stacked>
        {() => (
          <ConditionBuilder
            initial={rules.exitWhen}
            inCampaign
            emptyText="campaignExitWhenEmpty"
            onChange={(exitWhen) => onRules(withPart(rules, "exitWhen", exitWhen))}
          />
        )}
      </SettingRow>
      <SettingRow label={t("campaignGoal")} hint={t("campaignGoalHelp")} stacked>
        {() => (
          <>
            <ConditionBuilder
              initial={goal}
              inCampaign
              emptyText="campaignGoalEmpty"
              onChange={(condition) => setGoal(condition, within)}
            />
            {goal !== undefined && (
              <DurationField
                label={t("campaignGoalWithin")}
                required
                value={within}
                onChange={(time) => setGoal(goal, time ?? "")}
              />
            )}
          </>
        )}
      </SettingRow>
      <DurationField
        label={t("campaignEmailIfUnread")}
        hint={t("campaignEmailIfUnreadHelp")}
        value={delivery.emailIfUnread}
        onChange={(emailIfUnread) => onDelivery(withPart(delivery, "emailIfUnread", emailIfUnread))}
      />
    </div>
  );
}
