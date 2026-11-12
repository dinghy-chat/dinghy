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
