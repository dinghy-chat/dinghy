import { expect, test } from "vitest";
import type { Member, SavedReply } from "./api.ts";
import { chosenIndex, composerPicks, mentionsIn } from "./picker.tsx";

const member = (id: string, name: string): Member => ({
  id,
  name,
  email: `${id}@example.com`,
  role: "member",
  pictureUrl: null,
  twoFactor: "off",
  canResetTwoFactor: false,
});

const anna = member("anna", "Anna");
const annaSmith = member("anna-smith", "Anna Smith");
const jean = member("jean", "Jean");
const jeanLuc = member("jean-luc", "Jean-Luc");
const team = [anna, annaSmith, jean, jeanLuc];
const NONE_PICKED = new Map<string, string>();
const mentionsOf = (body: string, members: Member[]) => mentionsIn(body, members, NONE_PICKED);

test("a longer name never also mentions the shorter name it starts with", () => {
  expect(mentionsOf("@Anna Smith, can you look?", team)).toEqual(["anna-smith"]);
  expect(mentionsOf("@Jean-Luc knows this one", team)).toEqual(["jean-luc"]);
});

test("both names mention both people when the note holds both", () => {
  expect(mentionsOf("@Anna Smith and @Anna, see above", team).sort()).toEqual([
    "anna",
    "anna-smith",
  ]);
  expect(mentionsOf("@Jean, ask @Jean-Luc", team).sort()).toEqual(["jean", "jean-luc"]);
});

test("a name that goes on is not a mention", () => {
  expect(mentionsOf("@Annabel will reply", team)).toEqual([]);
});

const alex = member("alex", "Alex");
const otherAlex = member("other-alex", "Alex");
const alexes = [alex, otherAlex];

test("of two members with one name, the picked one is mentioned", () => {
  expect(mentionsIn("@Alex, can you look?", alexes, new Map([["Alex", "other-alex"]]))).toEqual([
    "other-alex",
  ]);
});

test("a name typed by hand goes to the first member with that name", () => {
  expect(mentionsOf("@Alex, can you look?", alexes)).toEqual(["alex"]);
});

test("an edited note keeps the member it mentioned, unless the edit picks another", () => {
  expect(mentionsIn("@Alex, and now?", alexes, NONE_PICKED, ["other-alex"])).toEqual([
    "other-alex",
  ]);
  expect(
    mentionsIn("@Alex, and now?", alexes, new Map([["Alex", "alex"]]), ["other-alex"]),
  ).toEqual(["alex"]);
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

test("the picker builds at most 8 saved replies, those that start with the word first", () => {
  const replies: SavedReply[] = Array.from({ length: 12 }, (_, index) => ({
    id: `reply-${index}`,
    shortcut: index === 11 ? "refund" : `about-refund-${index}`,
    body: "**Hello**",
    updatedAt: "2026-11-13T10:00:00.000Z",
  }));
  const items = composerPicks(replies, [], "me", false)["/"]?.("refund") ?? [];
  expect(items.map((item) => item.label)).toHaveLength(8);
  expect(items[0]).toMatchObject({ label: "/refund", detail: "Hello" });
});
