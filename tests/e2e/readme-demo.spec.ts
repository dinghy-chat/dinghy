import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";

// Records the two videos behind docs/media/demo.gif. It is not a test, so it runs only by hand:
// RECORD_DEMO=<directory> bun x playwright test readme-demo --project=chromium
const directory = process.env.RECORD_DEMO;
test.skip(directory === undefined, "Set RECORD_DEMO to record");
test.setTimeout(120_000);

const hostPage = `<!doctype html><title>Acme</title>
<body style="margin:0;font:18px system-ui;background:#f4f6f8;color:#223">
<div style="padding:48px 40px"><h1 style="margin:0 0 12px">Acme</h1><p>Your product's page.</p></div>
<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>`;

test("record", async ({ browser }) => {
  if (directory === undefined) return;
  const server = await startE2EServer({ "/": { html: hostPage } });
  await server.createOperator("anna@example.com", "a-long-test-password");
  const size = { width: 640, height: 720 };
  const options = { viewport: size, recordVideo: { dir: directory, size } };

  const operatorContext = await browser.newContext(options);
  const operator = await operatorContext.newPage();
  await operator.goto(server.apiOrigin);
  await operator.getByLabel("Email").fill("anna@example.com");
  await operator.getByLabel("Password").fill("a-long-test-password");
  await operator.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(operator.getByRole("heading", { name: "E2E" })).toBeVisible();

  const visitorContext = await browser.newContext(options);
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${server.hostOrigin}/`);
  await visitor.waitForTimeout(1200);
  await visitor.getByRole("button", { name: "Open chat" }).click();
  await visitor.waitForTimeout(1500);
  const message = visitor.getByRole("textbox", { name: "Your message" });
  await message.pressSequentially("Hi! My export keeps failing.", { delay: 45 });
  await message.press("Enter");

  await operator.getByText("My export keeps failing.").first().click();
  await operator.waitForTimeout(1000);
  const reply = operator.getByRole("textbox", { name: "Your reply" });
  await reply.pressSequentially("Looking now. Which browser do you use?", { delay: 45 });
  await reply.press("Enter");
  await expect(visitor.getByText("Which browser do you use?")).toBeVisible();
  await visitor.waitForTimeout(2500);

  // The pictures in the docs.
  await visitor.screenshot({ path: join(directory, "widget.png") });
  await operator.setViewportSize({ width: 1100, height: 720 });
  await operator.screenshot({ path: join(directory, "inbox.png") });
  await operator.getByRole("button", { name: "Settings" }).click();
  await operator.getByRole("heading", { name: "Widget snippet" }).waitFor();
  await operator.screenshot({ path: join(directory, "settings.png"), fullPage: true });

  const videos = [
    [visitor, "visitor.webm"],
    [operator, "operator.webm"],
  ] as const;
  await visitorContext.close();
  await operatorContext.close();
  await mkdir(directory, { recursive: true });
  for (const [page, name] of videos) {
    const path = await page.video()?.path();
    if (path !== undefined) await rename(path, join(directory, name));
  }
  await server.stop();
});
