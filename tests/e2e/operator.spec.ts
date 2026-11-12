import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { inboxFilter } from "./filters.ts";
import { openLink, signedIn, signOut } from "./links.ts";
import { openSettings } from "./settings.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/plain": { html: `<!doctype html><title>Host</title><h1>Host</h1>${SNIPPET}` },
  });
  await server.createOperator("anna@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function visitor(browser: Browser, text: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.hostOrigin}/plain`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await page.getByRole("textbox", { name: "Your message" }).fill(text);
  await page.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
  return page;
}

const row = (page: Page, text: string) => page.locator(".row", { hasText: text });
const reply = (page: Page) => page.getByRole("textbox", { name: "Your reply" });

/** Runs an action from the conversation's "…" menu. */
async function moreAction(page: Page, name: string) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

function setVisibility(page: Page, state: "hidden" | "visible") {
  return page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { get: () => value, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("a full conversation between the widget and the operator app @smoke", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  const errors: string[] = [];
  operator.on("pageerror", (error) => errors.push(error.message));
  operator.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) {
      errors.push(message.text());
    }
  });

  // The new conversation appears with no reload.
  const widget = await visitor(browser, "The import stops at 40%.");
  await row(operator, "The import stops at 40%.").click();
  await expect(operator.locator(".msg.visitor", { hasText: "40%" })).toBeVisible();

  // The reply reaches the visitor at once.
  await reply(operator).fill("Thanks, I am looking.");
  await reply(operator).press("Enter");
  await expect(
    widget.locator(".msg:not(.mine)", { hasText: "Thanks, I am looking." }),
  ).toBeVisible();

  // A later message from the visitor reaches the open thread.
  await widget.getByRole("textbox", { name: "Your message" }).fill("It also fails on Tuesday.");
  await widget.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(operator.locator(".msg.visitor", { hasText: "Tuesday" })).toBeVisible();

  // Close, then reopen.
  await operator.getByRole("button", { name: "Close", exact: true }).click();
  await expect(operator.getByText("This conversation is closed.")).toBeVisible();
  await expect(reply(operator)).toHaveCount(0);
  await (await inboxFilter(operator, "Closed")).click();
  await expect(row(operator, "Tuesday")).toBeVisible();
  await operator.getByRole("button", { name: "Reopen" }).click();
  await expect(reply(operator)).toBeVisible();

  expect(errors).toEqual([]);
});

test("a message in another conversation does not reload the open thread", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  const open = await visitor(browser, "The open one");
  await row(operator, "The open one").click();
  await expect(operator.locator(".msg.visitor", { hasText: "The open one" })).toBeVisible();
  const threadLoads: string[] = [];
  operator.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && /\/conversations\/[0-9a-f-]{36}\/messages$/.test(path)) {
      threadLoads.push(path);
    }
  });
  const other = await visitor(browser, "Somebody else");
  await expect(row(operator, "Somebody else")).toBeVisible();
  expect(threadLoads).toEqual([]);

  // Its own conversation's message still loads it once.
  await open.getByRole("textbox", { name: "Your message" }).fill("Still here");
  await open.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(operator.locator(".msg.visitor", { hasText: "Still here" })).toBeVisible();
  expect(threadLoads.length).toBeGreaterThan(0);
  for (const page of [operator, open, other]) await page.context().close();
});

