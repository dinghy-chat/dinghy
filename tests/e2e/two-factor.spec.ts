import { expect, type Page, test } from "@playwright/test";
import { authenticatorCode } from "../../apps/server/test/authenticator.ts";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink, signedIn, signOut } from "./links.ts";
import { openSettings } from "./settings.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("anna@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function openProfile(page: Page) {
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
}

test("an operator turns on two-step sign-in, and the next sign-in asks for a code", async ({
  browser,
}) => {
  const page = await signedIn(browser, server, "anna@example.com");
  await openProfile(page);
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const key = await page.getByRole("textbox", { name: "Or enter this key" }).inputValue();
  await page.getByRole("textbox", { name: "6-digit code" }).fill(await authenticatorCode(key, -1));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Save your recovery codes")).toBeVisible();
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
  await page.getByRole("button", { name: "Turn off" }).click();
  const offField = page.getByRole("textbox", { name: "Code from your app, or a recovery code" });
  await offField.fill("000000");
  await page.getByRole("button", { name: "Turn off" }).click();
  // A wrong code keeps the form open with its error.
  await expect(page.getByText("That code is not right, or it was already used.")).toBeVisible();
  await offField.fill(await authenticatorCode(key, 1));
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
  await page.context().close();
});
