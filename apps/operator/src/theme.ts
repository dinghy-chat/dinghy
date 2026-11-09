// Light or dark, per device. "system" follows the device's setting, which app.css reads by itself,
// so only a fixed choice puts data-theme on the page.

export type Theme = "system" | "light" | "dark";

const KEY = "dinghy:theme";

/** Storage can throw in a private window or with blocked site data. Then the device decides. */
export function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // The choice lasts until the page reloads.
  }
}