test("the reply shows its formatting, typed or pasted as Markdown, and sends Markdown", async ({
  browser,
}) => {
  const customer = await visitor(browser, "Format my answer");
  const page = await signedIn(browser, server, "anna@example.com");
  await row(page, "Format my answer").click();
  const field = reply(page);
  await field.pressSequentially("Click **Send transfer** now");
  await expect(field.locator("strong")).toHaveText("Send transfer");
  await expect(field).toHaveText("Click Send transfer now");
  await field.press("Enter");
  await expect(customer.locator(".msg:not(.mine) strong")).toHaveText("Send transfer");
  await expect(field).toHaveText("");

  await field.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "1. Pay the **open** invoice\n2. Download your *past* invoices");
    // A plain event, because Firefox ignores clipboardData in the ClipboardEvent constructor.
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  });
  await expect(field.locator("ol li")).toHaveCount(2);
  await expect(field.locator("ol strong")).toHaveText("open");
  await field.press("Enter");
  await expect(customer.locator(".msg:not(.mine) ol em", { hasText: "past" })).toBeVisible();

  // The link field links the selected words, Shift+Enter starts a line, and Code formats it.
  await field.pressSequentially("Read the docs");
  for (const _ of "docs") await field.press("Shift+ArrowLeft");
  await page.getByRole("button", { name: /^Link/ }).click();
  await page.getByRole("textbox", { name: "Link address" }).fill("dinghy.chat/docs");
  await page.locator(".link-field").getByRole("button", { name: "Save" }).click();
  await expect(field.locator('a[href="https://dinghy.chat/docs"]')).toHaveText("docs");
  // Save puts the caret after the link, in the text again, and words typed there stay out of it.
  await expect(field).toBeFocused();
  await field.pressSequentially(" now");
  await expect(field.locator("a")).toHaveText("docs");
  await field.press("Shift+Enter");
  await field.pressSequentially("npm i");
  for (const _ of "npm i") await field.press("Shift+ArrowLeft");
  await page.getByRole("button", { name: /^Code/ }).click();
  await expect(field.locator("p code")).toHaveText("npm i");
  await field.press("Enter");
  const sent = customer.locator(".msg:not(.mine)", { hasText: "Read the docs now" });
  await expect(sent.locator('a[href="https://dinghy.chat/docs"]')).toHaveText("docs");
  await expect(sent.locator("code")).toHaveText("npm i");
  await customer.context().close();
  await page.context().close();
});

test("a draft survives closing and reopening the conversation", async ({ browser }) => {
  const customer = await visitor(browser, "Keep my draft");
  const page = await signedIn(browser, server, "anna@example.com");
  await page.locator(".row", { hasText: "Keep my draft" }).click();
  const reply = page.getByRole("textbox", { name: "Your reply" });
  await reply.fill("Half a sentence");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(reply).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(reply).toHaveText("Half a sentence");
  await customer.context().close();
  await page.context().close();
});

test("messages that arrive together all reach the open thread", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await visitor(browser, "Start of a burst");
  await row(operator, "Start of a burst").click();
  await expect(reply(operator)).toBeVisible();
  await server.visitorBurst(["Burst one", "Burst two", "Burst three"]);
  await expect(operator.locator(".msg.visitor")).toHaveText([
    "Start of a burst",
    "Burst one",
    "Burst two",
    "Burst three",
  ]);
});

test("a refused stream waits for Retry-After before it tries again", async ({ browser }) => {
  const context = await browser.newContext();
  const tries: number[] = [];
  await context.route("**/stream*", async (route) => {
    tries.push(Date.now());
    if (tries.length > 1) return route.continue().catch(() => {});
    // As the server answers when it holds too many streams. The backoff would try again in 1 second.
    return route.fulfill({
      status: 429,
      headers: { "retry-after": "3" },
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "too_many_requests", message: "Busy." } }),
    });
  });
  const page = await context.newPage();
  await openLink(page, await server.signInLink("anna@example.com"));
  await expect.poll(() => tries.length, { timeout: 8000 }).toBe(2);
  expect((tries[1] ?? 0) - (tries[0] ?? 0)).toBeGreaterThanOrEqual(2900);
  await context.close();
});

test("a steady stream of events does not keep a thread from loading", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await visitor(browser, "Busy workspace");
  // The list must show this conversation first, or the click below could pick an older one.
  await expect(operator.locator(".row").first()).toContainText("Busy workspace");
  // Every load takes longer than the gap between events.
  await operator.route("**/messages?after=*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue().catch(() => {});
  });
  let running = true;
  const traffic = (async () => {
    while (running) {
      await server.visitorBurst(["More traffic"]);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  })();
  try {
    // The newest activity is first. The traffic changes this row's text, so it has no fixed name.
    await operator.locator(".row").first().click();
    await expect(operator.locator(".msg.visitor", { hasText: "Busy workspace" })).toBeVisible();
  } finally {
    running = false;
    await traffic;
  }
});

