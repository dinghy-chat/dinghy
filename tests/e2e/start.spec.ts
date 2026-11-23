import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { pngFile } from "./images.ts";
import { openLink } from "./links.ts";
import { settingsList } from "./settings.ts";

const HOST_PAGE = `<!doctype html><title>Host</title><h1>Host</h1>
<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>`;

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  // With email, so a member can turn on email alerts, one of the steps.
  server = await startE2EServer({ "/plain": { html: HOST_PAGE } }, { emailAvailable: true });
  await server.createSecondWorkspace("Fresh", "new@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

test("a new workspace shows Get started, whose steps open settings, until it is hidden", async ({
  page,
}) => {
  await openLink(page, await server.signInLink("new@example.com"));
  const button = page.getByRole("button", { name: /^Get started/ });
  await expect(button).toContainText("0/5");
  // The button names the next step, so it says what to do.
  await expect(button).toContainText("Next: Install the widget");
  await button.click();
  const steps = page.getByRole("region", { name: "Get started" });
  await expect(steps).toBeVisible();
  // Inviting a teammate is optional, so the count of 5 leaves it out.
  await expect(steps.getByRole("listitem").filter({ hasText: "Invite a teammate" })).toContainText(
    "Optional",
  );

  const list = page.getByRole("navigation", { name: "Settings" });
  await steps.getByRole("button", { name: "Install the widget" }).click();
  await expect(list.getByRole("link", { name: "Install" })).toHaveAttribute("aria-current", "page");
  await expect(steps).toHaveCount(0);

  // Email alerts are a way to get notified, and the count follows.
  await button.click();
  await steps.getByRole("button", { name: "Turn on notifications for me" }).click();
  const email = page.getByRole("checkbox", { name: "Email me about new messages" });
  // The box follows the server's answer, so it ticks once the save is done.
  await email.click();
  await expect(email).toBeChecked();
  await button.click();
  const done = steps.getByRole("listitem").filter({ hasText: "Turn on notifications" });
  await expect(done).toHaveClass("done");
  // A step's mark is a circle, filled green once the step is done.
  const mark = done.locator(".step-mark");
  await expect(mark).toHaveCSS("border-radius", "50%");
  await expect(mark).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(button).toContainText("1/5");

  await steps.getByRole("button", { name: "Hide for good" }).click();
  await expect(button).toHaveCount(0);
  // The server keeps it hidden, so a reload, or another device, shows no steps either.
  await page.reload();
  await page.getByRole("button", { name: "Inbox" }).click();
  // A new workspace with no widget yet: the board, to send the first message.
  await expect(page.getByText("No conversations yet.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Send yourself the first message." }),
  ).toBeVisible();
  await expect(button).toHaveCount(0);
});

test("a new workspace's charts show a grey placeholder until something is counted", async ({
  page,
}) => {
  await openLink(page, await server.signInLink("new@example.com"));
  const menu = page.getByRole("navigation", { name: "Main menu" });
  await menu.getByRole("button", { name: /^Visitors/ }).click();
  await expect(page.locator(".live-spark.spark-empty")).toBeVisible();
  // An empty chart has nothing to point at.
  await expect(page.locator(".live-spark .spark-point")).toHaveCount(0);
});

test("a logo uploaded in Workspace shows there, in the sidebar and in the chat's header", async ({
  page,
}) => {
  await server.createOperator("logo@example.com");
  await openLink(page, await server.signInLink("logo@example.com"));
  await page.getByRole("button", { name: /^Get started/ }).click();
  await page.getByRole("region", { name: "Get started" }).getByText("Add a logo").click();
  await expect(settingsList(page).getByRole("link", { name: "Workspace" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.getByLabel("Upload logo").setInputFiles(pngFile("logo.png"));
  // The image shows the upload worked, with no note.
  const preview = page.getByRole("img", { name: "The current logo" });
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(16);
  await expect(page.getByRole("button", { name: "Replace logo" })).toBeVisible();
  await expect(page.locator(".side img.ws-tile")).toBeVisible();

  const site = await page.context().newPage();
  await site.goto(`${server.hostOrigin}/plain`);
  await site.getByRole("button", { name: "Open chat" }).click();
  const logo = site.locator(".head img.logo");
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(16);
  await expect(site.locator(".head .sea")).toHaveCount(0);
  await site.close();

  await page.getByRole("button", { name: "Remove logo" }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload logo" })).toBeVisible();
});

test("a workspace whose conversations are all closed has its test chat done", async ({ page }) => {
  await server.seedConversations(1, "Earlier");
  await server.closeConversations();
  await server.createOperator("closed@example.com");
  await openLink(page, await server.signInLink("closed@example.com"));
  await expect(page.getByText("Nothing open.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "All caught up." })).toBeVisible();
  await page.getByRole("button", { name: /^Get started/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Get started" })
      .getByRole("listitem")
      .filter({ hasText: "Send yourself a message" }),
  ).toHaveClass("done");
});

test("a new workspace sends itself a test from the board, and the chat lands in the list", async ({
  page,
}) => {
  await server.createSecondWorkspace("Board", "board@example.com");
  await openLink(page, await server.signInLink("board@example.com"));
  await expect(
    page.getByRole("heading", { name: "Send yourself the first message." }),
  ).toBeVisible();
  const field = page.getByRole("textbox", { name: "Write a message as a visitor" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await field.fill("Do you ship to Spain?");
  await send.click();
  // The real test visitor's conversation arrives through the live updates, marked as a test.
  const row = page.locator(".list .row", { hasText: "Do you ship to Spain?" });
  await expect(row).toBeVisible();
  await expect(row.getByText("Test")).toBeVisible();
  await expect(page.getByRole("heading", { name: "A message came in." })).toBeVisible();
  await expect(field).toHaveValue("");

  // A search that finds nothing shows the gull's telescope, and clearing it brings the row back.
  await page.getByRole("searchbox", { name: "Search conversations" }).fill("zebra");
  const telescope = page.getByRole("heading", { name: "The gull can't see it either." });
  await expect(telescope).toBeVisible();
  await expect(page.getByText("No conversation matches “zebra”.")).toBeVisible();
  // Refining keeps the telescope, and the list names the new query only once it was searched.
  await page.getByRole("searchbox", { name: "Search conversations" }).fill("zebrax");
  await expect(telescope).toBeVisible();
  await expect(page.getByText("No conversation matches “zebrax”.")).toBeVisible();
  await expect(telescope).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(row).toBeVisible();
  await expect(page.getByRole("heading", { name: "Select a conversation." })).toBeVisible();
  // Opening the conversation takes the gull away.
  await row.click();
  await expect(page.locator(".gull-pane")).toHaveCount(0);
});
