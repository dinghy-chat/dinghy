import { LOCALES, type Locale } from "../../../packages/widget/src/shared.ts";
import { messagesOf } from "../../server/src/campaign-parts.ts";
import type { CampaignDefinition, Member } from "./api.ts";

// The editor's campaign: the same JSON the API takes, from a new one's first fields to the code
// that "Copy as code" gives.

/**
 * `object` with `key` set to `value`, or without the key when the value is undefined: an optional
 * part of a campaign is left out, never set to undefined.
 */
export function withPart<T extends object, K extends keyof T>(
  object: T,
  key: K,
  value: T[K] | undefined,
): T {
  if (value !== undefined) return { ...object, [key]: value };
  const { [key]: _left, ...rest } = object;
  return rest as T;
}

/** A new campaign's fields: a message for everyone who starts to match, once per person. */
export const newDefinition = (): CampaignDefinition => ({
  key: "",
  name: "",
  trigger: { type: "match" },
  message: { body: "" },
  presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
  delivery: { sendEmail: false },
  rules: { frequency: "once", businessHours: false, endsAt: null },
});

type Message = CampaignDefinition["message"];

/** The languages that one of the messages lacks: the campaign's own, or a variant's own. */
export const missingLocales = (definition: Pick<CampaignDefinition, "message" | "variants">) =>
  LOCALES.filter((locale) =>
    messagesOf(definition).some((message) => message.translations?.[locale] === undefined),
  );

/** The message with a translation in `locale`, which starts as its own text. One it has stays. */
export const withTranslation = (message: Message, locale: Locale): Message =>
  message.translations?.[locale] !== undefined
    ? message
    : { ...message, translations: { ...message.translations, [locale]: { body: message.body } } };

/** The campaign with a translation in `locale` in each of its messages that lacks one. */
export function withLanguage(definition: CampaignDefinition, locale: Locale): CampaignDefinition {
  const variants = definition.variants?.map((variant) =>
    "message" in variant && variant.message !== undefined
      ? { ...variant, message: withTranslation(variant.message, locale) }
      : variant,
  );
  return withPart(
    { ...definition, message: withTranslation(definition.message, locale) },
    "variants",
    variants,
  );
}

/** The list with the item at `index` changed to `next`, or removed when `next` is null. */
export const replaceAt = <T>(list: readonly T[], index: number, next: T | null): T[] =>
  list.flatMap((item, at) => (at !== index ? [item] : next === null ? [] : [next]));

/** A day as a date input takes it, "2026-11-16", in this browser's time zone. */
export const dateInput = (date: Date) => date.toLocaleDateString("en-CA");

/** The longest key, as CAMPAIGN_KEY_PATTERN allows it. */
export const KEY_MAX = 64;

/** A key made from a name, as a new campaign suggests it: "DNS help" gives "dns-help". */
export const keyFromName = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KEY_MAX);

/** The member a message's sender names, by ID or by email in any case, as the server matches. */
export const senderMember = (
  sender: { operatorId: string } | { email: string },
  members: Member[],
) =>
  members.find((one) =>
    "operatorId" in sender
      ? one.id === sender.operatorId
      : one.email.toLowerCase() === sender.email.toLowerCase(),
  );

/** The message without a sender who is no longer a member, so it comes from whoever saves it. */
function withKnownSender(message: Message, members: Member[]): Message {
  const { sender } = message;
  if (sender === undefined || sender === "team") return message;
  return senderMember(sender, members) === undefined
    ? withPart(message, "sender", undefined)
    : message;
}

/**
 * A copy of a campaign as a new draft: an end already past would end it at once, so it goes, and a
 * sender who left gives way to whoever saves it. A schedule keeps its dates, which the draft shows
 * to change.
 */
export function copyOf(
  definition: CampaignDefinition,
  { name, key, members, now }: { name: string; key: string; members: Member[]; now: Date },
): CampaignDefinition {
  const { rules } = definition;
  const variants = definition.variants?.map((variant) =>
    "message" in variant && variant.message !== undefined
      ? { ...variant, message: withKnownSender(variant.message, members) }
      : variant,
  );
  return withPart(
    {
      ...definition,
      name,
      key,
      message: withKnownSender(definition.message, members),
      rules: {
        ...rules,
        endsAt: rules.endsAt !== null && new Date(rules.endsAt) <= now ? null : rules.endsAt,
      },
    },
    "variants",
    variants,
  );
}

/** The definition as JSON, as the API, MCP and the SDK take it. */
export const definitionJson = (definition: CampaignDefinition) =>
  JSON.stringify(definition, null, 2);

/** The SDK call that keeps the campaign in a repository. */
export const upsertCode = (definition: CampaignDefinition) =>
  `// server, in a deploy script\nawait dinghy.campaigns.upsert(${definitionJson(definition)});`;
