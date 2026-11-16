import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { say } from "./chat.ts";

// The recipes of docs/campaigns.md, against a real server: help on the pricing page with no code,
// and a campaign that support writes while the customer's code picks the moment.

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';
const page = (title: string) => ({
  html: `<!doctype html><title>${title}</title><h1>${title}</h1>${SNIPPET}`,
});

let server: Awaited<ReturnType<typeof startE2EServer>>;
/** The repository's deploy key, which saves campaigns, and the app's server key, which sends. */
let deployKey: string;
let serverKey: string;

test.beforeAll(async () => {
  server = await startE2EServer({ "/pricing": page("Pricing"), "/app": page("App") });
  await server.createOperator("julien@shipmail.example");
  deployKey = await server.sendingKey("Deploy", "setup");
  serverKey = await server.sendingKey("Shipmail server");
});

test.afterAll(async () => {
  await server.stop();
});

/** A call to the API with a key. */
async function api(key: string, method: string, path: string, body?: unknown) {
  const response = await fetch(
    `${server.apiOrigin}/v1/operator/workspaces/${server.workspaceId()}${path}`,
    {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** Saves a campaign as code does, and starts it. */
async function liveCampaign(definition: { key: string } & Record<string, unknown>) {
  const saved = await api(deployKey, "PUT", `/campaigns/by-key/${definition.key}`, definition);
  expect(saved.status).toBe(201);
  expect((await api(deployKey, "POST", `/campaigns/by-key/${definition.key}/resume`)).status).toBe(
    200,
  );
}

const resultsOf = async (key: string) =>
  (await api(serverKey, "GET", `/campaigns/by-key/${key}/results`)).json.variants as Record<
    string,
    number
  >[];

async function newPage(browser: Browser, path: string): Promise<Page> {
  const opened = await (await browser.newContext()).newPage();
  await opened.goto(`${server.hostOrigin}${path}`);
  return opened;
}

test("recipe 3: help on the pricing page, with no code", async ({ browser }) => {
  await liveCampaign({
    key: "pricing-help",
    name: "Pricing help",
    trigger: { type: "page", url: "/pricing*", seconds: 2 },
    message: {
      sender: { email: "julien@shipmail.example" },
      body: "Comparing plans? I can tell you which one fits.",
    },
    presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
  });

  // Another page shows nothing.
  const elsewhere = await newPage(browser, "/app");
  await elsewhere.waitForTimeout(3000);
  await expect(elsewhere.locator(".preview")).toHaveCount(0);

  const visitor = await newPage(browser, "/pricing");
  const card = visitor.locator(".preview");
  await expect(card).toContainText("Comparing plans?", { timeout: 10_000 });
  // The server stores nothing about this visitor before they answer.
  expect(await server.visitorCount()).toBe(0);
  await expect.poll(async () => (await resultsOf("pricing-help"))[0]?.read).toBe(0);

  await card.locator(".peek").click();
  await expect(visitor.locator(".panel .msg", { hasText: "Comparing plans?" })).toBeVisible();
  await say(visitor, "Which plan has the API?");
  await expect.poll(() => server.visitorCount()).toBe(1);
  const conversations = await api(serverKey, "GET", "/conversations?status=open");
  const [conversation] = conversations.json.conversations as { id: string }[];
  const messages = await api(serverKey, "GET", `/conversations/${conversation?.id}/messages`);
  const bodies = (messages.json.messages as { body: string }[]).map((one) => one.body);
  expect(bodies).toEqual([
    "Comparing plans? I can tell you which one fits.",
    "Which plan has the API?",
  ]);
  await expect
    .poll(async () => (await resultsOf("pricing-help"))[0])
    .toMatchObject({ entered: 1, sent: 1, read: 1, replied: 1, conversationsStarted: 1 });

  // Once per page load: the card does not come back on this page.
  await visitor.waitForTimeout(3000);
  await expect(card).toHaveCount(0);
});

test("recipe 5: text in the dashboard, trigger in code", async ({ browser }) => {
  await liveCampaign({
    key: "onboarding-done",
    name: "Onboarding done",
    trigger: { type: "api" },
    message: {
      sender: { email: "julien@shipmail.example" },
      body: 'You are all set on {{ data.plan | default: "your plan" }}! Anything I can help with?',
    },
    presentation: { startConversation: "on_reply", show: "badge", ifConversationOpen: "skip" },
  });
  // The customer's server, when onboarding ends.
  const sent = await api(serverKey, "POST", "/campaigns/by-key/onboarding-done/send", {
    clientId: randomUUID(),
    visitor: { userId: "shipmail-5", name: "Grace Hopper" },
    data: { plan: "Pro" },
  });
  expect(sent.status).toBe(201);

  const visitor = await (await browser.newContext()).newPage();
  const token = await server.hostToken("shipmail-5");
  await visitor.addInitScript((value) => {
    (window as unknown as { Dinghy: unknown }).Dinghy = { q: [["identify", value]] };
  }, token);
  await visitor.goto(`${server.hostOrigin}/app`);
  await expect(visitor.locator(".launcher.nudge .badge")).toHaveText("1");
  await visitor.getByRole("button", { name: /Open chat/ }).click();
  await expect(visitor.locator(".msg", { hasText: "You are all set on Pro!" })).toBeVisible();
  await say(visitor, "All good, thanks");
  // Support reads the rates in the campaign's results, with no deploy.
  await expect
    .poll(async () => (await resultsOf("onboarding-done"))[0])
    .toMatchObject({ sent: 1, delivered: 1, read: 1, replied: 1 });
});
