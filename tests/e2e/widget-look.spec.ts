import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn, signInOn } from "./links.ts";
import { openSettings, settingsList } from "./settings.ts";

const tag = (attributes = "") =>
  `<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" ${attributes} async></script>`;
const page = (attributes = "") => ({
  html: `<!doctype html><title>Host</title><h1>Host</h1>${tag(attributes)}`,
});

// What a new workspace saves, so each test starts from it.
const DEFAULTS = {
  primary: null,
  accent: null,
  position: "right",
  theme: "auto",
  launcher: "bubble",
  radius: 16,
  emailAsk: "after_first",
  branding: true,
} as const;

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer(
    {
      "/plain": page(),
      "/tagged": page('data-accent="#ff0000" data-position="right" data-launcher="boat"'),
      "/no-branding": page('data-branding="false"'),
    },
    { emailAvailable: true },
  );
  await server.createOperator("owner@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

test.beforeEach(async () => {
  await server.setWidgetSettings(DEFAULTS);
});

/** A new visitor's page, in a context of its own, so no answer comes from the cache. */
async function visit(browser: Browser, path = "/plain", options = {}): Promise<Page> {
  const context = await browser.newContext(options);
  const visitor = await context.newPage();
  await visitor.goto(`${server.hostOrigin}${path}`);
  return visitor;
}

const launcher = (visitor: Page) => visitor.getByRole("button", { name: "Open chat" });
const hostStyle = (visitor: Page, name: string) =>
  visitor.locator("dinghy-chat").evaluate((host, property) => {
    return (host as HTMLElement).style.getPropertyValue(property);
  }, name);
/** The panel's paper, under its header's color: the last stop of its background's gradient. */
const paper = (visitor: Page) =>
  visitor.locator(".panel").evaluate((element) =>
    getComputedStyle(element)
      .backgroundImage.match(/rgb\([^)]*\)/g)
      ?.at(-1),
  );

test("the loader draws the launcher with the saved look", async ({ browser }) => {
  await server.setWidgetSettings({
    launcher: "bubble",
    accent: "#1f6bff",
    position: "left",
    radius: 4,
  });
  const visitor = await visit(browser);
  await expect(launcher(visitor)).toHaveClass("launcher bubble");
  expect(await hostStyle(visitor, "--d-accent")).toBe("#1f6bff");
  expect(await hostStyle(visitor, "--d-radius")).toBe("4px");
  await expect(visitor.locator("dinghy-chat")).toHaveAttribute("data-side", "left");
  await visitor.context().close();
});

test("the loader draws a square with the saved corners, and a label with the chat's title", async ({
  browser,
}) => {
  await server.setWidgetSettings({ launcher: "square", radius: 4 });
  const square = await visit(browser);
  await expect(launcher(square)).toHaveClass("launcher square");
  expect(await launcher(square).evaluate((button) => getComputedStyle(button).borderRadius)).toBe(
    "4px",
  );
  await square.context().close();

  // The title is text, never markup.
  await server.setWidgetSettings({ launcher: "label", title: "<i>Ask</i> us" });
  const label = await visit(browser);
  await expect(launcher(label)).toHaveClass("launcher label");
  await expect(launcher(label).locator("svg")).toBeVisible();
  await expect(launcher(label).locator("b")).toHaveText("<i>Ask</i> us");
  await label.context().close();

  // With no saved title, the label shows the chat's own.
  await server.setWidgetSettings({ title: null });
  const fallback = await visit(browser);
  await expect(launcher(fallback).locator("b")).toHaveText("Chat with us");
  await fallback.context().close();
});

test("the tag's attributes win over the saved look", async ({ browser }) => {
  await server.setWidgetSettings({ launcher: "bubble", accent: "#1f6bff", position: "left" });
  const visitor = await visit(browser, "/tagged");
  await expect(launcher(visitor)).toHaveClass("launcher boat");
  expect(await hostStyle(visitor, "--d-accent")).toBe("#ff0000");
  await expect(visitor.locator("dinghy-chat")).toHaveAttribute("data-side", "right");
  await visitor.context().close();
});

