import { afterEach, expect, test, vi } from "vitest";
import { setSoundOn, soundOn } from "./sound.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the sound is on by default, and the choice stays on this device", () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  expect(soundOn()).toBe(true);
  setSoundOn(false);
  expect(soundOn()).toBe(false);
  setSoundOn(true);
  expect(soundOn()).toBe(true);
});

test("storage that throws leaves the sound on and does not break the page", () => {
  const refuse = () => {
    throw new Error("blocked");
  };
  vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse });
  expect(soundOn()).toBe(true);
  expect(() => setSoundOn(false)).not.toThrow();
});
