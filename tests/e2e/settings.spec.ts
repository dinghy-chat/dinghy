import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink } from "./links.ts";
import { openSettings, settingsList } from "./settings.ts";

let server: Awaited<ReturnType<typeof startE2EServer>>;

/** Every page of Settings, by its name in the list, its address and its heading. */
const PAGES = [
  { name: "Profile", path: "profile", heading: "Profile" },
  { name: "Notifications", path: "notifications", heading: "Notifications" },
  { name: "Workspace", path: "workspace", heading: "Workspace" },
  { name: "Team", path: "team", heading: "Team" },
  { name: "Appearance", path: "appearance", heading: "Appearance" },
  { name: "Install", path: "install", heading: "Install" },
  { name: "API & webhooks", path: "developers", heading: "API & webhooks" },
];
const MEMBER_PAGES = ["Profile", "Notifications", "Team", "Appearance"];

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("owner@example.com");
  await server.createOperator("member@example.com", { role: "member" });
});

test.afterAll(async () => {
  await server.stop();
});

async function signedIn(browser: Browser, email = "owner@example.com"): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openLink(page, await server.signInLink(email));
  await expect(page.getByRole("button", { name: "Your account" })).toBeVisible();
  return page;
}

/** The open page's title, which is the panel's second heading after "Settings". */
const pageTitle = (page: Page, name: string) =>
  page.locator(".settings-pane").getByRole("heading", { name, exact: true, level: 2 });

test("the grouped list opens each page, by a click and by its address", async ({ browser }) => {
  const page = await signedIn(browser);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const list = settingsList(page);
  await expect(list.getByRole("heading", { level: 3 })).toHaveText([
    "You",
    "Workspace",
    "Chat widget",
    "Developers",
  ]);
  await expect(list.getByRole("link")).toHaveText(PAGES.map((one) => one.name));
  // The title row has no line under it.
  await expect(list.getByRole("heading", { name: "Settings", level: 2 })).toBeVisible();

  for (const one of PAGES) {
    await list.getByRole("link", { name: one.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/${one.path}$`));
    await expect(pageTitle(page, one.heading)).toBeVisible();
    await expect(list.locator('[aria-current="page"]')).toHaveText(one.name);
  }
  for (const one of PAGES) {
    await page.goto(`${server.apiOrigin}/settings/${one.path}`);
    await expect(pageTitle(page, one.heading)).toBeVisible();
    await expect(list.getByRole("link", { name: one.name, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }

  // Back and Forward move between pages, and the sidebar leaves Settings.
  await list.getByRole("link", { name: "Team", exact: true }).click();
  await list.getByRole("link", { name: "Install", exact: true }).click();
  await page.goBack();
  await expect(pageTitle(page, "Team")).toBeVisible();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page).toHaveURL(`${server.apiOrigin}/`);
  await expect(list).toHaveCount(0);
  await page.goBack();
  await expect(pageTitle(page, "Team")).toBeVisible();
  await page.context().close();
});

test("the sidebar keeps Inbox, Analytics and Settings, and Profile opens from the user menu", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  await expect(page.getByRole("navigation", { name: "Main menu" }).getByRole("button")).toHaveText([
    "Inbox",
    "Analytics",
    "Settings",
  ]);
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(pageTitle(page, "Profile")).toBeVisible();
  await page.context().close();
});

test("a member sees only their own pages, and the team and the widget read-only", async ({
  browser,
}) => {
  const page = await signedIn(browser, "member@example.com");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const list = settingsList(page);
  await expect(list.getByRole("link")).toHaveText(MEMBER_PAGES);
  await expect(list.getByRole("heading", { level: 3 })).toHaveText([
    "You",
    "Workspace",
    "Chat widget",
  ]);
  await list.getByRole("link", { name: "Team" }).click();
  await expect(page.getByRole("button", { name: "Invite someone" })).toHaveCount(0);
  await list.getByRole("link", { name: "Appearance" }).click();
  await expect(page.getByText("Only owners and admins can change the widget.")).toBeVisible();
  // An address of a page they cannot see opens their first page instead.
  await page.goto(`${server.apiOrigin}/settings/install`);
  await expect(pageTitle(page, "Profile")).toBeVisible();
  await expect(page.getByText("Install code")).toHaveCount(0);
  await page.context().close();
});

test("the Team page has the Invite button, and no other page does", async ({ browser }) => {
  const page = await signedIn(browser);
  await openSettings(page, "Team");
  const invite = page.locator(".page-head").getByRole("button", { name: "Invite someone" });
  await expect(invite).toBeVisible();
  await invite.click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Invite someone" }),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await settingsList(page).getByRole("link", { name: "Workspace" }).click();
  await expect(page.getByRole("button", { name: "Invite someone" })).toHaveCount(0);
  await page.context().close();
});

test("renaming the workspace shows the new name in the sidebar, here and in another tab", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  const other = await page.context().newPage();
  await other.goto(server.apiOrigin);
  const otherHeading = other.getByRole("heading", { name: "Harbor Labs", level: 1 });
  await openSettings(page, "Workspace");
  const field = page.getByRole("textbox", { name: "Workspace name" });
  const before = await field.inputValue();
  const save = page.locator(".page-row", { has: field }).getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await field.fill("   ");
  await expect(save).toBeDisabled();

  await field.fill("Harbor Labs");
  await save.click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await expect(page.locator(".side .ws-name")).toHaveText("Harbor Labs");
  await expect(page.getByRole("heading", { name: "Harbor Labs", level: 1 })).toBeAttached();
  await expect(otherHeading).toBeAttached();

  await field.fill(before);
  await save.click();
  await expect(page.locator(".side .ws-name")).toHaveText(before);
  await page.context().close();
});

test("on a phone the list is its own screen, and each page opens with a way back", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const list = settingsList(page);
  const back = page.getByRole("button", { name: "Back", exact: true });
  await expect(list).toBeVisible();
  await expect(back).toBeHidden();
  for (const one of PAGES) {
    await list.getByRole("link", { name: one.name, exact: true }).click();
    await expect(pageTitle(page, one.heading)).toBeVisible();
    await expect(list).toBeHidden();
    // Nothing on the page scrolls sideways.
    const overflow = await page
      .locator(".settings-pane .page")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow, one.name).toBe(false);
    await back.click();
    await expect(list).toBeVisible();
    await expect(page).toHaveURL(/\/settings$/);
  }
  await page.context().close();
});
