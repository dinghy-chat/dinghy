import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';
const PDF = Buffer.from("%PDF-1.7\nOrder 1042\n%%EOF\n");
const pdfFile = { name: "Order 1042.pdf", mimeType: "application/pdf", buffer: PDF };

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/plain": { html: `<!doctype html><title>Host</title><h1>Host</h1>${SNIPPET}` },
  });
  await server.createOperator("anna@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function openWidget(page: Page) {
  await page.goto(`${server.hostOrigin}/plain`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByRole("textbox", { name: "Your message" })).toBeVisible();
}

async function openInbox(page: Page) {
  await openLink(page, await server.signInLink("anna@example.com"));
  await expect(page.getByRole("heading", { name: "E2E", exact: true })).toBeVisible();
  await page.locator(".row").first().click();
}

test("a PDF from the visitor downloads in the operator app, and never opens in place @smoke", async ({
  browser,
}) => {
  const widgetContext = await browser.newContext();
  const widget = await widgetContext.newPage();
  await openWidget(widget);
  await widget.getByLabel("Attach an image or a file").first().setInputFiles(pdfFile);
  await expect(widget.locator(".doc.mine")).toContainText("Order 1042.pdf");
  await expect(widget.locator(".doc.mine")).toContainText("1 KB");

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await openInbox(operator);
  await expect(operator.locator(".row").first()).toContainText("Order 1042.pdf");
  const link = operator.locator(".file-link", { hasText: "Order 1042.pdf" });
  await expect(link).toContainText("1 KB");
  const [download] = await Promise.all([operator.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe("Order 1042.pdf");
  expect(await readFile(await download.path())).toEqual(PDF);
  await widgetContext.close();
  await operatorContext.close();
});

test("an operator's file reaches the visitor as a download", async ({ browser }) => {
  const widgetContext = await browser.newContext();
  const widget = await widgetContext.newPage();
  await openWidget(widget);
  await widget.getByRole("textbox", { name: "Your message" }).fill("Can you send the invoice?");
  await widget.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(widget.locator(".state", { hasText: "Sending" })).toHaveCount(0);

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await openInbox(operator);
  await expect(operator.getByRole("textbox", { name: "Your reply" })).toBeVisible();
  await operator.getByLabel("Attach an image or a file").first().setInputFiles(pdfFile);
  await expect(operator.locator(".file-link")).toContainText("Order 1042.pdf");

  const line = widget.locator(".doc:not(.mine)", { hasText: "Order 1042.pdf" });
  await expect(line).toBeVisible();
  const [download] = await Promise.all([widget.waitForEvent("download"), line.click()]);
  expect(download.suggestedFilename()).toBe("Order 1042.pdf");
  await widgetContext.close();
  await operatorContext.close();
});

test("a type outside the list is refused in the widget, with the types it takes", async ({
  page,
}) => {
  await openWidget(page);
  await page
    .getByLabel("Attach an image or a file")
    .first()
    .setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.getByText("PDF, TXT, CSV", { exact: false })).toBeVisible();
  await expect(page.locator(".doc")).toHaveCount(0);
});
