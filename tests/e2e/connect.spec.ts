import { createHash, randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { conversation, webhook, webhookDelivery } from "../../apps/server/src/db/schema.ts";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink, signedIn } from "./links.ts";
import { openSettings } from "./settings.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

// A loopback address nothing listens on: the test answers it in the browser.
const LOOPBACK_REDIRECT = "http://127.0.0.1:9/callback";
// An app's own scheme, which leaves the tab where it is, as a desktop app does.
const APP_REDIRECT = "com.example.app:/callback";
// Claude Code's client ID metadata document, which the server reads from this fake fetch.
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";

test.beforeAll(async () => {
  server = await startE2EServer(
    {},
    {
      fetchClientDocument: async (url) =>
        url === CLAUDE_CODE
          ? {
              client_id: CLAUDE_CODE,
              client_name: "Claude Code",
              redirect_uris: [LOOPBACK_REDIRECT],
              token_endpoint_auth_method: "none",
            }
          : null,
    },
  );
  await server.createOperator("owner@example.com");
  await server.createOperator("member@example.com", { role: "member" });
});

test.afterAll(async () => {
  await server.stop();
});

/** Registers an app with its redirect URI, and gives its client ID. */
async function register(redirectUri: string, name: string) {
  const registered = await fetch(`${server.apiOrigin}/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri] }),
  });
  return ((await registered.json()) as { client_id: string }).client_id;
}

/**
 * The consent page's address for an app and its PKCE verifier. `app` is a metadata URL, used as the
 * client ID, or the name to register an app with, as Claude Code does.
 */
async function authorizeRequest(redirectUri: string, scope = "conversations", app = "Claude Code") {
  const clientId = app.startsWith("https:") ? app : await register(redirectUri, app);
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "state-1",
    scope,
  });
  return { url: `${server.apiOrigin}/oauth/authorize?${query}`, clientId, verifier };
}

const consentHeading = (page: Page) =>
  page.getByRole("heading", { name: "Connect Claude Code to Dinghy?" });

test("an owner approves an app with Full access and Drafts only, then sees it in Settings and changes its replies", async ({
  browser,
}) => {
  const page = await signedIn(browser, server, "owner@example.com");
  const request = await authorizeRequest(LOOPBACK_REDIRECT, "setup");
  await page.route(`${LOOPBACK_REDIRECT}**`, (route) =>
    route.fulfill({ contentType: "text/plain", body: "app" }),
  );
  await page.goto(request.url);
  await expect(consentHeading(page)).toBeVisible();
  await expect(page.getByText("Signed in as owner@example.com")).toBeVisible();
  // Nothing on the page says where the app runs.
  await expect(page.getByText(/this computer|localhost|127\.0\.0\.1/i)).toHaveCount(0);
  await expect(page.getByText(/Returns to|Published by/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Workspace/ })).toContainText("E2E");
  await expect(page.getByRole("button", { name: /^Workspace/ })).toContainText("Owner");
  await expect(page.getByRole("radio", { name: /^Full access/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^Chats/ })).not.toBeChecked();
  await expect(page.getByText("Can't see keys or change your team or billing")).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Drafts only/ })).toBeChecked();

  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:9\/callback\?/);
  const answer = new URL(page.url()).searchParams;
  expect(answer.get("state")).toBe("state-1");
  expect(answer.get("iss")).toBe(server.apiOrigin);

  // Settings lists an app once it has used its code.
  const token = await fetch(`${server.apiOrigin}/v1/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: answer.get("code") ?? "",
      redirect_uri: LOOPBACK_REDIRECT,
      client_id: request.clientId,
      code_verifier: request.verifier,
    }),
  });
  expect(token.status).toBe(200);

  await page.goto(`${server.apiOrigin}/settings/developers`);
  const apps = page.getByRole("region", { name: "Connected apps" });
  const row = apps.locator(".item-row", { hasText: "Claude Code" });
  await expect(row.getByText("Full access", { exact: true })).toBeVisible();
  await expect(row.getByText(/Approved by owner@example\.com on /)).toBeVisible();
  await expect(row).not.toContainText("This computer");
  await expect(row).not.toContainText("Returns to");
  await expect(page.locator(".status-card")).toContainText("1 connected app, 0 API keys");
  const replies = row.getByRole("button", { name: /Replies from Claude Code/ });
  await expect(replies).toContainText("Drafts only");
  await replies.click();
  await page.getByRole("option", { name: "Send directly" }).click();
  await expect(replies).toContainText("Send directly");
  await page.reload();
  await expect(
    page.locator(".item-row", { hasText: "Claude Code" }).getByRole("button", { name: /Replies/ }),
  ).toContainText("Send directly");
  await page.context().close();
});

