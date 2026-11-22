import { describe, expect, test } from "vitest";
import { closeThreadRoute, openThreadRoute } from "./src/thread-route";

describe("the pushed conversation", () => {
  test("opens a new screen for a conversation", () => {
    expect(openThreadRoute(null, "c1", 1)).toEqual({ key: "thread-1", conversationId: "c1" });
  });

  test("keeps the screen when the same conversation opens again", () => {
    const open = openThreadRoute(null, "c1", 1);
    expect(openThreadRoute(open, "c1", 2)).toBe(open);
  });

  test("replaces the screen for another conversation", () => {
    const open = openThreadRoute(null, "c1", 1);
    expect(openThreadRoute(open, "c2", 2)).toEqual({ key: "thread-2", conversationId: "c2" });
  });

  test("reopening a closed conversation gives it a fresh screen", () => {
    const first = openThreadRoute(null, "c1", 1);
    const closed = closeThreadRoute(first, first.key);
    expect(openThreadRoute(closed, "c1", 2).key).toBe("thread-2");
  });

  test("closes the screen that was dismissed", () => {
    const open = openThreadRoute(null, "c1", 1);
    expect(closeThreadRoute(open, "thread-1")).toBeNull();
  });

  test("ignores a late dismissal from a replaced screen", () => {
    const replaced = openThreadRoute(openThreadRoute(null, "c1", 1), "c2", 2);
    expect(closeThreadRoute(replaced, "thread-1")).toBe(replaced);
  });
});
