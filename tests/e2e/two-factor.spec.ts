import { expect, type Page, test } from "@playwright/test";
import { authenticatorCode } from "../../apps/server/test/authenticator.ts";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink, signedIn, signOut } from "./links.ts";
import { openSettings } from "./settings.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("anna@example.com");
  await server.createOperator("ben@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function openProfile(page: Page) {
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
}

/** Turns two-step sign-in on from Profile, up to the recovery codes. Returns the key. */
async function turnOn(page: Page) {
  await openProfile(page);
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const key = await page.getByRole("textbox", { name: "Or enter this key" }).inputValue();
  await page.getByRole("textbox", { name: "6-digit code" }).fill(await authenticatorCode(key, -1));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Save your recovery codes")).toBeVisible();
  return key;
}

test("an operator turns on two-step sign-in, and the next sign-in asks for a code", async ({
  browser,
}) => {
  const page = await signedIn(browser, server, "anna@example.com");
  const key = await turnOn(page);
  await expect(page.locator(".recovery-codes li")).toHaveCount(10);
  await page.getByRole("button", { name: "I saved them" }).click();
  await expect(page.getByText("On. Each new sign-in asks for a code.")).toBeVisible();

  await openSettings(page, "Team");
  await expect(page.getByRole("cell", { name: "On", exact: true })).toBeVisible();

  await signOut(page);
  await openLink(page, await server.signInLink("anna@example.com"));
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  const field = page.getByRole("textbox", { name: "Code from your app, or a recovery code" });
  await field.fill("000000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That code is not right, or it was already used.")).toBeVisible();
  await field.fill(await authenticatorCode(key, 0));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Your account" })).toBeVisible();

  await openProfile(page);
  await expect(page.getByText("10 recovery codes left.")).toBeVisible();
  await page.getByRole("button", { name: "New recovery codes" }).click();
  await page.getByRole("textbox", { name: "6-digit code" }).fill(await authenticatorCode(key, 1));
  await page.getByRole("button", { name: "Make new codes" }).click();
  await expect(page.getByText("Save your recovery codes")).toBeVisible();
  const recoveryCode = (await page.locator(".recovery-codes li").first().textContent()) ?? "";
  await page.getByRole("button", { name: "I saved them" }).click();
  await expect(page.getByText("10 recovery codes left.")).toBeVisible();

  await page.getByRole("button", { name: "Turn off" }).click();
  const offField = page.getByRole("textbox", { name: "Code from your app, or a recovery code" });
  await offField.fill("000000");
  await page.getByRole("button", { name: "Turn off" }).click();
  // A wrong code keeps the form open with its error.
  await expect(page.getByText("That code is not right, or it was already used.")).toBeVisible();
  // A code of the new set works.
  await offField.fill(recoveryCode);
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
  await page.context().close();
});

test("too many wrong codes while turning it off end the session, and say so", async ({
  browser,
}) => {
  const page = await signedIn(browser, server, "ben@example.com");
  await turnOn(page);
  await page.getByRole("button", { name: "I saved them" }).click();
  await page.getByRole("button", { name: "Turn off" }).click();
  const field = page.getByRole("textbox", { name: "Code from your app, or a recovery code" });
  for (let tries = 1; tries < 5; tries += 1) {
    await field.fill("000000");
    await page.getByRole("button", { name: "Turn off" }).click();
    await expect(page.getByText("That code is not right, or it was already used.")).toBeVisible();
  }
  await field.fill("000000");
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("Too many wrong codes, so you were signed out.")).toBeVisible();
  await page.getByRole("button", { name: "Back to sign-in" }).click();
  await expect(page.getByRole("button", { name: "Your account" })).toHaveCount(0);
  await page.context().close();
});

test("a lost app starts a removal request from the code screen, and a signed-in device cancels it at once", async ({
  browser,
}) => {
  await server.createOperator("cara@example.com");
  await server.createOperator("dan@example.com");
  const page = await signedIn(browser, server, "cara@example.com");
  await turnOn(page);
  await page.getByRole("button", { name: "I saved them" }).click();

  const lost = await (await browser.newContext()).newPage();
  await openLink(lost, await server.signInLink("cara@example.com"));
  await expect(lost.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await lost
    .getByRole("button", { name: "Lost your authenticator app and your recovery codes?" })
    .click();
  await lost.getByRole("button", { name: "Start the 72-hour wait" }).click();
  await expect(lost.getByText("Two-step sign-in will be removed on")).toBeVisible();

  // Another owner sees it in Settings > Team.
  const dan = await signedIn(browser, server, "dan@example.com");
  await openSettings(dan, "Team");
  await expect(dan.getByRole("cell", { name: "Removal requested" })).toBeVisible();

  // The signed-in device, open since before the request, shows it with no reload.
  const banner = page.getByText("Someone asked to remove two-step sign-in from your account.");
  await expect(banner).toBeVisible();
  await page.getByRole("button", { name: "Cancel the request" }).click();
  await expect(banner).toHaveCount(0);

  // The session that never passed the check ended with the cancel.
  await lost.reload();
  await expect(lost.getByRole("heading", { name: "Sign in" })).toBeVisible();
  for (const one of [page, lost, dan]) await one.context().close();
});
