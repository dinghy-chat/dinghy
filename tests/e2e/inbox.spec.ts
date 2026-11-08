import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/pricing": { html: `<!doctype html><title>Host</title><h1>Pricing</h1>${SNIPPET}` },
  });
  // createOperator names each operator after its email.
  for (const email of ["alice@example.com", "bob@example.com", "carol@example.com"]) {
    await server.createOperator(email);
  }
});

test.afterAll(async () => {
  await server.stop();
});

// Each test starts with no open conversation, so the counts below are exact.
test.beforeEach(async () => {
  await server.closeConversations();
});

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openLink(page, await server.signInLink(email));
  await expect(page.getByRole("heading", { name: "E2E" })).toBeVisible();
  return page;
}

async function visitor(browser: Browser, text: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.hostOrigin}/pricing?coupon=SECRET#top`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await say(page, text);
  return page;
}

async function say(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Your message" }).fill(text);
  await page.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
}

async function answer(page: Page, text: string) {
  const reply = page.getByRole("textbox", { name: "Your reply" });
  await reply.fill(text);
  await reply.press("Enter");
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
}

const row = (page: Page, text: string) => page.locator(".row", { hasText: text });
const openCount = (page: Page) => page.locator(".nav .count");

test("each reply shows who sent it, and your own say You", async ({ browser }) => {
  const customer = await visitor(browser, "Who is answering?");
  const alice = await signedIn(browser, "alice@example.com");
  const bob = await signedIn(browser, "bob@example.com");

  await row(alice, "Who is answering?").click();
  await answer(alice, "Alice here.");
  await answer(alice, "One more from Alice.");

  await row(bob, "One more from Alice").click();
  await answer(bob, "Bob joins.");

  // The name and the time under each run of messages from one operator.
  await expect(alice.locator(".log .meta:not(.visitor)")).toHaveText([
    /^You · \d/,
    /^bob@example\.com · \d/,
  ]);
  await expect(bob.locator(".log .meta:not(.visitor)")).toHaveText([
    /^alice@example\.com · \d/,
    /^You · \d/,
  ]);

  // The visitor sees the replies, and no operator's name.
  await expect(customer.locator(".msg:not(.mine)", { hasText: "Bob joins." })).toBeVisible();
  await expect(customer.getByText("alice@example.com")).toHaveCount(0);

  // A signed-out visitor has a short code, and the thread shows the page without its query.
  await expect(alice.locator(".thread-head h2")).toHaveText(/^Visitor [0-9A-Z]{4}$/);
  const from = alice.locator(".thread-head .who-text p:not(.visit)");
  await expect(from).toHaveText(`started on ${new URL(server.hostOrigin).host}/pricing`);
  await expect(alice.locator(".thread")).not.toContainText("SECRET");

  for (const page of [customer, alice, bob]) await page.context().close();
});

test("the Inbox item and the tab title count the conversations that wait for a reply", async ({
  browser,
}) => {
  const operator = await signedIn(browser, "alice@example.com");
  await expect(openCount(operator)).toHaveCount(0);
  await expect(operator).toHaveTitle("Dinghy");

  // A new message arrives live, with no reload.
  const first = await visitor(browser, "First question");
  await expect(openCount(operator)).toHaveText("1");
  await expect(operator).toHaveTitle("(1) Dinghy");
  await expect(row(operator, "First question").locator(".chip.warn")).toHaveText(
    "Waits for a reply",
  );

  const second = await visitor(browser, "Second question");
  await expect(openCount(operator)).toHaveText("2");
  await expect(operator).toHaveTitle("(2) Dinghy");

  // A reply takes it off the count. The count is the workspace's, so another tab sees it too.
  const teammate = await signedIn(browser, "bob@example.com");
  await expect(openCount(teammate)).toHaveText("2");
  await row(operator, "First question").click();
  await answer(operator, "Answered.");
  await expect(openCount(operator)).toHaveText("1");
  await expect(openCount(teammate)).toHaveText("1");
  await expect(row(operator, "Answered.").locator(".chip.warn")).toHaveCount(0);

  // The visitor writes again, so it waits again.
  await say(first, "Thanks, and one more thing");
  await expect(openCount(operator)).toHaveText("2");

  // Closing one takes it off the count.
  await operator.getByRole("button", { name: "Close", exact: true }).click();
  await expect(openCount(operator)).toHaveText("1");
  await expect(operator).toHaveTitle("(1) Dinghy");

  for (const page of [first, second, operator, teammate]) await page.context().close();
});

test("a draft stays with its conversation when the operator opens another", async ({ browser }) => {
  const one = await visitor(browser, "Draft one");
  const two = await visitor(browser, "Draft two");
  const operator = await signedIn(browser, "alice@example.com");
  const reply = operator.getByRole("textbox", { name: "Your reply" });
  await row(operator, "Draft one").click();
  await reply.fill("Half a sentence for one");
  await row(operator, "Draft two").click();
  await expect(reply).toHaveValue("");
  await reply.fill("For two");
  await row(operator, "Draft one").click();
  await expect(reply).toHaveValue("Half a sentence for one");
  await row(operator, "Draft two").click();
  await expect(reply).toHaveValue("For two");
  for (const page of [one, two, operator]) await page.context().close();
});

test("a failed action says so", async ({ browser }) => {
  const customer = await visitor(browser, "Close me later");
  const operator = await signedIn(browser, "alice@example.com");
  await row(operator, "Close me later").click();
  await operator.route("**/conversations/*", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  await operator.getByRole("button", { name: "Close", exact: true }).click();
  await expect(operator.getByRole("alert")).toHaveText(
    "That did not work. Check the connection and try again.",
  );
  await expect(operator.getByRole("textbox", { name: "Your reply" })).toBeVisible();
  for (const page of [customer, operator]) await page.context().close();
});

test("an operator changes their name in Profile, which has no password", async ({ browser }) => {
  const page = await signedIn(browser, "carol@example.com");
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page.getByText("Change password")).toHaveCount(0);
  await expect(page.getByLabel(/password/i)).toHaveCount(0);

  await page.getByLabel("Name", { exact: true }).fill("Carol King");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.locator(".me")).toContainText("Carol King");

  // The inbox's assignment dropdown shows the new name too, without a reload.
  const customer = await visitor(browser, "Who is Carol now?");
  await page.getByRole("button", { name: "Inbox" }).click();
  await row(page, "Who is Carol now?").click();
  await page.getByRole("button", { name: /^Assign to/ }).click();
  await expect(page.getByRole("option", { name: "Carol King" })).toBeVisible();
  await page.keyboard.press("Escape");
  await customer.context().close();

  const again = await signedIn(browser, "carol@example.com");
  await expect(again.locator(".me")).toContainText("Carol King");
  for (const one of [page, again]) await one.context().close();
});
