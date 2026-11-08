import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openLink } from "./links.ts";

const tag = (attributes = "") =>
  `<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" ${attributes} async></script>`;

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/plain": { html: `<!doctype html><title>Host</title>${tag()}` },
    "/plain2": { html: `<!doctype html><title>Host</title>${tag()}` },
    "/no-mascot": { html: `<!doctype html><title>Host</title>${tag('data-mascot="false"')}` },
    "/themed": {
      html: `<!doctype html><title>Host</title>${tag('data-primary="#112233" data-accent="#f0e000"')}`,
    },
    "/bad-theme": {
      html: `<!doctype html><title>Host</title>${tag('data-primary="red" data-accent="#12"')}`,
    },
    "/strict": {
      html: `<!doctype html><title>Host</title>${tag()}`,
      csp: "default-src 'none'; script-src {{API}}; style-src 'none'; connect-src {{API}}; img-src {{API}}",
    },
  });
  await server.createOperator("anna@example.com");
});

test.afterAll(async () => {
  await server.stop();
});

async function openWidget(browser: Browser, path = "/plain", options = {}): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${server.hostOrigin}${path}`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page.locator(".scene")).toBeVisible();
  return page;
}

const sendMessage = async (page: Page, text: string) => {
  await page.getByRole("textbox", { name: "Your message" }).fill(text);
  await page.getByRole("textbox", { name: "Your message" }).press("Enter");
};

test.describe("each state shows its boat and its text", () => {
  test("no team online", async ({ browser }) => {
    const page = await openWidget(browser);
    const scene = page.locator(".scene.away");
    await expect(scene).toContainText("We are away.");
    await expect(scene.locator(".moon")).toBeVisible();
    await expect(scene.locator(".ship svg")).toBeVisible();
    await page.context().close();
  });

  test("sending", async ({ browser }) => {
    const page = await openWidget(browser);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/messages", async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    await sendMessage(page, "Held on its way");
    const scene = page.locator(".scene.sending");
    await expect(scene).toContainText("Sending your message");
    await expect(scene.locator(".parcel")).toBeVisible();
    release();
    await expect(scene).toHaveCount(0);
    await page.context().close();
  });

  test("connection lost", async ({ browser }) => {
    const page = await openWidget(browser);
    await sendMessage(page, "Before the outage");
    await expect(page.locator(".scene.sending")).toHaveCount(0);
    // Every new stream fails, so the reloaded page cannot connect.
    await page.route("**/stream*", (route) => route.abort());
    await page.reload();
    await page.getByRole("button", { name: "Open chat" }).click();
    const scene = page.locator(".scene.lost");
    await expect(scene).toContainText("Connection lost.");
    await expect(scene.locator(".ship svg")).toBeVisible();
    await page.context().close();
  });

  test("the team online, then a new reply with a flag", async ({ browser }) => {
    const operatorContext = await browser.newContext();
    const operator = await operatorContext.newPage();
    await openLink(operator, await server.signInLink("anna@example.com"));
    await expect(operator.getByRole("button", { name: "Sign out" })).toBeVisible();

    const page = await openWidget(browser, "/plain2");
    await expect(page.locator(".scene.waiting")).toContainText("We are online");
    await sendMessage(page, "Is anyone there?");
    await operator.locator(".row", { hasText: "Is anyone there?" }).click();
    await operator.getByRole("textbox", { name: "Your reply" }).fill("Yes, I am here.");
    await operator.getByRole("textbox", { name: "Your reply" }).press("Enter");
    const scene = page.locator(".scene.reply");
    await expect(scene).toContainText("New reply");
    await expect(scene.locator("path.b-f")).toHaveCount(1);
    // It is news only for a moment.
    await expect(scene).toHaveCount(0, { timeout: 8000 });
    await page.context().close();
    await operatorContext.close();
    await server.closeConversations();
  });

  test("an empty inbox in the operator app", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openLink(page, await server.signInLink("anna@example.com"));
    const empty = page.locator(".empty-boat");
    await expect(empty).toContainText("No open conversations.");
    await expect(empty.locator(".ship svg")).toBeVisible();
    await context.close();
  });
});

test("an empty chat with an unknown team shows the empty state", async ({ browser }) => {
  const page = await openWidget(browser);
  // A failed answer means unknown, which must not show as away.
  await page.route("**/presence", (route) => route.abort());
  await page.reload();
  await page.getByRole("button", { name: "Open chat" }).click();
  const scene = page.locator(".scene.empty-state");
  await expect(scene).toContainText("Send us a message.");
  await expect(page.getByText("Send us a message.")).toHaveCount(1);
  await page.context().close();
});

test.describe("reduced motion", () => {
  const animations = (page: Page, selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((element) => element.getAnimations().length);
  // The swell carries the boat, so its place changes from frame to frame while the sea moves.
  const boatPlace = (page: Page) =>
    page.locator(".sea .float").evaluate((element) => (element as HTMLElement).style.transform);

  test("the boat moves by default @smoke", async ({ browser }) => {
    const page = await openWidget(browser);
    expect(await animations(page, ".ship")).toBeGreaterThan(0);
    const first = await boatPlace(page);
    expect(first).not.toBe("");
    await expect.poll(() => boatPlace(page)).not.toBe(first);
    await page.context().close();
  });

  test("a visitor who asks for less motion gets a still boat, with the same text", async ({
    browser,
  }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    const launcher = page.getByRole("button", { name: "Open chat" });
    expect(
      await launcher.locator("svg").evaluate((element) => element.getAnimations().length),
    ).toBe(0);
    await launcher.click();
    // An operator from an earlier test can still be online, so either text is right here.
    await expect(page.locator(".scene")).toContainText(/We are (away|online)/);
    expect(await animations(page, ".ship")).toBe(0);
    const still = await boatPlace(page);
    expect(still).not.toBe("");
    await page.waitForTimeout(400);
    expect(await boatPlace(page)).toBe(still);
    await context.close();
  });

  test("asking for less motion while the chat is open stops the sea at once", async ({
    browser,
  }) => {
    const page = await openWidget(browser);
    const first = await boatPlace(page);
    await expect.poll(() => boatPlace(page)).not.toBe(first);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const still = await boatPlace(page);
    await page.waitForTimeout(400);
    expect(await boatPlace(page)).toBe(still);
    await page.context().close();
  });

  test("the sea draws at most 30 frames a second", async ({ browser }) => {
    const page = await openWidget(browser);
    const places = await page.locator(".sea .float").evaluate(async (element) => {
      const seen = new Set<string>();
      const start = performance.now();
      while (performance.now() - start < 1000) {
        seen.add((element as HTMLElement).style.transform);
        await new Promise(requestAnimationFrame);
      }
      return seen.size;
    });
    expect(places).toBeGreaterThan(10);
    expect(places).toBeLessThanOrEqual(32);
    await page.context().close();
  });

  test("the operator app's boat stops too", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await openLink(page, await server.signInLink("anna@example.com"));
    await expect(page.locator(".empty-boat .ship")).toBeVisible();
    expect(await animations(page, ".empty-boat .ship")).toBe(0);
    await context.close();
  });
});

test.describe("the host's options", () => {
  test("mascot off removes the boat and keeps the text", async ({ browser }) => {
    const page = await openWidget(browser, "/no-mascot");
    await expect(page.locator(".scene")).toContainText(/We are (away|online)/);
    await expect(page.locator(".ship")).toHaveCount(0);
    await expect(page.locator(".launcher.boat")).toHaveCount(0);
    await page.context().close();
  });

  test("a host's color stays on the visitor's messages in dark mode", async ({ browser }) => {
    const page = await openWidget(browser, "/themed", { colorScheme: "dark" });
    await sendMessage(page, "Dark and themed");
    const mine = page.locator(".msg.mine", { hasText: "Dark and themed" });
    await expect(mine).toHaveCSS("background-color", "rgb(17, 34, 51)");
    await page.context().close();
  });

  test("theme colors reach the header, the sail and the launcher", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // An unknown team leaves the sail up. An away team would lower it.
    await page.route("**/presence", (route) => route.abort());
    await page.goto(`${server.hostOrigin}/themed`);
    await page.getByRole("button", { name: "Open chat" }).click();
    await expect(page.locator(".scene.empty-state")).toBeVisible();
    const background = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(await background(".head")).toBe("rgb(17, 34, 51)");
    const color = await page
      .locator(".head")
      .evaluate((element) => getComputedStyle(element).color);
    expect(color).toBe("rgb(255, 255, 255)");
    // WebKit gave a fill="var(...)" attribute the hull's color, so each browser checks this.
    const sail = await page
      .locator(".ship svg path.b-s")
      .evaluate((element) => getComputedStyle(element).fill);
    expect(sail).toBe("rgb(240, 224, 0)");
    const launcherSail = await page
      .locator(".launcher path.s")
      .evaluate((element) => getComputedStyle(element).fill);
    expect(launcherSail).toBe("rgb(240, 224, 0)");
    await page.context().close();
  });

  test("the launcher with no boat keeps its bubble", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/no-mascot`);
    const launcher = page.getByRole("button", { name: "Open chat" });
    await expect(launcher.locator("svg")).toBeVisible();
    await expect(launcher.locator("path.s")).toHaveCount(0);
    await context.close();
  });

  test("a color in another format is ignored", async ({ browser }) => {
    const page = await openWidget(browser, "/bad-theme");
    const background = await page
      .locator(".head")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(background).toBe("rgb(11, 34, 57)");
    await expect(page.locator(".panel")).toBeVisible();
    await page.context().close();
  });

  test("the boat draws under a strict CSP with no violation", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations: string[] = [];
    page.on("console", (message) => {
      if (
        message.text().includes("Content Security Policy") &&
        !message.text().includes("favicon")
      ) {
        violations.push(message.text());
      }
    });
    await page.goto(`${server.hostOrigin}/strict`);
    await page.getByRole("button", { name: "Open chat" }).click();
    await expect(page.locator(".ship svg")).toBeVisible();
    // The computed width, because the boat's rocking tilts its bounding box.
    await expect(page.locator(".ship svg")).toHaveCSS("width", "32px");
    expect(violations).toEqual([]);
    await context.close();
  });
});
