import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn } from "./links.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({ "/": { html: "<!doctype html><title>Host</title>" } });
  await server.createOperator("alice@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

test.beforeEach(async () => {
  await server.closeConversations();
});

const space = () => `${server.apiOrigin}/v1/operator/workspaces/${server.workspace.id}`;

/** A request as the signed-in operator, from the app's own origin. */
async function asOperator(page: Page, path: string, data: unknown) {
  const response = await page.request.post(`${space()}${path}`, {
    data,
    headers: { origin: server.apiOrigin },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

/** A bot that answers chats. New keys write drafts. */
async function newBot(page: Page, name: string): Promise<string> {
  const key = (await asOperator(page, "/api-keys", { name, level: "conversations" })) as {
    token: string;
  };
  return key.token;
}

/** A request as a bot's key. */
async function asBot(page: Page, token: string, path: string, data: unknown) {
  const response = await page.request.post(`${space()}${path}`, {
    data,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBe(true);
}

/** A test visitor writes, and the conversation's ID comes back. */
async function testVisitorSays(page: Page, body: string, conversationId?: string) {
  const sent = (await asOperator(page, "/test-visitors/messages", {
    body,
    name: "Tess Test",
    conversationId,
  })) as { conversationId: string };
  return sent.conversationId;
}

/** The one dropdown that says and picks who answers the open conversation. */
const handlerButton = (page: Page) => page.getByRole("button", { name: /^Who answers/ });

let clientIds = 0;
function draft(page: Page, token: string, conversationId: string, body: string) {
  clientIds += 1;
  return asBot(page, token, `/conversations/${conversationId}/messages`, {
    clientId: `draft-${clientIds}`,
    body,
  });
}

test("an operator sends, edits and discards a bot's suggested replies", async ({ browser }) => {
  const alice = await signedIn(browser, server, "alice@example.com");
  const token = await newBot(alice, "Support bot");
  const chat = await testVisitorSays(alice, "Where is my order?");
  await draft(alice, token, chat, "It ships **today**.");

  const row = alice.locator(".row", { hasText: "Where is my order?" });
  await expect(row.locator(".chip.test")).toHaveText("Test");
  await row.click();
  const card = alice.locator(".sugg");
  await expect(card).toContainText("Suggested by Support bot");
  await expect(card).toContainText("Not sent. Tess can't see this yet.");
  await expect(card.locator("strong", { hasText: "today" })).toBeVisible();
  // The row's mark and the dropdown name the same handler, from the server.
  await expect(handlerButton(alice)).toContainText("Support bot");
  await expect(row.getByRole("img", { name: "Support bot" })).toBeVisible();

  await card.getByRole("button", { name: "Send" }).click();
  await expect(alice.locator(".bubble-row", { hasText: "It ships today." })).toBeVisible();
  await expect(card).toHaveCount(0);

  // A visitor message after a draft makes it stale, live: it waits behind a button, and Send asks.
  await draft(alice, token, chat, "Anything else?");
  await expect(card).toContainText("Anything else?");
  await testVisitorSays(alice, "Hello?", chat);
  const older = alice.getByRole("button", { name: "1 older suggestion" });
  await expect(older).toHaveAttribute("aria-expanded", "false");
  await expect(card).toHaveCount(0);
  await expect(older).toContainText("Tess sent a new message.");
  await older.click();
  await expect(card).toContainText("Written before the last message");
  await card.getByRole("button", { name: "Send" }).click();
  await expect(card).toContainText("New messages came after this. Send it anyway?");
  await card.getByRole("button", { name: "Cancel" }).click();

  // Edit puts the text in the box, and sending it sends the draft.
  await card.getByRole("button", { name: "Edit" }).click();
  const box = alice.getByRole("textbox", { name: "Your reply" });
  await expect(box).toHaveText("Anything else?");
  await expect(alice.locator(".quote-chip")).toContainText("Editing Support bot's suggestion");
  await box.fill("Anything else I can help with?");
  await box.press("Enter");
  await expect(
    alice.locator(".bubble-row", { hasText: "Anything else I can help with?" }),
  ).toBeVisible();
  await expect(card).toHaveCount(0);

  await draft(alice, token, chat, "Bye for now");
  await card.getByRole("button", { name: "Discard" }).click();
  await expect(card).toHaveCount(0);
  await expect(alice.locator(".bubble-row", { hasText: "Bye for now" })).toHaveCount(0);

  // Two open drafts show oldest first, and a long one shows all of its text when asked.
  await draft(alice, token, chat, "Short one");
  await draft(alice, token, chat, "Line one\n\nLine two\n\nLine three\n\nThe last line");
  await expect(card).toHaveCount(2);
  await expect(card.first()).toContainText("Short one");
  const long = card.nth(1);
  await expect(long.getByText("The last line")).not.toBeInViewport({ ratio: 1 });
  await long.getByRole("button", { name: "Show the whole suggestion" }).click();
  await expect(long.getByText("The last line")).toBeInViewport({ ratio: 1 });
  await expect(long.getByRole("button", { name: "Show the whole suggestion" })).toHaveCount(0);

  await alice.context().close();
});

test("notes, a bot's handoff, giving it back, and the bot typing", async ({ browser }) => {
  const alice = await signedIn(browser, server, "alice@example.com");
  const token = await newBot(alice, "Helper bot");
  const chat = await testVisitorSays(alice, "I want a refund");
  await alice.locator(".row", { hasText: "I want a refund" }).click();

  await alice.getByRole("radio", { name: "Note" }).check();
  const noteBox = alice.getByRole("textbox", { name: "Your note" });
  await noteBox.fill("Check the order in *Stripe* first");
  await noteBox.press("Enter");
  const mine = alice.locator(".msg.note", { hasText: "Check the order in Stripe first" });
  await expect(mine.locator(".note-label")).toHaveText("Internal note · You");
  await expect(mine.locator("em")).toHaveText("Stripe");

  await asBot(alice, token, `/conversations/${chat}/handoff`, {
    clientId: "handoff-1",
    reason: "Refunds need a person",
  });
  // The handoff shows as one line that says who took it, and the bot's note under it.
  const handoff = alice.locator(".handoff");
  await expect(handoff.locator(".handoff-line")).toContainText(
    "Helper bot handed this to the team",
  );
  await expect(handoff.locator(".handoff-card")).toContainText("Handed off: Refunds need a person");
  await expect(handoff.locator(".handoff-card")).toContainText("Only your team sees this");
  await expect(handlerButton(alice)).toContainText("Team");

  // A link in a bot's note shows its address, and nobody can click it. An operator's keeps its link.
  await asBot(alice, token, `/conversations/${chat}/messages`, {
    clientId: "note-link-1",
    body: "The visitor sent [the receipt](https://example.com/receipt).",
    note: true,
  });
  const botNote = alice.locator(".msg.note", { hasText: "the receipt" });
  await expect(botNote).toContainText("the receipt (https://example.com/receipt)");
  await expect(botNote.locator("a")).toHaveCount(0);
  await noteBox.fill("See [the order](https://example.com/order)");
  await noteBox.press("Enter");
  const ownLink = alice.locator(".msg.note", { hasText: "the order" }).locator("a");
  await expect(ownLink).toHaveAttribute("href", "https://example.com/order");

  await alice.getByRole("button", { name: "More actions" }).click();
  await alice.getByRole("menuitem", { name: "Give back to bot" }).click();
  await expect(alice.getByText("The bot can answer this conversation again.")).toBeVisible();
  await expect(handlerButton(alice)).toContainText("Helper bot");
  const row = alice.locator(".row", { hasText: "I want a refund" });
  await expect(row.getByRole("img", { name: "Helper bot" })).toBeVisible();

  // One dropdown picks who answers: a person takes it over, and the bot gets it back.
  await handlerButton(alice).click();
  await alice.getByRole("option", { name: /^alice@example\.com/ }).click();
  await expect(handlerButton(alice)).toContainText("alice@example.com");
  await handlerButton(alice).click();
  await alice.getByRole("option", { name: /^Helper bot/ }).click();
  await expect(handlerButton(alice)).toContainText("Helper bot");
  await expect(row.getByRole("img", { name: "Helper bot" })).toBeVisible();

  await asBot(alice, token, `/conversations/${chat}/typing`, { typing: true });
  await expect(alice.getByText("Helper bot is typing…")).toBeVisible();
  await asBot(alice, token, `/conversations/${chat}/typing`, { typing: false });
  await expect(alice.getByText("Helper bot is typing…")).toHaveCount(0);

  await alice.context().close();
});

test("an operator's reply takes the conversation from the bot, and the dropdown follows live", async ({
  browser,
}) => {
  const alice = await signedIn(browser, server, "alice@example.com");
  const token = await newBot(alice, "Order bot");
  const chat = await testVisitorSays(alice, "Is my parcel lost?");
  await draft(alice, token, chat, "Let me check.");
  await alice.locator(".row", { hasText: "Is my parcel lost?" }).click();
  const handler = handlerButton(alice);
  await expect(handler).toContainText("Order bot");

  // Sent from elsewhere, so only the live stream can tell this tab.
  await asOperator(alice, `/conversations/${chat}/messages`, {
    clientId: "takeover-1",
    body: "I'll look into it myself.",
  });
  await expect(handler).toContainText("alice@example.com");
  await expect(handler).not.toContainText("Order bot");
  // The operator's message makes the bot's draft stale, so it waits behind a button.
  await expect(alice.locator(".sugg")).toHaveCount(0);
  await expect(alice.getByRole("button", { name: "1 older suggestion" })).toBeVisible();
  await alice.context().close();
});