test("the consent page names who published the app, or the website it returns to", async ({
  browser,
}) => {
  const page = await signedIn(browser, server, "owner@example.com");
  const origin = page.locator(".consent-origin");
  const cases: { request: Promise<{ url: string }>; line: string | null }[] = [
    {
      request: authorizeRequest(LOOPBACK_REDIRECT, "setup", CLAUDE_CODE),
      line: "Published by claude.ai",
    },
    { request: authorizeRequest("https://evil.example/cb"), line: "Returns to evil.example" },
    { request: authorizeRequest(APP_REDIRECT), line: null },
  ];
  for (const { request, line } of cases) {
    await page.goto((await request).url);
    await expect(consentHeading(page)).toBeVisible();
    if (line === null) await expect(origin).toHaveCount(0);
    else await expect(origin).toHaveText(line);
  }

  // Settings shows the same line once the app has used its code.
  const remote = await authorizeRequest("https://evil.example/cb", "conversations", "Remote app");
  await page.route("https://evil.example/**", (route) =>
    route.fulfill({ contentType: "text/plain", body: "app" }),
  );
  await page.goto(remote.url);
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/^https:\/\/evil\.example\/cb\?/);
  const token = await fetch(`${server.apiOrigin}/v1/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(page.url()).searchParams.get("code") ?? "",
      redirect_uri: "https://evil.example/cb",
      client_id: remote.clientId,
      code_verifier: remote.verifier,
    }),
  });
  expect(token.status).toBe(200);
  await page.goto(`${server.apiOrigin}/settings/developers`);
  await expect(page.locator(".item-row", { hasText: "Remote app" })).toContainText(
    "Returns to evil.example",
  );
  await page.context().close();
});

test("signed out, the sign-in link comes back to the request, and Cancel leaves the tab done", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const request = await authorizeRequest(APP_REDIRECT);
  await page.goto(request.url);
  await expect(page.getByText("Sign in to connect an app.")).toBeVisible();
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await openLink(page, await server.linkTo("owner@example.com"));
  await expect(consentHeading(page)).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Chats/ })).toBeChecked();

  // The app's own scheme leaves the tab here, so the card says it is done.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Cancelled" })).toBeVisible();
  await expect(page.getByText("You can close this tab.")).toBeVisible();
  await context.close();
});

test("a member is told only owners and admins connect apps, and an unknown app gets a calm error", async ({
  browser,
}) => {
  const page = await signedIn(browser, server, "member@example.com");
  await page.goto((await authorizeRequest(LOOPBACK_REDIRECT)).url);
  await expect(page.getByText("Only owners and admins can connect apps.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  const unknown = new URLSearchParams({
    response_type: "code",
    client_id: "dcr1.not-a-real-client",
    redirect_uri: "https://evil.example/callback",
  });
  await page.goto(`${server.apiOrigin}/oauth/authorize?${unknown}`);
  await expect(page.getByRole("heading", { name: "This app can't connect" })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(server.apiOrigin);
  await page.context().close();
});

test("an owner pauses every bot from the workspace menu, everyone sees the banner, and Resume ends it", async ({
  browser,
}) => {
  const owner = await signedIn(browser, server, "owner@example.com");
  const member = await signedIn(browser, server, "member@example.com");
  const banner = (page: Page) => page.locator(".bots-banner");

  await owner.getByRole("button", { name: /E2E/ }).click();
  const pause = owner.getByRole("menuitemcheckbox", { name: "Pause all bots" });
  await expect(pause).toHaveAttribute("aria-checked", "false");
  await pause.click();
  await expect(banner(owner)).toBeVisible();
  await expect(banner(owner)).toContainText(
    "Bots are paused. Only your team replies to visitors. owner@example.com paused them at",
  );
  // The other operator's app hears of it from the server.
  await expect(banner(member)).toBeVisible();
  await expect(member.getByRole("button", { name: "Resume bots" })).toHaveCount(0);

  await openSettings(owner, "API & webhooks");
  await expect(owner.getByRole("checkbox", { name: "Pause bots" })).toBeChecked();
  await expect(owner.locator(".status-card")).toContainText("Paused by owner@example.com.");
  await owner.getByRole("button", { name: /E2E/ }).click();
  await expect(pause).toHaveAttribute("aria-checked", "true");
  await owner.keyboard.press("Escape");
  await owner.getByRole("button", { name: "Resume bots" }).click();
  await expect(banner(owner)).toHaveCount(0);
  await expect(banner(member)).toHaveCount(0);
  await expect(owner.getByRole("checkbox", { name: "Pause bots" })).not.toBeChecked();
  await owner.context().close();
  await member.context().close();
});

test("a failed delivery shows the receiver's answer and can be replayed", async ({ browser }) => {
  const workspaceId = server.workspaceId();
  await server.seedConversations(1, "hook");
  // This server's database holds one workspace.
  const [chat] = await server.owner.select({ id: conversation.id }).from(conversation);
  const [hook] = await server.owner
    .insert(webhook)
    .values({
      workspaceId,
      url: "https://hooks.example.com/dinghy",
      secret: "whsec_test",
      events: ["message.created"],
    })
    .returning({ id: webhook.id });
  await server.owner.insert(webhookDelivery).values({
    workspaceId,
    webhookId: hook?.id ?? "",
    eventId: crypto.randomUUID(),
    type: "message.created",
    conversationId: chat?.id ?? "",
    attempts: 8,
    outcome: "failed",
    finishedAt: new Date(),
    lastStatus: 500,
    responseExcerpt: '{"error":"database is down"}',
  });

  const page = await signedIn(browser, server, "owner@example.com");
  await openSettings(page, "API & webhooks");
  await page
    .getByRole("button", { name: "Edit the webhook https://hooks.example.com/dinghy" })
    .click();
  await page.getByRole("button", { name: "Show deliveries" }).click();
  const deliveries = page.getByRole("list", { name: "Recent deliveries" });
  await expect(deliveries.getByText("Delivery stopped")).toBeVisible();
  await deliveries.getByText("The server's answer").click();
  await expect(deliveries.getByText('{"error":"database is down"}')).toBeVisible();

  await deliveries.getByRole("button", { name: /Replay the message\.created delivery/ }).click();
  await expect(deliveries.getByText("Replayed")).toBeVisible();
  // The replay waits to go, so it offers no Replay of its own.
  await expect(
    deliveries.getByRole("button", { name: /Replay the message\.created delivery/ }),
  ).toHaveCount(1);
  await page.context().close();
});

test("the Install page shows a short, whole prompt per coding agent", async ({ browser }) => {
  const page = await signedIn(browser, server, "owner@example.com");
  await openSettings(page, "Install");
  await expect(page.getByRole("heading", { name: "Set up with an agent" })).toBeVisible();
  const agentRow = page.locator(".page-row", { hasText: "Set up with an agent" });
  await expect(agentRow.getByRole("button", { name: "Copy prompt" })).toHaveText("Copy prompt");
  await expect(agentRow.getByRole("button", { name: /Copy/ })).toHaveCount(1);
  const prompt = agentRow.locator(".prompt-text");
  await expect(agentRow.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await expect(prompt).toContainText(
    `claude mcp add --transport http dinghy ${server.apiOrigin}/v1/mcp`,
  );
  await agentRow.getByRole("radio", { name: "Cursor" }).check();
  await expect(prompt).toContainText(".cursor/mcp.json");
  await expect(prompt).not.toContainText("claude mcp add");
  await agentRow.getByRole("radio", { name: "Other" }).check();
  await expect(prompt).toContainText(`remote HTTP MCP server, at ${server.apiOrigin}/v1/mcp`);
  await expect(
    page.getByText("Ask me before you change anything outside the install."),
  ).toBeVisible();
  await expect(prompt).toContainText("verify_install, at most 5 times");
  await page.context().close();
});