test("a slow response cannot fill the wrong tab", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await visitor(browser, "An open conversation");
  await expect(row(operator, "An open conversation")).toBeVisible();
  let releaseOpen = () => {};
  const heldOpen = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  let releaseClosed = () => {};
  const heldClosed = new Promise<void>((resolve) => {
    releaseClosed = resolve;
  });
  await operator.route("**/conversations?status=open*", async (route) => {
    const response = await route.fetch();
    await heldOpen;
    await route.fulfill({ response }).catch(() => {});
  });
  await operator.route("**/conversations?status=closed*", async (route) => {
    const response = await route.fetch();
    await heldClosed;
    await route.fulfill({ response }).catch(() => {});
  });
  await operator.reload();
  await (await inboxFilter(operator, "Closed")).click();
  // The open response arrives while the Closed tab is showing, and its own is still on its way.
  releaseOpen();
  await operator.waitForTimeout(200);
  await expect(row(operator, "An open conversation")).toHaveCount(0);
  releaseClosed();
  await expect(operator.getByText("No closed conversations.")).toBeVisible();
});

test("an operator can reach conversations past the first page", async ({ browser }) => {
  await server.seedConversations(55, "paged");
  const operator = await signedIn(browser, server, "anna@example.com");
  await expect(row(operator, "paged message 54")).toBeVisible();
  await expect(row(operator, "paged message 0")).toHaveCount(0);
  await operator.getByRole("button", { name: "Load more" }).click();
  await expect(row(operator, "paged message 0")).toBeVisible();
  await server.closeConversations();
});

test("a refresh keeps the session and the conversations", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await visitor(browser, "Still here after a refresh");
  await expect(row(operator, "Still here after a refresh")).toBeVisible();
  await operator.reload();
  await expect(row(operator, "Still here after a refresh")).toBeVisible();
});

test("an operator who was disconnected catches up", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await visitor(browser, "Before the disconnect");
  await row(operator, "Before the disconnect").click();
  await expect(reply(operator)).toBeVisible();

  const dropped = operator.waitForEvent("requestfailed", (r) => r.url().includes("/stream"));
  await setVisibility(operator, "hidden");
  await dropped;
  await visitor(browser, "Sent during the disconnect");
  await server.closeConversations();
  await operator.waitForTimeout(200);
  await expect(row(operator, "Sent during the disconnect")).toHaveCount(0);

  await setVisibility(operator, "visible");
  // The close arrives too: the open thread now refuses a reply.
  await expect(operator.getByText("This conversation is closed.")).toBeVisible();
});

test("a revoked session returns to the sign-in page", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await visitor(browser, "Before the revoke");
  await server.revokeSessions();
  // The next wake checks the session again.
  await visitor(browser, "After the revoke");
  await expect(operator.getByRole("heading", { name: "Sign in to Dinghy" })).toBeVisible();
});

test("signing out returns to the sign-in page, and a reload stays there", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await signOut(operator);
  await expect(operator.getByRole("heading", { name: "Sign in to Dinghy" })).toBeVisible();
  await operator.reload();
  await expect(operator.getByRole("heading", { name: "Sign in to Dinghy" })).toBeVisible();
});

