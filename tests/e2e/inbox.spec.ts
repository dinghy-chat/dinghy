import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { inboxFilter } from "./filters.ts";
import { signedIn } from "./links.ts";

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
const openCount = (page: Page) => page.locator(".nav .count:not(.live)");
const favicon = (page: Page) => page.locator('link[rel="icon"]');

/** Runs an action from the conversation's "…" menu. */
async function moreAction(page: Page, name: string) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("a snoozed conversation leaves the count until the visitor writes again", async ({
  browser,
}) => {
  const customer = await visitor(browser, "Snooze me");
  const operator = await signedIn(browser, server, "alice@example.com");
  await expect(openCount(operator)).toHaveText("1");
  await row(operator, "Snooze me").click();

  await moreAction(operator, "Snooze until they reply");
  await expect(openCount(operator)).toHaveCount(0);
  await expect(row(operator, "Snooze me").locator(".chip")).toHaveText("Snoozed");

  // A snooze with a time says when it ends, and Unsnooze ends it.
  await moreAction(operator, "Unsnooze");
  await expect(openCount(operator)).toHaveText("1");
  await moreAction(operator, "Snooze until tomorrow");
  await expect(row(operator, "Snooze me").locator(".chip")).toHaveText(/^Snoozed until \w+ 9:00/);

  // A close ends the snooze, so a reopen offers to snooze it again.
  await operator.getByRole("button", { name: "Close", exact: true }).click();
  await operator.getByRole("button", { name: "Reopen" }).click();
  await operator.getByRole("button", { name: "More actions" }).click();
  await expect(operator.getByRole("menuitem", { name: "Unsnooze" })).toHaveCount(0);
  await operator.getByRole("menuitem", { name: "Snooze until tomorrow", exact: true }).click();

  // The visitor writes again, so it waits again.
  await say(customer, "Any news?");
  await expect(openCount(operator)).toHaveText("1");
  await expect(row(operator, "Any news?").locator(".chip.warn")).toHaveText("Waiting for a reply");

  for (const page of [customer, operator]) await page.context().close();
});

test("each reply shows who sent it, and your own say You", async ({ browser }) => {
  const customer = await visitor(browser, "Who is answering?");
  const alice = await signedIn(browser, server, "alice@example.com");
  const bob = await signedIn(browser, server, "bob@example.com");

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
  // The last page is in the visitor's panel, by its path.
  await expect(alice.locator(".visitor-panel")).toContainText("/pricing");
  await expect(alice.locator(".thread")).not.toContainText("SECRET");

  for (const page of [customer, alice, bob]) await page.context().close();
});

test("the Inbox item, the tab title and the favicon count the conversations that wait for a reply", async ({
  browser,
}) => {
  const operator = await signedIn(browser, server, "alice@example.com");
  await expect(openCount(operator)).toHaveCount(0);
  await expect(operator).toHaveTitle("Dinghy");

  // A new message arrives live, with no reload.
  const first = await visitor(browser, "First question");
  await expect(openCount(operator)).toHaveText("1");
  await expect(operator).toHaveTitle("(1) Dinghy");
  await expect(row(operator, "First question").locator(".chip.warn")).toHaveText(
    "Waiting for a reply",
  );

  const second = await visitor(browser, "Second question");
  await expect(openCount(operator)).toHaveText("2");
  await expect(operator).toHaveTitle("(2) Dinghy");

  // A reply takes it off the count. The count is the workspace's, so another tab sees it too.
  const teammate = await signedIn(browser, server, "bob@example.com");
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
  await expect(favicon(operator)).toHaveAttribute("href", /^data:image\/png/);

  // A teammate's conversation is not theirs to answer, so it leaves their count.
  await row(operator, "Second question").click();
  await operator.getByRole("button", { name: /^Who answers/ }).click();
  await operator.getByRole("option", { name: "alice@example.com" }).click();
  await expect(openCount(teammate)).toHaveCount(0);
  await expect(teammate).toHaveTitle("Dinghy");
  await expect(favicon(teammate)).toHaveAttribute("href", "/assets/icon.svg");
  await expect(openCount(operator)).toHaveText("1");

  for (const page of [first, second, operator, teammate]) await page.context().close();
});

