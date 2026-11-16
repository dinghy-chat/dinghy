import { CONTACT_VARIABLES, WEEKDAYS } from "../../../packages/widget/src/shared.ts";
import { VARIABLE_PREFIXES } from "../../../packages/widget/src/template.ts";
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
  takesList,
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

type BooleanField = "signedIn" | "hasChatted" | "optedOut" | "repliedToCampaign";

/** What a yes, then a no, of a field says the person did, after "they" or "people who". */
const DID_TEXT: Record<BooleanField, [TextId, TextId]> = {
  signedIn: ["summarySignedIn", "summaryNotSignedIn"],
  hasChatted: ["summaryChatted", "summaryNotChatted"],
  optedOut: ["summaryOptedOut", "summaryNotOptedOut"],
  repliedToCampaign: ["summaryReplied", "summaryNotReplied"],
};
const isBooleanField = (field: FieldChoice): field is BooleanField =>
  Object.hasOwn(DID_TEXT, field);

/** A field inside a sentence, in lower case. An attribute goes by its key. */
const FIELD_WORDS: Record<Exclude<FieldChoice, BooleanField | "attribute">, TextId> = {
  name: "summaryFieldName",
  firstName: "summaryFieldFirstName",
  email: "summaryFieldEmail",
  userId: "summaryFieldUserId",
  language: "summaryFieldLanguage",
  country: "summaryFieldCountry",
  timeZone: "summaryFieldTimeZone",
  conversationCount: "summaryFieldConversations",
  firstSeenAt: "summaryFieldFirstSeen",
  lastSeenAt: "summaryFieldLastSeen",
  eventCount: "summaryFieldEventCount",
  eventLastAt: "summaryFieldEventLastAt",
};

/** How many times an event happened, by the comparison: "at least 3 times". */
const TIMES_TEXT: Partial<Record<Op, TextId>> = {
  eq: "summaryTimesEq",
  ne: "summaryTimesNe",
  gt: "summaryTimesGt",
  gte: "summaryTimesGte",
  lt: "summaryTimesLt",
  lte: "summaryTimesLte",
};

const OR_LIST = new Intl.ListFormat(undefined, { type: "disjunction" });

/** A rule's value in words: "trial or pro", "7 days", or a day. */
function valueWords(rule: RuleDraft): string {
  if (takesList(rule.op)) {
    return OR_LIST.format(
      rule.text
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    );
  }
  if (rule.op === "older_than") return durationWords(rule.text);
  return kindOf(rule.field) === "time" ? new Date(rule.text).toLocaleDateString() : rule.text;
}

/** A list compares as one value: "is trial or pro", "is not trial or pro". */
const opWords = (rule: RuleDraft) =>
  rule.op === "in"
    ? t("conditionIs")
    : rule.op === "not_in"
      ? t("conditionIsNot")
      : opText(rule.field, rule.op);

/**
 * A rule as what the person did, "signed in" or "did export.finished at least 3 times", or as what
 * a field of theirs is, "plan is trial or pro".
 */
function rulePhrase(rule: RuleDraft): { kind: "did" | "is"; words: string } {
  const { field, op } = rule;
  if (isBooleanField(field)) {
    // A yes or no compares only as is, or is not.
    const isYes = (rule.text === "true") === (op !== "ne");
    return { kind: "did", words: t(DID_TEXT[field][isYes ? 0 : 1]) };
  }
  const times = TIMES_TEXT[op];
  if (field === "eventCount" && times !== undefined) {
    const count = plural(Number(rule.text), "summaryTimeOne", "summaryTimeMany");
    return {
      kind: "did",
      words: t("summaryDidEvent", { event: rule.key, times: t(times, { count }) }),
    };
  }
  const fieldWords = field === "attribute" ? rule.key : t(FIELD_WORDS[field], { event: rule.key });
  const words = `${fieldWords} ${opWords(rule)}`;
  return { kind: "is", words: takesValue(op) ? `${words} ${valueWords(rule)}` : words };
}

/** A rule as a clause: "they signed in", or "plan is trial or pro". */
function ruleWords(rule: RuleDraft): string {
  const phrase = rulePhrase(rule);
  return phrase.kind === "did" ? t("summaryThey", { did: phrase.words }) : phrase.words;
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

const ruleCount = (group: GroupDraft): number =>
  group.items.reduce((count, item) => count + (isGroup(item) ? ruleCount(item) : 1), 0);

const WHO_MATCH: Record<GroupDraft["match"], TextId> = {
  all: "summaryWhoAll",
  any: "summaryWhoAny",
  none: "summaryWhoNone",
};

/** An audience's one rule, or null when it has none, several, or "none of". */
function onlyRule(group: GroupDraft): RuleDraft | null {
  const [only, ...others] = group.items;
  return only !== undefined && others.length === 0 && !isGroup(only) && group.match !== "none"
    ? only
    : null;
}

/**
 * Who gets it, short enough for the list's one line: everyone, one rule in words, such as "People
 * whose plan is trial or pro", or how many rules they match.
 */
function audienceWords(audience: Condition | undefined): string {
  if (audience === undefined) return t("summaryEveryone");
  const group = groupOf(audience);
  const only = onlyRule(group);
  if (only !== null) {
    const phrase = rulePhrase(only);
    return phrase.kind === "did"
      ? t("summaryWhoDid", { did: phrase.words })
      : t("summaryWhoIs", { rule: phrase.words });
  }
  const rules = plural(ruleCount(group), "summaryRulesOne", "summaryRulesMany");
  return t(WHO_MATCH[group.match], { rules });
}

/** A variable of a message's text in words: "first name", or the key of an attribute or data. */
export function variableWords(path: string): string {
  const field = CONTACT_VARIABLES.find((one) => one === path);
  if (field !== undefined) return t(FIELD_WORDS[field]);
  const prefix = Object.values(VARIABLE_PREFIXES).find((one) => path.startsWith(one));
  return prefix === undefined ? path : path.slice(prefix.length);
}

const REPEAT_TEXT: Record<Extract<CampaignTrigger, { type: "schedule" }>["repeat"], TextId> = {
  once: "summaryScheduleOnce",
  daily: "summaryScheduleDaily",
  weekly: "summaryScheduleWeekly",
  monthly: "summaryScheduleMonthly",
};
/** The days' short names, Monday first, as WEEKDAYS orders them. */
export const DAY_NAMES = weekdayNames("short");

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

/**
 * An event campaign whose audience counts the same event, said once: "After export.finished, once
 * they have done it 3 times", or null for any other campaign.
 */
function eventCountWords(audience: Condition | undefined, trigger: CampaignTrigger) {
  if (audience === undefined || trigger.type !== "event" || trigger.delay !== undefined)
    return null;
  const rule = onlyRule(groupOf(audience));
  if (rule?.field !== "eventCount" || rule.key !== trigger.name) return null;
  if (rule.op !== "gte" && rule.op !== "gt") return null;
  const count = Number(rule.text) + (rule.op === "gt" ? 1 : 0);
  return t("summaryEventFrom", {
    event: trigger.name,
    times: plural(count, "summaryTimeOne", "summaryTimeMany"),
  });
}

/** The list's sentence: who, when and how it shows. */
export function campaignSentence({ audience, trigger, presentation }: CampaignDefinition) {
  const show = t(SHOW_WORDS[presentation.show]);
  const eventCount = eventCountWords(audience, trigger);
  if (eventCount !== null) return t("summarySentenceWhen", { when: eventCount, show });
  return t("summarySentence", { who: audienceWords(audience), when: triggerWords(trigger), show });
}

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
