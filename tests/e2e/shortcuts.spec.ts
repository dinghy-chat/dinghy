import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/": { html: `<!doctype html><title>Host</title><h1>Home</h1>${SNIPPET}` },
  });
  await server.createOperator("alice@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function visitor(browser: Browser, text: string) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.hostOrigin}/`);
  await page.getByRole("button", { name: "Open chat" }).click();
  const field = page.getByRole("textbox", { name: "Your message" });
  await field.fill(text);
  await field.press("Enter");
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
}

const current = (page: Page) => page.locator('.row[aria-current="true"]');

test("the keyboard moves through the Inbox, replies, and closes a chat to open the next", async ({
  browser,
}) => {
  await server.closeConversations();
  await visitor(browser, "First question");
  await visitor(browser, "Second question");
  const operator = await signedIn(browser, server, "alice@example.com");
  const rows = operator.locator(".row");
  await expect(rows).toHaveCount(2);

  // J opens the first row, then the next; K goes back.
  await operator.keyboard.press("j");
  await expect(current(operator)).toHaveCount(1);
  const first = (await current(operator).textContent()) ?? "";
  await operator.keyboard.press("j");
  await expect(current(operator)).not.toHaveText(first);
  await operator.keyboard.press("k");
  await expect(current(operator)).toHaveText(first);

  // R puts the caret in the reply, Escape leaves it, and the keys work again.
  const reply = operator.getByRole("textbox", { name: "Your reply" });
  // The conversation K opened has loaded.
  await expect(reply).toBeVisible();
  await operator.keyboard.press("r");
  await expect(reply).toBeFocused();
  await operator.keyboard.type("On it");
  await operator.keyboard.press("Enter");
  await expect(operator.locator(".state", { hasText: "Sending" })).toHaveCount(0);
  await operator.keyboard.press("Escape");
  await expect(reply).not.toBeFocused();

  // E closes this chat and opens the one left.
  await operator.keyboard.press("e");
  await expect(rows).toHaveCount(1);
  await expect(current(operator)).toHaveCount(1);
  await expect(current(operator)).not.toHaveText(first);

  // A second E while the first saves does not skip past the chat the first opened.
  await visitor(browser, "Third question");
  await expect(rows).toHaveCount(2);
  const left = (await current(operator).textContent()) ?? "";
  await operator.keyboard.press("e");
  await operator.keyboard.press("e");
  await expect(rows).toHaveCount(1);
  await expect(current(operator)).toHaveCount(1);
  await expect(current(operator)).not.toHaveText(left);

  // G then S opens Settings, and G then I comes back.
  await operator.keyboard.press("g");
  await operator.keyboard.press("s");
  await expect(operator.getByRole("button", { name: "Settings" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await operator.keyboard.press("g");
  await operator.keyboard.press("i");
  await expect(operator.getByRole("button", { name: "Inbox" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("Help opens the shortcuts, which the operator can turn off", async ({ browser }) => {
  await server.closeConversations();
  await visitor(browser, "Any question");
  const operator = await signedIn(browser, server, "alice@example.com");
  await expect(operator.locator(".row")).toHaveCount(1);

  await operator.getByRole("button", { name: "Help" }).click();
  await expect(operator.getByRole("menuitem", { name: "Documentation" })).toBeVisible();
  await operator.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
  const sheet = operator.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("checkbox", { name: /Single-key shortcuts/ }).uncheck();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);

  // Off, J does nothing, and the choice outlives a reload.
  await operator.keyboard.press("j");
  await expect(current(operator)).toHaveCount(0);
  await operator.reload();
  await expect(operator.locator(".row")).toHaveCount(1);
  await operator.keyboard.press("j");
  await expect(current(operator)).toHaveCount(0);

  // ? still works through Help, and turning the keys on brings J back.
  await operator.getByRole("button", { name: "Help" }).click();
  await operator.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
  await sheet.getByRole("checkbox", { name: /Single-key shortcuts/ }).check();
  await operator.keyboard.press("Escape");
  await operator.keyboard.press("j");
  await expect(current(operator)).toHaveCount(1);
  await operator.keyboard.press("?");
  await expect(sheet).toBeVisible();
});
