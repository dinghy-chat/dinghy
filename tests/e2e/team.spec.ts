import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink, signOut } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/plain": { html: `<!doctype html><title>Host</title>${SNIPPET}` },
  });
  await server.createOperator("owner@example.com");
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
  await openLink(page, await server.signInLink(email));
  await expect(page.getByRole("button", { name: "Your account" })).toBeVisible();
  return page;
}

/** Picks a choice in one of the app's dropdowns, by the dropdown's label. */
async function pick(page: Page, label: string, choice: string) {
  await page.getByRole("button", { name: label }).click();
  await page.getByRole("listbox", { name: label }).getByRole("option", { name: choice }).click();
}

/** Opens Settings on one of its tabs. */
async function settingsTab(page: Page, tab: string) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: tab }).click();
}

async function inviteLink(page: Page, role: "Agent" | "Admin" = "Agent"): Promise<string> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Invite someone" }).click();
  await pick(page, "Role for the invite", role);
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = page.getByRole("textbox", { name: "Invite link" });
  await expect(link).toHaveValue(/\/invite\?token=/);
  const url = await link.inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  return url;
}

async function joinAsNew(browser: Browser, url: string, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Join a workspace" })).toBeVisible();
  const email = `${name.toLowerCase()}@example.com`;
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  // The link joins and signs in, in this same browser.
  await openLink(page, await server.linkTo(email), "Join the team");
  await expect(page.getByRole("button", { name: "Your account" })).toBeVisible();
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
  await expect(agent.locator(".members .email-cell").getByText("ben@example.com")).toBeVisible();
  await expect(agent.getByText("Signing secret")).toHaveCount(0);
  await expect(agent.getByText("Invite someone")).toHaveCount(0);
  await agent.getByRole("button", { name: "Inbox", exact: true }).click();

  // The same link does not work twice.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(url);
  await expect(
    stranger.getByRole("heading", { name: "This invite no longer works" }),
  ).toBeVisible();
  await expect(stranger.getByText("expired or was already used")).toBeVisible();

  await server.seedConversations(1, "assign me");
  await boss.reload();
  await boss.locator(".row", { hasText: "assign me" }).click();
  await pick(boss, "Assign to", "Ben");
  await expect(boss.locator(".row", { hasText: "assign me" })).toContainText("Ben");
  // The agent's open app learns this from the stream.
  await expect(agent.locator(".row", { hasText: "assign me" })).toContainText("Ben");

  await boss.getByRole("button", { name: "Settings" }).click();
  await boss.getByRole("button", { name: "Remove Ben" }).click();
  await expect(boss.getByRole("alertdialog")).toContainText("Remove Ben?");
  await boss.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(boss.locator(".members .email-cell").getByText("ben@example.com")).toHaveCount(0);
  await boss.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(boss.locator(".row", { hasText: "assign me" })).not.toContainText("Ben");

  await agent.reload();
  await expect(agent.getByText("You are not in a workspace yet.")).toBeVisible();
  await server.closeConversations();
});

test("an owner changes the allowed sites and replaces the secret", async ({ browser }) => {
  const boss = await signedIn(browser);
  await settingsTab(boss, "Install");
  await expect(boss.locator(".page pre").first()).toContainText("data-key=");
  await boss.getByRole("tab", { name: "Allowed sites" }).click();

  const first = boss.getByRole("textbox", { name: "Site 1" });
  const original = await first.inputValue();
  const save = boss.getByRole("button", { name: "Save", exact: true });

  // Add a site: a new empty row, with the focus in it. A bad one is named under its own row.
  await boss.getByRole("button", { name: "Add a site" }).click();
  const second = boss.getByRole("textbox", { name: "Site 2" });
  await expect(second).toBeFocused();
  await second.fill("not a site");
  await save.click();
  await expect(second).toHaveAttribute("aria-invalid", "true");
  await expect(second).toHaveAccessibleDescription(
    "Enter a site like https://example.com, with no path after it.",
  );
  await expect(first).toHaveAttribute("aria-invalid", "false");
  await second.fill("https://second.example.com");
  await expect(boss.getByText("with no path after it")).toHaveCount(0);
  await save.click();
  await expect(boss.getByRole("status")).toHaveText("Saved.");
  await boss.reload();
  await settingsTab(boss, "Allowed sites");
  await expect(boss.getByRole("textbox", { name: "Site 1" })).toHaveValue(original);
  await expect(boss.getByRole("textbox", { name: "Site 2" })).toHaveValue(
    "https://second.example.com",
  );

  // Remove a site.
  await boss.getByRole("button", { name: "Remove https://second.example.com" }).click();
  await expect(boss.getByRole("textbox", { name: "Site 2" })).toHaveCount(0);
  await save.click();
  await expect(boss.getByRole("status")).toHaveText("Saved.");
  await boss.reload();
  await settingsTab(boss, "Allowed sites");
  await expect(boss.getByRole("textbox", { name: /^Site/ })).toHaveCount(1);

  // The secret is masked until the eye shows it, and replacing it asks first.
  await boss.getByRole("tab", { name: "Signing secret" }).click();
  const secret = boss.getByRole("textbox", { name: "Signing secret" });
  await expect(secret).toHaveAttribute("type", "password");
  await boss.getByRole("button", { name: "Show the secret" }).click();
  await expect(secret).toHaveAttribute("type", "text");
  const before = await secret.inputValue();
  expect(before.length).toBeGreaterThan(20);
  await boss.getByRole("button", { name: "Hide the secret" }).click();
  await expect(secret).toHaveAttribute("type", "password");
  await boss.getByRole("button", { name: "Replace the secret" }).click();
  await expect(boss.getByRole("alertdialog")).toContainText("stops working at once");
  await boss.getByRole("button", { name: "Cancel" }).click();
  await boss.getByRole("button", { name: "Replace the secret" }).click();
  await boss.getByRole("button", { name: "Replace it" }).click();
  await expect(secret).not.toHaveValue(before);
});

