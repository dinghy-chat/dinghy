// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { expect, type Page, test } from "@playwright/test";
import { openLink } from "../../tests/e2e/links.ts";
import { openSettings } from "../../tests/e2e/settings.ts";
import { startCloudE2EServer } from "../server/test/e2e-cloud.ts";

type Server = Awaited<ReturnType<typeof startCloudE2EServer>>;

let server: Server;

test.beforeAll(async () => {
  server = await startCloudE2EServer({ billing: true });
});

test.afterAll(async () => {
  await server.stop();
});

/** Waits for the fake Checkout page and returns its session and workspace. */
async function onCheckout(page: Page) {
  await expect(page.getByRole("heading", { name: "Fake Checkout" })).toBeVisible();
  const sessionId = page.url().split("/").at(-1) ?? "";
  const workspaceId =
    server.stripe?.sessions.get(sessionId)?.params.get("client_reference_id") ?? "";
  return { sessionId, workspaceId };
}

/** Signs up, pays and lands in the inbox of a new workspace. */
async function paidWorkspace(page: Page, name: string) {
  const email = `nora-${Date.now()}@example.com`;
  await page.goto(`${server.apiOrigin}/signup`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-up link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await openLink(page, await server.linkTo(email), "Get started");
  await page.getByLabel("Your name").fill("Nora");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  const { sessionId, workspaceId } = await onCheckout(page);
  await server.completeCheckout(sessionId);
  const streaming = page.waitForResponse((response) => response.url().includes("/stream"));
  await page.goto(`${server.apiOrigin}/?workspace=${workspaceId}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  // The inbox's live stream is open, so a change from here on reaches it.
  await streaming;
  return workspaceId;
}

test("an open inbox shows the read-only banner without a reload, and paying again brings it back", async ({
  page,
}) => {
  const workspaceId = await paidWorkspace(page, "Quiet Shop");
  await server.endSubscription(workspaceId);
  const banner = page.getByRole("status").filter({ hasText: "Visitor chat is off" });
  await expect(banner).toBeVisible();

  await banner.getByRole("button", { name: "Restart subscription" }).click();
  const { sessionId } = await onCheckout(page);
  // Stripe sends the browser back, and the webhook follows.
  await page.goto(`${server.apiOrigin}/billing/return?workspace=${workspaceId}`);
  await server.completeCheckout(sessionId);
  await expect(page.getByRole("heading", { name: "Quiet Shop" })).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test("a write refused as read-only shows the banner, when the page missed the change", async ({
  page,
}) => {
  const workspaceId = await paidWorkspace(page, "Missed Shop");
  await server.markReadOnly(workspaceId);
  const banner = page.getByRole("status").filter({ hasText: "Visitor chat is off" });
  await expect(banner).toHaveCount(0);
  await openSettings(page, "Team");
  await page.getByRole("button", { name: "Invite someone" }).click();
  await page.getByRole("dialog").getByLabel("Email").fill("new@example.com");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(banner).toBeVisible();
});

test("the owner sees the Billing section and opens Stripe's portal", async ({ page }) => {
  await paidWorkspace(page, "Busy Shop");
  await openSettings(page, "Workspace");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByText(/^Active\. Renews on /)).toBeVisible();
  await page.getByRole("button", { name: "Manage billing" }).click();
  await expect(page.getByRole("heading", { name: "Fake billing portal" })).toBeVisible();
});

test("the owner deletes the workspace after typing its name", async ({ page }) => {
  const workspaceId = await paidWorkspace(page, "Closing Shop");
  await openSettings(page, "Workspace");
  await expect(page.getByRole("heading", { name: "Delete this workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Delete Closing Shop?");
  const remove = page.getByRole("button", { name: "Delete the workspace" });
  await expect(remove).toBeDisabled();
  const confirm = page.getByLabel("Type Closing Shop to confirm");
  await expect(confirm).toBeFocused();
  await confirm.fill("Closing Sho");
  await expect(remove).toBeDisabled();
  await confirm.fill("Closing Shop");
  await remove.click();
  // On the cloud, an account with no workspace left can start a new one.
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
  expect(await server.isDeleted(workspaceId)).toBe(true);
  const subscriptions = [...(server.stripe?.subscriptions.values() ?? [])].filter(
    (one) => one.metadata.workspace_id === workspaceId,
  );
  expect(subscriptions.map((one) => one.status)).toEqual(["canceled"]);
});
