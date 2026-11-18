import type { Page } from "@playwright/test";

/** With SCREENSHOTS set to a folder, each step saves a picture there for a review. */
export async function picture(page: Page, name: string, fullPage = false) {
  const folder = process.env.SCREENSHOTS;
  if (folder !== undefined) await page.screenshot({ path: `${folder}/${name}.png`, fullPage });
}
