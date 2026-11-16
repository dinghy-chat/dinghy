import { WEEKDAYS } from "../../../packages/widget/src/shared.ts";
import { goalCondition } from "../../server/src/campaign-parts.ts";
import type { CampaignDefinition, CampaignTrigger, Condition } from "./api.ts";
import {
  type FieldChoice,
  type GroupDraft,
  groupOf,
  isGroup,
  kindOf,
  type Op,
  type RuleDraft,
  takesKey,
  takesValue,
} from "./campaign-conditions.ts";
import { weekdayNames } from "./format.ts";
import { plural, type TextId, t } from "./text.ts";

// A campaign in plain words, from its definition: the list's one sentence per campaign, and the
// editor's summaries of its folded parts. One place, so both always say the same thing.

type Presentation = CampaignDefinition["presentation"];
type Rules = CampaignDefinition["rules"];

export const FIELD_TEXT: Record<FieldChoice, TextId> = {
  name: "conditionFieldName",
  firstName: "conditionFieldFirstName",
  email: "email",
  userId: "conditionFieldUserId",
  language: "conditionFieldLanguage",
  country: "colCountry",
  timeZone: "conditionFieldTimeZone",
  signedIn: "conditionFieldSignedIn",
  hasChatted: "conditionFieldHasChatted",
  optedOut: "conditionFieldOptedOut",
  conversationCount: "colConversations",
  firstSeenAt: "sortFirstSeen",
  lastSeenAt: "sortLastSeen",
  attribute: "conditionFieldAttribute",
  eventCount: "conditionFieldEventCount",
  eventLastAt: "conditionFieldEventLastAt",
  repliedToCampaign: "conditionFieldReplied",
};

const OP_TEXT: Record<Op, TextId> = {
  eq: "conditionIs",
  ne: "conditionIsNot",
  in: "conditionIn",
  not_in: "conditionNotIn",
  exists: "conditionExists",
  missing: "conditionMissing",
  gt: "conditionGt",
  gte: "conditionGte",
  lt: "conditionLt",
  lte: "conditionLte",
  contains: "conditionContains",
  older_than: "conditionOlderThan",
};

/** A time compares as before and after, not as more and less. */
const TIME_OP_TEXT: Partial<Record<Op, TextId>> = {
  gt: "conditionAfter",
  gte: "conditionAfter",
  lt: "conditionBefore",
  lte: "conditionBefore",
};

/** An operator's words for a rule's field, such as "is after" for a time. */
export const opText = (field: FieldChoice, op: Op) =>
  t((kindOf(field) === "time" ? TIME_OP_TEXT[op] : undefined) ?? OP_TEXT[op]);

const DURATION_UNITS = {
  m: ["durationMinuteOne", "durationMinuteMany"],
  h: ["durationHourOne", "durationHourMany"],
  d: ["durationDayOne", "durationDayMany"],
} as const satisfies Record<string, [TextId, TextId]>;

/** A duration as the server takes it, in words: "1h" is "1 hour". */
export function durationWords(duration: string): string {
  const unit = duration.at(-1);
  if (unit !== "m" && unit !== "h" && unit !== "d") return duration;
  const [one, many] = DURATION_UNITS[unit];
  return plural(Number(duration.slice(0, -1)), one, many);
}

/** A rule in words: "plan is one of trial, pro", or "Signed in" for a yes. */
function ruleWords(rule: RuleDraft): string {
  const field =
    rule.field === "attribute"
      ? rule.key
      : takesKey(rule.field)
        ? `${t(FIELD_TEXT[rule.field])} ${rule.key}`
        : t(FIELD_TEXT[rule.field]);
  if (kindOf(rule.field) === "boolean" && (rule.op === "eq" || rule.op === "ne")) {
    const isYes = (rule.text === "true") === (rule.op === "eq");
    return isYes ? field : t("summaryNot", { field });
  }
  if (!takesValue(rule.op)) return `${field} ${opText(rule.field, rule.op)}`;
  const value = rule.op === "older_than" ? durationWords(rule.text) : rule.text;
  return `${field} ${opText(rule.field, rule.op)} ${value}`;
}

const JOINS: Record<"all" | "any", TextId> = { all: "summaryAnd", any: "summaryOr" };

function groupWords(group: GroupDraft, nested: boolean): string {
  const parts = group.items.map((item) =>
    isGroup(item) ? groupWords(item, true) : ruleWords(item),
  );
  if (group.match === "none") return t("summaryNoneOf", { rules: parts.join(", ") });
  const words = parts.join(t(JOINS[group.match]));
  return nested && parts.length > 1 ? `(${words})` : words;
}

