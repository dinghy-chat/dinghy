import type { Page } from "@playwright/test";

/** The grouped list on the left of Settings. */
export const settingsList = (page: Page) => page.getByRole("navigation", { name: "Settings" });

/** Opens Settings from the sidebar, and gives its grouped list. */
export async function openSettingsList(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return settingsList(page);
}

/** Opens a page of Settings from the sidebar and the grouped list, as an operator does. */
export async function openSettings(page: Page, name: string) {
  await (await openSettingsList(page)).getByRole("link", { name, exact: true }).click();
}
