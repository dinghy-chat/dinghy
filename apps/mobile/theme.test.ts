import { beforeEach, expect, test, vi } from "vitest";

const secureStore = vi.hoisted(() => ({
  value: null as string | null,
  deleted: false,
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async () => secureStore.value,
  setItemAsync: async (_key: string, value: string) => {
    secureStore.value = value;
  },
  deleteItemAsync: async () => {
    secureStore.deleted = true;
    secureStore.value = null;
  },
}));

vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles },
}));

import { readThemePreference, saveThemePreference } from "./src/theme.ts";

beforeEach(() => {
  secureStore.value = null;
  secureStore.deleted = false;
});

test("the native theme follows the device until a fixed choice is saved", async () => {
  expect(await readThemePreference()).toBe("system");
  await saveThemePreference("dark");
  expect(await readThemePreference()).toBe("dark");
  await saveThemePreference("system");
  expect(secureStore.deleted).toBe(true);
  expect(await readThemePreference()).toBe("system");
});

test("an unknown saved theme falls back to the device", async () => {
  secureStore.value = "sepia";
  expect(await readThemePreference()).toBe("system");
});
