import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { say, visitor } from "./chat.ts";
import { signedIn } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';
// A single-page site, which changes its address with the History API and never reloads.
const SPA = `<!doctype html><title>App</title><h1>App</h1>
<button id="go" onclick="history.pushState({}, '', '/app/settings?tab=billing'); setTimeout(() => { document.title = 'Billing settings' }, 50)">Settings</button>
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
  await server.setWidgetSettings({ title: null, greeting: null, away: null, primary: null });
});

test("the reply email's link opens the conversation on its own page, to read and reply", async ({
  browser,
}) => {
  await visitor(browser, server, "/pricing", "Is there a yearly plan?");
  await server.reply("Yes, two months free.");
  await server.setWidgetSettings({ title: "Talk to E2E", primary: "#1f6bff" });
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
  // The saved colors, as on the site.
  const primary = await page
    .locator("dinghy-chat")
    .evaluate((host) => (host as HTMLElement).style.getPropertyValue("--d-primary"));
  expect(primary).toBe("#1f6bff");
  // Nothing to close on a page of its own.
  await expect(page.getByRole("button", { name: "Close chat" })).toHaveCount(0);
  await say(page, "Great, I'll take it.");
  await expect(page.getByRole("button", { name: "Not sent" })).toHaveCount(0);
  // The operator's next reply arrives live.
  await server.reply("Done!");
  await expect(page.locator(".msg", { hasText: "Done!" })).toBeVisible();
  expect(problems).toEqual([]);

  const owner = await signedIn(browser, server, "owner@example.com");
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
  await server.setWidgetSettings({ title: "Ask Acme", greeting: "Ask us anything at all." });
  // A slow answer, so the page is read before the saved settings arrive.
  let answer: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route("**/appearance", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${server.hostOrigin}/pricing`);
  // The launcher waits for them, so it never changes shape, and the default title never shows.
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: "Open chat" })).toHaveCount(0);
  answer();
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.locator(".head b")).toHaveText("Ask Acme");
  await expect(page.getByText("Ask us anything at all.")).toBeVisible();
  await expect(page.getByText("Chat with us")).toHaveCount(0);
});

test("the operator sees the visitor online, their device and the page they moved to", async ({
  browser,
}) => {
  const customer = await visitor(browser, server, "/app", "Where is billing?");
  // The widget waits a moment after a change of address, for the new title.
  const reported = customer.waitForRequest(
    (request) =>
      request.url().endsWith("/page") && request.postData()?.includes("settings") === true,
  );
  await customer.locator("#go").click();
  await reported;
  const owner = await signedIn(browser, server, "owner@example.com");
  await owner.locator(".row", { hasText: "Where is billing?" }).click();
  // The header says only that the chat is open. The device and the page are in the panel.
  await expect(owner.locator(".thread-head .visit")).toHaveText("Chat is open");
  const facts = owner.locator(".visitor-panel .place-tiles", { hasText: "Chrome" });
  await expect(facts).toBeVisible();
  const page = facts.getByRole("link");
  await expect(page).toHaveText(/\/app\/settings$/);
  await expect(page).toHaveAttribute("target", "_blank");
  await expect(page).toHaveAttribute("rel", "noopener noreferrer");
});

test("search finds a conversation by its text, and Escape returns to the list", async ({
  browser,
}) => {
  await visitor(browser, server, "/pricing", "My invoice number is 4417");
  await visitor(browser, server, "/pricing", "Something unrelated");
  const owner = await signedIn(browser, server, "owner@example.com");
  const field = owner.getByRole("searchbox", { name: "Search conversations" });
  await field.fill("invoice number");
  await expect(owner.locator(".row")).toHaveCount(1);
  await expect(owner.locator(".row .preview")).toHaveText("My invoice number is 4417");
  await field.press("Escape");
  await expect(field).toHaveValue("");
  await expect(owner.locator(".row", { hasText: "Something unrelated" })).toBeVisible();
});

test("a visitor who never chatted stores nothing and reports no page", async ({ page }) => {
  const reports: string[] = [];
  page.on("request", (request) => {
    if (/\/v1\/widget\/[^/]+\/(page|visitors)$/.test(request.url())) reports.push(request.url());
  });
  await page.goto(`${server.hostOrigin}/app`);
  await page.locator("#go").click();
  // Opening the chat and closing it is not using it.
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByRole("textbox", { name: "Your message" })).toBeVisible();
  await page.getByRole("button", { name: "Close chat" }).click();
  await page.evaluate(() => {
    const api = (globalThis as { Dinghy?: { reset(): void } }).Dinghy;
    api?.reset();
  });
  await page.waitForTimeout(1000);
  expect(reports).toEqual([]);
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    cookies: document.cookie,
  }));
  expect(stored).toEqual({ local: [], session: [], cookies: "" });
});