test("a hidden tab's title counts a visitor who writes while it is hidden", async ({ browser }) => {
  const operator = await signedIn(browser, server, "alice@example.com");
  // The waiting counts load every minute while the tab is hidden, which the fake clock skips.
  await operator.clock.install();
  await operator.reload();
  await expect(operator).toHaveTitle("Dinghy");
  await operator.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const writer = await visitor(browser, "Written while hidden");
  await operator.clock.runFor(60_000);
  await expect(operator).toHaveTitle("(1) Dinghy");
  for (const page of [writer, operator]) await page.context().close();
});

test("a row shows the visitor's country as a flag on the avatar, and names it", async ({
  browser,
}) => {
  await server.seedConversations(1, "from-portugal", "PT");
  await server.seedConversations(1, "from-nowhere");
  const operator = await signedIn(browser, server, "alice@example.com");
  const flagged = row(operator, "from-portugal message 0");
  await expect(flagged.locator(".avatar-wrap .flag-badge")).toHaveText("🇵🇹");
  await expect(flagged.getByRole("img", { name: "Portugal" })).toBeVisible();
  await expect(row(operator, "from-nowhere message 0").locator(".flag-badge")).toHaveCount(0);
  await operator.context().close();
});

test("a draft stays with its conversation when the operator opens another", async ({ browser }) => {
  const one = await visitor(browser, "Draft one");
  const two = await visitor(browser, "Draft two");
  const operator = await signedIn(browser, server, "alice@example.com");
  const reply = operator.getByRole("textbox", { name: "Your reply" });
  await row(operator, "Draft one").click();
  await reply.fill("Half a sentence for one");
  await row(operator, "Draft two").click();
  await expect(reply).toHaveText("");
  // The list shows the unsent reply in place of the visitor's last message.
  await expect(row(operator, "Half a sentence for one")).toContainText("Draft:");
  await reply.fill("For two");
  await row(operator, "Half a sentence for one").click();
  await expect(reply).toHaveText("Half a sentence for one");
  await row(operator, "For two").click();
  await expect(reply).toHaveText("For two");
  // A reload of the tab keeps both.
  await operator.reload();
  await expect(row(operator, "Half a sentence for one")).toContainText("Draft:");
  for (const page of [one, two, operator]) await page.context().close();
});

test("a failed action says so", async ({ browser }) => {
  const customer = await visitor(browser, "Close me later");
  const operator = await signedIn(browser, server, "alice@example.com");
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
  const page = await signedIn(browser, server, "carol@example.com");
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
  await page.getByRole("button", { name: /^Who answers/ }).click();
  await expect(page.getByRole("option", { name: "Carol King" })).toBeVisible();
  await page.keyboard.press("Escape");
  await customer.context().close();

  const again = await signedIn(browser, server, "carol@example.com");
  await expect(again.locator(".me")).toContainText("Carol King");
  for (const one of [page, again]) await one.context().close();
});

test("the Closed switch lists closed conversations, by keyboard too, and a reload keeps it", async ({
  browser,
}) => {
  const customer = await visitor(browser, "Close this one");
  const page = await signedIn(browser, server, "alice@example.com");
  await row(page, "Close this one").click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // A conversation that stops matching leaves the list.
  await expect(row(page, "Close this one")).toHaveCount(0);

  const open = await inboxFilter(page, "Open");
  await open.focus();
  await page.keyboard.press("ArrowRight");
  await expect(await inboxFilter(page, "Closed")).toBeChecked();
  await expect(row(page, "Close this one")).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=closed/);

  await page.reload();
  // The card opens with the focus on the chosen filter, so the arrows move from it.
  const closed = await inboxFilter(page, "Closed");
  await expect(closed).toBeChecked();
  await expect(closed).toBeFocused();
  await expect(row(page, "Close this one")).toBeVisible();
  for (const one of [customer, page]) await one.context().close();
});

