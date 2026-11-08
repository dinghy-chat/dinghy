import type { Page } from "@playwright/test";

/** Opens an emailed link, whose page has one button that uses it, and selects the button. */
export async function openLink(page: Page, url: string, button = "Sign in to Dinghy") {
  await page.goto(url);
  await page.getByRole("button", { name: button }).click();
}
