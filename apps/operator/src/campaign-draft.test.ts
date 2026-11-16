import { expect, test } from "vitest";
import type { Member } from "./api.ts";
import {
  copyOf,
  dateInput,
  missingLocales,
  newDefinition,
  replaceAt,
  withLanguage,
} from "./campaign-draft.ts";

const abTest = () => ({
  ...newDefinition(),
  message: { body: "Hello" },
  variants: [
    { key: "a", weight: 50 },
    { key: "b", weight: 40, message: { body: "Hi there" } },
    { key: "c", weight: 10, control: true as const },
  ],
});

test("a language goes in every message that lacks it: the campaign's own and each variant's", () => {
  const definition = withLanguage(abTest(), "fr");
  expect(definition.message.translations).toEqual({ fr: { body: "Hello" } });
  expect(definition.variants).toEqual([
    { key: "a", weight: 50 },
    {
      key: "b",
      weight: 40,
      message: { body: "Hi there", translations: { fr: { body: "Hi there" } } },
    },
    { key: "c", weight: 10, control: true },
  ]);
  // A translation already written stays as it is.
  const written = withLanguage(
    { ...definition, message: { body: "Hello", translations: { fr: { body: "Bonjour" } } } },
    "fr",
  );
  expect(written.message.translations).toEqual({ fr: { body: "Bonjour" } });
  expect(withLanguage(newDefinition(), "fr")).not.toHaveProperty("variants");
});

test("a language is offered while one message lacks it, a variant's own included", () => {
  const definition = abTest();
  expect(missingLocales(definition)).toEqual(["en", "fr", "es"]);
  const ownOnly = { ...definition, message: withLanguage(definition, "fr").message };
  expect(missingLocales(ownOnly)).toContain("fr");
  expect(missingLocales(withLanguage(definition, "fr"))).toEqual(["en", "es"]);
});

test("replaceAt changes or removes one item", () => {
  expect(replaceAt(["a", "b", "c"], 1, "B")).toEqual(["a", "B", "c"]);
  expect(replaceAt(["a", "b", "c"], 1, null)).toEqual(["a", "c"]);
});

test("a date input's day is written year first", () => {
  expect(dateInput(new Date(2026, 10, 6))).toBe("2026-11-06");
});

test("a copy drops a past end and a sender who left, and keeps the rest", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const member: Member = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Julien",
    email: "julien@example.com",
    role: "owner",
    pictureUrl: null,
    twoFactor: "off",
    canResetTwoFactor: false,
  };
  const gone = { operatorId: "00000000-0000-4000-8000-000000000002" };
  const copy = copyOf(
    {
      ...abTest(),
      message: { body: "Hello", sender: gone },
      variants: [
        { key: "a", weight: 50, message: { body: "Hi", sender: { operatorId: member.id } } },
        { key: "b", weight: 50, message: { body: "Hey", sender: { email: "left@example.com" } } },
        { key: "c", weight: 50, message: { body: "Yo", sender: { email: "JULIEN@example.com" } } },
      ],
      trigger: {
        type: "schedule",
        repeat: "daily",
        time: "09:00",
        startDate: "2026-10-01",
        endDate: "2026-10-31",
        timeZone: "UTC",
      },
      rules: { ...newDefinition().rules, endsAt: "2026-11-01T00:00:00.000Z" },
    },
    { name: "Copy", key: "copy", members: [member], now },
  );
  expect(copy.message).toEqual({ body: "Hello" });
  expect(copy.variants).toEqual([
    { key: "a", weight: 50, message: { body: "Hi", sender: { operatorId: member.id } } },
    { key: "b", weight: 50, message: { body: "Hey" } },
    { key: "c", weight: 50, message: { body: "Yo", sender: { email: "JULIEN@example.com" } } },
  ]);
  expect(copy.trigger).toEqual({
    type: "schedule",
    repeat: "daily",
    time: "09:00",
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    timeZone: "UTC",
  });
  expect(copy.rules.endsAt).toBeNull();

  // Dates still ahead stay as they are.
  const ahead = copyOf(
    { ...newDefinition(), rules: { ...newDefinition().rules, endsAt: "2027-01-01T00:00:00.000Z" } },
    { name: "Copy", key: "copy", members: [], now },
  );
  expect(ahead.rules.endsAt).toBe("2027-01-01T00:00:00.000Z");
});
