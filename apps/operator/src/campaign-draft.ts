import type { CampaignDefinition } from "./api.ts";

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

/** A key made from a name, as a new campaign suggests it: "DNS help" gives "dns-help". */
export const keyFromName = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** The definition as JSON, as the API, MCP and the SDK take it. */
export const definitionJson = (definition: CampaignDefinition) =>
  JSON.stringify(definition, null, 2);

/** The SDK call that keeps the campaign in a repository. */
export const upsertCode = (definition: CampaignDefinition) =>
  `// server, in a deploy script\nawait dinghy.campaigns.upsert(${definitionJson(definition)});`;
