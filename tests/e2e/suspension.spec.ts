import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink } from "./links.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("owner@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function signIn(page: Page) {
  const streaming = page.waitForResponse((response) => response.url().includes("/stream"));
  await openLink(page, await server.signInLink("owner@example.com"));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  // The inbox's live stream is open, so a change from here on reaches it.
  await streaming;
}

test("an open inbox shows the suspension banner without a reload, and loses it when lifted", async ({
  page,
}) => {
  await signIn(page);
  const banner = page.getByRole("status").filter({ hasText: "This workspace is suspended" });
  await expect(banner).toHaveCount(0);

  await server.suspend();
  await expect(banner).toBeVisible();
  // A self-hosted server has no cloud address, so it points to whoever runs the server.
  await expect(banner).toContainText("Ask the person who runs this server.");
  await page.reload();
  await expect(banner).toBeVisible();

  await server.suspend(false);
  await expect(banner).toHaveCount(0);
});