test("the sign-in page sends a link, and the answer is the same for an unknown email", async ({
  browser,
}) => {
  // New addresses each run, because the link limit lives in Valkey and outlasts the database.
  const known = `known-${crypto.randomUUID()}@example.com`;
  const unknown = `unknown-${crypto.randomUUID()}@example.com`;
  await server.createOperator(known);
  const answers: string[] = [];
  for (const email of [known, unknown]) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(server.apiOrigin);
    await expect(page.getByLabel(/password/i)).toHaveCount(0);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    answers.push(((await page.getByRole("status").textContent()) ?? "").replace(email, "{email}"));
    await page.context().close();
  }
  expect(answers[0]).toBe(answers[1]);
  expect(answers[0]).toContain("If {email} has an account, we'll send a sign-in link.");

  const page = await (await browser.newContext()).newPage();
  await openLink(page, await server.linkTo(known));
  await expect(page.getByRole("heading", { name: "E2E", exact: true })).toBeVisible();
  expect(server.mail.filter((one) => one.to === unknown)).toEqual([]);
  await page.context().close();
});

test("opening a link uses nothing: only its page's button signs in", async ({ browser }) => {
  const link = await server.signInLink("anna@example.com");
  // A mail scanner fetches the link, and a person may open it twice. Neither uses it up.
  const scanner = await (await browser.newContext()).newPage();
  await scanner.goto(link);
  await expect(scanner.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await scanner.reload();
  await expect(scanner.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  const page = await (await browser.newContext()).newPage();
  await openLink(page, link);
  await expect(page.getByRole("heading", { name: "E2E", exact: true })).toBeVisible();
  for (const one of [scanner, page]) await one.context().close();
});

test("a used link says so, with a way to ask for a new one", async ({ browser }) => {
  const link = await server.signInLink("anna@example.com");
  const first = await (await browser.newContext()).newPage();
  await openLink(first, link);
  await expect(first.getByRole("heading", { name: "E2E", exact: true })).toBeVisible();
  const page = await (await browser.newContext()).newPage();
  await openLink(page, link);
  await expect(page.getByRole("alert")).toHaveText(
    "That link has expired or was already used. Ask for a new one.",
  );
  await page.getByRole("link", { name: "Get a new link" }).click();
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  for (const one of [first, page]) await one.context().close();
});

test("with no mail server, the sign-in page says to ask the admin for a link", async ({
  browser,
}) => {
  const quiet = await startE2EServer({}, { mail: false });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(quiet.apiOrigin);
    await expect(page.getByRole("heading", { name: "Sign in to Dinghy" })).toBeVisible();
    await expect(
      page.getByText("Ask the server administrator to create a sign-in link", { exact: false }),
    ).toBeVisible();
    // The command is for the server's admin, so the docs name it, and the page links there.
    await expect(page.getByRole("link", { name: "If no sign-in link arrives" })).toHaveAttribute(
      "href",
      "https://dinghy.chat/docs/operator-guide#if-no-sign-in-link-arrives",
    );
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await page.context().close();
  } finally {
    await quiet.stop();
  }
});

test("on a phone, the list and the thread take turns", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await operator.setViewportSize({ width: 390, height: 780 });
  await visitor(browser, "From a phone test");
  await row(operator, "From a phone test").click();
  await expect(reply(operator)).toBeVisible();
  await expect(row(operator, "From a phone test")).toBeHidden();
  await operator.getByRole("button", { name: "Back" }).click();
  await expect(row(operator, "From a phone test")).toBeVisible();
  const overflow = await operator.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("on a phone, the sections sit in a tab bar and the formats wait behind Aa", async ({
  browser,
}) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await operator.setViewportSize({ width: 390, height: 844 });
  await visitor(browser, "Tab bar test");
  const tabs = operator.getByRole("navigation", { name: "Main menu" });
  const box = await tabs.boundingBox();
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
  await tabs.getByRole("button", { name: "Contacts" }).click();
  await expect(operator.getByRole("heading", { name: "Contacts" })).toBeVisible();
  await tabs.getByRole("button", { name: "Inbox" }).click();

  // A thread has its own Back, so the tab bar goes, and the reply takes one row.
  await row(operator, "Tab bar test").click();
  await expect(tabs).toBeHidden();
  const send = await operator.getByRole("button", { name: "Send" }).boundingBox();
  const field = await reply(operator).boundingBox();
  expect(Math.abs((send?.y ?? 0) - (field?.y ?? 0))).toBeLessThan(10);
  const bold = operator.getByRole("button", { name: /^Bold/ });
  await expect(bold).toBeHidden();
  const formats = operator.getByRole("button", { name: "Formatting" });
  await formats.click();
  await expect(formats).toHaveAttribute("aria-pressed", "true");
  await reply(operator).fill("Phone");
  await reply(operator).selectText();
  await bold.click();
  await expect(reply(operator).locator("strong")).toHaveText("Phone");
  const overflow = await operator.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("a site that is not allowed shows Not sent, never the text for a block", async ({
  browser,
}) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  const widget = await visitor(browser, "Before the change");
  await openSettings(operator, "Install");
  const original = (await operator.locator(".site-card").textContent()) ?? "";
  const swap = async (from: string, to: string) => {
    await operator.getByRole("button", { name: "Add a site" }).click();
    await operator.getByRole("textbox", { name: "Website address" }).fill(to);
    await operator.getByRole("button", { name: "Add", exact: true }).click();
    await expect(operator.locator(".toast")).toHaveText("Site added.");
    await operator.getByRole("button", { name: `Remove ${from}` }).click();
    await expect(operator.locator(".toast")).toHaveText("Site removed.");
    await expect(operator.locator(".site-card")).toHaveText([to]);
  };
  await swap(original, "https://elsewhere.example.com");

  // The refusal carries no CORS headers, so the browser hides it, and the send reads as failed.
  await widget.getByRole("textbox", { name: "Your message" }).fill("After the change");
  await widget.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(
    widget.getByRole("button", { name: "Not sent. Select to try again." }),
  ).toBeVisible();
  await expect(widget.getByRole("alert")).toHaveCount(0);

  await swap("https://elsewhere.example.com", original);
});

test("an operator blocks a visitor, who then sees why they cannot send", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  const widget = await visitor(browser, "Please block me");
  await row(operator, "Please block me").click();
  await moreAction(operator, "Block");
  await expect(operator.getByText("This visitor is blocked")).toBeVisible();

  await widget.getByRole("textbox", { name: "Your message" }).fill("Still here");
  await widget.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(widget.getByRole("alert")).toHaveText("You cannot send messages in this chat.");

  // Clearing the browser does not help.
  await widget.evaluate(() => localStorage.clear());
  await widget.reload();
  await widget.getByRole("button", { name: "Open chat" }).click();
  await widget.getByRole("textbox", { name: "Your message" }).fill("A new start");
  await widget.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(widget.getByRole("alert")).toHaveText("You cannot send messages in this chat.");

  // The settings list the block too, for a visitor whose conversation is gone.
  await openSettings(operator, "Workspace");
  await expect(operator.getByText("Blocked visitors")).toBeVisible();
  await operator.getByRole("button", { name: "Inbox", exact: true }).click();

  await moreAction(operator, "Unblock");
  await expect(operator.getByText("This visitor is blocked")).toHaveCount(0);

  // A send that works ends the warning.
  await widget.getByRole("textbox", { name: "Your message" }).fill("Thanks for unblocking");
  await widget.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(widget.locator(".msg.mine", { hasText: "Thanks for unblocking" })).toBeVisible();
  await expect(widget.getByRole("alert")).toHaveCount(0);
});

test("a block shows in another open thread of the same visitor", async ({ browser }) => {
  const first = await signedIn(browser, server, "anna@example.com");
  const widget = await visitor(browser, "My first visit");
  await row(first, "My first visit").click();
  await first.getByRole("button", { name: "Close", exact: true }).click();
  await expect(first.getByText("This conversation is closed.")).toBeVisible();
  // The visitor writes again, which starts a second conversation.
  await widget.getByRole("textbox", { name: "Your message" }).fill("My second visit");
  await widget.getByRole("textbox", { name: "Your message" }).press("Enter");

  const second = await signedIn(browser, server, "anna@example.com");
  await row(second, "My second visit").click();
  await moreAction(second, "Block");
  await expect(second.getByText("This visitor is blocked")).toBeVisible();
  // The first operator still has the closed conversation open, and sees the block there too.
  await expect(first.getByText("This visitor is blocked")).toBeVisible();
  await moreAction(first, "Unblock");
  await expect(second.getByText("This visitor is blocked")).toHaveCount(0);
});

test("clicking Load more twice in the blocked list still reaches every visitor", async ({
  browser,
}) => {
  await server.blockVisitors(120);
  const operator = await signedIn(browser, server, "anna@example.com");
  await openSettings(operator, "Workspace");
  const rows = operator.locator(".page .item-list li", { hasText: "Blocked " });
  await expect(rows).toHaveCount(50);
  const more = operator.locator(".page").getByRole("button", { name: "Load more" });
  await more.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect(rows).toHaveCount(100);
  await more.click();
  await expect(rows).toHaveCount(120);
  await expect(more).toHaveCount(0);
  await server.unblockVisitors();
});

test("an owner deletes a conversation, and the list and the thread go too", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await visitor(browser, "Please delete this");
  await row(operator, "Please delete this").click();
  await moreAction(operator, "Delete");
  await expect(operator.getByRole("alertdialog")).toContainText("for good");
  // Canceling changes nothing.
  await operator.getByRole("button", { name: "Cancel" }).click();
  await expect(operator.getByRole("alertdialog")).toHaveCount(0);
  await expect(row(operator, "Please delete this")).toBeVisible();

  await moreAction(operator, "Delete");
  await operator.getByRole("button", { name: "Delete it" }).click();
  await expect(row(operator, "Please delete this")).toHaveCount(0);
  await expect(reply(operator)).toHaveCount(0);
});

