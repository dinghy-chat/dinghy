import type { Page } from "@playwright/test";

/** The grouped list on the left of Settings. */
export const settingsList = (page: Page) => page.getByRole("navigation", { name: "Settings" });

/** Opens a page of Settings from the sidebar and the grouped list, as an operator does. */
export async function openSettings(page: Page, name: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsList(page).getByRole("link", { name, exact: true }).click();
}