test("the operator sees the pages the visitor went through, newest first", async ({ browser }) => {
  const customer = await visitor(browser, server, "/app", "Which plan do I have?");
  // The widget waits a moment after a change of address, for the new title.
  const reported = customer.waitForRequest(
    (request) =>
      request.url().endsWith("/page") && request.postData()?.includes("Billing") === true,
  );
  await customer.locator("#go").click();
  await reported;
  const owner = await signedIn(browser, server, "owner@example.com");
  await owner.locator(".row", { hasText: "Which plan do I have?" }).click();
  const journey = owner.getByRole("region", { name: "Pages visited" });
  await expect(journey.getByRole("link")).toHaveText(["Billing settings", "App"]);
  const newest = journey.getByRole("link").first();
  await expect(newest).toHaveAttribute("href", `${server.hostOrigin}/app/settings`);
  await expect(newest).toHaveAttribute("target", "_blank");
  await expect(newest).toHaveAttribute("rel", "noopener noreferrer");
  await expect(journey.locator("time").first()).toHaveText(/now|sec|min|0/);
});

test("the Analytics page shows the workspace's numbers for the chosen period", async ({
  browser,
}) => {
  await visitor(browser, server, "/pricing", "Counting this one");
  await server.reply("Answered.");
  const owner = await signedIn(browser, server, "owner@example.com");
  await owner.getByRole("button", { name: "Analytics" }).click();
  const page = owner.getByRole("region", { name: "Analytics" });
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  const zone = await owner.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect(page.getByText(`in ${zone} time`)).toBeVisible();
  const stats = page.getByRole("region", { name: "Key numbers" });
  const started = stats.locator(".stat", { hasText: "Conversations" }).locator(".stat-value");
  await expect(started).toHaveText(/^[1-9]\d*$/);
  await expect(stats.getByRole("heading", { name: "Median first reply" })).toBeVisible();
  await expect(stats.getByText(/^\d+ of \d+ got a reply$/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "What happened to them" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who replies first" })).toBeVisible();
  await expect(page.locator(".day-bar")).toHaveCount(30);
  await expect(page.locator(".heat-cell")).toHaveCount(7 * 24);
  await expect(page.locator(".heat-cell.peak")).toHaveCount(1);

  // An explanation shows on focus, and Escape hides it.
  const help = stats.getByRole("button", { name: /^Half of answered conversations/ });
  await help.focus();
  await expect(page.locator(".chart-tip")).toContainText("Half of answered conversations");
  await owner.keyboard.press("Escape");
  await expect(page.locator(".chart-tip")).toHaveCount(0);

  await page.getByRole("radio", { name: "7 days" }).check();
  await expect(page.locator(".day-bar")).toHaveCount(7);
  await expect(page.getByRole("radio", { name: "7 days" })).toBeChecked();
});

test("Analytics compares the period with the one just before", async ({ browser }) => {
  // Before the last 7 days, and slower than 5 minutes: 10 minutes.
  await visitor(browser, server, "/pricing", "A question last week");
  await server.reply("Sorry for the wait.");
  await server.backdateLatest(10 * 24, 600);
  await visitor(browser, server, "/pricing", "A question today");
  await server.reply("Right away.");
  const owner = await signedIn(browser, server, "owner@example.com");
  await owner.getByRole("button", { name: "Analytics" }).click();
  const page = owner.getByRole("region", { name: "Analytics" });
  const stats = page.getByRole("region", { name: "Key numbers" });
  // The 30 days before the last 30 had no conversations, so nothing compares.
  await expect(stats.locator(".stat-value").first()).toBeVisible();
  await expect(stats.locator(".stat-change")).toHaveCount(0);

  await page.getByRole("radio", { name: "7 days" }).check();
  await expect(page.locator(".day-bar")).toHaveCount(7);
  const median = stats.locator(".stat", { hasText: "Median first reply" }).locator(".stat-change");
  await expect(median).toHaveText(/^↓ .+ faster vs previous 7 days$/);
  await expect(median).toHaveClass(/better/);
  const fast = stats.locator(".stat", { hasText: "Replied within 5 min" }).locator(".stat-change");
  await expect(fast).toHaveText(/^↑ \d+ pts vs previous 7 days$/);
  await expect(fast).toHaveClass(/better/);
  await expect(
    stats.locator(".stat", { hasText: "Conversations" }).locator(".stat-change"),
  ).toContainText("vs previous 7 days");
});

test("a message in the open conversation chimes while another page hides it", async ({
  browser,
}) => {
  const customer = await visitor(browser, server, "/pricing", "First question");
  const owner = await signedIn(browser, server, "owner@example.com");
  // Counts each chime, which starts its notes with an oscillator.
  await owner.evaluate(() => {
    const counted = globalThis as { chimes?: number };
    counted.chimes = 0;
    const original = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
      counted.chimes = (counted.chimes ?? 0) + 1;
      return original.call(this);
    };
  });
  await owner.locator(".row", { hasText: "First question" }).click();
  await expect(owner.locator(".thread .msg.visitor", { hasText: "First question" })).toBeVisible();
  await owner.getByRole("button", { name: "Analytics" }).click();
  await expect(owner.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await say(customer, "Are you there?");
  await expect
    .poll(() => owner.evaluate(() => (globalThis as { chimes?: number }).chimes ?? 0))
    .toBeGreaterThan(0);
});
