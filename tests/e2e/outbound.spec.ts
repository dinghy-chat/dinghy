import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import type { DinghyApi, NudgeOptions } from "../../packages/widget/src/shared.ts";
import { say } from "./chat.ts";

// The recipes of docs/outbound-messages.md, against a real server: a welcome that waits until the
// visitor opens the chat, a delayed message with a cancel, and an AI agent through MCP.

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;
let key: string;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/app": { html: `<!doctype html><title>App</title><h1>App</h1>${SNIPPET}` },
  });
  await server.createOperator("julien@shipmail.example");
  key = await server.sendingKey("Welcome bot");
});

test.beforeEach(async () => {
  await server.closeConversations();
});

test.afterAll(async () => {
  await server.stop();
});

const inWorkspace = (path: string) =>
  `${server.apiOrigin}/v1/operator/workspaces/${server.workspaceId()}${path}`;

/** The fields of the API's answers that these tests read. */
interface Answer {
  outboundMessage: { id: string; status: string; conversationId: string | null };
  outboundMessages: unknown[];
  conversations: unknown[];
}

/** A call from the customer's server, with the key. */
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(inWorkspace(path), {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Answer };
}

const send = (body: Record<string, unknown>) =>
  api("POST", "/outbound-messages", { clientId: randomUUID(), ...body });

/** An MCP tool's structured answer, with the key. */
async function tool(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${server.apiOrigin}/v1/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const answer = (await response.json()) as {
    result: { structuredContent: Record<string, unknown> };
  };
  return answer.result.structuredContent;
}

/** The host page as a signed-in user, whose page calls identify() as it loads. */
async function signedInPage(browser: Browser, userId: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const token = await server.hostToken(userId);
  await page.addInitScript((value) => {
    (window as unknown as { Dinghy: unknown }).Dinghy = { q: [["identify", value]] };
  }, token);
  await page.goto(`${server.hostOrigin}/app`);
  return page;
}

const conversationsOfKey = async () =>
  (await api("GET", "/conversations?status=open")).json.conversations.length;

test("recipe 1: a welcome waits on the contact until the visitor opens the chat and answers", async ({
  browser,
}) => {
  const user = { userId: "shipmail-1", name: "Ada Lovelace", email: "ada@example.com" };
  const sent = await send({
    visitor: user,
    sender: { email: "julien@shipmail.example" },
    body: "Welcome to Shipmail! Stuck on DNS or an import? Ask me here.",
    dedupeKey: "welcome",
  });
  expect(sent.status).toBe(201);
  // Only once: the same `dedupeKey` answers the first message.
  const again = await send({ visitor: user, body: "Welcome again", dedupeKey: "welcome" });
  expect([again.status, again.json.outboundMessage.id]).toEqual([
    200,
    sent.json.outboundMessage.id,
  ]);

  const page = await signedInPage(browser, user.userId);
  const launcher = page.getByRole("button", { name: /Open chat/ });
  // The launcher pulses with a count, and nothing is in the inbox while the visitor has not answered.
  await expect(page.locator(".launcher.nudge .badge")).toHaveText("1");
  expect(await conversationsOfKey()).toBe(0);

  await launcher.click();
  await expect(page.locator(".msg", { hasText: "Welcome to Shipmail!" })).toBeVisible();
  await expect(page.locator(".launcher.nudge")).toHaveCount(0);
  await say(page, "Thanks! How do I add my domain?");
  await expect.poll(conversationsOfKey).toBe(1);
  const listed = await api("GET", "/outbound-messages?status=replied");
  expect(listed.json.outboundMessages).toHaveLength(1);
});

const nudge = (page: Page, on?: boolean | NudgeOptions) =>
  page.evaluate((value) => (window as unknown as { Dinghy: DinghyApi }).Dinghy.nudge(value), on);
const messageBox = (page: Page) => page.getByRole("textbox", { name: "Your message" });
const pulses = (page: Page) => page.locator(".launcher.nudge");

async function closeChat(page: Page) {
  await page.keyboard.press("Escape");
  await expect(messageBox(page)).toBeHidden();
}

