import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn } from "./links.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("owner@example.com");
  await server.seedConversations(1, "Address");
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
