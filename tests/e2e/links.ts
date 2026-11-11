import { type Browser, expect, type Page } from "@playwright/test";

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

/** Hands out sign-in links, as the e2e server does. */
interface SignInLinks {
  signInLink(email: string): Promise<string>;
}

/** Signs `page` in as `email`, and waits for the app to open. */
export async function signInOn(page: Page, server: SignInLinks, email: string) {
  await openLink(page, await server.signInLink(email));
  await expect(page.getByRole("button", { name: "Your account" })).toBeVisible();
}

/** A new browser context, signed in as `email`, that may write to the clipboard. */
export async function signedIn(
  browser: Browser,
  server: SignInLinks,
  email: string,
): Promise<Page> {
  const context = await browser.newContext();
  // Only Chromium has this permission. In WebKit, asking for it breaks the next new page.
  if (browser.browserType().name() === "chromium") {
    await context.grantPermissions(["clipboard-write"]);
  }
  const page = await context.newPage();
  await signInOn(page, server, email);
  return page;
}
