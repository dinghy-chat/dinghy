import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/": { html: `<!doctype html><title>Host</title><h1>Shop</h1>${SNIPPET}` },
  });
  await server.createOperator("alice@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

test.beforeEach(async () => {
  await server.closeConversations();
});

async function visitor(browser: Browser, text: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.hostOrigin}/`);
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

/** Opens the "…" beside the operator app's bubble that holds this text, and picks an item. */
async function messageAction(page: Page, text: string, item: string, row = ".bubble-row") {
  const bubble = page.locator(row, { hasText: text });
  await bubble.hover();
  await bubble.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("an operator quotes the visitor, and the visitor quotes the operator back", async ({
  browser,
}) => {
  const customer = await visitor(browser, "Do you ship to **Canada**?");
  const alice = await signedIn(browser, server, "alice@example.com");
  await alice.locator(".row", { hasText: "Do you ship to" }).click();

  await messageAction(alice, "Do you ship to", "Reply");
  const chip = alice.locator(".quote-chip");
  await expect(chip).toContainText(/Replying to Visitor/);
  await expect(chip).toContainText("Do you ship to Canada?");
  await answer(alice, "Yes, in 5 days.");
  await expect(chip).toHaveCount(0);
  const sent = alice.locator(".bubble-row", { hasText: "Yes, in 5 days." });
  await expect(sent.locator(".quote")).toContainText("Do you ship to Canada?");

  // The widget shows the quote too, with the visitor's own message as "You".
  const reply = customer.locator(".msg:not(.mine)", { hasText: "Yes, in 5 days." });
  await expect(reply.locator(".quote")).toHaveText("YouDo you ship to Canada?");

  // The visitor answers with a quote of the reply.
  await reply.hover();
  await reply.getByRole("button", { name: "Reply" }).click();
  await expect(customer.locator(".chip")).toContainText("Yes, in 5 days.");
  await say(customer, "Great, thanks!");
  await expect(customer.locator(".chip")).toHaveCount(0);
  await expect(
    customer.locator(".msg.mine", { hasText: "Great, thanks!" }).locator(".quote"),
  ).toContainText("Yes, in 5 days.");

  const thanks = alice.locator(".bubble-row.visitor", { hasText: "Great, thanks!" });
  await expect(thanks.locator(".quote")).toContainText("alice@example.com");
  await expect(thanks.locator(".quote")).toContainText("Yes, in 5 days.");

  for (const page of [customer, alice]) await page.context().close();
});

test("Escape drops the quote, and a click on a quote shows the original", async ({ browser }) => {
  const customer = await visitor(browser, "The first question");
  const alice = await signedIn(browser, server, "alice@example.com");
  await alice.locator(".row", { hasText: "The first question" }).click();

  await messageAction(alice, "The first question", "Reply");
  await alice.getByRole("textbox", { name: "Your reply" }).press("Escape");
  await expect(alice.locator(".quote-chip")).toHaveCount(0);

  // Enough lines that the first one scrolls out of view.
  for (let n = 1; n <= 12; n += 1) await answer(alice, `Line ${n}\n\nwith room`);
  await messageAction(alice, "The first question", "Reply");
  await answer(alice, "About your first question");
  const original = alice.locator(".bubble-row.visitor", { hasText: "The first question" });
  await expect(original).not.toBeInViewport();

  await alice
    .locator(".bubble-row", { hasText: "About your first question" })
    .getByRole("button", { name: /Go to the message/ })
    .click();
  await expect(original).toBeInViewport();
  await expect(original).toHaveClass(/flash/);

  for (const page of [customer, alice]) await page.context().close();
});

test("an operator edits a reply before the visitor sees it, and deletes a message", async ({
  browser,
}) => {
  const customer = await visitor(browser, "My card is 4242 4242 4242 4242");
  // The visitor leaves, so the next reply stays unread and can still change.
  await customer.context().close();
  const alice = await signedIn(browser, server, "alice@example.com");
  await alice.locator(".row", { hasText: "My card is" }).click();
  await answer(alice, "Plese never send that here.");

  await messageAction(alice, "Plese never", "Edit");
  const editor = alice.getByRole("textbox", { name: "Edit your reply" });
  await editor.fill("Please never send that here.");
  await editor.press("Enter");
  const edited = alice.locator(".bubble-row", { hasText: "Please never send that here." });
  await expect(edited).toBeVisible();
  await expect(alice.locator(".log .meta", { hasText: "edited" })).toBeVisible();

  await messageAction(alice, "My card is", "Delete");
  await alice.getByRole("button", { name: "Delete message" }).click();
  await expect(alice.locator(".msg.removed", { hasText: "Message deleted" })).toBeVisible();
  await expect(alice.locator(".log")).not.toContainText("4242");

  await alice.context().close();
});

test("a deleted message leaves its quotes at once, in the widget's live chat", async ({
  browser,
}) => {
  const customer = await visitor(browser, "My password is hunter2");
  const alice = await signedIn(browser, server, "alice@example.com");
  await alice.locator(".row", { hasText: "My password is" }).click();
  await messageAction(alice, "My password is", "Reply");
  await answer(alice, "Please change it now.");
  const reply = customer.locator(".msg:not(.mine)", { hasText: "Please change it now." });
  await expect(reply.locator(".quote")).toHaveText("YouMy password is hunter2");

  await messageAction(alice, "My password is", "Delete", ".bubble-row.visitor");
  await alice.getByRole("button", { name: "Delete message" }).click();
  // The open chat gets the delete from its stream, and the quote changes with it, with no reload.
  await expect(reply.locator(".quote")).toHaveText("YouOriginal message deleted");
  await expect(customer.locator(".log")).not.toContainText("hunter2");
  const quoted = alice.locator(".bubble-row", { hasText: "Please change it now." });
  await expect(quoted.locator(".quote")).toContainText("Original message deleted");

  for (const page of [customer, alice]) await page.context().close();
});

test("an edit that fails keeps the editor and its text, with the reason", async ({ browser }) => {
  const customer = await visitor(browser, "Where is my parcel?");
  await customer.getByRole("button", { name: "Close chat" }).click();
  const alice = await signedIn(browser, server, "alice@example.com");
  await alice.locator(".row", { hasText: "Where is my parcel?" }).click();
  await answer(alice, "It left on Monday.");

  await messageAction(alice, "It left on Monday.", "Edit");
  const editor = alice.getByRole("textbox", { name: "Edit your reply" });
  await editor.fill("It left on Tuesday.");
  // The visitor reads the reply while the operator edits it, so the save is refused.
  await customer.getByRole("button", { name: "Open chat" }).click();
  await expect(alice.locator(".receipt", { hasText: "Read in chat" })).toBeVisible();
  await editor.press("Enter");
  await expect(alice.locator(".compose.editing [role=alert]")).toBeVisible();
  await expect(editor).toHaveValue("It left on Tuesday.");

  for (const page of [customer, alice]) await page.context().close();
});

test("a deleted reply leaves the widget's unread count", async ({ browser }) => {
  const customer = await visitor(browser, "Is anyone there?");
  await customer.getByRole("button", { name: "Close chat" }).click();
  const alice = await signedIn(browser, server, "alice@example.com");
  await alice.locator(".row", { hasText: "Is anyone there?" }).click();
  await answer(alice, "Yes, hello!");
  await answer(alice, "Wrong chat, sorry.");
  const badge = customer.locator(".launcher .badge");
  await expect(badge).toHaveText("2");
  await messageAction(alice, "Wrong chat, sorry.", "Delete");
  await alice.getByRole("button", { name: "Delete message" }).click();
  await expect(badge).toHaveText("1");

  for (const page of [customer, alice]) await page.context().close();
});
