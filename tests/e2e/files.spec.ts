import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openInbox, openWidget } from "./chat.ts";

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

test("a PDF from the visitor downloads in the operator app, and never opens in place @smoke", async ({
  browser,
}) => {
  const widgetContext = await browser.newContext();
  const widget = await widgetContext.newPage();
  await openWidget(widget, server);
  await widget.getByLabel("Attach an image or a file").first().setInputFiles(pdfFile);
  await expect(widget.locator(".doc.mine")).toContainText("Order 1042.pdf");
  await expect(widget.locator(".doc.mine")).toContainText("1 kB");

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await openInbox(operator, server, "anna@example.com");
  await operator.locator(".row").first().click();
  await expect(operator.locator(".row").first()).toContainText("Order 1042.pdf");
  const link = operator.locator(".file-link", { hasText: "Order 1042.pdf" });
  await expect(link).toContainText("1 kB");
  const [download] = await Promise.all([operator.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe("Order 1042.pdf");
  expect(await readFile(await download.path())).toEqual(PDF);
  await widgetContext.close();
  await operatorContext.close();
});

test("an operator's file reaches the visitor as a download", async ({ browser }) => {
  const widgetContext = await browser.newContext();
  const widget = await widgetContext.newPage();
  await openWidget(widget, server);
  await widget.getByRole("textbox", { name: "Your message" }).fill("Can you send the invoice?");
  await widget.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(widget.locator(".state", { hasText: "Sending" })).toHaveCount(0);

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await openInbox(operator, server, "anna@example.com");
  await operator.locator(".row").first().click();
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
  await openWidget(page, server);
  await page
    .getByLabel("Attach an image or a file")
    .first()
    .setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.getByText("PDF, TXT, CSV", { exact: false })).toBeVisible();
  await expect(page.locator(".doc")).toHaveCount(0);
});

test("files turned off during a visit are refused, with the image types", async ({ page }) => {
  await openWidget(page, server);
  // The widget loaded with files on, so only the server can refuse this one.
  await server.setWidgetSettings({ visitorFiles: false });
  try {
    await page.locator("input[type=file]").setInputFiles(pdfFile);
    await expect(page.getByText("Send a PNG, JPEG or WebP image.")).toBeVisible();
    await expect(page.locator(".doc")).toHaveCount(0);
  } finally {
    await server.setWidgetSettings({ visitorFiles: true });
  }
});

test("a file whose URL expired still downloads in the widget, and the page stays", async ({
  page,
}) => {
  await openWidget(page, server);
  await page.locator("input[type=file]").setInputFiles(pdfFile);
  const line = page.locator(".doc.mine", { hasText: "Order 1042.pdf" });
  await expect(line).toBeVisible();
  let requests = 0;
  await page.route("**/v1/files/**", async (route) => {
    requests += 1;
    // The first URL has expired by the time it reaches the server, as in a tab left open.
    if (requests === 1) server.expireUploadUrls();
    return route.continue();
  });
  const [download] = await Promise.all([page.waitForEvent("download"), line.click()]);
  expect(await readFile(await download.path())).toEqual(PDF);
  expect(requests).toBe(2);
  expect(new URL(page.url()).pathname).toBe("/plain");
});

test("a file whose URL expired still downloads in the operator app", async ({ browser }) => {
  const widgetContext = await browser.newContext();
  const widget = await widgetContext.newPage();
  await openWidget(widget, server);
  await widget.locator("input[type=file]").setInputFiles(pdfFile);
  await expect(widget.locator(".doc.mine")).toContainText("Order 1042.pdf");

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await openInbox(operator, server, "anna@example.com");
  await operator.locator(".row").first().click();
  const link = operator.locator(".file-link", { hasText: "Order 1042.pdf" });
  await expect(link).toBeVisible();
  let requests = 0;
  await operator.route("**/v1/files/**", async (route) => {
    requests += 1;
    if (requests === 1) server.expireUploadUrls();
    return route.continue();
  });
  const [download] = await Promise.all([operator.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe("Order 1042.pdf");
  expect(await readFile(await download.path())).toEqual(PDF);
  expect(requests).toBe(2);
  await widgetContext.close();
  await operatorContext.close();
});