test("the page's nudge shows a card until it opens the chat with its message", async ({ page }) => {
  await page.goto(`${server.hostOrigin}/app`);
  const card = page.locator(".preview");

  await test.step("the card shows plain text, and its close button stops the pulse", async () => {
    await nudge(page, { text: "We saw an error. Can we help? https://example.com" });
    await expect(card).toContainText("We saw an error.");
    await expect(card.locator("a")).toHaveCount(0);
    await expect(pulses(page)).toHaveCount(1);
    await card.getByRole("button", { name: "Close this message" }).click();
    await expect(card).toHaveCount(0);
    await expect(pulses(page)).toHaveCount(0);
  });

  await test.step("nudge(false) removes the card", async () => {
    await nudge(page, { text: "Still stuck?" });
    await expect(card).toHaveCount(1);
    await nudge(page, false);
    await expect(card).toHaveCount(0);
    await expect(pulses(page)).toHaveCount(0);
  });

  await test.step("a reused object updates the card, and a plain nudge() keeps it", async () => {
    await page.evaluate(() => {
      const options = { text: "First error", message: "Error ID first" };
      const { Dinghy } = window as unknown as { Dinghy: DinghyApi };
      Dinghy.nudge(options);
      options.text = "Need a hand?";
      options.message = "Error ID def456";
      Dinghy.nudge(options);
      Dinghy.nudge();
    });
    await card.getByText("Need a hand?").click();
    await expect(messageBox(page)).toHaveValue("Error ID def456");
    await expect(card).toHaveCount(0);
    await expect(pulses(page)).toHaveCount(0);
    await closeChat(page);
  });

  await test.step("the keyboard opens the chat from the card", async () => {
    await nudge(page, { text: "Still stuck?", message: "Error ID stu901" });
    await card.getByRole("button", { name: "Still stuck?" }).press("Enter");
    await expect(messageBox(page)).toHaveValue("Error ID stu901");
    await closeChat(page);
  });

  await test.step("the launcher opens the chat with the card's message", async () => {
    await nudge(page, { text: "Still stuck?", message: "Error ID pqr678" });
    await page.getByRole("button", { name: /Open chat/ }).click();
    await expect(messageBox(page)).toHaveValue("Error ID pqr678");
  });
});

test("a nudge before the saved look still pulses, and reset() drops the card", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { Dinghy: unknown }).Dinghy = {
      q: [["nudge", { text: "Can we help?", message: "Error ID ghi789" }]],
    };
  });
  await page.goto(`${server.hostOrigin}/app`);
  await expect(page.locator(".preview")).toContainText("Can we help?");
  await expect(pulses(page)).toHaveCount(1);
  // The next visitor in this browser gets neither the card nor its message.
  await page.evaluate(() => (window as unknown as { Dinghy: { reset(): void } }).Dinghy.reset());
  await expect(page.locator(".preview")).toHaveCount(0);
  await page.getByRole("button", { name: /Open chat/ }).click();
  await expect(messageBox(page)).toHaveValue("");
});

test("the nudge's message is no typing preview until the visitor changes it", async ({ page }) => {
  await page.goto(`${server.hostOrigin}/app`);
  await page.getByRole("button", { name: /Open chat/ }).click();
  await say(page, "Hello");
  await closeChat(page);
  const drafts: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/typing")) drafts.push(request.postData() ?? "");
  });
  await nudge(page, { text: "Can we help?", message: "Error ID jkl012" });
  await page.locator(".preview").getByText("Can we help?").click();
  await expect(messageBox(page)).toHaveValue("Error ID jkl012");
  await messageBox(page).press("End");
  await messageBox(page).pressSequentially("!");
  await expect.poll(() => drafts.some((body) => body.includes("jkl012!"))).toBe(true);
  expect(drafts.some((body) => body.includes('"Error ID jkl012"'))).toBe(false);
});

test("closing the page's card keeps the pulse of a message that waits", async ({ browser }) => {
  const user = { userId: "nudge-badge" };
  expect(
    (await send({ visitor: user, body: "A new import tool is out", show: "badge" })).status,
  ).toBe(201);
  const page = await signedInPage(browser, user.userId);
  await expect(page.locator(".launcher.nudge .badge")).toHaveText("1");
  await nudge(page, { text: "Can we help?" });
  await page.locator(".preview").getByRole("button", { name: "Close this message" }).click();
  await expect(page.locator(".preview")).toHaveCount(0);
  await expect(pulses(page)).toHaveCount(1);
});

test("the page's card takes the place of a waiting card, which comes back after it", async ({
  browser,
}) => {
  const user = { userId: "nudge-preview" };
  const sent = await send({ visitor: user, body: "A new import tool is out", show: "preview" });
  expect(sent.status).toBe(201);
  const page = await signedInPage(browser, user.userId);
  const card = page.locator(".preview");
  await expect(card).toContainText("A new import tool is out");
  await nudge(page, { text: "Can we help?" });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Can we help?");
  await card.getByRole("button", { name: "Close this message" }).click();
  await expect(card).toContainText("A new import tool is out");
});

