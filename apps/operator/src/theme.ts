// Light or dark, per device. "system" follows the device's setting, which app.css reads by itself,
// so only a fixed choice puts data-theme on the page.

import { readStored, store } from "./stored.ts";

export type Theme = "system" | "light" | "dark";

const KEY = "dinghy:theme";

/** Without a saved choice, or without storage, the device decides. */
export function savedTheme(): Theme {
  const saved = readStored(KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  store(KEY, theme === "system" ? null : theme);
}