test("a used join link says to open the invite again, with no way to the sign-in page", async ({
  browser,
}) => {
  const boss = await signedIn(browser);
  const url = await inviteLink(boss);
  const joined = await joinAsNew(browser, url, "Eve");
  const page = await (await browser.newContext()).newPage();
  await openLink(page, await server.linkTo("eve@example.com"), "Join the team");
  await expect(page.getByRole("alert")).toHaveText(
    "That link has expired or was already used. Open your invite link again to get a new one.",
  );
  await expect(page.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveCount(0);
  for (const one of [boss, joined, page]) await one.context().close();
});

test("someone with an account joins a second workspace and switches between them", async ({
  browser,
}) => {
  const boss = await signedIn(browser);
  const url = await inviteLink(boss);
  const other = await server.createSecondWorkspace("Other", "multi@example.com");
  const page = await signedIn(browser, "multi@example.com");
  await page.goto(url);
  await expect(page.getByText("You are signed in as multi@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Join", exact: true }).click();

  // The workspace pill opens a menu of both, with a check on the current one.
  const switcher = page.getByRole("button", { name: /^Workspace:/ });
  await expect(switcher).toHaveAccessibleName("Workspace: E2E");
  await switcher.click();
  const menu = page.getByRole("menu");
  // Each item's initials are a picture, so only the label counts.
  const labels = menu.getByRole("menuitemradio").locator(".item-label");
  await expect(labels).toHaveCount(2);
  expect((await labels.allTextContents()).sort()).toEqual(["E2E", "Other"]);
  await expect(menu.getByRole("menuitemradio", { name: "E2E" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // A self-hosted server makes no workspaces from the app.
  await expect(menu.getByRole("menuitem", { name: "Create a workspace" })).toHaveCount(0);
  await menu.getByRole("menuitemradio", { name: "Other" }).click();
  await expect(page.getByRole("heading", { name: "Other" })).toBeVisible();
  await expect(switcher).toHaveAccessibleName("Workspace: Other");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Other" })).toBeVisible();
  expect(other.id).not.toBe(server.workspaceId());
});

test("an open app sees team changes, and a removal opens the other workspace", async ({
  browser,
}) => {
  const boss = await signedIn(browser);
  const url = await inviteLink(boss);
  const laterUrl = await inviteLink(boss);
  await server.createSecondWorkspace("Elsewhere", "two@example.com");
  const person = await signedIn(browser, "two@example.com");
  await person.goto(url);
  await person.getByRole("button", { name: "Join", exact: true }).click();
  await expect(person.getByRole("heading", { name: "E2E" })).toBeVisible();
  await person.reload();
  await expect(person.getByRole("heading", { name: "E2E" })).toBeVisible();

  await server.seedConversations(1, "live roster");
  await boss.reload();
  await boss.locator(".row", { hasText: "live roster" }).click();
  const assignees = async () => {
    await boss.getByRole("button", { name: /^Assign to/ }).click();
    const names = await boss
      .getByRole("listbox", { name: "Assign to" })
      .getByRole("option")
      .locator(".item-label")
      .allTextContents();
    await boss.keyboard.press("Escape");
    return names;
  };
  await expect.poll(assignees).toContain("two@example.com");
  // Someone joins while this page stays open, with no dialog or reload to refresh the list.
  await joinAsNew(browser, laterUrl, "Cara");
  await expect.poll(assignees).toContain("Cara");

  // A promotion shows in the agent's open app, with no reload.
  await person.getByRole("button", { name: "Settings" }).click();
  await expect(person.getByText("Signing secret")).toHaveCount(0);
  await person.getByRole("button", { name: "Inbox", exact: true }).click();
  await boss.getByRole("button", { name: "Settings" }).click();
  await pick(boss, "Role: two@example.com", "Admin");
  await expect(async () => {
    await person.getByRole("button", { name: "Settings" }).click();
    try {
      await expect(person.getByText("Signing secret")).toBeVisible({ timeout: 1000 });
    } finally {
      await person.getByRole("button", { name: "Inbox", exact: true }).click();
    }
  }).toPass();

  // A removal ends this workspace for them and leaves them signed in to the other one.
  await boss.getByRole("button", { name: "Remove two@example.com" }).click();
  await boss.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(boss.locator(".members .email-cell").getByText("two@example.com")).toHaveCount(0);
  await boss.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect.poll(assignees).not.toContain("two@example.com");
  await expect(person.getByRole("heading", { name: "Elsewhere" })).toBeVisible();
  await expect(person.getByRole("heading", { name: "Sign in to Dinghy" })).toHaveCount(0);
  await server.closeConversations();
});

test("a window whose session ended elsewhere reconnects with the new one", async ({ browser }) => {
  const first = await signedIn(browser);
  const second = await first.context().newPage();
  await second.goto(server.apiOrigin);
  await signOut(second);
  await openLink(second, await server.signInLink("owner@example.com"));
  await expect(second.getByRole("button", { name: "Your account" })).toBeVisible();

  // The next event ends the first window's old stream, and a later one must still arrive.
  await server.seedConversations(1, "after sign in");
  await server.wakeOperators();
  await expect(first.getByRole("button", { name: "Your account" })).toBeVisible();
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
  await settingsTab(boss, "Data");
  const [download] = await Promise.all([
    boss.waitForEvent("download"),
    boss.getByRole("link", { name: "Download an export" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^dinghy-export-.*\.tar$/);
  expect(await download.failure()).toBeNull();
  await boss.getByRole("button", { name: "Inbox", exact: true }).click();

  const url = await inviteLink(boss);
  const agent = await joinAsNew(browser, url, "Dana");
  await agent.getByRole("button", { name: "Settings" }).click();
  await expect(agent.locator(".members .email-cell").getByText("dana@example.com")).toBeVisible();
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

test("the last owner cannot lower their role or leave, and the app says why", async ({
  browser,
}) => {
  const lone = `lone-${Date.now()}@example.com`;
  const { id } = await server.createSecondWorkspace("Solo", lone);
  const page = await signedIn(browser, lone);
  await page.goto(`${server.apiOrigin}/?workspace=${id}`);
  await expect(page.getByRole("heading", { name: "Solo" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: `Role: ${lone}` })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Leave the workspace" })).toBeDisabled();
  await expect(page.getByText("You're the only owner.")).toBeVisible();
  // The server refuses it too, for a client that skips the app.
  const leave = await page.request.delete(
    `${server.apiOrigin}/v1/operator/workspaces/${id}/members/${await myId(page)}`,
    { headers: { origin: server.apiOrigin } },
  );
  expect(leave.status()).toBe(409);
  expect(await leave.json()).toEqual({
    error: {
      code: "last_owner",
      message: "A workspace needs an owner. Make someone else owner first.",
    },
  });
  await page.context().close();
});

async function myId(page: Page): Promise<string> {
  const me = await page.request.get(`${server.apiOrigin}/v1/operator/me`);
  return ((await me.json()) as { id: string }).id;
}

test("the user menu opens the profile, which saves a new name", async ({ browser }) => {
  const page = await signedIn(browser);
  const account = page.getByRole("button", { name: "Your account" });
  await expect(account).toHaveAttribute("aria-haspopup", "menu");
  await account.click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Profile", "Sign out"]);
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("owner@example.com");
  await expect(page.getByLabel("Email", { exact: true })).not.toBeEditable();
  await page.getByLabel("Name", { exact: true }).fill("Olive Owner");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await expect(page.locator(".me")).toContainText("Olive Owner");

  // The menu's other item signs out.
  await signOut(page);
  await expect(page.getByRole("heading", { name: "Sign in to Dinghy" })).toBeVisible();
  await page.context().close();
});