test("with no answer, the launcher draws from the tag and the defaults", async ({ browser }) => {
  await server.setWidgetSettings({ launcher: "bubble" });
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await visitor.route("**/appearance", (route) => route.abort());
  await visitor.goto(`${server.hostOrigin}/plain`);
  await expect(launcher(visitor)).toHaveClass("launcher bubble");
  await launcher(visitor).click();
  await expect(visitor.locator(".head b")).toHaveText("Chat with us");
  await context.close();
});

test("a workspace whose widget is off draws nothing", async ({ browser }) => {
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await visitor.route("**/appearance", (route) =>
    route.fulfill({
      status: 404,
      headers: { "access-control-allow-origin": "*" },
      json: { error: { code: "not_found", message: "This does not exist." } },
    }),
  );
  const answered = visitor.waitForResponse((response) => response.url().endsWith("/appearance"));
  await visitor.goto(`${server.hostOrigin}/plain`);
  await answered;
  await visitor.waitForTimeout(200);
  await expect(visitor.locator("dinghy-chat")).toHaveCount(0);
  await context.close();
});

test.describe("the theme", () => {
  const PAPER_DARK = "rgb(20, 38, 59)";
  const PAPER_LIGHT = "rgb(255, 255, 255)";

  test("dark gives the chat its dark colors on a light device", async ({ browser }) => {
    await server.setWidgetSettings({ theme: "dark" });
    const visitor = await visit(browser, "/plain", { colorScheme: "light" });
    await launcher(visitor).click();
    await expect(visitor.locator("dinghy-chat")).toHaveAttribute("data-theme", "dark");
    expect(await paper(visitor)).toBe(PAPER_DARK);
    await visitor.context().close();
  });

  test("auto follows the device, and light stays light on a dark one", async ({ browser }) => {
    const dark = await visit(browser, "/plain", { colorScheme: "dark" });
    await launcher(dark).click();
    expect(await paper(dark)).toBe(PAPER_DARK);
    await dark.context().close();

    await server.setWidgetSettings({ theme: "light" });
    const light = await visit(browser, "/plain", { colorScheme: "dark" });
    await launcher(light).click();
    expect(await paper(light)).toBe(PAPER_LIGHT);
    await light.context().close();
  });
});

test("before the first message, the email takes the message box's place until it is given", async ({
  browser,
}) => {
  await server.setWidgetSettings({ emailAsk: "before_first" });
  const visitor = await visit(browser);
  await launcher(visitor).click();
  const email = visitor.getByRole("textbox", { name: "Your email, so we can reply if you leave" });
  await expect(email).toBeVisible();
  await expect(visitor.getByRole("textbox", { name: "Your message" })).toHaveCount(0);
  await email.fill("visitor@example.com");
  await visitor.getByRole("button", { name: "Save" }).click();
  await expect(visitor.getByText("Thanks. We will use this email if you leave.")).toBeVisible();
  await expect(visitor.getByRole("textbox", { name: "Your message" })).toBeVisible();
  await expect(email).toHaveCount(0);
  // The server holds the email, so the next page, where the chat stays open, does not ask again.
  await visitor.reload();
  await expect(visitor.getByRole("textbox", { name: "Your message" })).toBeVisible();
  await expect(email).toHaveCount(0);
  await visitor.context().close();
});

test("before the first message, a failed save keeps the email form and its error", async ({
  browser,
}) => {
  await server.setWidgetSettings({ emailAsk: "before_first" });
  const visitor = await visit(browser);
  // The first save makes the visitor, and then the server refuses the email.
  await visitor.route("**/me", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const refused = await route.fetch({ postData: JSON.stringify({ email: "not an email" }) });
    await route.fulfill({ response: refused });
  });
  await launcher(visitor).click();
  // By its type, as an error takes the label's place.
  const email = visitor.locator("input[type=email]");
  await email.fill("visitor@example.com");
  await visitor.getByRole("button", { name: "Save" }).click();
  await expect(visitor.getByText("Enter a valid email.")).toBeVisible();
  await expect(email).toBeVisible();
  await expect(visitor.getByRole("textbox", { name: "Your message" })).toHaveCount(0);

  // A lost answer keeps it too, and the next save opens the message box.
  await visitor.unroute("**/me");
  await visitor.route("**/me", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  await visitor.getByRole("button", { name: "Save" }).click();
  await expect(visitor.getByText("Not saved. Try again.")).toBeVisible();
  await expect(email).toBeVisible();
  await visitor.unroute("**/me");
  await visitor.getByRole("button", { name: "Save" }).click();
  await expect(visitor.getByRole("textbox", { name: "Your message" })).toBeVisible();
  await expect(email).toHaveCount(0);
  await visitor.context().close();
});

