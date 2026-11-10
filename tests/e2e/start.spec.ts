import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink } from "./links.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({});
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
