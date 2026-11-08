import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";

const PASSWORD = "a-long-test-password";
const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/plain": { html: `<!doctype html><title>Host</title>${SNIPPET}` },
  });
  await server.createOperator("owner@example.com", PASSWORD);
});

test.afterAll(async () => {
  await server.stop();
});

async function signedIn(browser: Browser, email = "owner@example.com"): Promise<Page> {
  const context = await browser.newContext();
  // Only Chromium has this permission. In WebKit, asking for it breaks the next new page.
  if (browser.browserType().name() === "chromium") {
    await context.grantPermissions(["clipboard-write"]);
  }
  const page = await context.newPage();
  await page.goto(server.apiOrigin);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  return page;
}

async function inviteLink(page: Page, role: "Agent" | "Admin" = "Agent"): Promise<string> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("combobox", { name: "Role", exact: true }).selectOption({ label: role });
  await page.getByRole("button", { name: "Create a link" }).click();
  const link = page.locator(".page pre", { hasText: "/invite?token=" });
  await expect(link).toBeVisible();
  const url = (await link.textContent()) ?? "";
  await page.getByRole("button", { name: "Open", exact: true }).click();
  return url;
}

async function joinAsNew(browser: Browser, url: string, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Join a workspace" })).toBeVisible();
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(`${name.toLowerCase()}@example.com`);
  await page.getByLabel("New password").fill(PASSWORD);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  return page;
}

test("an owner invites an agent, assigns a chat to them, then removes them @smoke", async ({
  browser,
}) => {
  const boss = await signedIn(browser);
  const url = await inviteLink(boss);
  const agent = await joinAsNew(browser, url, "Ben");

  // An agent sees the team, and no settings for the widget.
  await agent.getByRole("button", { name: "Settings" }).click();
  await expect(agent.locator(".team").getByText("ben@example.com")).toBeVisible();
  await expect(agent.getByText("Signing secret")).toHaveCount(0);
  await expect(agent.getByText("Invite someone")).toHaveCount(0);
  await agent.getByRole("button", { name: "Open", exact: true }).click();

  // The same link does not work twice.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(url);
  await expect(stranger.getByRole("alert")).toContainText("expired or was already used");

  await server.seedConversations(1, "assign me");
  await boss.reload();
  await boss.locator(".row", { hasText: "assign me" }).click();
  await boss.getByRole("combobox", { name: "Assign to" }).selectOption({ label: "Ben" });
  await expect(boss.locator(".row", { hasText: "assign me" })).toContainText("Ben");
  // The agent's open app learns this from the stream.
  await expect(agent.locator(".row", { hasText: "assign me" })).toContainText("Ben");

  await boss.getByRole("button", { name: "Settings" }).click();
  await boss.getByRole("button", { name: "Remove: Ben" }).click();
  await expect(boss.locator(".team").getByText("ben@example.com")).toHaveCount(0);
  await boss.getByRole("button", { name: "Open", exact: true }).click();
  await expect(boss.locator(".row", { hasText: "assign me" })).not.toContainText("Ben");

  await agent.reload();
  await expect(agent.getByText("You are not in a workspace yet.")).toBeVisible();
  await server.closeConversations();
});

test("an owner changes the allowed sites and replaces the secret", async ({ browser }) => {
  const boss = await signedIn(browser);
  await boss.getByRole("button", { name: "Settings" }).click();
  await expect(boss.locator(".page pre").first()).toContainText("data-key=");

  const sites = boss.getByLabel("Allowed sites");
  const original = await sites.inputValue();
  await sites.fill("not a site");
  await boss.getByRole("button", { name: "Save sites" }).click();
  await expect(boss.getByRole("status")).toHaveText("One of these is not a valid origin.");
  await sites.fill(`${original}\nhttps://second.example.com`);
  await boss.getByRole("button", { name: "Save sites" }).click();
  await expect(boss.getByRole("status")).toHaveText("Saved.");
  await boss.reload();
  await boss.getByRole("button", { name: "Settings" }).click();
  await expect(boss.getByLabel("Allowed sites")).toHaveValue(
    `${original}\nhttps://second.example.com`,
  );

  await boss.getByRole("button", { name: "Show" }).click();
  const secret = boss.locator(".page pre").nth(1);
  const before = await secret.textContent();
  await boss.getByRole("button", { name: "Replace the secret" }).click();
  await expect(boss.getByRole("alert")).toContainText("stop working at once");
  await boss.getByRole("button", { name: "Replace it now" }).click();
  await expect(secret).not.toHaveText(before ?? "");
});