test("recipe 2: a message after an hour, cancelled when the domain verifies, or shown as a card", async ({
  browser,
}) => {
  const owner = { userId: "shipmail-2" };
  const first = await send({
    visitor: owner,
    body: "example.com is not verified yet. Want me to check your DNS with you?",
    delay: "1h",
    dedupeKey: "dns-unverified:1",
  });
  expect(first.json.outboundMessage.status).toBe("scheduled");
  // The domain verified within the hour.
  const cancelled = await api("POST", "/outbound-messages/cancel", {
    visitor: owner,
    dedupeKey: "dns-unverified:1",
  });
  expect(cancelled.json.outboundMessage).toMatchObject({ status: "cancelled" });

  await send({
    visitor: owner,
    body: "shipmail.example is not verified yet. Want me to check your DNS with you?",
    delay: "1h",
    dedupeKey: "dns-unverified:2",
    show: "preview",
    buttons: [
      { label: "Yes, please", value: "yes" },
      { label: "I'm fine", dismiss: true },
    ],
  });
  const page = await signedInPage(browser, owner.userId);
  await expect(page.locator(".preview")).toHaveCount(0);
  await server.outboundTimePasses();
  await page.reload();
  const card = page.locator(".preview");
  await expect(card).toContainText("shipmail.example is not verified yet");
  await expect(card).not.toContainText("example.com is not verified yet");
  await expect(card).toHaveAttribute("aria-live", "polite");
  await card.getByRole("button", { name: "Yes, please" }).click();
  await expect.poll(conversationsOfKey).toBe(1);
  await page.getByRole("button", { name: /Open chat/ }).click();
  await expect(page.locator(".msg.mine", { hasText: "Yes, please" })).toBeVisible();
});

test("recipe 4: an AI agent starts a conversation now, and wait_for_events gets the answer", async ({
  browser,
}) => {
  const now = await tool("wait_for_events", {});
  const sent = await tool("send_outbound_message", {
    clientId: randomUUID(),
    visitor: { userId: "shipmail-4" },
    body: "Your import finished with 3 skipped messages. Want the list?",
    startConversation: "now",
    dedupeKey: "import-7781-done",
  });
  const { conversationId } = sent.outboundMessage as { conversationId: string | null };
  expect(conversationId).not.toBeNull();

  const page = await signedInPage(browser, "shipmail-4");
  await page.getByRole("button", { name: /Open chat/ }).click();
  await expect(page.locator(".msg", { hasText: "Your import finished" })).toBeVisible();
  await say(page, "Yes, send me the list");
  const waited = await tool("wait_for_events", { cursor: now.cursor, timeoutSeconds: 10 });
  const messages = waited.events as { conversationId: string; message: { body: string } }[];
  expect(messages.map((one) => [one.conversationId, one.message.body])).toEqual([
    [conversationId, "Yes, send me the list"],
  ]);
});

/** Records the page's outbound and visitor events from now. */
const watchEvents = (page: Page) =>
  page.evaluate(() => {
    const win = window as unknown as {
      heard: unknown[];
      Dinghy: { on(event: string, callback: (data: unknown) => void): void };
    };
    win.heard = [];
    for (const name of ["outbound:read", "outbound:dismissed", "visitor"]) {
      win.Dinghy.on(name, (data) => win.heard.push([name, data]));
    }
  });
const heard = (page: Page) =>
  page.evaluate(() => (window as unknown as { heard: unknown[] }).heard);

test("a card's button reads the message, and reset() forgets the visitor's ID", async ({
  browser,
}) => {
  const sent = await send({
    visitor: { userId: "shipmail-card" },
    body: "Your trial ends in 3 days.",
    show: "preview",
    buttons: [{ label: "I'm fine", dismiss: true }],
  });
  const { id } = sent.json.outboundMessage;
  const page = await signedInPage(browser, "shipmail-card");
  await expect(page.locator(".preview")).toContainText("Your trial ends");
  await watchEvents(page);
  await page.locator(".preview").getByRole("button", { name: "I'm fine" }).click();
  await expect(page.locator(".preview")).toHaveCount(0);
  const button = { value: null, label: "I'm fine" };
  await expect
    .poll(() => heard(page))
    .toEqual([
      ["outbound:read", { id, campaignId: null, button }],
      ["outbound:dismissed", { id, campaignId: null, button }],
    ]);
  const visitorId = () =>
    page.evaluate(
      () =>
        (window as unknown as { Dinghy: { state: { visitorId: string | null } } }).Dinghy.state
          .visitorId,
    );
  expect(await visitorId()).not.toBeNull();
  await page.evaluate(() => (window as unknown as { Dinghy: { reset(): void } }).Dinghy.reset());
  expect(await visitorId()).toBeNull();
  await expect.poll(() => heard(page)).toContainEqual(["visitor", null]);
});

test("a message that starts a conversation keeps its buttons there", async ({ browser }) => {
  await send({
    visitor: { userId: "shipmail-buttons" },
    body: "Your import finished. Want the list of skipped messages?",
    startConversation: "now",
    buttons: [{ label: "Send the list", value: "list" }],
  });
  const page = await signedInPage(browser, "shipmail-buttons");
  await page.getByRole("button", { name: /Open chat/ }).click();
  await expect(page.locator(".msg", { hasText: "Your import finished" })).toBeVisible();
  await page.locator(".choices").getByRole("button", { name: "Send the list" }).click();
  await expect(page.locator(".msg.mine", { hasText: "Send the list" })).toBeVisible();
  await expect(page.locator(".choices")).toHaveCount(0);
  await expect
    .poll(async () => (await api("GET", "/outbound-messages?status=replied")).json.outboundMessages)
    .toContainEqual(expect.objectContaining({ button: { value: "list", label: "Send the list" } }));
});
