import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { signedIn } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

/** With SCREENSHOTS set to a folder, each step saves a picture there for a review. */
async function picture(page: Page, name: string) {
  const folder = process.env.SCREENSHOTS;
  if (folder !== undefined) await page.screenshot({ path: `${folder}/${name}.png` });
}

test.beforeAll(async () => {
  server = await startE2EServer({
    "/pricing": { html: `<!doctype html><title>Pricing</title><h1>Pricing</h1>${SNIPPET}` },
  });
  await server.createOperator("vera@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function visitor(browser: Browser, text: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.hostOrigin}/pricing`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await page.getByRole("textbox", { name: "Your message" }).fill(text);
  await page.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
  return page;
}

test("the operator sees the visitor's draft, the read receipt and the visitor's panel", async ({
  browser,
}) => {
  const operator = await signedIn(browser, server, "vera@example.com");
  const widget = await visitor(browser, "Do you have **yearly** plans?");
  // The widget's page installed it, and the chat is the test chat.
  await operator.getByRole("button", { name: /^Get started/ }).click();
  const steps = operator.getByRole("region", { name: "Get started" });
  await expect(steps.getByRole("listitem").filter({ hasText: "Install the widget" })).toHaveClass(
    "done",
  );
  await expect(steps.getByRole("listitem").filter({ hasText: "Send a test chat" })).toHaveClass(
    "done",
  );
  await picture(operator, "get-started");
  await operator.keyboard.press("Escape");
  await expect(steps).toHaveCount(0);
  await operator.locator(".row", { hasText: "yearly" }).click();
  // The visitor's Markdown shows as formatting.
  await expect(operator.locator(".msg.visitor strong", { hasText: "yearly" })).toBeVisible();

  // The draft shows before it is sent, and goes when the message arrives.
  const box = widget.getByRole("textbox", { name: "Your message" });
  await box.fill("And monthly too");
  const draft = operator.getByRole("status", { name: "The visitor is typing" });
  await expect(draft).toHaveText("And monthly too");
  await expect(operator.locator(".row .preview.typing")).toBeVisible();
  await picture(operator, "typing");
  await box.press("Enter");
  await expect(operator.locator(".msg.visitor", { hasText: "And monthly too" })).toBeVisible();
  await expect(draft).toHaveCount(0);

  // A reply is stored, then read in the chat, and the line changes with no reload.
  const reply = operator.getByRole("textbox", { name: "Your reply" });
  await reply.fill("Yes, both.");
  await operator.getByRole("button", { name: /^Bold/ }).click();
  await expect(reply).toHaveValue("Yes, both.****");
  await reply.fill("Yes, **both**.");
  await reply.press("Enter");
  await expect(widget.locator(".msg:not(.mine) strong", { hasText: "both" })).toBeVisible();
  await expect(operator.locator(".receipt.read")).toHaveText("Read in chat");

  // The first reply assigned the conversation to the operator.
  const panel = operator.locator(".visitor-panel");
  await expect(panel.getByRole("button", { name: /^Assign to/ })).toContainText("vera");
  await expect(panel.getByRole("region", { name: "Visitor" })).toContainText("Chrome on Linux");
  await picture(operator, "thread");

  // The panel hides, and the header holds the assignee again.
  await operator.getByRole("button", { name: "Hide the visitor's details" }).click();
  await expect(panel).toHaveCount(0);
  await expect(operator.getByRole("button", { name: /^Assign to/ })).toBeVisible();
  await operator.getByRole("button", { name: "Show the visitor's details" }).click();

  // The note saves when the field loses focus, and the contact page shows it.
  await panel.getByRole("textbox", { name: "Note" }).fill("Wants an invoice.");
  await panel.getByRole("button", { name: "View contact" }).focus();
  await expect(operator.getByText("Saved.")).toBeVisible();
  await panel.getByRole("button", { name: "View contact" }).click();
  await expect(operator.getByRole("textbox", { name: "Note" })).toHaveValue("Wants an invoice.");
  await picture(operator, "contact");
  await operator.getByRole("button", { name: "Contacts", exact: true }).first().click();
  await expect(operator.locator("table.contacts tbody tr")).toHaveCount(1);
  await picture(operator, "contacts");

  // The visitor's open tab shows in Visitors, chatting.
  await operator
    .getByRole("navigation", { name: "Main menu" })
    .getByRole("button", { name: /^Visitors/ })
    .click();
  await expect(operator.locator(".live-row")).toHaveCount(1);
  await expect(operator.locator(".live-row")).toContainText("Chatting");
  await expect(operator.locator(".live-row")).toContainText("Pricing");
  await expect(operator.getByRole("link", { name: "IP geolocation by DB-IP" })).toBeVisible();
  await picture(operator, "visitors");
  await operator.locator(".live-row").getByRole("button", { name: "Chatting" }).click();
  await expect(operator.locator(".msg.visitor", { hasText: "And monthly too" })).toBeVisible();

  for (const page of [operator, widget]) await page.context().close();
});
