import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink, signedIn, signInOn, signOut } from "./links.ts";
import { openSettings, settingsList } from "./settings.ts";

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

/** Picks a choice in one of the app's dropdowns, by the dropdown's label. */
async function pick(page: Page, label: string, choice: string) {
  await page.getByRole("button", { name: label }).click();
  await page.getByRole("listbox", { name: label }).getByRole("option", { name: choice }).click();
}

/** Invites an email from Settings. The server emails the invite, and this returns its link. */
async function invite(page: Page, email: string, role: "Member" | "Admin" = "Member") {
  const before = server.mail.filter((one) => one.to === email).length;
  await openSettings(page, "Team");
  await page.getByRole("button", { name: "Invite someone" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("We'll email them a link to join.")).toBeVisible();
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("radio", { name: role }).check();
  await dialog.getByRole("button", { name: "Send invite" }).click();
  await expect(dialog.getByRole("status")).toHaveText(`Invite sent${email} has 7 days to join.`);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".members .email-cell").getByText(email)).toBeVisible();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  return server.linkTo(email, before);
}

/** Opens an invite with no account, and joins with a name only: the invite holds the email. */
async function joinAsNew(browser: Browser, url: string, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByRole("heading", { name: /^Join / })).toBeVisible();
  await expect(
    page.getByText(`invited ${name.toLowerCase()}@example.com to join as`, { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: /^Join / }).click();
  await expect(page.getByRole("button", { name: "Your account" })).toBeVisible();
  return page;
}

test("an owner invites a member, assigns a chat to them, then removes them @smoke", async ({
  browser,
}) => {
  const boss = await signedIn(browser, server, "owner@example.com");
  const url = await invite(boss, "ben@example.com");
  const member = await joinAsNew(browser, url, "Ben");

  // A member sees the team, and no settings for the widget.
  await openSettings(member, "Team");
  await expect(member.locator(".members .email-cell").getByText("ben@example.com")).toBeVisible();
  await expect(settingsList(member).getByRole("link", { name: "Install" })).toHaveCount(0);
  await expect(member.getByText("Invite someone")).toHaveCount(0);
  await member.getByRole("button", { name: "Inbox", exact: true }).click();

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
  // The member's open app learns this from the stream.
  await expect(member.locator(".row", { hasText: "assign me" })).toContainText("Ben");

  await openSettings(boss, "Team");
  await boss.getByRole("button", { name: "Remove Ben" }).click();
  await expect(boss.getByRole("alertdialog")).toContainText("Remove Ben?");
  await boss.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(boss.locator(".members .email-cell").getByText("ben@example.com")).toHaveCount(0);
  await boss.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(boss.locator(".row", { hasText: "assign me" })).not.toContainText("Ben");

  await member.reload();
  await expect(member.getByText("You are not in a workspace on this server.")).toBeVisible();
  await server.closeConversations();
});

test("an owner changes the allowed sites and replaces the secret", async ({ browser }) => {
  const boss = await signedIn(browser, server, "owner@example.com");
  await openSettings(boss, "Install");
  await expect(boss.locator(".page pre").first()).toContainText("data-key=");

  // Each saved site is a card, and the field shows only after "Add a site".
  const cards = boss.locator(".site-card");
  await expect(cards).toHaveCount(1);
  const field = boss.getByRole("textbox", { name: "Website address" });
  await expect(field).toHaveCount(0);

  // A bad site is refused, and Cancel closes the field.
  await boss.getByRole("button", { name: "Add a site" }).click();
  await expect(field).toBeFocused();
  await field.fill("not a site");
  await boss.getByRole("button", { name: "Add", exact: true }).click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(boss.getByRole("alert")).toHaveText(
    "Enter a site like https://example.com, with no path after it.",
  );
  await boss.getByRole("button", { name: "Cancel" }).click();
  await expect(field).toHaveCount(0);

  // A good one saves at once and becomes a card.
  await boss.getByRole("button", { name: "Add a site" }).click();
  await field.fill("https://second.example.com");
  await field.press("Enter");
  await expect(boss.locator(".toast")).toHaveText("Site added.");
  await expect(field).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  await boss.reload();
  await expect(boss).toHaveURL(/\/settings\/install\?workspace=/);
  await expect(cards.nth(1)).toHaveText("https://second.example.com");

  // Remove a site.
  await boss.getByRole("button", { name: "Remove https://second.example.com" }).click();
  await expect(boss.locator(".toast")).toHaveText("Site removed.");
  await expect(cards).toHaveCount(1);
  await boss.reload();
  await expect(boss).toHaveURL(/\/settings\/install\?workspace=/);
  await expect(cards).toHaveCount(1);

  // The secret is masked until the eye shows it, and replacing it asks first.
  const secret = boss.getByRole("textbox", { name: "Identity signing secret" });
  await expect(secret).toHaveAttribute("type", "password");
  await boss.getByRole("button", { name: "Show the secret" }).click();
  await expect(secret).toHaveAttribute("type", "text");
  const before = await secret.inputValue();
  expect(before.length).toBeGreaterThan(20);
  await boss.getByRole("button", { name: "Hide the secret" }).click();
  await expect(secret).toHaveAttribute("type", "password");
  await boss.getByRole("button", { name: "Replace the secret" }).click();
  await expect(boss.getByRole("alertdialog")).toContainText(
    "stops chat access for identified users",
  );
  await boss.getByRole("button", { name: "Cancel" }).click();
  await boss.getByRole("button", { name: "Replace the secret" }).click();
  await boss.getByRole("button", { name: "Replace it" }).click();
  await expect(secret).not.toHaveValue(before);
});

