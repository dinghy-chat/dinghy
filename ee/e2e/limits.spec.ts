// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { expect, type Page, test } from "@playwright/test";
import { openLink } from "../../tests/e2e/links.ts";
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
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "Plan" })).toBeVisible();
  const operators = page.locator(".meter", { hasText: "Operators" });
  await expect(operators).toContainText("5 of 5");
  await expect(operators).toContainText("At the limit.");
  await expect(operators).toHaveClass(/full/);
  const images = page.locator(".meter", { hasText: "Images" });
  await expect(images).toContainText("0 MB of 1 GB");
  await expect(images).toHaveClass(/ ok/);
  await expect(page.getByText("Each image is kept for 12 months.")).toBeVisible();
  await page.getByRole("button", { name: "Invite someone" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  await expect(
    page.getByText("This workspace has 5 operators, the most the plan allows."),
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
