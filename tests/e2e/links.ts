import type { Page } from "@playwright/test";

/** Opens an emailed link, whose page has one button that uses it, and selects the button. */
export async function openLink(page: Page, url: string, button = "Sign in") {
  await page.goto(url);
  await page.getByRole("button", { name: button }).click();
}

/** Signs out through the user menu at the foot of the rail. */
export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
}
