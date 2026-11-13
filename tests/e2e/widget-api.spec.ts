import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import type { DinghyApi } from "../../packages/widget/src/shared.ts";

// The browser API on the host page: window.Dinghy.

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';
// Callbacks registered before the loader runs, through the queue, record every event.
const WATCHED = `<!doctype html><title>Watched</title><h1>Watched</h1>
<script>
  window.events = [];
  const record = (name) => (data) => window.events.push(data === undefined ? name : [name, data]);
  window.Dinghy = { q: ["ready", "open", "close", "message:sent", "message:received", "conversation:started"]
    .map((name) => ["on", name, record(name)]) };
</script>
${SNIPPET}`;
// A page that opens the chat with a message before the loader runs, as an "Ask support" button does.
const QUEUED = `<!doctype html><title>Queued</title>
<script>
  window.events = [];
  window.Dinghy = { q: [
    ["on", "open", () => window.events.push("open")],
    ["on", "close", () => window.events.push("close")],
    ["open", { message: "From the queue" }],
  ] };
</script>
${SNIPPET}`;
const LEFT = `<!doctype html><title>Left</title>${SNIPPET.replace(
  "async>",
  'data-position="left" data-offset-x="40" data-offset-y="80" async>',
)}`;

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/watched": { html: WATCHED },
    "/queued": { html: QUEUED },
    "/left": { html: LEFT },
  });
});

test.afterAll(async () => {
  await server.stop();
});

type Win = Window & { Dinghy: DinghyApi; events: unknown[] };

const launcher = (page: Page) => page.getByRole("button", { name: "Open chat" });
const input = (page: Page) => page.getByRole("textbox", { name: "Your message" });
const dinghy = <T>(page: Page, run: (api: DinghyApi) => T) =>
  page.evaluate(`(${run.toString()})(window.Dinghy)`) as Promise<T>;
const events = (page: Page) => page.evaluate(() => (window as unknown as Win).events);

async function sendMessage(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press("Enter");
  await expect(page.locator(".msg.mine", { hasText: text })).toBeVisible();
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
}

test("open({ message }) fills the composer without sending, and the events follow the chat", async ({
  page,
}) => {
  await page.goto(`${server.hostOrigin}/watched`);
  expect(await dinghy(page, (api) => api.state)).toEqual({
    ready: false,
    open: false,
    unread: 0,
    conversation: false,
  });
  const sends: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/messages") && request.method() === "POST")
      sends.push(request.url());
  });

  await dinghy(page, (api) => api.open({ message: "I need help with my order" }));
  await expect(input(page)).toHaveValue("I need help with my order");
  expect(sends).toEqual([]);
  expect(await dinghy(page, (api) => api.state)).toEqual({
    ready: true,
    open: true,
    unread: 0,
    conversation: false,
  });

  await sendMessage(page, "I need help with my order");
  await server.reply("Which order?");
  await expect(page.locator(".msg:not(.mine)", { hasText: "Which order?" })).toBeVisible();
  await dinghy(page, (api) => api.close());
  await expect(input(page)).toHaveCount(0);
  await dinghy(page, (api) => api.toggle());
  await expect(input(page)).toBeVisible();

  await expect
    .poll(() => events(page))
    .toEqual([
      "ready",
      "open",
      ["message:sent", { body: "I need help with my order" }],
      "conversation:started",
      ["message:received", { body: "Which order?" }],
      "close",
      "open",
    ]);
});

test("a queued open({ message }) fills the composer, keeps a typed draft, and reports a close from the chat", async ({
  page,
}) => {
  await page.goto(`${server.hostOrigin}/queued`);
  await expect(input(page)).toHaveValue("From the queue");

  // The visitor's own words stay when the page asks again.
  await input(page).fill("My own words");
  await dinghy(page, (api) => api.open({ message: "Another question" }));
  await expect(input(page)).toHaveValue("My own words");
  // An empty box takes the page's message.
  await input(page).fill("");
  await dinghy(page, (api) => api.open({ message: "Another question" }));
  await expect(input(page)).toHaveValue("Another question");
  // A later message from the page takes the place of one the visitor did not change.
  await dinghy(page, (api) => api.open({ message: "A third question" }));
  await expect(input(page)).toHaveValue("A third question");

  // The visitor closes the chat from inside it, and the page hears it.
  await page.getByRole("button", { name: "Close chat" }).click();
  await expect(input(page)).toHaveCount(0);
  expect(await dinghy(page, (api) => api.state.open)).toBe(false);
  await expect.poll(() => events(page)).toEqual(["open", "close"]);
});

