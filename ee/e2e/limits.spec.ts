// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { expect, type Page, test } from "@playwright/test";
import { openLink } from "../../tests/e2e/links.ts";
import { openSettings, settingsList } from "../../tests/e2e/settings.ts";
import { startCloudE2EServer } from "../server/test/e2e-cloud.ts";

let server: Awaited<ReturnType<typeof startCloudE2EServer>>;

test.beforeAll(async () => {
  server = await startCloudE2EServer({ early: true });
  // With the seeded owner, the workspace has 5 operators.
  for (const name of ["ana", "ben", "cy", "dee"]) {
    await server.createOperator(`${name}@example.com`);
  }
});

test.afterAll(async () => {
  await server.stop();
});

async function signIn(page: Page) {
  const streaming = page.waitForResponse((response) => response.url().includes("/stream"));
  await openLink(page, await server.signInLink("ana@example.com"));
  await expect(page.getByRole("button", { name: "Your account" })).toBeVisible();
  await streaming;
}

test("a workspace with 5 operators shows the limit when an owner creates an invite", async ({
  page,
}) => {
  await signIn(page);
  await openSettings(page, "Workspace");
  const plan = page.locator(".page-row", {
    has: page.getByRole("heading", { name: "Plan and usage" }),
  });
  const operators = plan.locator(".meter", { hasText: "Team members" });
  await expect(operators).toContainText("5 of 5");
  await expect(operators).toContainText("All team places are in use.");
  await expect(operators).toHaveClass(/full/);
  const images = plan.locator(".meter", { hasText: "File storage" });
  await expect(images).toContainText("0 MB of 1 GB");
  await expect(images).toHaveClass(/ ok/);
  await expect(
    page.getByText("Dinghy Cloud automatically deletes chat images and files after 12 months."),
  ).toBeVisible();
  // The Team page says how full it is, under its title, beside its Invite button.
  await settingsList(page).getByRole("link", { name: "Team" }).click();
  await expect(page.getByText("5 of 5 team members. Pending invites count too.")).toBeVisible();
  await page.getByRole("button", { name: "Invite someone" }).click();
  await page.getByRole("dialog").getByLabel("Email").fill("new@example.com");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(
    page.getByText("This workspace has reached its limit of 5 team members", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Invite link" })).toHaveCount(0);
});

test("a suspended cloud workspace tells its operators where to write", async ({ page }) => {
  await signIn(page);
  await server.suspend();
  const banner = page.getByRole("status").filter({ hasText: "This workspace is suspended" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "hello@dinghy.chat" })).toHaveAttribute(
    "href",
    "mailto:hello@dinghy.chat",
  );
  await server.suspend(false);
  await expect(banner).toHaveCount(0);
});
