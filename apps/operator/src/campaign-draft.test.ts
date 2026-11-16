import { expect, test } from "vitest";
import {
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
