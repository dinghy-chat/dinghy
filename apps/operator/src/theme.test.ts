import { afterEach, expect, test, vi } from "vitest";
import { savedTheme, setTheme } from "./theme.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPage() {
  const root = { dataset: {} as Record<string, string> };
  vi.stubGlobal("document", { documentElement: root });
  return root;
}

test("the device decides by default, and a fixed choice stays on this device", () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  const root = stubPage();
  expect(savedTheme()).toBe("system");
  setTheme("dark");
  expect(savedTheme()).toBe("dark");
  expect(root.dataset.theme).toBe("dark");
  setTheme("system");
  expect(savedTheme()).toBe("system");
  expect(root.dataset.theme).toBeUndefined();
});

test("storage that throws lets the device decide and still changes the page", () => {
  const refuse = () => {
    throw new Error("blocked");
  };
  vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse });
  const root = stubPage();
  expect(savedTheme()).toBe("system");
  expect(() => setTheme("light")).not.toThrow();
  expect(root.dataset.theme).toBe("light");
});
