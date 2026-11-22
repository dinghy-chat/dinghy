import type { Page } from "@playwright/test";

/** Opens the Inbox's filter card, unless it is open, and gives one of its choices. */
export async function inboxFilter(
  page: Page,
  name: "Open" | "Closed" | "All" | "Mine" | "Unassigned",
) {
  const button = page.getByRole("button", { name: /^Filter conversations/ });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  return page.getByRole("dialog", { name: "Filter conversations" }).getByRole("radio", { name });
}

/** Shows one status in the Inbox's list, and shuts the filter card so the rows take clicks. */
export async function showStatus(page: Page, name: "Open" | "Closed") {
  await (await inboxFilter(page, name)).click();
  await page.getByRole("button", { name: /^Filter conversations/ }).click();
}
