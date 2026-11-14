import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn } from "./links.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("owner@example.com");
  await server.seedConversations(1, "Address");
  await server.createSecondWorkspace("Harbor", "owner@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

const menu = (page: Page) => page.getByRole("navigation", { name: "Main menu" });

test("each screen has its own address, so a reload stays on it", async ({ browser }) => {
  const page = await signedIn(browser, server, "owner@example.com");
  const workspace = `workspace=${server.workspaceId()}`;

  await page.locator(".row", { hasText: "Address message 0" }).click();
  await expect(page).toHaveURL(new RegExp(`/\\?${workspace}&conversation=`));
  await page.reload();
  await expect(page.locator(".row[aria-current='true']")).toContainText("Address message 0");

  for (const [name, path] of [
    ["Contacts", "/contacts"],
    ["Visitors", "/visitors"],
    ["Analytics", "/analytics"],
  ] as const) {
    await menu(page).getByRole("button", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}\\?${workspace}$`));
    await page.reload();
    await expect(menu(page).getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }

  // Back returns to the Inbox with the conversation still open.
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/conversation=/);
  await expect(menu(page).getByRole("button", { name: "Inbox", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator(".row[aria-current='true']")).toContainText("Address message 0");
});

test("Back to another workspace's conversation opens that workspace", async ({ browser }) => {
  const page = await signedIn(browser, server, "owner@example.com");
  const switcher = page.getByRole("button", { name: /^Workspace:/ });
  await page.goto(`${server.apiOrigin}/?workspace=${server.workspaceId()}`);
  await page.locator(".row", { hasText: "Address message 0" }).click();
  await expect(page).toHaveURL(/conversation=/);
  // A switch replaces the address it leaves, so a view comes first.
  await menu(page).getByRole("button", { name: "Visitors", exact: true }).click();
  await expect(page).toHaveURL(/\/visitors\?/);

  await switcher.click();
  await page.getByRole("menuitemradio", { name: "Harbor" }).click();
  await expect(switcher).toHaveAccessibleName(/^Workspace: Harbor/);
  await menu(page).getByRole("button", { name: "Contacts", exact: true }).click();
  await expect(page).toHaveURL(/\/contacts\?/);

  // Two steps back is the E2E workspace's conversation, which Harbor's Inbox must not overwrite.
  await page.evaluate(() => history.go(-2));
  await expect(switcher).toHaveAccessibleName(/^Workspace: E2E/);
  await expect(page).toHaveURL(/conversation=/);
  await expect(page.locator(".row[aria-current='true']")).toContainText("Address message 0");
});
