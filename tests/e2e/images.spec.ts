import { expect, type Locator, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { dropImage, pasteImage, pngFile } from "./images.ts";
import { openLink } from "./links.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/plain": { html: `<!doctype html><title>Host</title><h1>Host</h1>${SNIPPET}` },
    "/hostile": {
      html: `<!doctype html><title>Hostile</title><style>img { display: none !important; max-width: 1px; }</style>${SNIPPET}`,
      csp: "default-src 'none'; script-src {{API}}; style-src 'unsafe-inline'; connect-src {{API}}; img-src {{API}}",
    },
  });
  await server.createOperator("anna@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function openWidget(page: Page, path = "/plain") {
  await page.goto(`${server.hostOrigin}${path}`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByRole("textbox", { name: "Your message" })).toBeVisible();
}

async function openInbox(page: Page) {
  await openLink(page, await server.signInLink("anna@example.com"));
  await expect(page.getByRole("heading", { name: "E2E" })).toBeVisible();
}

/** The image really loaded, with its bytes decoded, and not only an img tag on the page. */
async function expectLoaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(16);
}

test.describe("from the visitor", () => {
  const methods: [string, (page: Page) => Promise<void>][] = [
    [
      "the file picker",
      (page) => page.getByLabel("Attach an image").first().setInputFiles(pngFile()),
    ],
    ["paste", (page) => pasteImage(page.getByRole("textbox", { name: "Your message" }))],
    ["drag and drop", (page) => dropImage(page.locator(".panel"))],
  ];

  for (const [name, send] of methods) {
    test(`an image sent by ${name} reaches the operator @smoke`, async ({ browser }) => {
      const widgetContext = await browser.newContext();
      const widget = await widgetContext.newPage();
      await openWidget(widget);
      await send(widget);
      await expectLoaded(widget.locator(".shot.mine img").first());

      const operatorContext = await browser.newContext();
      const operator = await operatorContext.newPage();
      await openInbox(operator);
      await operator.locator(".row").first().click();
      await expectLoaded(operator.locator(".shot.visitor img").first());
      await widgetContext.close();
      await operatorContext.close();
    });
  }
});

test.describe("from the operator", () => {
  const methods: [string, (page: Page) => Promise<void>][] = [
    [
      "the file picker",
      (page) => page.getByLabel("Attach an image").first().setInputFiles(pngFile()),
    ],
    ["paste", (page) => pasteImage(page.getByRole("textbox", { name: "Your reply" }))],
    ["drag and drop", (page) => dropImage(page.locator(".thread"))],
  ];

  for (const [name, send] of methods) {
    test(`an image sent by ${name} reaches the visitor`, async ({ browser }) => {
      const widgetContext = await browser.newContext();
      const widget = await widgetContext.newPage();
      await openWidget(widget);
      await widget.getByRole("textbox", { name: "Your message" }).fill("Can you see this?");
      await widget.getByRole("textbox", { name: "Your message" }).press("Enter");
      await expect(widget.locator(".state", { hasText: "Sending" })).toHaveCount(0);

      const operatorContext = await browser.newContext();
      const operator = await operatorContext.newPage();
      await openInbox(operator);
      await operator.locator(".row").first().click();
      await expect(operator.getByRole("textbox", { name: "Your reply" })).toBeVisible();
      await send(operator);
      await expectLoaded(operator.locator(".shot:not(.visitor) img").first());
      await expectLoaded(widget.locator(".shot:not(.mine) img").first());
      await widgetContext.close();
      await operatorContext.close();
    });
  }
});

test("the list shows that the last message is an image", async ({ browser }) => {
  const widgetContext = await browser.newContext();
  const widget = await widgetContext.newPage();
  await openWidget(widget);
  await widget.getByLabel("Attach an image").first().setInputFiles(pngFile());
  await expectLoaded(widget.locator(".shot.mine img").first());
  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await openInbox(operator);
  await expect(operator.locator(".row").first()).toContainText("Image");
  await widgetContext.close();
  await operatorContext.close();
});

test("the widget's images work on a hostile page with a strict CSP", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy") && !message.text().includes("favicon")) {
      violations.push(message.text());
    }
  });
  await openWidget(page, "/hostile");
  await page.getByLabel("Attach an image").first().setInputFiles(pngFile());
  await expectLoaded(page.locator(".shot.mine img").first());
  const box = await page.locator(".shot.mine img").first().boundingBox();
  expect(box?.width).toBe(16);
  expect(violations).toEqual([]);
  await context.close();
});

test("the widget refuses a file it cannot send, with a message", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  const picker = page.getByLabel("Attach an image").first();
  await picker.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByRole("alert")).toHaveText("Send a PNG, JPEG or WebP image.");
  await picker.setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toHaveText("This image is over 5 MB.");
  await expect(page.locator(".shot")).toHaveCount(0);
  await context.close();
});

test("a good image finishing does not hide the warning about a refused one", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  await page
    .getByLabel("Attach an image")
    .first()
    .setInputFiles([
      pngFile("good.png"),
      { name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
    ]);
  await expectLoaded(page.locator(".shot.mine img").first());
  await expect(page.getByRole("alert")).toHaveText("This image is over 5 MB.");
  await context.close();
});

test("a good image after a refused one in the same selection keeps the warning", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  await page
    .getByLabel("Attach an image")
    .first()
    .setInputFiles([
      { name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
      pngFile("good.png"),
    ]);
  await expectLoaded(page.locator(".shot.mine img").first());
  await expect(page.getByRole("alert")).toHaveText("This image is over 5 MB.");
  await context.close();
});

