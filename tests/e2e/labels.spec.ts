import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn } from "./links.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("owner@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

test.beforeEach(async () => {
  await server.closeConversations();
});

test("L adds a new label by its name, and the filter lists only the conversations with it", async ({
  browser,
}) => {
  await server.seedConversations(2, "labels");
  const page = await signedIn(browser, server, "owner@example.com");
  await page.locator(".row", { hasText: "labels message 0" }).click();

  await expect(page.getByRole("button", { name: "Labels", exact: true })).toBeVisible();
  await page.keyboard.press("l");
  const picker = page.getByRole("dialog", { name: "Labels" });
  await picker.getByRole("textbox", { name: "Find or add a label" }).fill("Billing");
  await picker.getByRole("textbox", { name: "Find or add a label" }).press("Enter");
  await expect(picker.getByRole("checkbox", { name: "Billing" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator(".thread-head .label-pill")).toHaveText(["Billing"]);
  await expect(
    page.locator(".row", { hasText: "labels message 0" }).locator(".label-pill"),
  ).toHaveText("Billing");

  await page.getByRole("button", { name: /^Filter conversations/ }).click();
  const filters = page.getByRole("dialog", { name: "Filter conversations" });
  await filters.getByRole("button", { name: /^Label/ }).click();
  await page.getByRole("option", { name: "Billing" }).click();
  await expect(page.locator(".rows .row")).toHaveCount(1);
  await expect(page.locator(".rows .row")).toContainText("labels message 0");
  expect(new URL(page.url()).searchParams.get("label")).not.toBeNull();
});

test("X, Shift-click and the box beside the count choose rows, and Close closes them all", async ({
  browser,
}) => {
  await server.seedConversations(3, "bulk");
  const page = await signedIn(browser, server, "owner@example.com");
  const rows = page.locator(".rows > li");
  await expect(rows).toHaveCount(3);

  await rows.nth(0).locator(".row").click();
  await page.keyboard.press("x");
  const bar = page.getByRole("toolbar", { name: "Selected conversations" });
  await expect(bar).toContainText("1 selected");
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await rows
    .nth(2)
    .getByRole("checkbox")
    .click({ modifiers: ["Shift"] });
  await expect(bar).toContainText("3 selected");
  await bar.getByRole("checkbox", { name: "Select all" }).click();
  await expect(bar).toHaveCount(0);
  // With nothing chosen, a row's box shows only under the pointer.
  await rows.nth(1).hover();
  await rows.nth(1).getByRole("checkbox").click();
  const all = bar.getByRole("checkbox", { name: "Select all" });
  await expect(all).toHaveJSProperty("indeterminate", true);
  // Escape clears the choice from a row's box too, which keeps its own keys.
  await rows.nth(1).getByRole("checkbox").press("Escape");
  await expect(bar).toHaveCount(0);
  await rows.nth(1).hover();
  await rows.nth(1).getByRole("checkbox").click();
  await all.click();
  await expect(all).toHaveJSProperty("indeterminate", false);
  await expect(bar).toContainText("3 selected");

  await bar.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Mark read" }).click();
  // The first row was open, so it was read already and does not count as marked.
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Marked 2 conversations read. 1 needed no change." }),
  ).toBeVisible();
  await expect(bar).toHaveCount(0);
  await rows.nth(0).hover();
  await rows.nth(0).getByRole("checkbox").click();
  await all.click();

  await bar.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Closed 3 conversations." }),
  ).toBeVisible();
  await expect(page.locator(".rows .row")).toHaveCount(0);
});

test("with single keys off, a row's box is a tab stop, so a keyboard can start a selection", async ({
  browser,
}) => {
  await server.seedConversations(1, "keyboard");
  const page = await signedIn(browser, server, "owner@example.com");
  await page.evaluate(() => localStorage.setItem("dinghy:shortcuts", "off"));
  await page.reload();
  const box = page.locator(".rows > li", { hasText: "keyboard message 0" }).getByRole("checkbox");
  await expect(box).toHaveAttribute("tabindex", "0");
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
});
