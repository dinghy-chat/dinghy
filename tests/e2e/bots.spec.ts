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
  const card = alice.locator(".draft-card");
  await expect(card).toContainText("Suggested by Support bot");
  await expect(card.locator("strong", { hasText: "today" })).toBeVisible();
  await expect(alice.locator(".thread-head .handler")).toContainText("Bot: Support bot");

  await card.getByRole("button", { name: "Send" }).click();
  await expect(alice.locator(".bubble-row", { hasText: "It ships today." })).toBeVisible();
  await expect(card).toHaveCount(0);

  // A visitor message after a draft makes it stale, live, and Send asks first.
  await draft(alice, token, chat, "Anything else?");
  await expect(card).toContainText("Anything else?");
  await testVisitorSays(alice, "Hello?", chat);
  await expect(card).toContainText("Older than the visitor's last message");
  await card.getByRole("button", { name: "Send" }).click();
  await expect(card).toContainText("The visitor wrote after this. Send it anyway?");
  await card.getByRole("button", { name: "Cancel" }).click();

  // Edit puts the text in the box, and sending it sends the draft.
  await card.getByRole("button", { name: "Edit" }).click();
  const box = alice.getByRole("textbox", { name: "Your reply" });
  await expect(box).toHaveValue("Anything else?");
  await expect(alice.locator(".quote-chip")).toContainText(
    "Editing the reply Support bot suggested",
  );
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

  await alice.context().close();
});

test("notes, a bot's handoff, giving it back, and the bot typing", async ({ browser }) => {
  const alice = await signedIn(browser, server, "alice@example.com");
  const token = await newBot(alice, "Helper bot");
  const chat = await testVisitorSays(alice, "I want a refund");
  await alice.locator(".row", { hasText: "I want a refund" }).click();

  await alice.getByRole("radio", { name: "Note" }).check();
  await expect(alice.locator(".compose-hint")).toHaveText("Only your team sees notes");
  const noteBox = alice.getByRole("textbox", { name: "Your note" });
  await noteBox.fill("Check the order in *Stripe* first");
  await noteBox.press("Enter");
  const mine = alice.locator(".team-note", { hasText: "Check the order in Stripe first" });
  await expect(mine).toContainText("You");
  await expect(mine.locator("em")).toHaveText("Stripe");
  await expect(alice.locator(".bubble-row", { hasText: "Check the order" })).toHaveCount(0);

  await asBot(alice, token, `/conversations/${chat}/handoff`, {
    clientId: "handoff-1",
    reason: "Refunds need a person",
  });
  const handoff = alice.locator(".team-note", { hasText: "Handed off: Refunds need a person" });
  await expect(handoff).toContainText("Helper bot");
  await expect(alice.locator(".thread-head .handler")).toContainText("Team");

  await alice.getByRole("button", { name: "More actions" }).click();
  await alice.getByRole("menuitem", { name: "Give back to bot" }).click();
  await expect(alice.getByText("The bot can answer this conversation again.")).toBeVisible();
  await expect(alice.locator(".thread-head .handler")).toContainText("Bot: Helper bot");
  const row = alice.locator(".row", { hasText: "I want a refund" });
  await expect(row.locator(".chip", { hasText: "Helper bot" })).toBeVisible();

  await asBot(alice, token, `/conversations/${chat}/typing`, { typing: true });
  await expect(alice.getByText("Helper bot is typing…")).toBeVisible();
  await asBot(alice, token, `/conversations/${chat}/typing`, { typing: false });
  await expect(alice.getByText("Helper bot is typing…")).toHaveCount(0);

  await alice.context().close();
});