test("someone with an account joins a second workspace and switches between them", async ({
  browser,
}) => {
  const boss = await signedIn(browser);
  const url = await inviteLink(boss);
  const other = await server.createSecondWorkspace("Other", "multi@example.com", PASSWORD);
  const page = await signedIn(browser, "multi@example.com");
  await page.goto(url);
  await expect(page.getByText("You are signed in as multi@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Join", exact: true }).click();

  const picker = page.getByRole("combobox", { name: "Workspace" });
  await expect(picker).toHaveValue(server.workspaceId());
  await picker.selectOption({ value: other.id });
  await expect(picker).toHaveValue(other.id);
  await page.reload();
  await expect(picker).toHaveValue(other.id);
});

test("an open app sees team changes, and a removal opens the other workspace", async ({
  browser,
}) => {
  const boss = await signedIn(browser);
  const url = await inviteLink(boss);
  const laterUrl = await inviteLink(boss);
  await server.createSecondWorkspace("Elsewhere", "two@example.com", PASSWORD);
  const person = await signedIn(browser, "two@example.com");
  await person.goto(url);
  await person.getByRole("button", { name: "Join", exact: true }).click();
  const picker = person.getByRole("combobox", { name: "Workspace" });
  await expect(picker).toHaveValue(server.workspaceId());
  await person.reload();
  await expect(picker).toHaveValue(server.workspaceId());

  await server.seedConversations(1, "live roster");
  await boss.reload();
  await boss.locator(".row", { hasText: "live roster" }).click();
  const assign = boss.getByRole("combobox", { name: "Assign to" });
  await expect(assign.locator("option", { hasText: "two@example.com" })).toHaveCount(1);
  // Someone joins while this page stays open, with no dialog or reload to refresh the list.
  await joinAsNew(browser, laterUrl, "Cara");
  await expect(assign.locator("option", { hasText: "Cara" })).toHaveCount(1);

  // A promotion shows in the agent's open app, with no reload.
  await person.getByRole("button", { name: "Settings" }).click();
  await expect(person.getByText("Signing secret")).toHaveCount(0);
  await person.getByRole("button", { name: "Open", exact: true }).click();
  await boss.getByRole("button", { name: "Settings" }).click();
  await boss
    .getByRole("combobox", { name: "Role: two@example.com" })
    .selectOption({ label: "Admin" });
  await expect(async () => {
    await person.getByRole("button", { name: "Settings" }).click();
    try {
      await expect(person.getByText("Signing secret")).toBeVisible({ timeout: 1000 });
    } finally {
      await person.getByRole("button", { name: "Open", exact: true }).click();
    }
  }).toPass();

  // A removal ends this workspace for them and leaves them signed in to the other one.
  await boss.getByRole("button", { name: "Remove: two@example.com" }).click();
  await boss.getByRole("button", { name: "Open", exact: true }).click();
  await expect(assign.locator("option", { hasText: "two@example.com" })).toHaveCount(0);
  await expect(person.getByRole("heading", { name: "Elsewhere" })).toBeVisible();
  await expect(person.getByRole("heading", { name: "Sign in to Dinghy" })).toHaveCount(0);
  await server.closeConversations();
});

test("a window whose session ended elsewhere reconnects with the new one", async ({ browser }) => {
  const first = await signedIn(browser);
  const second = await first.context().newPage();
  await second.goto(server.apiOrigin);
  await second.getByRole("button", { name: "Sign out" }).click();
  await second.getByLabel("Email").fill("owner@example.com");
  await second.getByLabel("Password").fill(PASSWORD);
  await second.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(second.getByRole("button", { name: "Sign out" })).toBeVisible();

  // The next event ends the first window's old stream, and a later one must still arrive.
  await server.seedConversations(1, "after sign in");
  await server.wakeOperators();
  await expect(first.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect
    .poll(
      async () => {
        await server.wakeOperators();
        return first.locator(".row", { hasText: "after sign in" }).count();
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  await server.closeConversations();
});

test("an owner downloads an export from Settings, and an agent sees no link", async ({
  browser,
}) => {
  const boss = await signedIn(browser);
  await boss.getByRole("button", { name: "Settings" }).click();
  const [download] = await Promise.all([
    boss.waitForEvent("download"),
    boss.getByRole("link", { name: "Download an export" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^dinghy-export-.*\.tar$/);
  expect(await download.failure()).toBeNull();
  await boss.getByRole("button", { name: "Open", exact: true }).click();

  const url = await inviteLink(boss);
  const agent = await joinAsNew(browser, url, "Dana");
  await agent.getByRole("button", { name: "Settings" }).click();
  await expect(agent.locator(".team").getByText("dana@example.com")).toBeVisible();
  await expect(agent.getByRole("link", { name: "Download an export" })).toHaveCount(0);
});

test("the settings fit on a phone", async ({ browser }) => {
  const boss = await signedIn(browser);
  await boss.setViewportSize({ width: 390, height: 780 });
  await boss.getByRole("button", { name: "Settings" }).click();
  await expect(boss.getByText("Signing secret")).toBeVisible();
  const overflow = await boss
    .locator(".page")
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
});
