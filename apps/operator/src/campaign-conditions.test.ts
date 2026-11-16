import { describe, expect, test } from "vitest";
import type { Condition } from "./api.ts";
import {
  conditionOf,
  groupOf,
  isGroup,
  namesRead,
  newRule,
  type RuleDraft,
} from "./campaign-conditions.ts";
import { newDefinition } from "./campaign-draft.ts";

const roundTrip = (condition: Condition) => conditionOf(groupOf(condition));

describe("the condition builder's model", () => {
  test("a condition from code comes back the same", () => {
    const conditions: Condition[] = [
      { field: "attributes.plan", op: "in", value: ["trial", "pro"] },
      {
        all: [
          { field: "signedIn", op: "eq", value: true },
          { field: "events.export.finished.count", op: "gte", value: 3 },
          {
            any: [
              { field: "country", op: "eq", value: "FR" },
              { field: "email", op: "exists" },
            ],
          },
        ],
      },
      { not: { field: "optedOut", op: "eq", value: true } },
      {
        not: {
          any: [
            { field: "language", op: "eq", value: "fr" },
            { field: "name", op: "missing" },
          ],
        },
      },
      { field: "events.signed.up.lastAt", op: "older_than", value: "7d" },
    ];
    for (const condition of conditions) expect(roundTrip(condition)).toEqual(condition);
  });

  test("no rule is no condition, and an empty group counts for nothing", () => {
    expect(conditionOf(groupOf(undefined))).toBeUndefined();
    const rule: RuleDraft = { ...newRule("attribute"), key: "plan", text: "pro" };
    const root = groupOf(undefined);
    expect(conditionOf({ ...root, items: [rule, groupOf(undefined)] })).toEqual({
      field: "attributes.plan",
      op: "eq",
      value: "pro",
    });
  });

  test("typed text becomes the value its field takes", () => {
    const value = (rule: Partial<RuleDraft>) => {
      const made = conditionOf({ ...groupOf(undefined), items: [{ ...newRule(), ...rule }] });
      return made !== undefined && "value" in made ? made.value : undefined;
    };
    expect(value({ field: "attribute", key: "seats", op: "eq", text: "12" })).toBe(12);
    expect(value({ field: "attribute", key: "paid", op: "eq", text: "true" })).toBe(true);
    expect(value({ field: "attribute", key: "plan", op: "in", text: "pro, trial," })).toEqual([
      "pro",
      "trial",
    ]);
    expect(value({ field: "conversationCount", op: "gt", text: "2" })).toBe(2);
    // A half-typed number stays as typed, and the server says what is wrong.
    expect(value({ field: "conversationCount", op: "gt", text: "" })).toBe("");
    expect(value({ field: "signedIn", op: "eq", text: "false" })).toBe(false);
  });

  test("a time shows on this browser's clock and goes back as the same moment", () => {
    const at = "2026-12-01T09:30:00.000Z";
    const group = groupOf({ field: "lastSeenAt", op: "gt", value: at });
    const [rule] = group.items;
    expect(rule !== undefined && !isGroup(rule) && rule.text).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d$/,
    );
    expect(conditionOf(group)).toEqual({ field: "lastSeenAt", op: "gt", value: at });
  });
});

test("a campaign reads the names in its audience, exit, goal and event trigger", () => {
  const read = namesRead({
    ...newDefinition(),
    audience: {
      all: [
        { field: "attributes.plan", op: "eq", value: "pro" },
        { not: { field: "events.export.finished.count", op: "gte", value: 1 } },
      ],
    },
    trigger: { type: "event", name: "signed.up" },
    rules: {
      ...newDefinition().rules,
      exitWhen: { field: "attributes.setupDone", op: "eq", value: true },
      goal: { field: "events.upgraded.lastAt", op: "exists", within: "7d" },
    },
  });
  expect([...read.attributes].sort()).toEqual(["plan", "setupDone"]);
  expect([...read.events].sort()).toEqual(["export.finished", "signed.up", "upgraded"]);
});
