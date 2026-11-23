import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn } from "./links.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("alice@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

test("What's new shows a dot until the operator opens it", async ({ browser }) => {
  const operator = await signedIn(browser, server, "alice@example.com");
  const button = operator.getByRole("button", {
    name: "What's new, with changes you have not seen",
  });
  await expect(button.locator(".whats-new-dot")).toBeVisible();

  await button.click();
  const dialog = operator.getByRole("dialog", { name: "What's new" });
  await expect(dialog.locator(".update").first()).toBeVisible();
  // The first time, every update is new, so none has a New tag.
  await expect(dialog.locator(".update-new")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();

  await expect(operator.getByRole("button", { name: "What's new", exact: true })).toBeVisible();
  await expect(operator.locator(".whats-new-dot")).toHaveCount(0);
  // The browser remembers it across a reload.
  await operator.reload();
  await expect(operator.getByRole("button", { name: "What's new", exact: true })).toBeVisible();
  await expect(operator.locator(".whats-new-dot")).toHaveCount(0);
});