test("before the first message, a visitor with a token waits for the server, and asks if it fails", async ({
  browser,
}) => {
  await server.setWidgetSettings({ emailAsk: "before_first" });
  const visitor = await visit(browser);
  // A refused save leaves a token and no email.
  await visitor.route("**/me", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const refused = await route.fetch({ postData: JSON.stringify({ email: "not an email" }) });
    await route.fulfill({ response: refused });
  });
  await launcher(visitor).click();
  await visitor.locator("input[type=email]").fill("visitor@example.com");
  await visitor.getByRole("button", { name: "Save" }).click();
  await expect(visitor.getByText("Enter a valid email.")).toBeVisible();

  // On the next page, the server's answer about the email is held back.
  await visitor.unroute("**/me");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await visitor.route("**/me", async (route) => {
    await held;
    await route.abort();
  });
  await visitor.reload();
  await expect(visitor.getByRole("region", { name: "Chat with us" })).toBeVisible();
  await expect(visitor.locator("input[type=email]")).toHaveCount(0);
  await expect(visitor.getByRole("textbox", { name: "Your message" })).toHaveCount(0);
  // With no answer, it asks for the email, and still not for a message.
  release();
  await expect(visitor.locator("input[type=email]")).toBeVisible();
  await expect(visitor.getByRole("textbox", { name: "Your message" })).toHaveCount(0);
  await visitor.context().close();
});

test("a returning visitor's unread count shows on the launcher, even before the look arrives", async ({
  browser,
}) => {
  const visitor = await visit(browser);
  await launcher(visitor).click();
  const message = visitor.getByRole("textbox", { name: "Your message" });
  await message.fill("Anyone there?");
  await message.press("Enter");
  await expect(visitor.locator(".state", { hasText: "Sending" })).toHaveCount(0);
  await visitor.keyboard.press("Escape");
  await server.reply("We are here.");

  // The look waits until the chat knows the count.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await visitor.route("**/appearance", async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await visitor.reload();
  await expect
    .poll(() =>
      visitor.evaluate(
        () => (globalThis as { Dinghy?: { state: { unread: number } } }).Dinghy?.state.unread,
      ),
    )
    .toBe(1);
  release();
  await expect(visitor.getByRole("button", { name: "Open chat (1)" })).toBeVisible();
  await visitor.context().close();
});

test.describe("the Powered by Dinghy line", () => {
  const branding = (visitor: Page) => visitor.getByRole("link", { name: "Powered by Dinghy" });

  test("shows by default, as a plain link", async ({ browser }) => {
    const visitor = await visit(browser);
    await launcher(visitor).click();
    await expect(branding(visitor)).toHaveAttribute("href", "https://dinghy.chat");
    await expect(branding(visitor)).toHaveAttribute("rel", "noopener");
    await visitor.context().close();
  });

  test("hides with the setting", async ({ browser }) => {
    await server.setWidgetSettings({ branding: false });
    const visitor = await visit(browser);
    await launcher(visitor).click();
    await expect(visitor.locator(".head b")).toHaveText("Chat with us");
    await expect(branding(visitor)).toHaveCount(0);
    await visitor.context().close();
  });

  test("hides with the tag's data-branding", async ({ browser }) => {
    const visitor = await visit(browser, "/no-branding");
    await launcher(visitor).click();
    await expect(visitor.locator(".head b")).toHaveText("Chat with us");
    await expect(branding(visitor)).toHaveCount(0);
    await visitor.context().close();
  });
});

