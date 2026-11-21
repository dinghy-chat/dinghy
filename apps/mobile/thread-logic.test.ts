import { describe, expect, test } from "vitest";
import {
  displayLink,
  insertSavedReply,
  matchSavedReplies,
  menuPlacement,
  typedSlash,
  visitorContext,
} from "./src/thread-logic.ts";
import type { SavedReply } from "./src/types.ts";

const screen = { width: 390, height: 844, top: 59, bottom: 34 };
const menu = { width: 248, height: 4 * 46 };

describe("message menu placement", () => {
  test("opens under the bubble, on the bubble's side", () => {
    const place = menuPlacement({ x: 16, y: 160, width: 220, height: 44 }, menu, screen, "start");
    expect(place).toMatchObject({ top: 212, left: 16, above: false, liftTop: 160 });
  });

  test("flips above a bubble near the bottom, aligned to its right edge", () => {
    const place = menuPlacement({ x: 120, y: 700, width: 254, height: 44 }, menu, screen, "end");
    expect(place.above).toBe(true);
    expect(place.top).toBe(700 - 8 - menu.height);
    expect(place.left).toBe(120 + 254 - 248);
  });

  test("keeps the menu on screen for a bubble near an edge", () => {
    const place = menuPlacement({ x: 4, y: 160, width: 40, height: 44 }, menu, screen, "end");
    expect(place.left).toBe(16);
  });

  test("moves a bubble taller than the screen allows up to end above the menu", () => {
    const place = menuPlacement({ x: 16, y: 100, width: 300, height: 700 }, menu, screen, "start");
    expect(place.top).toBe(844 - 34 - 16 - menu.height);
    expect(place.liftBottom).toBe(place.top - 8);
    expect(place.liftTop).toBe(place.liftBottom - 700);
  });
});

describe("visitor line", () => {
  const now = new Date("2026-11-19T20:41:00Z");
  test("shows the visitor's country and local time", () => {
    const { place, time } = visitorContext("FR", "Europe/Paris", now);
    expect(place).toBe("France");
    expect(time).toMatch(/^9:41\s?PM$/);
  });

  test("omits missing countries and unknown time zones independently", () => {
    expect(visitorContext("FR", "Not/AZone", now)).toEqual({ place: "France", time: null });
    expect(visitorContext(null, "Europe/Paris", now).time).toBeTruthy();
    expect(visitorContext(null, null, now)).toEqual({ place: null, time: null });
  });
});

describe("saved replies in the composer", () => {
  const reply = (shortcut: string, body = shortcut): SavedReply => ({
    id: shortcut,
    shortcut,
    body,
    updatedAt: "2026-11-01T00:00:00Z",
  });

  test("finds the slash word at the caret only at the start of a word", () => {
    expect(typedSlash("/sig", 4)).toEqual({ from: 0, to: 4, word: "sig" });
    expect(typedSlash("Hi /", 4)).toEqual({ from: 3, to: 4, word: "" });
    expect(typedSlash("and/or", 6)).toBeNull();
    expect(typedSlash("see https://a.example/x", 23)).toBeNull();
    expect(typedSlash("```\n/usr", 8)).toBeNull();
  });

  test("lists shortcuts that start with the word first", () => {
    const found = matchSavedReplies([reply("mobile-sig"), reply("sig"), reply("sync")], "sig");
    expect(found.map((item) => item.shortcut)).toEqual(["sig", "mobile-sig"]);
  });

  test("replaces the slash word with the reply and puts the caret after it", () => {
    expect(insertSavedReply("Hi /sig", "Thanks!", { from: 3, to: 7 })).toEqual({
      text: "Hi Thanks!",
      caret: 10,
    });
    expect(insertSavedReply("Hi", "Thanks!", null)).toEqual({ text: "Hi\nThanks!", caret: 10 });
    expect(insertSavedReply("", "Thanks!", null)).toEqual({ text: "Thanks!", caret: 7 });
  });
});

test("bare links show without their scheme", () => {
  expect(displayLink("https://shipmail.to/docs/inbox/settings")).toBe(
    "shipmail.to/docs/inbox/settings",
  );
  expect(displayLink("https://dinghy.chat/")).toBe("dinghy.chat");
  expect(displayLink("mailto:hello@dinghy.chat")).toBe("hello@dinghy.chat");
});
