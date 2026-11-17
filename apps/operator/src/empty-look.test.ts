import { expect, test } from "vitest";
import { chooseLook, isEmptyInbox } from "./empty-look.ts";

const NEW = { install: false, chat: false };
const INSTALLED = { install: true, chat: false };
const BUSY = { install: true, chat: true };
const base = { shows: "empty", isFiltered: false, steps: NEW, maySetUp: true } as const;

test("a list with rows asks for a pick (A), whatever the workspace's steps", () => {
  expect(chooseLook({ ...base, shows: "rows" })).toEqual({ kind: "pick" });
  expect(chooseLook({ ...base, shows: "rows", steps: null, isFiltered: true })).toEqual({
    kind: "pick",
  });
});

test("an empty inbox in a workspace that had conversations is caught up (B)", () => {
  expect(chooseLook({ ...base, steps: BUSY })).toEqual({ kind: "caughtUp" });
  // The steps say so even before the widget is installed, as with chats from the API.
  expect(chooseLook({ ...base, steps: { install: false, chat: true } })).toEqual({
    kind: "caughtUp",
  });
});

test("a search or a filter that finds nothing is a no-match (C)", () => {
  expect(chooseLook({ ...base, shows: "searchEmpty", steps: BUSY })).toEqual({
    kind: "noMatch",
    by: "search",
  });
  expect(chooseLook({ ...base, isFiltered: true, steps: BUSY })).toEqual({
    kind: "noMatch",
    by: "filter",
  });
  // A filter needs no steps to know it found nothing.
  expect(chooseLook({ ...base, isFiltered: true, steps: null })).toEqual({
    kind: "noMatch",
    by: "filter",
  });
});

test("a new workspace without the widget gets the board (D), or a plain wait for a member", () => {
  expect(chooseLook(base)).toEqual({ kind: "board" });
  expect(chooseLook({ ...base, maySetUp: false })).toEqual({ kind: "waitingSetup" });
});

test("a workspace whose widget is installed and has no conversation is live (E)", () => {
  expect(chooseLook({ ...base, steps: INSTALLED })).toEqual({ kind: "live" });
  expect(chooseLook({ ...base, steps: INSTALLED, maySetUp: false })).toEqual({ kind: "live" });
});

test("nothing is chosen until the list and the steps have loaded", () => {
  expect(chooseLook({ ...base, shows: "loading" })).toEqual({ kind: "loading" });
  expect(chooseLook({ ...base, steps: null })).toEqual({ kind: "loading" });
});

test("only an empty inbox gets the arrival flight", () => {
  expect(isEmptyInbox({ kind: "caughtUp" })).toBe(true);
  expect(isEmptyInbox({ kind: "board" })).toBe(true);
  expect(isEmptyInbox({ kind: "live" })).toBe(true);
  expect(isEmptyInbox({ kind: "pick" })).toBe(false);
  expect(isEmptyInbox({ kind: "noMatch", by: "search" })).toBe(false);
});