test("an existing account joins by an emailed link, which works once", async ({ browser }) => {
  const boss = await signedIn(browser, server, "owner@example.com");
  await server.createOperator("eve@example.com", { member: false });
  const url = await invite(boss, "eve@example.com");
  const page = await (await browser.newContext()).newPage();
  await page.goto(url);
  await expect(page.getByLabel("Your name")).toHaveCount(0);
  // Before the click, the page says an email comes first, since the link may have been forwarded.
  await expect(
    page.getByText(
      "You already have a Dinghy account. We'll email you a sign-in link to confirm it's you, then you join E2E.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    "We sent a sign-in link to eve@example.com. Open it within 15 minutes to join E2E.",
  );
  const link = await server.linkTo("eve@example.com", 1);
  await openLink(page, link, "Join the team");
  await expect(page.getByRole("button", { name: "Your account" })).toBeVisible();

  const again = await (await browser.newContext()).newPage();
  await openLink(again, link, "Join the team");
  await expect(again.getByRole("alert")).toHaveText(
    "That link has expired or was already used. Open your invite link again to get a new one.",
  );
  await expect(again.getByRole("link")).toHaveCount(0);
  await expect(again.getByRole("button")).toHaveCount(0);
  for (const one of [boss, page, again]) await one.context().close();
});

test("revoking an invite asks first, and someone signed in as another email cannot use it", async ({
  browser,
}) => {
  const boss = await signedIn(browser, server, "owner@example.com");
  const url = await invite(boss, "rex@example.com");
  const other = await signedIn(browser, server, "owner@example.com");
  await other.goto(url);
  await expect(
    other.getByText(
      "This invite is for rex@example.com, but you are signed in as owner@example.com.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(other.getByRole("button", { name: /^Join / })).toHaveCount(0);

  await openSettings(boss, "Team");
  const revoke = boss.getByRole("button", { name: "Cancel the invite for rex@example.com" });
  await revoke.click();
  await expect(boss.getByRole("alertdialog")).toContainText(
    "Cancel the invite for rex@example.com?",
  );
  await boss.getByRole("button", { name: "Keep invite" }).click();
  await expect(revoke).toBeVisible();
  await revoke.click();
  await boss.getByRole("button", { name: "Cancel invite" }).click();
  await expect(revoke).toHaveCount(0);
  await other.reload();
  await expect(other.getByRole("heading", { name: "This invite no longer works" })).toBeVisible();
  for (const one of [boss, other]) await one.context().close();
});

test("someone with an account joins a second workspace and switches between them", async ({
  browser,
}) => {
  const boss = await signedIn(browser, server, "owner@example.com");
  const url = await invite(boss, "multi@example.com");
  const other = await server.createSecondWorkspace("Other", "multi@example.com");
  const page = await signedIn(browser, server, "multi@example.com");
  await page.goto(url);
  await expect(
    page.getByText("invited multi@example.com to join as", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Join / }).click();

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
  const boss = await signedIn(browser, server, "owner@example.com");
  const url = await invite(boss, "two@example.com");
  const laterUrl = await invite(boss, "cara@example.com");
  await server.createSecondWorkspace("Elsewhere", "two@example.com");
  const person = await signedIn(browser, server, "two@example.com");
  await person.goto(url);
  await person.getByRole("button", { name: /^Join / }).click();
  await expect(person.getByRole("heading", { name: "E2E", exact: true })).toBeVisible();
  await person.reload();
  await expect(person.getByRole("heading", { name: "E2E", exact: true })).toBeVisible();

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

  // A promotion shows in the member's open app, with no reload.
  await person.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settingsList(person).getByRole("link", { name: "Install" })).toHaveCount(0);
  await person.getByRole("button", { name: "Inbox", exact: true }).click();
  await openSettings(boss, "Team");
  await pick(boss, "Role: two@example.com", "Admin");
  await expect(async () => {
    await person.getByRole("button", { name: "Settings", exact: true }).click();
    try {
      await expect(settingsList(person).getByRole("link", { name: "Install" })).toBeVisible({
        timeout: 1000,
      });
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
  const first = await signedIn(browser, server, "owner@example.com");
  const second = await first.context().newPage();
  await second.goto(server.apiOrigin);
  await signOut(second);
  await signInOn(second, server, "owner@example.com");

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

test("an owner downloads an export from Settings, and a member sees no link", async ({
  browser,
}) => {
  const boss = await signedIn(browser, server, "owner@example.com");
  await openSettings(boss, "Workspace");
  const [download] = await Promise.all([
    boss.waitForEvent("download"),
    boss.getByRole("link", { name: "Download an export" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^dinghy-export-.*\.tar$/);
  expect(await download.failure()).toBeNull();
  await boss.getByRole("button", { name: "Inbox", exact: true }).click();

  const url = await invite(boss, "dana@example.com");
  const member = await joinAsNew(browser, url, "Dana");
  await openSettings(member, "Team");
  await expect(member.locator(".members .email-cell").getByText("dana@example.com")).toBeVisible();
  await expect(settingsList(member).getByRole("link", { name: "Workspace" })).toHaveCount(0);
  await member.goto(`${server.apiOrigin}/settings/workspace`);
  await expect(member.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(member.getByRole("link", { name: "Download an export" })).toHaveCount(0);
});

test("the last owner cannot lower their role or leave, and the app says why", async ({
  browser,
}) => {
  const lone = `lone-${Date.now()}@example.com`;
  const { id } = await server.createSecondWorkspace("Solo", lone);
  const page = await signedIn(browser, server, lone);
  await page.goto(`${server.apiOrigin}/?workspace=${id}`);
  await expect(page.getByRole("heading", { name: "Solo" })).toBeVisible();
  await openSettings(page, "Team");
  await expect(page.getByRole("button", { name: `Role: ${lone}` })).toBeDisabled();
  const leaveButton = page.getByRole("button", { name: "Leave the workspace" });
  await expect(leaveButton).toBeDisabled();
  // It says why on hover, and to a screen reader.
  await leaveButton.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(leaveButton).toHaveAccessibleDescription(
    "You can't leave while you're the only owner.",
  );
  await expect(page.getByText(/^You're the only owner\./)).toBeVisible();
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

test("a sole owner's account delete says what happens to each workspace", async ({ browser }) => {
  const lone = `sole-${Date.now()}@example.com`;
  const { id } = await server.createSecondWorkspace("Harbor", lone);
  const page = await signedIn(browser, server, lone);
  await page.goto(`${server.apiOrigin}/?workspace=${id}`);
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await page.getByRole("button", { name: "Delete my account" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.locator(".outcome")).toHaveText([
    "Harbor is deleted with all its conversations, because nobody else is in it.",
  ]);
  await expect(dialog.getByRole("button", { name: "Email me the link" })).toBeEnabled();
  await page.context().close();
});

async function myId(page: Page): Promise<string> {
  const me = await page.request.get(`${server.apiOrigin}/v1/operator/me`);
  return ((await me.json()) as { id: string }).id;
}

test("the user menu opens the profile, which saves a new name", async ({ browser }) => {
  const page = await signedIn(browser, server, "owner@example.com");
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
