import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";

// Records the frames behind docs/media/demo.gif, and the pictures in the docs. It is not a test, so
// it runs only by hand, then scripts/demo-gif.sh turns the frames into the GIF:
//   RECORD_DEMO=<directory> bun x playwright test readme-demo --project=chromium
//   scripts/demo-gif.sh <directory>
const directory = process.env.RECORD_DEMO;
test.skip(directory === undefined, "Set RECORD_DEMO to record");
test.setTimeout(180_000);

// The visitor's page, served by the browser itself under a real-looking address, so the inbox shows
// where the chat started instead of a test port.
const SITE = "https://acme.example";
const hostPage = `<!doctype html><title>Acme pricing</title>
<body style="margin:0;font:16px system-ui;background:#f6f7f9;color:#1d2433">
<header style="display:flex;gap:24px;align-items:center;padding:20px 32px;background:#fff;border-bottom:1px solid #e5e8ee">
<strong style="font-size:20px">Acme</strong><span>Product</span><span>Pricing</span><span>Docs</span></header>
<main style="padding:40px 32px"><h1 style="margin:0 0 8px;font-size:30px">Simple pricing</h1>
<p style="margin:0 0 28px;color:#5b6475">Export your reports in one click.</p>
<div style="display:flex;gap:16px">
<div style="flex:1;background:#fff;border:1px solid #e5e8ee;border-radius:12px;padding:20px"><b>Starter</b><p style="font-size:28px;margin:8px 0">$12</p></div>
<div style="flex:1;background:#fff;border:1px solid #e5e8ee;border-radius:12px;padding:20px"><b>Team</b><p style="font-size:28px;margin:8px 0">$29</p></div>
</div></main>
<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>`;

const VISITOR = { width: 600, height: 700 };
const OPERATOR = { width: 1000, height: 700 };
const FRAME_MS = 100;

/**
 * Screenshots each page about every FRAME_MS until stopped, as numbered PNGs, and writes one ffmpeg
 * concat list per page with each frame's real duration, because a 2x screenshot can take longer.
 */
function recordFrames(pages: { page: Page; name: string }[], into: string) {
  let running = true;
  const times: number[] = [];
  const done = (async () => {
    for (let frame = 0; running; frame += 1) {
      times.push(Date.now());
      const number = String(frame).padStart(5, "0");
      await Promise.all(
        pages.map(({ page, name }) =>
          page.screenshot({ path: join(into, `${name}-${number}.png`) }),
        ),
      );
      const spent = Date.now() - (times.at(-1) ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, FRAME_MS - spent)));
    }
    times.push(Date.now());
  })();
  return async () => {
    running = false;
    await done;
    for (const { name } of pages) {
      const lines = times.slice(0, -1).map((at, frame) => {
        const file = `${name}-${String(frame).padStart(5, "0")}.png`;
        return `file '${file}'\nduration ${((times[frame + 1] ?? at) - at) / 1000}`;
      });
      await writeFile(join(into, `${name}.txt`), `${lines.join("\n")}\n`);
    }
  };
}

test("record", async () => {
  if (directory === undefined) return;
  const frames = join(directory, "frames");
  await mkdir(frames, { recursive: true });
  const server = await startE2EServer({ "/": { html: hostPage } });
  await server.createOperator("anna@acme.example", "a-long-test-password");
  // The names a real team would have, instead of the test fixtures'.
  const database = server.owner.$client;
  await database.query("update operator set name = 'Anna' where email = $1", ["anna@acme.example"]);
  await database.query("update workspace set name = 'Acme', allowed_origins = $1 where id = $2", [
    [SITE, server.hostOrigin],
    server.workspaceId(),
  ]);
  const page = await (await fetch(`${server.hostOrigin}/`)).text();
  // The page's address is public and the test server is on 127.0.0.1, which Chrome's private
  // network protection blocks. Only this recording turns it off; a real site never meets it.
  const browser = await chromium.launch({
    args: [
      "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks",
    ],
  });

  const operatorContext = await browser.newContext({ viewport: OPERATOR, deviceScaleFactor: 2 });
  const operator = await operatorContext.newPage();
  await operator.goto(server.apiOrigin);
  await operator.getByLabel("Email").fill("anna@acme.example");
  await operator.getByLabel("Password").fill("a-long-test-password");
  await operator.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(operator.getByRole("heading", { name: "Acme" })).toBeVisible();

  const visitorContext = await browser.newContext({ viewport: VISITOR, deviceScaleFactor: 2 });
  await visitorContext.route(`${SITE}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: page }),
  );
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${SITE}/pricing`);
  await visitor.getByRole("button", { name: "Open chat" }).waitFor();

  const stop = recordFrames(
    [
      { page: visitor, name: "visitor" },
      { page: operator, name: "operator" },
    ],
    frames,
  );
  await visitor.waitForTimeout(1000);
  await visitor.getByRole("button", { name: "Open chat" }).click();
  await visitor.waitForTimeout(1200);
  const message = visitor.getByRole("textbox", { name: "Your message" });
  await message.pressSequentially("Hi! My export keeps failing.", { delay: 60 });
  await message.press("Enter");

  await operator.getByText("My export keeps failing.").first().waitFor();
  await operator.waitForTimeout(1200);
  await operator.getByText("My export keeps failing.").first().click();
  await operator.waitForTimeout(1000);
  const reply = operator.getByRole("textbox", { name: "Your reply" });
  await reply.pressSequentially("Looking now. Which browser do you use?", { delay: 60 });
  await reply.press("Enter");
  await expect(visitor.getByText("Which browser do you use?")).toBeVisible();
  await visitor.waitForTimeout(1200);
  await message.pressSequentially("Firefox, on a Mac.", { delay: 60 });
  await message.press("Enter");
  await expect(operator.getByText("Firefox, on a Mac.").first()).toBeVisible();
  await operator.waitForTimeout(2500);
  await stop();

  // The pictures in the docs, after the recording, so the GIF never shows them.
  await visitor.screenshot({ path: join(directory, "widget.png") });
  await operator.setViewportSize({ width: 1100, height: 720 });
  await operator.screenshot({ path: join(directory, "inbox.png") });
  await operator.getByRole("button", { name: "Settings" }).click();
  await operator.getByRole("heading", { name: "Widget snippet" }).waitFor();
  // The snippet names the test server's address. A reader should see a real-looking one.
  await operator.evaluate((api) => {
    for (const code of document.querySelectorAll("pre, code")) {
      code.textContent = (code.textContent ?? "").replaceAll(api, "https://chat.acme.example");
    }
  }, server.apiOrigin);
  await operator.screenshot({ path: join(directory, "settings.png"), fullPage: true });

  await visitorContext.close();
  await operatorContext.close();
  await browser.close();
  await server.stop();
});