test("each emailed link's page says what it is for", async ({ page }) => {
  const pages: [string, string, string][] = [
    ["sign-in", "Welcome back", "Sign in"],
    ["signup", "Welcome to Dinghy", "Get started"],
    ["add-workspace", "Welcome back", "Sign in"],
    ["join", "Join your team", "Join the team"],
  ];
  for (const [purpose, heading, button] of pages) {
    await page.goto(`${server.apiOrigin}/link?for=${purpose}&token=unused`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText("Continue to sign in with this browser.")).toBeVisible();
    await expect(page.getByRole("button", { name: button, exact: true })).toBeVisible();
    // The link page is midday in the account screens' day.
    await expect(page.locator(".scene")).toHaveClass(/\bnoon\b/);
  }
  await expect(page.getByText("One more step")).toHaveCount(0);
});

test("the account screens move from morning to mid-morning, with text for the scene", async ({
  browser,
}) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(server.apiOrigin);
  const scene = page.locator(".scene");
  await expect(scene).toHaveClass(/\bmorning\b/);
  await expect(page.getByText("Early morning. The boat sets out on a calm sea.")).toBeAttached();
  await page.getByLabel("Email").fill("anna@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(scene).toHaveClass(/\bforenoon\b/);
  await expect(page.getByText("Mid-morning. The boat sails on.")).toBeAttached();
  await page.context().close();
});