test("an owner changes the color, theme and launcher in Appearance, and the site shows them", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const owner = await context.newPage();
  await signInOn(owner, server, "owner@example.com");
  await openSettings(owner, "Appearance");
  const form = owner.locator(".widget-form");
  const save = form.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();

  await form.getByRole("textbox", { name: "Accent color as a hex code" }).fill("#1f6bff");
  // An auto theme shows the visitor's device, which the operator picks.
  const device = owner.getByRole("group", { name: "Show the chat on a light or dark device" });
  await device.getByRole("radio", { name: "Dark" }).check();
  await expect(owner.locator(".preview-stage > div")).toHaveAttribute("data-theme", "dark");
  await form.getByRole("group", { name: "Theme" }).getByRole("radio", { name: "Light" }).check();
  await expect(device).toHaveCount(0);
  await expect(owner.locator(".preview-stage > div")).toHaveAttribute("data-theme", "light");
  await form.getByRole("group", { name: "Theme" }).getByRole("radio", { name: "Dark" }).check();
  await form.getByRole("radio", { name: "Label" }).check();
  // The preview changes before the save, and shows the open chat and its button together.
  const preview = owner.locator(".preview-stage > div");
  await expect(preview.locator(".panel")).toBeVisible();
  await expect(preview.locator(".launcher.label")).toContainText("Chat with us");
  await save.click();
  await expect(
    owner.getByText("Saved. New pages of your site show this within 5 minutes."),
  ).toBeVisible();
  await expect(save).toBeDisabled();

  const visitor = await visit(browser);
  await expect(launcher(visitor)).toHaveClass("launcher label");
  expect(await hostStyle(visitor, "--d-accent")).toBe("#1f6bff");
  await launcher(visitor).click();
  await expect(visitor.locator("dinghy-chat")).toHaveAttribute("data-theme", "dark");
  await visitor.context().close();
  await context.close();
});

test("Back with unsaved Appearance changes asks first, and Stay keeps them and the address", async ({
  browser,
}) => {
  const owner = await signedIn(browser, server, "owner@example.com");
  await openSettings(owner, "Team");
  await settingsList(owner).getByRole("link", { name: "Appearance" }).click();
  const title = owner.locator(".widget-form").getByRole("textbox", { name: "Chat title" });
  await title.fill("Unsaved");
  const dialog = owner.getByRole("alertdialog", { name: "Leave without saving?" });

  await owner.goBack();
  await dialog.getByRole("button", { name: "Stay" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(owner).toHaveURL(/\/settings\/appearance\?/);
  await expect(title).toHaveValue("Unsaved");

  await owner.goBack();
  await dialog.getByRole("button", { name: "Leave" }).click();
  await expect(owner).toHaveURL(/\/settings\/team\?/);
  await expect(
    owner.locator(".settings-pane").getByRole("heading", { name: "Team" }),
  ).toBeVisible();
  await owner.context().close();
});

test("Appearance asks before another page or view drops unsaved changes", async ({ browser }) => {
  const context = await browser.newContext();
  const owner = await context.newPage();
  await signInOn(owner, server, "owner@example.com");
  await openSettings(owner, "Appearance");
  const list = settingsList(owner);
  const title = owner.locator(".widget-form").getByRole("textbox", { name: "Chat title" });
  await title.fill("Unsaved");
  const dialog = owner.getByRole("alertdialog", { name: "Leave without saving?" });

  await list.getByRole("link", { name: "Team" }).click();
  await expect(dialog).toContainText("Your widget changes will be lost.");
  await dialog.getByRole("button", { name: "Stay" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(list.getByRole("link", { name: "Appearance" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(title).toHaveValue("Unsaved");

  await owner.getByRole("button", { name: "Inbox" }).click();
  await dialog.getByRole("button", { name: "Leave" }).click();
  await expect(list).toHaveCount(0);

  // Nothing was saved, and with no change the pages switch without asking.
  await openSettings(owner, "Appearance");
  await expect(title).toHaveValue("");
  await list.getByRole("link", { name: "Team" }).click();
  await expect(list.getByRole("link", { name: "Team" })).toHaveAttribute("aria-current", "page");
  await expect(dialog).toHaveCount(0);
  await context.close();
});
