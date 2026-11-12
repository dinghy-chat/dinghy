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
  await expect(button).toContainText("0/6");
  await button.click();
  const steps = page.getByRole("region", { name: "Get started" });
  await expect(steps).toBeVisible();

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
  await expect(
    steps.getByRole("listitem").filter({ hasText: "Turn on notifications" }),
  ).toHaveClass("done");
  await expect(button).toContainText("1/6");

  await steps.getByRole("button", { name: "Hide for good" }).click();
  await expect(button).toHaveCount(0);
  // The server keeps it hidden, so a reload, or another device, shows no steps either.
  await page.reload();
  await page.getByRole("button", { name: "Inbox" }).click();
  await expect(page.getByText("No open conversations.")).toBeVisible();
  await expect(button).toHaveCount(0);
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
  await expect(page.getByText("No open conversations.")).toBeVisible();
  await page.getByRole("button", { name: /^Get started/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Get started" })
      .getByRole("listitem")
      .filter({ hasText: "Send a test chat" }),
  ).toHaveClass("done");
});