/** A condition in words, as one line. */
export const conditionWords = (condition: Condition) => groupWords(groupOf(condition), false);

/** Who gets it: everyone, or the audience's rules. */
const audienceWords = (audience: Condition | undefined) =>
  audience === undefined ? t("summaryEveryone") : conditionWords(audience);

const REPEAT_TEXT: Record<Extract<CampaignTrigger, { type: "schedule" }>["repeat"], TextId> = {
  once: "summaryScheduleOnce",
  daily: "summaryScheduleDaily",
  weekly: "summaryScheduleWeekly",
  monthly: "summaryScheduleMonthly",
};
const DAY_NAMES = weekdayNames("short");

/** When it goes, after who gets it: "1 hour after they match". */
function triggerWords(trigger: CampaignTrigger): string {
  switch (trigger.type) {
    case "match":
      return trigger.delay === undefined
        ? t("summaryMatchNow")
        : t("summaryMatchAfter", { delay: durationWords(trigger.delay) });
    case "event":
      return trigger.delay === undefined
        ? t("summaryEventNow", { event: trigger.name })
        : t("summaryEventAfter", { event: trigger.name, delay: durationWords(trigger.delay) });
    case "page":
      return t("summaryPage", { url: trigger.url, seconds: trigger.seconds });
    case "schedule": {
      const days = (trigger.days ?? []).map((day) => DAY_NAMES[WEEKDAYS.indexOf(day)]);
      return t(REPEAT_TEXT[trigger.repeat], {
        time: trigger.time,
        date: trigger.startDate,
        days: days.join(", "),
      });
    }
    case "api":
      return t("summaryApi");
  }
}

const SHOW_WORDS: Record<Presentation["show"], TextId> = {
  badge: "summaryShowBadge",
  preview: "summaryShowPreview",
  chat: "summaryShowChat",
};

/** The list's sentence: who, when and how it shows. */
export const campaignSentence = ({ audience, trigger, presentation }: CampaignDefinition) =>
  t("summarySentence", {
    who: audienceWords(audience),
    when: triggerWords(trigger),
    show: t(SHOW_WORDS[presentation.show]),
  });

/** How many people, as the estimate gives it: "1,204 people", or "10,000+ people". */
export const peopleWords = ({ count, more }: { count: number; more: boolean }) =>
  t(count === 1 && !more ? "campaignPeopleOne" : "campaignPeopleMany", {
    count: `${count.toLocaleString()}${more ? "+" : ""}`,
  });

/** The rules folded: "Once per person · stops when Replied to this campaign · any time". */
export function rulesWords(rules: Rules): string {
  const parts = [
    rules.frequency === "once"
      ? t("summaryOnce")
      : t("summaryEvery", { every: durationWords(rules.frequency.every) }),
  ];
  if (rules.exitWhen !== undefined) {
    parts.push(t("summaryExit", { condition: conditionWords(rules.exitWhen) }));
  }
  if (rules.businessHours) parts.push(t("summaryBusinessHours"));
  if (rules.sendWindow !== undefined) parts.push(t("summaryWindow", rules.sendWindow));
  if (!rules.businessHours && rules.sendWindow === undefined) parts.push(t("summaryAnyTime"));
  if (rules.endsAt !== null) {
    parts.push(t("summaryEnds", { date: new Date(rules.endsAt).toLocaleDateString() }));
  }
  return parts.join(" · ");
}

/** The goal folded: "domainVerified within 7 days", or no goal. */
export function goalWords(goal: Rules["goal"]): string {
  if (goal === undefined) return t("campaignGoalEmpty");
  return t("summaryGoal", {
    condition: conditionWords(goalCondition(goal)),
    within: durationWords(goal.within),
  });
}

const START_WORDS: Record<Presentation["startConversation"], TextId> = {
  on_reply: "summaryStartOnReply",
  now: "summaryStartNow",
};
const IF_OPEN_WORDS: Record<Presentation["ifConversationOpen"], TextId> = {
  hold: "summaryIfOpenHold",
  join: "summaryIfOpenJoin",
  skip: "summaryIfOpenSkip",
};

/** Delivery folded: when the conversation starts, an open one, and email. */
export function deliveryWords({ presentation, delivery }: CampaignDefinition): string {
  return [
    t(START_WORDS[presentation.startConversation]),
    t(IF_OPEN_WORDS[presentation.ifConversationOpen]),
    t(delivery.sendEmail ? "summaryEmail" : "summaryNoEmail"),
  ].join(" · ");
}