test("a sign-in link opens the inbox in place, with no page load", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(await server.signInLink("anna@example.com"));
  // A full page load would lose this.
  await page.evaluate(() => {
    Object.assign(window, { stayed: true });
  });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E", exact: true })).toBeVisible();
  expect(await page.evaluate(() => "stayed" in window)).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/");
  await page.context().close();
});

test("the assignee dropdown works with the keyboard", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await visitor(browser, "Keyboard assignment");
  await row(operator, "Keyboard assignment").click();
  const button = operator.getByRole("button", { name: /^Who answers/ });
  await expect(button).toHaveAttribute("aria-haspopup", "listbox");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.focus();
  await operator.keyboard.press("ArrowDown");
  const list = operator.getByRole("listbox", { name: "Who answers" });
  await expect(list).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(list.getByRole("option", { name: /^Unassigned/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Escape closes it, and the focus goes back to the button.
  await operator.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(button).toBeFocused();

  // End moves to the last choice, Home back to the first, and typing jumps to a name.
  await operator.keyboard.press("Enter");
  await operator.keyboard.press("End");
  const last = list.getByRole("option").last();
  await expect(list).toHaveAttribute(
    "aria-activedescendant",
    (await last.getAttribute("id")) ?? "",
  );
  await operator.keyboard.press("Home");
  // A capital letter jumps too.
  await operator.keyboard.press("Shift+A");
  const anna = list.getByRole("option", { name: "anna@example.com" });
  await expect(list).toHaveAttribute(
    "aria-activedescendant",
    (await anna.getAttribute("id")) ?? "",
  );
  await operator.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toContainText("anna@example.com");
  await expect(
    row(operator, "Keyboard assignment").getByRole("img", { name: "anna@example.com" }),
  ).toBeVisible();

  // A click outside closes it with no change.
  await button.click();
  await expect(list).toBeVisible();
  await operator.locator(".log").click();
  await expect(list).toHaveCount(0);
  await expect(button).toContainText("anna@example.com");
});

test("the … menu blocks with the keyboard too", async ({ browser }) => {
  const operator = await signedIn(browser, server, "anna@example.com");
  await visitor(browser, "Menu by keyboard");
  await row(operator, "Menu by keyboard").click();
  const more = operator.getByRole("button", { name: "More actions" });
  await more.focus();
  await operator.keyboard.press("Enter");
  const menu = operator.getByRole("menu", { name: "More actions" });
  await expect(menu).toBeFocused();
  // Send transcript says why it is unavailable: this visitor gave no email.
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Block",
    "Send transcriptThe visitor gave no email",
    "Delete",
  ]);
  await operator.keyboard.press("Enter");
  await expect(operator.getByText("This visitor is blocked")).toBeVisible();
  await expect(more).toBeFocused();
  await moreAction(operator, "Unblock");
  await expect(operator.getByText("This visitor is blocked")).toHaveCount(0);
});

