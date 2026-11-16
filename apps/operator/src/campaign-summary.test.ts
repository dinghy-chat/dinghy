import { expect, test } from "vitest";
import { CampaignDefinitionSchema } from "../../server/src/campaign-schemas.ts";
import type { CampaignDefinition } from "./api.ts";
import { newDefinition } from "./campaign-draft.ts";
import {
  campaignSentence,
  conditionWords,
  deliveryWords,
  durationWords,
  goalWords,
  rulesWords,
} from "./campaign-summary.ts";
import { freeKey, TEMPLATES } from "./campaign-templates.ts";

test("a duration reads in words, one or many", () => {
  expect(durationWords("1h")).toBe("1 hour");
  expect(durationWords("30m")).toBe("30 minutes");
  expect(durationWords("7d")).toBe("7 days");
});

test("a condition reads as one line: a list, a yes, a count and a group", () => {
  expect(conditionWords({ field: "attributes.plan", op: "in", value: ["trial", "pro"] })).toBe(
    "plan is trial or pro",
  );
  expect(conditionWords({ field: "signedIn", op: "eq", value: true })).toBe("they signed in");
  expect(conditionWords({ field: "hasChatted", op: "eq", value: false })).toBe(
    "they have never chatted",
  );
  expect(conditionWords({ field: "events.export.finished.count", op: "gte", value: 1 })).toBe(
    "they did export.finished at least 1 time",
  );
  expect(
    conditionWords({
      all: [
        { field: "attributes.plan", op: "eq", value: "pro" },
        {
          any: [
            { field: "country", op: "eq", value: "FR" },
            { field: "country", op: "eq", value: "BE" },
          ],
        },
      ],
    }),
  ).toBe("plan is pro and (country is FR or country is BE)");
});

test("the list's sentence says who, when and how it shows, in plain words", () => {
  const sentence = (parts: Partial<CampaignDefinition>) =>
    campaignSentence({ ...newDefinition(), ...parts });
  expect(
    sentence({
      audience: { field: "attributes.plan", op: "in", value: ["trial", "pro"] },
      trigger: { type: "match", delay: "1h" },
    }),
  ).toBe("People whose plan is trial or pro, 1 hour after they match · as a card");
  expect(
    sentence({
      audience: { field: "events.export.finished.count", op: "gte", value: 3 },
      trigger: { type: "event", name: "export.finished" },
    }),
  ).toBe("People who did export.finished at least 3 times, after export.finished · as a card");
  expect(
    sentence({
      audience: {
        all: [
          { field: "signedIn", op: "eq", value: true },
          { field: "attributes.plan", op: "eq", value: "pro" },
        ],
      },
      trigger: { type: "api" },
    }),
  ).toBe("People who match 2 rules, when your code sends it · as a card");
  expect(
    sentence({
      trigger: { type: "page", url: "/pricing", seconds: 20 },
      presentation: { ...newDefinition().presentation, show: "badge" },
    }),
  ).toBe("Everyone, on /pricing for 20 seconds · as a dot on the launcher");
});

test("the folded parts read as one line each", () => {
  const { rules } = newDefinition();
  expect(rulesWords(rules)).toBe("Once per person · any time");
  expect(
    rulesWords({
      ...rules,
      frequency: { every: "7d" },
      businessHours: true,
      exitWhen: { field: "repliedToCampaign", op: "eq", value: true },
    }),
  ).toBe("At most every 7 days · stops when they replied to it · business hours only");
  expect(goalWords(undefined)).toBe("No goal.");
  expect(
    goalWords({ field: "attributes.domainVerified", op: "eq", value: true, within: "7d" }),
  ).toBe("domainVerified is true within 7 days");
  expect(deliveryWords(newDefinition())).toBe(
    "Conversation starts on reply · skips people in a conversation · no email",
  );
});

test("each template is a definition the server takes", () => {
  for (const template of TEMPLATES) {
    const parsed = CampaignDefinitionSchema.safeParse(template.definition());
    expect(parsed.error?.issues ?? [], template.title).toEqual([]);
  }
});

test("a template's key moves aside for a campaign that has it", () => {
  expect(freeKey("welcome", new Set())).toBe("welcome");
  expect(freeKey("welcome", new Set(["welcome", "welcome-2"]))).toBe("welcome-3");
});
