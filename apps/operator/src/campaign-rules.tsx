/** @jsxImportSource react */
import { goalCondition } from "../../server/src/campaign-parts.ts";
import type { CampaignDefinition, Condition } from "./api.ts";
import { withPart } from "./campaign-draft.ts";
import { ConditionBuilder } from "./condition-builder.tsx";
import { dateTimeInput } from "./format.ts";
import { type TextId, t } from "./text.ts";
import {
  Choices,
  Field,
  type Option,
  type OptionCard,
  OptionCards,
  SettingRow,
  Switch,
} from "./ui.tsx";

type Presentation = CampaignDefinition["presentation"];
type Delivery = CampaignDefinition["delivery"];
type Rules = CampaignDefinition["rules"];

/** A duration as the server takes it: 1 to 9999 with m, h or d. */
const DURATION_PATTERN = "[1-9][0-9]{0,3}[mhd]";
const GOAL_WITHIN = "7d";
const FREQUENCY_EVERY = "7d";
const SEND_WINDOW = { from: "09:00", to: "18:00" };

/** A duration, such as "7d", or nothing when the box is empty. */
function DurationField({
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
const IF_OPEN: Option<Presentation["ifConversationOpen"]>[] = [
  { value: "hold", label: "ifOpenHold" },
  { value: "join", label: "ifOpenJoin" },
  { value: "skip", label: "ifOpenSkip" },
];

/** A small drawing of the launcher, with a dot, a card above it, or the open chat. */
const ShowArt = ({ show }: { show: Presentation["show"] }) => (
  <span className={`show-art show-${show}`} />
);

const SHOW_CARDS: OptionCard<Presentation["show"]>[] = [
  { value: "badge", label: "showBadge", hint: "showBadgeHelp", art: <ShowArt show="badge" /> },
  {
    value: "preview",
    label: "showPreview",
    hint: "showPreviewHelp",
    art: <ShowArt show="preview" />,
  },
  { value: "chat", label: "showChat", hint: "showChatHelp", art: <ShowArt show="chat" /> },
];

/** How the message shows, as cards. A page campaign never opens the chat. */
export function ShowCards({
  show,
  isPage,
  onChange,
}: {
  show: Presentation["show"];
  isPage: boolean;
  onChange(show: Presentation["show"]): void;
}) {
  return (
    <>
      <OptionCards<Presentation["show"]>
        label={t("campaignShow")}
        value={show}
        options={isPage ? SHOW_CARDS.filter((one) => one.value !== "chat") : SHOW_CARDS}
        onChange={onChange}
      />
      {isPage && <p className="hint">{t("campaignShowPageHelp")}</p>}
    </>
  );
}

/**
 * When the conversation starts and what an open one does, email, always or once unread for a time,
 * the assignment on a reply, and how long it waits. A page campaign starts a conversation on reply.
 */
export function DeliveryFields({
  presentation,
  delivery,
  isPage,
  onPresentation,
  onChange,
}: {
  presentation: Presentation;
  delivery: Delivery;
  isPage: boolean;
  onPresentation(presentation: Presentation): void;
  onChange(delivery: Delivery): void;
}) {
  return (
    <div className="setting-rows">
      <ChoiceRow
        label="campaignStart"
        hint="campaignStartHelp"
        value={presentation.startConversation}
        options={isPage ? STARTS.filter((one) => one.value !== "now") : STARTS}
        onChange={(startConversation) => onPresentation({ ...presentation, startConversation })}
      />
      <ChoiceRow
        label="campaignIfOpen"
        hint="campaignIfOpenHelp"
        value={presentation.ifConversationOpen}
        options={IF_OPEN}
        onChange={(ifConversationOpen) => onPresentation({ ...presentation, ifConversationOpen })}
      />
      <div className="setting-row setting-switch">
        <Switch
          label={t("campaignSendEmail")}
          hint={t("campaignSendEmailHelp")}
          checked={delivery.sendEmail}
          onChange={(sendEmail) => onChange({ ...delivery, sendEmail })}
        />
      </div>
      <DurationField
        label={t("campaignEmailIfUnread")}
        hint={t("campaignEmailIfUnreadHelp")}
        value={delivery.emailIfUnread}
        onChange={(emailIfUnread) => onChange(withPart(delivery, "emailIfUnread", emailIfUnread))}
      />
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

/** Frequency, hours, the end, and who leaves the campaign. */
export function RulesFields({ rules, onRules }: { rules: Rules; onRules(rules: Rules): void }) {
  const change = (next: Partial<Rules>) => onRules({ ...rules, ...next });
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
        value={rules.endsAt === null ? "" : dateTimeInput(rules.endsAt)}
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
    </div>
  );
}

/** What the campaign is for, and how long after a message reaching it counts. */
export function GoalFields({
  goal,
  onChange,
}: {
  goal: Rules["goal"];
  onChange(goal: Rules["goal"]): void;
}) {
  const condition = goal === undefined ? undefined : goalCondition(goal);
  const within = goal?.within ?? GOAL_WITHIN;
  const set = (next: Condition | undefined, time: string) =>
    onChange(next === undefined ? undefined : { ...next, within: time });
  return (
    <div className="setting-rows">
      <p className="hint">{t("campaignGoalHelp")}</p>
      <ConditionBuilder
        initial={condition}
        inCampaign
        emptyText="campaignGoalEmpty"
        onChange={(next) => set(next, within)}
      />
      {condition !== undefined && (
        <DurationField
          label={t("campaignGoalWithin")}
          required
          value={within}
          onChange={(time) => set(condition, time ?? "")}
        />
      )}
    </div>
  );
}
