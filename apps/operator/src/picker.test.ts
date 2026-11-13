import { expect, test } from "vitest";
import type { Member } from "./api.ts";
import { chosenIndex, mentionsIn } from "./picker.tsx";

const member = (id: string, name: string): Member => ({
  id,
  name,
  email: `${id}@example.com`,
  role: "member",
  pictureUrl: null,
});

const anna = member("anna", "Anna");
const annaSmith = member("anna-smith", "Anna Smith");
const jean = member("jean", "Jean");
const jeanLuc = member("jean-luc", "Jean-Luc");
const team = [anna, annaSmith, jean, jeanLuc];

test("a longer name never also mentions the shorter name it starts with", () => {
  expect(mentionsIn("@Anna Smith, can you look?", team)).toEqual(["anna-smith"]);
  expect(mentionsIn("@Jean-Luc knows this one", team)).toEqual(["jean-luc"]);
});

test("both names mention both people when the note holds both", () => {
  expect(mentionsIn("@Anna Smith and @Anna, see above", team).sort()).toEqual([
    "anna",
    "anna-smith",
  ]);
  expect(mentionsIn("@Jean, ask @Jean-Luc", team).sort()).toEqual(["jean", "jean-luc"]);
});

test("a name that goes on is not a mention", () => {
  expect(mentionsIn("@Annabel will reply", team)).toEqual([]);
});

const typed = { trigger: "/" as const, word: "", from: 7, to: 8 };

test("the arrows' choice holds for the same trigger and word, within the items there are", () => {
  expect(chosenIndex({ from: 7, word: "", index: 2 }, typed, 4)).toBe(2);
  expect(chosenIndex({ from: 7, word: "", index: 2 }, typed, 1)).toBe(0);
});

test("a new trigger starts at the first item, even with the same word", () => {
  expect(chosenIndex({ from: 1, word: "", index: 2 }, typed, 4)).toBe(0);
  expect(chosenIndex({ from: 7, word: "re", index: 2 }, typed, 4)).toBe(0);
});
