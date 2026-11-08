import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';
// A single-page site, which changes its address with the History API and never reloads.
const SPA = `<!doctype html><title>App</title><h1>App</h1>
<button id="go" onclick="history.pushState({}, '', '/app/settings?tab=billing')">Settings</button>
${SNIPPET}`;

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/pricing": { html: `<!doctype html><title>Host</title><h1>Pricing</h1>${SNIPPET}` },
    "/app": { html: SPA },
  });
  await server.createOperator("owner@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

test.beforeEach(async () => {
  await server.closeConversations();
  await server.setWidgetTexts({ title: null, greeting: null, away: null });
});

async function signedIn(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openLink(page, await server.signInLink("owner@example.com"));
  await expect(page.getByRole("heading", { name: "E2E" })).toBeVisible();
  return page;
}

async function say(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Your message" }).fill(text);
  await page.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
}

async function visitor(browser: Browser, path: string, text: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.hostOrigin}${path}`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await say(page, text);
  return page;
}

test("the reply email's link opens the conversation on its own page, to read and reply", async ({
  browser,
}) => {
  await visitor(browser, "/pricing", "Is there a yearly plan?");
  await server.reply("Yes, two months free.");
  await server.setWidgetTexts({ title: "Talk to E2E", greeting: null, away: null });
  const link = await server.chatLink();

  const page = await (await browser.newContext()).newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  const response = await page.goto(link);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["cache-control"]).toBe("no-store");
  await expect(page.locator(".msg", { hasText: "Yes, two months free." })).toBeVisible();
  await expect(page.locator(".msg.mine", { hasText: "Is there a yearly plan?" })).toBeVisible();
  await expect(page.locator(".head b")).toHaveText("Talk to E2E");
  // Nothing to close on a page of its own.
  await expect(page.getByRole("button", { name: "Close chat" })).toHaveCount(0);
  await say(page, "Great, I'll take it.");
  await expect(page.getByRole("button", { name: "Not sent" })).toHaveCount(0);
  // The operator's next reply arrives live.
  await server.reply("Done!");
  await expect(page.locator(".msg", { hasText: "Done!" })).toBeVisible();
  expect(problems).toEqual([]);

  const owner = await signedIn(browser);
  await owner.locator(".row", { hasText: "Done!" }).click();
  await expect(
    owner.locator(".thread .msg.visitor", { hasText: "Great, I'll take it." }),
  ).toBeVisible();
});

test("an unknown link shows a clear page", async ({ page }) => {
  await page.goto(`${server.apiOrigin}/chat/dcl_nothing`);
  await expect(page.getByText("This link has expired")).toBeVisible();
});

test("the widget uses the workspace's own title and greeting", async ({ page }) => {
  await server.setWidgetTexts({
    title: "Ask Acme",
    greeting: "Ask us anything at all.",
    away: null,
  });
  await page.goto(`${server.hostOrigin}/pricing`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.locator(".head b")).toHaveText("Ask Acme");
  await expect(page.getByText("Ask us anything at all.")).toBeVisible();
});

test("the operator sees the visitor online, their device and the page they moved to", async ({
  browser,
}) => {
  const customer = await visitor(browser, "/app", "Where is billing?");
  await customer.locator("#go").click();
  const owner = await signedIn(browser);
  await owner.locator(".row", { hasText: "Where is billing?" }).click();
  const visit = owner.locator(".thread-head .visit");
  await expect(visit).toContainText("Online now");
  await expect(visit).toContainText("Chrome");
  const page = visit.getByRole("link");
  await expect(page).toHaveText(/\/app\/settings$/);
  await expect(page).toHaveAttribute("target", "_blank");
  await expect(page).toHaveAttribute("rel", "noopener noreferrer");
});

test("search finds a conversation by its text, and Escape returns to the list", async ({
  browser,
}) => {
  await visitor(browser, "/pricing", "My invoice number is 4417");
  await visitor(browser, "/pricing", "Something unrelated");
  const owner = await signedIn(browser);
  const field = owner.getByRole("searchbox", { name: "Search conversations" });
  await field.fill("invoice number");
  await expect(owner.locator(".row")).toHaveCount(1);
  await expect(owner.locator(".row .preview")).toHaveText("My invoice number is 4417");
  await field.press("Escape");
  await expect(field).toHaveValue("");
  await expect(owner.locator(".row", { hasText: "Something unrelated" })).toBeVisible();
});
