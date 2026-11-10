import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { pngFile } from "./images.ts";
import { openLink } from "./links.ts";

const HOST_PAGE = `<!doctype html><title>Host</title><h1>Host</h1>
<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>`;

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({ "/plain": { html: HOST_PAGE } });
  await server.createSecondWorkspace("Fresh", "new@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

test("a new workspace shows its first steps, which open settings and can be hidden", async ({
  page,
}) => {
  await openLink(page, await server.signInLink("new@example.com"));
  const steps = page.getByRole("region", { name: "Get started" });
  await expect(steps).toBeVisible();

  await steps.getByRole("button", { name: "Add your website" }).click();
  await expect(page.getByRole("tab", { name: "Allowed sites" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("button", { name: "Inbox" }).click();
  await steps.getByRole("button", { name: "Invite your team" }).click();
  await expect(page.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Inbox" }).click();
  await steps.getByRole("button", { name: "Hide these steps" }).click();
  await expect(steps).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("No open conversations.")).toBeVisible();
  await expect(steps).toHaveCount(0);
});

test("a logo uploaded in Settings shows there, in the sidebar and in the chat's header", async ({
  page,
}) => {
  await server.createOperator("logo@example.com");
  await openLink(page, await server.signInLink("logo@example.com"));
  await page.getByRole("region", { name: "Get started" }).getByText("Add your logo").click();
  await expect(page.getByRole("tab", { name: "Install" })).toHaveAttribute("aria-selected", "true");

  await page.getByLabel("Upload logo").setInputFiles(pngFile("logo.png"));
  await expect(page.getByText("Logo saved.")).toBeVisible();
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

  await page.getByRole("button", { name: "Remove" }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload logo" })).toBeVisible();
});

test("a workspace whose conversations are all closed shows no first steps", async ({ page }) => {
  await server.seedConversations(1, "Earlier");
  await server.closeConversations();
  await server.createOperator("closed@example.com");
  await openLink(page, await server.signInLink("closed@example.com"));
  await expect(page.getByText("No open conversations.")).toBeVisible();
  await page.getByRole("button", { name: "Closed" }).click();
  await expect(page.getByText("Earlier", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Inbox" }).click();
  await expect(page.getByText("No open conversations.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Get started" })).toHaveCount(0);
});
