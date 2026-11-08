import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/plain": { html: `<!doctype html><title>Host</title>${SNIPPET}` },
  });
  await server.createOperator("anna@example.com");
  await server.createOperator("ben@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function signedIn(browser: import("@playwright/test").Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openLink(page, await server.signInLink(email));
  await expect(page.getByRole("button", { name: "Your account" })).toBeVisible();
  return page;
}

test("the widget says when the team is online, and names nobody", async ({ browser }) => {
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await visitor.goto(`${server.hostOrigin}/plain`);
  await visitor.getByRole("button", { name: "Open chat" }).click();
  await expect(visitor.getByText("We are away.")).toBeVisible();
  await expect(visitor.getByText("We are online")).toHaveCount(0);

  const anna = await signedIn(browser, "anna@example.com");
  await expect(anna.getByRole("button", { name: "Alerts" })).toBeVisible();
  await visitor.reload();
  await visitor.getByRole("button", { name: "Open chat" }).click();
  await expect(visitor.getByText("We are online")).toBeVisible();
  await expect(visitor.getByText("We are away.")).toHaveCount(0);
  await expect(visitor.getByText("anna@example.com")).toHaveCount(0);
  await anna.close();
  await context.close();
});

test("an operator sees who has a conversation open, and it clears when they leave @smoke", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  await server.seedConversations(1, "shared");
  const anna = await signedIn(browser, "anna@example.com");
  const ben = await signedIn(browser, "ben@example.com");
  await anna.locator(".row", { hasText: "shared" }).click();
  await ben.locator(".row", { hasText: "shared" }).click();

  // Each sees the other, and neither sees themselves. A heartbeat can take 10 seconds.
  const annaSees = anna.locator(".thread .replying");
  await expect(annaSees).toHaveText(/ben@example\.com is replying/, { timeout: 15_000 });
  await expect(ben.locator(".thread .replying")).toHaveText(/anna@example\.com is replying/, {
    timeout: 15_000,
  });
  await expect(anna.locator(".row em")).toHaveText(/ben@example\.com is replying/);

  // A closing page sends a leave request, but under Playwright Firefox does not clear it within 15
  // seconds. So this also allows for the 30-second expiry that covers a crash or a lost network.
  await ben.close();
  await expect(annaSees).toHaveCount(0, { timeout: 35_000 });
  await server.closeConversations();
});

test("with no mail server, the widget does not promise a reply by email", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.hostOrigin}/plain`);
  const answered = page.waitForResponse((response) => response.url().endsWith("/presence"));
  await page.getByRole("button", { name: "Open chat" }).click();
  expect((await (await answered).json()).emailReplies).toBe(false);
  const message = page.getByRole("textbox", { name: "Your message" });
  await message.fill("Hello");
  await message.press("Enter");
  await expect(page.getByText("Hello")).toBeVisible();
  await expect(page.getByLabel("Your email")).toHaveCount(0);
  await context.close();
});

test("a closed widget asks nothing about the team", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/presence")) asked.push(request.url());
  });
  await page.goto(`${server.hostOrigin}/plain`);
  await expect(page.getByRole("button", { name: "Open chat" })).toBeVisible();
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect.poll(() => asked.length).toBe(1);
  await context.close();
});
