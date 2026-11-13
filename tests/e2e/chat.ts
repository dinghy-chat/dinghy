import { type Browser, expect, type Page } from "@playwright/test";
import { openLink } from "./links.ts";

/** The test server's host site, where the widget runs. */
interface HostSite {
  hostOrigin: string;
}

/** Opens the chat on a page of the host site, ready to type. */
export async function openWidget(page: Page, site: HostSite, path = "/plain") {
  await page.goto(`${site.hostOrigin}${path}`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByRole("textbox", { name: "Your message" })).toBeVisible();
}

/** Sends a visitor's message in the open chat, and waits until the server took it. */
export async function say(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Your message" }).fill(text);
  await page.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
}

/** A new visitor, in a browser context of their own, who opens the chat on `path` and writes. */
export async function visitor(
  browser: Browser,
  site: HostSite,
  path: string,
  text: string,
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openWidget(page, site, path);
  await say(page, text);
  return page;
}

/** Sends an operator's reply in the open conversation, and waits until the server took it. */
export async function answer(page: Page, text: string) {
  const reply = page.getByRole("textbox", { name: "Your reply" });
  await reply.fill(text);
  await reply.press("Enter");
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
}

/** Signs in from an emailed link and waits for the inbox of the test workspace. */
export async function openInbox(
  page: Page,
  server: { signInLink(email: string): Promise<string> },
  email: string,
) {
  await openLink(page, await server.signInLink(email));
  await expect(page.getByRole("heading", { name: "E2E", exact: true })).toBeVisible();
}