test('on("conversation") follows the open conversation, after a reload and a reset', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const watch = () =>
    page.evaluate(() => {
      const win = window as unknown as Win & { heard: boolean[] };
      win.heard = [];
      win.Dinghy.on("conversation", (open) => win.heard.push(open));
    });
  const heard = () => page.evaluate(() => (window as unknown as { heard: boolean[] }).heard);

  await page.goto(`${server.hostOrigin}/watched`);
  await watch();
  await expect.poll(heard).toEqual([false]);
  await launcher(page).click();
  await sendMessage(page, "Show my button");
  await expect.poll(heard).toEqual([false, true]);
  expect(await dinghy(page, (api) => api.state.conversation)).toBe(true);

  // A page that hides its own button learns it once the chat has asked the server.
  await dinghy(page, (api) => api.close());
  await page.reload();
  await watch();
  await expect.poll(heard).toEqual([false, true]);

  await dinghy(page, (api) => api.reset());
  await expect.poll(heard).toEqual([false, true, false]);
  await context.close();
});

test("a callback that throws does not stop the others, and on() returns a way to stop", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.hostOrigin}/watched`);
  await page.evaluate(() => {
    const win = window as unknown as Win;
    win.Dinghy.on("open", () => {
      throw new Error("A broken callback");
    });
    const stop = win.Dinghy.on("open", () => win.events.push("stopped one"));
    stop();
  });
  await launcher(page).click();
  await expect(input(page)).toBeVisible();
  await expect.poll(() => events(page)).toEqual(["ready", "open"]);
  // Firefox reports a page error to Playwright later than the events, so this waits for it too.
  await expect.poll(() => errors).toEqual(["A broken callback"]);
});

test("an open chat opens again after a reload in the same tab, once the visitor has a token", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.hostOrigin}/watched`);
  await launcher(page).click();
  await expect(input(page)).toBeVisible();
  // A visitor who never sent a message stores nothing, so the chat starts closed.
  expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);
  await page.reload();
  await expect(launcher(page)).toBeVisible();
  await expect(input(page)).toHaveCount(0);

  await launcher(page).click();
  await sendMessage(page, "Remember me");
  await page.reload();
  await expect(input(page)).toBeVisible();
  await expect(page.locator(".msg.mine", { hasText: "Remember me" })).toBeVisible();
  // Opened from memory, it leaves the page's focus alone.
  await expect(input(page)).not.toBeFocused();
  await expect.poll(() => events(page)).toEqual(["ready", "open"]);

  // Closed, it stays closed after a reload.
  await dinghy(page, (api) => api.close());
  await page.reload();
  await expect(launcher(page)).toBeVisible();
  await page.waitForTimeout(300);
  await expect(input(page)).toHaveCount(0);

  // A new tab starts closed.
  const other = await context.newPage();
  await other.goto(`${server.hostOrigin}/watched`);
  await expect(launcher(other)).toBeVisible();
  await other.waitForTimeout(300);
  await expect(input(other)).toHaveCount(0);
  await context.close();
});

test("setContext reaches the server only after the first message, cleaned", async ({ page }) => {
  await page.goto(`${server.hostOrigin}/watched`);
  const reports: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/context")) reports.push(request.postDataJSON());
  });
  await page.evaluate(() =>
    (window as unknown as Win).Dinghy.setContext({
      plan: "pro",
      seats: 3,
      // Not a value the API takes, so it is dropped.
      nested: { a: 1 } as unknown as string,
    }),
  );
  await launcher(page).click();
  await page.waitForTimeout(300);
  expect(reports).toEqual([]);

  await sendMessage(page, "Context please");
  await expect.poll(() => reports).toEqual([{ locale: "en", context: { plan: "pro", seats: 3 } }]);
  await page.evaluate(() => (window as unknown as Win).Dinghy.setContext({ plan: "team" }));
  await expect.poll(() => reports.at(-1)).toEqual({ locale: "en", context: { plan: "team" } });
});

test("show, hide and configure move the launcher and the chat follows its side", async ({
  page,
}) => {
  await page.goto(`${server.hostOrigin}/left`);
  const box = async () => (await launcher(page).boundingBox()) ?? { x: -1, y: -1 };
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  expect((await box()).x).toBe(40);
  expect(viewport.height - ((await box()).y + 60)).toBe(80);

  await dinghy(page, (api) => api.hide());
  await expect(launcher(page)).toBeHidden();
  await dinghy(page, (api) => api.show());
  await expect(launcher(page)).toBeVisible();

  await launcher(page).click();
  const panel = page.getByRole("region");
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())?.x).toBe(40);
  // The launcher hides while the chat is open, even after show().
  await dinghy(page, (api) => api.show());
  await expect(launcher(page)).toBeHidden();
  await dinghy(page, (api) => api.close());

  // Invalid values change nothing, and valid ones apply at once.
  await dinghy(page, (api) =>
    api.configure({ position: "middle" as "left", offsetX: -5, accent: "red" }),
  );
  expect((await box()).x).toBe(40);
  await dinghy(page, (api) => api.configure({ position: "right", offsetX: 24, accent: "#112233" }));
  expect(viewport.width - ((await box()).x + 60)).toBe(24);
  expect(
    await page.locator("dinghy-chat").evaluate((host) => host.style.getPropertyValue("--d-accent")),
  ).toBe("#112233");
});