test("Mine and Unassigned follow assignments as they change", async ({ browser }) => {
  const customers = [await visitor(browser, "For Alice"), await visitor(browser, "For Bob")];
  const alice = await signedIn(browser, server, "alice@example.com");
  const bob = await signedIn(browser, server, "bob@example.com");
  const assign = async (text: string, name: string) => {
    await row(alice, text).click();
    await alice.getByRole("button", { name: /^Who answers/ }).click();
    await alice.getByRole("option", { name }).click();
  };

  await (await inboxFilter(bob, "Unassigned")).click();
  await expect(row(bob, "For Alice")).toBeVisible();
  await expect(row(bob, "For Bob")).toBeVisible();
  await (await inboxFilter(bob, "Mine")).click();
  await expect(bob.getByText("Nothing is assigned to you.")).toBeVisible();
  await expect(bob).toHaveURL(/[?&]who=mine/);

  await assign("For Alice", "alice@example.com");
  await assign("For Bob", "bob@example.com");
  // One that starts matching enters the list, and another operator's never shows.
  await expect(row(bob, "For Bob")).toBeVisible();
  await expect(row(bob, "For Alice")).toHaveCount(0);

  // Reassigned away, it leaves.
  await assign("For Bob", "alice@example.com");
  await expect(row(bob, "For Bob")).toHaveCount(0);
  await (await inboxFilter(bob, "Unassigned")).click();
  await expect(bob.getByText("Every open conversation has someone on it.")).toBeVisible();

  await bob.reload();
  await expect(await inboxFilter(bob, "Unassigned")).toBeChecked();
  for (const one of [...customers, alice, bob]) await one.context().close();
});

test("an old Closed link opens the Inbox with Closed picked, and a conversation link its state", async ({
  browser,
}) => {
  const customer = await visitor(browser, "Linked and closed");
  const page = await signedIn(browser, server, "alice@example.com");
  await row(page, "Linked and closed").click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row(page, "Linked and closed")).toHaveCount(0);

  await page.goto(`${server.apiOrigin}/?view=closed`);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(await inboxFilter(page, "Closed")).toBeChecked();
  await expect(row(page, "Linked and closed")).toBeVisible();

  const workspaceId = server.workspaceId();
  const listed = await page.request.get(
    `${server.apiOrigin}/v1/operator/workspaces/${workspaceId}/conversations?status=closed`,
  );
  const { conversations } = (await listed.json()) as {
    conversations: { id: string; lastMessage: { body: string } | null }[];
  };
  const linked = conversations.find((one) => one.lastMessage?.body === "Linked and closed");
  await page.goto(`${server.apiOrigin}/?workspace=${workspaceId}&conversation=${linked?.id}`);
  await expect(page.getByText("This conversation is closed.")).toBeVisible();
  await expect(await inboxFilter(page, "Closed")).toBeChecked();
  for (const one of [customer, page]) await one.context().close();
});

test("each operator sees the conversations they have not read, with a dot", async ({ browser }) => {
  const customer = await visitor(browser, "Is anyone reading?");
  const other = await visitor(browser, "Another question");
  const alice = await signedIn(browser, server, "alice@example.com");
  const bob = await signedIn(browser, server, "bob@example.com");
  const dot = (page: Page, text: string) =>
    row(page, text).getByRole("img", { name: "Unread", exact: true });

  for (const page of [alice, bob]) {
    await expect(row(page, "Is anyone reading?")).toHaveClass(/\bunread\b/);
    await expect(dot(page, "Is anyone reading?")).toBeVisible();
  }

  // Alice opens it and moves on: it stays read for her, and Bob has still not read it.
  await row(alice, "Is anyone reading?").click();
  await expect(alice.locator(".log")).toContainText("Is anyone reading?");
  await row(alice, "Another question").click();
  await expect(row(alice, "Is anyone reading?")).not.toHaveClass(/\bunread\b/);
  await expect(dot(alice, "Is anyone reading?")).toHaveCount(0);
  await alice.reload();
  await expect(row(alice, "Another question")).toBeVisible();
  await expect(row(alice, "Is anyone reading?")).not.toHaveClass(/\bunread\b/);
  await expect(dot(bob, "Is anyone reading?")).toBeVisible();

  // The visitor writes again, so it is unread again.
  await say(customer, "Hello again");
  await expect(dot(alice, "Hello again")).toBeVisible();

  for (const page of [customer, other, alice, bob]) await page.context().close();
});