test("a failed image can be sent again, and creates one message", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  let attempts = 0;
  await page.route("**/images*", async (route) => {
    attempts += 1;
    if (attempts === 1) return route.abort();
    return route.continue();
  });
  await page.getByLabel("Attach an image").first().setInputFiles(pngFile());
  await page.getByRole("button", { name: "Not sent" }).click();
  await expectLoaded(page.locator(".shot.mine img").first());
  await expect(page.locator(".shot.mine")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Not sent" })).toHaveCount(0);
  await context.close();
});

test("an image survives a refresh", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  await page.getByLabel("Attach an image").first().setInputFiles(pngFile());
  await expectLoaded(page.locator(".shot.mine img").first());
  await page.reload();
  // The chat was open, so it opens again after the reload.
  await expect(page.getByRole("textbox", { name: "Your message" })).toBeVisible();
  await expectLoaded(page.locator(".shot.mine img").first());
  await context.close();
});

test("selecting an image shows it at full size, and Escape closes it", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  await page.getByLabel("Attach an image").first().setInputFiles(pngFile());
  await expectLoaded(page.locator(".shot.mine img").first());
  await page.getByRole("button", { name: "View the image at full size" }).click();
  await expectLoaded(page.locator("dialog img"));
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog")).toHaveCount(0);
  await context.close();
});

test("an operator sees an image at full size", async ({ browser }) => {
  const widgetContext = await browser.newContext();
  const widget = await widgetContext.newPage();
  await openWidget(widget);
  await widget.getByLabel("Attach an image").first().setInputFiles(pngFile());
  await expectLoaded(widget.locator(".shot.mine img").first());
  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await openInbox(operator);
  await operator.locator(".row").first().click();
  await operator.getByRole("button", { name: "View the image at full size" }).first().click();
  await expectLoaded(operator.locator("dialog img"));
  await operator.locator("dialog").click();
  await expect(operator.locator("dialog")).toHaveCount(0);
  await widgetContext.close();
  await operatorContext.close();
});

test("an expired image URL is replaced in the widget", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  await page.getByLabel("Attach an image").first().setInputFiles(pngFile());
  await expectLoaded(page.locator(".shot.mine img").first());
  // The next page load finds its first URL expired, as a tab left open for an hour does.
  let requests = 0;
  await page.route("**/v1/files/**", async (route) => {
    requests += 1;
    // The first URL has expired by the time it reaches the server.
    if (requests === 1) server.expireImageUrls();
    return route.continue();
  });
  await page.reload();
  // The chat was open, so it opens again after the reload.
  await expect(page.getByRole("textbox", { name: "Your message" })).toBeVisible();
  await expectLoaded(page.locator(".shot.mine img").first());
  expect(requests).toBeGreaterThan(1);
  await context.close();
});

test("an expired image URL is replaced in the operator app", async ({ browser }) => {
  const widgetContext = await browser.newContext();
  const widget = await widgetContext.newPage();
  await openWidget(widget);
  await widget.getByLabel("Attach an image").first().setInputFiles(pngFile());
  await expectLoaded(widget.locator(".shot.mine img").first());
  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await openInbox(operator);
  let requests = 0;
  await operator.route("**/v1/files/**", async (route) => {
    requests += 1;
    // The first URL has expired by the time it reaches the server.
    if (requests === 1) server.expireImageUrls();
    return route.continue();
  });
  await operator.locator(".row").first().click();
  await expectLoaded(operator.locator(".shot.visitor img").first());
  expect(requests).toBeGreaterThan(1);
  await widgetContext.close();
  await operatorContext.close();
});

test("an image that is broken for good does not reload the thread in a loop", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  await page.getByLabel("Attach an image").first().setInputFiles(pngFile());
  await expectLoaded(page.locator(".shot.mine img").first());
  let requests = 0;
  await page.route("**/v1/files/**", async (route) => {
    requests += 1;
    // The signature covers whole seconds, so each refresh gets a new URL only after this wait.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return route.fulfill({ status: 404 });
  });
  await page.reload();
  // The chat was open, so it opens again after the reload.
  await expect(page.getByRole("textbox", { name: "Your message" })).toBeVisible();
  await expect(page.locator(".shot.mine img").first()).toBeAttached();
  await page.waitForTimeout(5000);
  expect(requests).toBeLessThanOrEqual(2);
  await context.close();
});

test("a server refusal shows a message and leaves no line to retry", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  await page
    .getByLabel("Attach an image")
    .first()
    .setInputFiles({
      name: "broken.png",
      mimeType: "image/png",
      buffer: Buffer.from("this is not really a png"),
    });
  await expect(page.getByRole("alert")).toContainText("could not be sent");
  await expect(page.getByRole("button", { name: "Not sent" })).toHaveCount(0);
  await expect(page.getByText("Sending an image...")).toHaveCount(0);
  await context.close();
});

test("a paste that holds text and a picture of it does not upload the picture", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidget(page);
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/images")) uploads.push(request.url());
  });
  await pasteImage(page.getByRole("textbox", { name: "Your message" }), "cell A1");
  await page.waitForTimeout(300);
  expect(uploads).toEqual([]);
  await expect(page.getByText("Sending an image...")).toHaveCount(0);
  await context.close();
});
