import { expect, test } from "vitest";
import { CampaignDefinitionSchema } from "../../server/src/campaign-schemas.ts";
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

test("a condition reads as one line: a list, a yes, and a group", () => {
  expect(conditionWords({ field: "attributes.plan", op: "in", value: ["trial", "pro"] })).toBe(
    "plan is one of trial, pro",
  );
  expect(conditionWords({ field: "signedIn", op: "eq", value: true })).toBe("Signed in");
  expect(conditionWords({ field: "hasChatted", op: "eq", value: false })).toBe("not Has chatted");
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
  ).toBe("plan is pro and (Country is FR or Country is BE)");
});

test("the list's sentence says who, when and how it shows", () => {
  const definition = {
    ...newDefinition(),
    audience: { field: "attributes.plan", op: "in" as const, value: ["trial", "pro"] },
    trigger: { type: "match" as const, delay: "1h" },
  };
  expect(campaignSentence(definition)).toBe(
    "plan is one of trial, pro, 1 hour after they match · card above the launcher",
  );
  expect(
    campaignSentence({
      ...newDefinition(),
      trigger: { type: "page", url: "/pricing", seconds: 20 },
      presentation: { ...newDefinition().presentation, show: "badge" },
    }),
  ).toBe("Everyone, on /pricing for 20 seconds · dot on the launcher");
  expect(
    campaignSentence({ ...newDefinition(), trigger: { type: "event", name: "export.finished" } }),
  ).toBe("Everyone, when your server tracks export.finished · card above the launcher");
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
  ).toBe("At most every 7 days · stops when Replied to this campaign · business hours only");
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