test("the install code is one colored line, and a webhook's events are checkboxes", async ({
  browser,
}) => {
  const page = await signedIn(browser, server, "anna@example.com");
  await openSettings(page, "Install");
  // The install code's row: the agent prompt above it has code blocks of its own.
  const code = page
    .locator(".page-row", { has: page.getByRole("heading", { name: "Install by hand" }) })
    .locator(".code-block code");
  await expect(code).toHaveText(
    /^<script src="[^"]+\/widget\/loader\.js" data-key="wk_[^"]+" async><\/script>$/,
  );
  await expect(code.locator(".code-attr")).toHaveText(["src", "data-key", "async"]);

  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "API & webhooks" })
    .click();
  const add = page.getByRole("button", { name: "Add webhook" });
  const events = page.getByRole("group", { name: "Send an update when" }).getByRole("checkbox");
  // The form shows only once asked for, and Cancel puts it away.
  await expect(events).toHaveCount(0);
  await page.getByRole("button", { name: "New webhook" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(events).toHaveCount(0);
  await page.getByRole("button", { name: "New webhook" }).click();
  await expect(events).toHaveCount(9);
  await expect(
    page.getByRole("checkbox", { name: /A message is sent\s*message\.created/ }),
  ).toBeChecked();
  await expect(add).toBeDisabled();
  const url = "https://hooks.example.com/dinghy/with/a/rather/long/path/for/the/row";
  await page.getByRole("textbox", { name: "Webhook URL" }).fill(url);
  for (const box of await events.all()) await box.uncheck();
  await expect(add).toBeDisabled();
  await events.nth(1).check();
  await events.nth(2).check();
  await events.nth(3).check();
  await add.click();
  const hook = page.locator(".hook", { hasText: url });
  await expect(hook.locator(".item-name")).toHaveAttribute("title", url);
  await expect(hook).toContainText("3 events");
  await expect(page.getByRole("checkbox", { name: `Send events to ${url}` })).toBeChecked();
  // Once added, the form closes.
  await expect(events).toHaveCount(0);
});
