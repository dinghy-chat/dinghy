import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";

const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';
const PLAIN = `<!doctype html><title>Host</title><h1>Host</h1>${SNIPPET}`;
// A site that does what real sites do to an embedded widget.
const HOSTILE = `<!doctype html><title>Hostile</title>
<style>
  html { font-size: 10px; }
  body > div { display: none; }
  * { color: lime !important; }
  button, textarea, input { all: unset; }
  dinghy-chat { display: none; }
</style>
<script>
  // A site's single-key shortcut, as many products have.
  document.addEventListener("keydown", (event) => {
    window.__shortcuts = (window.__shortcuts ?? 0) + 1;
  });
  // A modal's focus trap, as an accessible dialog library writes it.
  document.addEventListener("focusin", (event) => {
    const modal = document.getElementById("modal");
    if (modal && !modal.contains(event.target)) modal.focus();
  });
</script>
<h1>Hostile</h1>
<div id="modal" tabindex="-1" role="dialog">A modal</div>
${SNIPPET}`;
const STRICT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' {{API}}; style-src 'unsafe-inline'; connect-src {{API}}; img-src {{API}}";
const STRICTEST_CSP =
  "default-src 'none'; script-src {{API}}; style-src 'none'; connect-src {{API}}; img-src {{API}}";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer(
    {
      "/plain": { html: PLAIN },
      "/hostile": { html: HOSTILE, csp: STRICT_CSP },
      "/strictest": { html: PLAIN, csp: STRICTEST_CSP },
      "/queued": {
        html: `<!doctype html><title>Queued</title><script>window.Dinghy = { q: [["open"]] };</script>${SNIPPET}`,
      },
      "/no-launcher": { html: PLAIN.replace("async>", 'data-launcher="hidden" async>') },
    },
    { emailAvailable: true },
  );
});

test.afterAll(async () => {
  await server.stop();
});

const launcher = (page: Page) => page.getByRole("button", { name: "Open chat" });
const input = (page: Page) => page.getByRole("textbox", { name: "Your message" });

async function sendMessage(page: Page, text: string) {
  await launcher(page).click();
  await input(page).fill(text);
  await input(page).press("Enter");
  await expect(page.locator(".msg.mine", { hasText: text })).toBeVisible();
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
}

async function sendMessageWhenOpen(page: Page, text: string) {
  await launcher(page).click();
  await input(page).fill(text);
  await input(page).press("Enter");
  await expect(page.locator(".msg.mine", { hasText: text })).toBeVisible();
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Not sent" })).toHaveCount(0);
}

function setVisibility(page: Page, state: "hidden" | "visible") {
  return page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { get: () => value, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** Makes new tabs report that they are hidden. Headless browsers report every tab as visible. */
async function hideNewTabs(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
  });
}

test("a visitor chats on a hostile page, and a refresh keeps the history @smoke", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // Firefox asks for the host page's own favicon, which that page's CSP blocks.
    if (message.type() === "error" && !message.text().includes("favicon")) {
      errors.push(message.text());
    }
  });
  await page.goto(`${server.hostOrigin}/hostile`);

  await sendMessage(page, "The import stops at 40%.");

  // The reload below must not cancel this request, or WebKit logs an access control error.
  const read = page.waitForResponse("**/read");
  await server.reply("Thanks, we are looking.");
  await expect(
    page.locator(".msg:not(.mine)", { hasText: "Thanks, we are looking." }),
  ).toBeVisible();

  await read;
  await page.reload();
  await launcher(page).click();
  await expect(page.locator(".msg")).toHaveText([
    "The import stops at 40%.",
    "Thanks, we are looking.",
  ]);
  expect(errors).toEqual([]);
});

test("the host page's CSS does not change the widget", async ({ page }) => {
  await page.goto(`${server.hostOrigin}/hostile`);
  await expect(launcher(page)).toBeVisible();
  await launcher(page).click();
  const box = await input(page).boundingBox();
  expect(box?.height).toBe(44);
  const style = await input(page).evaluate((element) => {
    const computed = getComputedStyle(element);
    return { fontSize: computed.fontSize, color: computed.color };
  });
  expect(style.fontSize).toBe("14.5px");
  expect(style.color).not.toBe("rgb(0, 255, 0)");
});

test("a focus trap on the host page does not steal focus from the widget", async ({ page }) => {
  await page.goto(`${server.hostOrigin}/hostile`);
  await launcher(page).click();
  await input(page).click();
  await page.keyboard.type("typed through");
  await expect(input(page)).toHaveValue("typed through");
});

test("the widget works under the strictest CSP it documents", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  await page.goto(`${server.hostOrigin}/strictest`);
  await sendMessage(page, "Strict hello");
  expect(violations).toEqual([]);
});

test("a page load with no conversation opens no stream and writes no row", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const before = await server.visitorCount();
  await page.goto(`${server.hostOrigin}/plain`);
  await expect(launcher(page)).toBeVisible();
  expect(requests.filter((url) => url.includes("/v1/"))).toEqual([]);
  expect(requests.filter((url) => url.endsWith("/widget/widget.js"))).toEqual([]);
  expect(await server.visitorCount()).toBe(before);
  await context.close();
});

test("a visitor with only a closed conversation holds no stream", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.hostOrigin}/plain`);
  await sendMessage(page, "Closed soon");
  await server.closeConversations();

  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.reload();
  await expect.poll(() => requests.some((url) => url.endsWith("/me"))).toBe(true);
  await page.waitForTimeout(300);
  expect(requests.filter((url) => url.includes("/stream"))).toEqual([]);
  await context.close();
});

test("a refused stream waits for Retry-After before it tries again", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const tries: number[] = [];
  await page.route("**/stream*", async (route) => {
    tries.push(Date.now());
    if (tries.length > 1) return route.continue().catch(() => {});
    // As the server answers when it holds too many streams. The backoff would try again in 1 second.
    return route.fulfill({
      status: 429,
      headers: {
        "access-control-allow-origin": server.hostOrigin,
        "access-control-expose-headers": "retry-after",
        "retry-after": "3",
      },
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "too_many_requests", message: "Busy." } }),
    });
  });
  await page.goto(`${server.hostOrigin}/plain`);
  await sendMessage(page, "Busy server");
  await expect.poll(() => tries.length, { timeout: 6000 }).toBe(2);
  expect((tries[1] ?? 0) - (tries[0] ?? 0)).toBeGreaterThanOrEqual(2900);
  await context.close();
});

test("a visitor can save an email", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.hostOrigin}/plain`);
  await launcher(page).click();
  await expect(page.getByLabel("Your email")).toHaveCount(0);
  await input(page).fill("Hello");
  await input(page).press("Enter");
  await page.getByLabel("Your email").fill("pat@example.com");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Thanks. We will use this email")).toBeVisible();
  expect(await server.visitorEmails()).toContain("pat@example.com");
  await context.close();
});

test("a hidden tab catches up when it becomes visible", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.hostOrigin}/plain`);
  await sendMessage(page, "Before hiding");

  // A hidden tab drops its stream, so wait for that before sending.
  const dropped = page.waitForEvent("requestfailed", (r) => r.url().includes("/stream"));
  await setVisibility(page, "hidden");
  await dropped;
  await server.reply("Sent while hidden");
  await page.waitForTimeout(200);
  await expect(page.locator(".msg", { hasText: "Sent while hidden" })).toHaveCount(0);

  await setVisibility(page, "visible");
  await expect(page.locator(".msg", { hasText: "Sent while hidden" })).toBeVisible();
  await context.close();
});

test("seven open tabs on HTTP/1.1 can still send", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await first.goto(`${server.hostOrigin}/plain`);
  await sendMessage(first, "First tab");

  // Six more tabs that report hidden, as background tabs do. None may hold a stream.
  await hideNewTabs(context);
  const streams: string[] = [];
  const pages: Page[] = [];
  for (let i = 0; i < 6; i++) {
    const page = await context.newPage();
    page.on("request", (request) => {
      if (request.url().includes("/stream")) streams.push(request.url());
    });
    await page.goto(`${server.hostOrigin}/plain`);
    pages.push(page);
  }
  await pages.at(-1)?.waitForTimeout(300);
  expect(streams).toEqual([]);

  // The first tab still holds its stream, and it can still send.
  await input(first).fill("Still works");
  await input(first).press("Enter");
  await expect(first.locator(".msg.mine", { hasText: "Still works" })).toBeVisible();
  await expect(first.locator(".state", { hasText: "Sending" })).toHaveCount(0);
  await context.close();
});

test.describe("the host page API", () => {
  type Win = Window & {
    Dinghy: {
      open(): void;
      close(): void;
      identify(token: unknown): void;
      reset(): void;
      onUnreadChange(callback: (count: number) => void): () => void;
    };
    counts: number[];
    renewals: number;
  };

  const identify = (page: Page, token: string) =>
    page.evaluate((value) => (window as unknown as Win).Dinghy.identify(value), token);

  test("open and close work, including a call queued before the loader", async ({ page }) => {
    await page.goto(`${server.hostOrigin}/queued`);
    await expect(input(page)).toBeVisible();
    await page.evaluate(() => (window as unknown as Win).Dinghy.close());
    await expect(input(page)).toHaveCount(0);
    await page.evaluate(() => (window as unknown as Win).Dinghy.open());
    await expect(input(page)).toBeVisible();
  });

  test("the launcher can be hidden, and open still works", async ({ page }) => {
    await page.goto(`${server.hostOrigin}/no-launcher`);
    await expect(launcher(page)).toBeHidden();
    await page.evaluate(() => (window as unknown as Win).Dinghy.open());
    await expect(input(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(launcher(page)).toBeHidden();
  });

  test("a signed-in user chats as that user, with no email field", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await identify(page, await server.hostToken("user-a"));
    await sendMessage(page, "Signed in");
    await expect(page.getByLabel("Your email")).toHaveCount(0);
    // Its token stays out of storage, and the next page load must call identify() again.
    const stored = await page.evaluate(() => Object.keys(localStorage));
    expect(stored.filter((name) => name.startsWith("dinghy:token:"))).toEqual([]);
    await context.close();
  });

  test("a send across token expiry renews the token", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const expired = await server.hostToken("renewing", 2);
    const fresh = await server.hostToken("renewing");
    await page.goto(`${server.hostOrigin}/plain`);
    await page.evaluate(
      ([first, second]) => {
        const win = window as unknown as Win;
        win.renewals = 0;
        win.Dinghy.identify(async () => {
          win.renewals += 1;
          return win.renewals === 1 ? first : second;
        });
      },
      [expired, fresh],
    );
    await sendMessage(page, "Before expiry");
    await page.waitForTimeout(2500);
    await input(page).fill("After expiry");
    await input(page).press("Enter");
    await expect(page.locator(".msg.mine", { hasText: "After expiry" })).toBeVisible();
    await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Not sent" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Win).renewals)).toBeGreaterThan(1);
    await context.close();
  });

  test("a late response for user A does not render after a switch to user B", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await identify(page, await server.hostToken("switch-a"));
    await sendMessage(page, "Private to A");
    const tokenB = await server.hostToken("switch-b");

    // A's history is on its way when the page signs out and signs in B.
    await page.reload();
    let heldA = false;
    await page.route("**/stream*", async (route) => {
      const isA = !heldA;
      heldA = true;
      if (isA) await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue().catch(() => {});
    });
    await identify(page, await server.hostToken("switch-a"));
    await launcher(page).click();
    await page.evaluate(() => (window as unknown as Win).Dinghy.reset());
    await identify(page, tokenB);
    await page.waitForTimeout(1200);
    await expect(page.locator(".msg", { hasText: "Private to A" })).toHaveCount(0);
    await context.close();
  });

  test("a rejected token does not cause a request loop", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await page.evaluate(() => {
      const win = window as unknown as Win;
      win.renewals = 0;
      // A different bad token each time, as after a rotated secret.
      win.Dinghy.identify(async () => {
        win.renewals += 1;
        return `bad.token.${win.renewals}`;
      });
    });
    await page.waitForTimeout(2500);
    const calls = await page.evaluate(() => (window as unknown as Win).renewals);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(4);
    await context.close();
  });

  test("a renewal that fails once is retried", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const good = await server.hostToken("retried");
    await page.goto(`${server.hostOrigin}/plain`);
    await page.evaluate((token) => {
      const win = window as unknown as Win;
      win.renewals = 0;
      win.Dinghy.identify(async () => {
        win.renewals += 1;
        if (win.renewals === 1) throw new Error("The host backend failed once");
        return token;
      });
    }, good);
    await sendMessageWhenOpen(page, "After a failed renewal");
    await context.close();
  });

  test("a send does not mark a reply as read before it arrives", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await sendMessage(page, "Question");
    const reads: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/read")) reads.push(request.postData() ?? "");
    });

    // The tab is hidden when the reply commits, and its stream comes back slowly.
    const dropped = page.waitForEvent("requestfailed", (r) => r.url().includes("/stream"));
    await setVisibility(page, "hidden");
    await dropped;
    const replySeq = await server.reply("Unseen reply");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/stream*", async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    await setVisibility(page, "visible");

    // The send's response has a higher position than the reply that has not arrived yet.
    await input(page).fill("Sent before the reply arrived");
    await input(page).press("Enter");
    await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
    await page.waitForTimeout(200);
    const positions = () => reads.map((body) => BigInt((JSON.parse(body) as { seq: string }).seq));
    expect(positions().every((seq) => seq < replySeq)).toBe(true);

    release();
    await expect(page.locator(".msg", { hasText: "Unseen reply" })).toBeVisible();
    await expect.poll(() => positions().some((seq) => seq >= replySeq)).toBe(true);
    await context.close();
  });

  test("a reply followed by a close while the tab is hidden still shows a badge", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await sendMessage(page, "Closing soon");
    await page.keyboard.press("Escape");
    const dropped = page.waitForEvent("requestfailed", (r) => r.url().includes("/stream"));
    await setVisibility(page, "hidden");
    await dropped;
    await server.reply("Reply before closing");
    await server.closeConversations();
    await setVisibility(page, "visible");
    await expect(page.getByRole("button", { name: "Open chat (1)" })).toBeVisible();
    const read = page.waitForResponse("**/read");
    await launcher(page).click();
    await expect(page.locator(".msg", { hasText: "Reply before closing" })).toBeVisible();
    await read;
    await page.keyboard.press("Escape");
    await expect(launcher(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Open chat (1)" })).toHaveCount(0);
    await context.close();
  });

  test("a late response cannot bring back a badge for a reply already read", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await sendMessage(page, "Closed with a reply");
    await page.keyboard.press("Escape");
    await server.reply("Read before the slow response");
    await server.closeConversations();

    // The next /me is slow, and it reports the reply as unread.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/me", async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.reload();
    const read = page.waitForResponse("**/read");
    await launcher(page).click();
    await expect(page.locator(".msg", { hasText: "Read before the slow response" })).toBeVisible();
    await read;
    await page.keyboard.press("Escape");
    await expect(launcher(page)).toBeVisible();
    release();
    await page.waitForTimeout(200);
    await expect(page.getByRole("button", { name: "Open chat (1)" })).toHaveCount(0);
    await context.close();
  });

  test("a read in another tab clears this tab's count when it becomes visible", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    await first.goto(`${server.hostOrigin}/plain`);
    await sendMessage(first, "Two tabs");
    await first.keyboard.press("Escape");
    await server.reply("A reply");
    await expect(first.getByRole("button", { name: "Open chat (1)" })).toBeVisible();

    const second = await context.newPage();
    await second.goto(`${server.hostOrigin}/plain`);
    await second.bringToFront();
    const read = second.waitForResponse("**/read");
    await launcher(second).click();
    await expect(second.locator(".msg", { hasText: "A reply" })).toBeVisible();
    await read;

    await setVisibility(first, "hidden");
    await setVisibility(first, "visible");
    await expect(first.getByRole("button", { name: "Open chat (1)" })).toHaveCount(0);
    await context.close();
  });

  test("a late 401 from an old session does not erase the new session's token", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    let releaseOld = () => {};
    const held = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    await page.route("**/me", async (route) => {
      if (route.request().headers().authorization === "Bearer dbt_invalid") await held;
      await route.continue().catch(() => {});
    });
    await page.evaluate(() =>
      localStorage.setItem(
        `dinghy:token:${document.querySelector("script[data-key]")?.getAttribute("data-key")}`,
        "dbt_invalid",
      ),
    );
    const meRequest = page.waitForRequest("**/me");
    await page.reload();
    await meRequest;
    await page.evaluate(() => (window as unknown as Win).Dinghy.reset());
    await sendMessage(page, "New session");
    const tokens = () =>
      page.evaluate(() =>
        Object.entries(localStorage).filter(([name]) => name.startsWith("dinghy:token:")),
      );
    expect(await tokens()).toHaveLength(1);
    releaseOld();
    await page.waitForTimeout(200);
    expect(await tokens()).toHaveLength(1);
    await context.close();
  });

  test("reset ends the session in another tab too", async ({ browser }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    await first.goto(`${server.hostOrigin}/plain`);
    await sendMessage(first, "Private text");
    const second = await context.newPage();
    await second.goto(`${server.hostOrigin}/plain`);
    // Some browsers report a background tab as hidden, and a hidden tab holds no stream.
    await second.bringToFront();
    await launcher(second).click();
    await expect(second.locator(".msg", { hasText: "Private text" })).toBeVisible();

    await first.evaluate(() => (window as unknown as Win).Dinghy.reset());
    await expect(first.locator(".msg", { hasText: "Private text" })).toHaveCount(0);
    await expect(second.locator(".msg", { hasText: "Private text" })).toHaveCount(0);
    const stored = await first.evaluate(() => Object.keys(localStorage));
    expect(stored.filter((name) => name.startsWith("dinghy:token:"))).toEqual([]);
    await context.close();
  });

  test("a visitor who starts after reset is a new visitor", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await sendMessage(page, "Old visitor");
    await page.evaluate(() => (window as unknown as Win).Dinghy.reset());
    const before = await server.visitorCount();
    await input(page).fill("New visitor");
    await input(page).press("Enter");
    await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
    await expect(page.locator(".msg")).toHaveText(["New visitor"]);
    expect(await server.visitorCount()).toBe(before + 1);
    await context.close();
  });

  test("onUnreadChange fires while the chat is closed, and reading clears it", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await sendMessage(page, "Unread test");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const win = window as unknown as Win;
      win.counts = [];
      win.Dinghy.onUnreadChange((count) => win.counts.push(count));
    });

    await server.reply("One reply");
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).counts.at(-1))).toBe(1);
    await expect(page.getByRole("button", { name: "Open chat (1)" })).toBeVisible();

    const read = page.waitForResponse("**/read");
    await launcher(page).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).counts.at(-1))).toBe(0);
    await read;

    // The read position is stored, so the count stays at 0 after a reload.
    await page.reload();
    await page.waitForTimeout(300);
    await expect(page.getByRole("button", { name: "Open chat (1)" })).toHaveCount(0);
    await context.close();
  });

  test("a page view with the chat closed streams only unread messages, and opening it shows all", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await sendMessage(page, "Old history line");
    const read = page.waitForResponse("**/read");
    await server.reply("A reply already read");
    await expect(page.locator(".msg:not(.mine)", { hasText: "already read" })).toBeVisible();
    await read;
    await page.keyboard.press("Escape");
    await server.reply("A reply not read yet");
    await expect(page.getByRole("button", { name: "Open chat (1)" })).toBeVisible();

    const streams: URL[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/stream")) streams.push(new URL(request.url()));
    });
    await page.reload();
    await expect(page.getByRole("button", { name: "Open chat (1)" })).toBeVisible();
    await expect.poll(() => streams.length).toBe(1);
    // It starts at the read position, so the history it skips never leaves the server.
    expect(streams[0]?.searchParams.get("after")).toMatch(/^\d+\.[1-9]\d*$/);

    await page.getByRole("button", { name: "Open chat (1)" }).click();
    await expect(page.locator(".msg")).toHaveText([
      "Old history line",
      "A reply already read",
      "A reply not read yet",
    ]);
    expect(streams.at(-1)?.searchParams.get("after")).toBeNull();
    await context.close();
  });

  test("a visitor with only a closed conversation sees its unread count with no stream", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.hostOrigin}/plain`);
    await sendMessage(page, "Reply then close");
    await page.keyboard.press("Escape");
    await server.reply("Reply before closing");
    await server.closeConversations();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.reload();
    await expect(page.getByRole("button", { name: "Open chat (1)" })).toBeVisible();
    expect(requests.filter((url) => url.includes("/stream"))).toEqual([]);
    await context.close();
  });
});

test("Escape closes the chat and returns focus to the launcher", async ({ page }) => {
  await page.goto(`${server.hostOrigin}/plain`);
  await launcher(page).click();
  await expect(input(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(launcher(page)).toBeFocused();
});

test("typing in the chat does not fire the host page's shortcuts", async ({ page }) => {
  await page.goto(`${server.hostOrigin}/hostile`);
  await launcher(page).click();
  await input(page).click();
  await page.keyboard.type("/search");
  await expect(input(page)).toHaveValue("/search");
  expect(await page.evaluate(() => (window as { __shortcuts?: number }).__shortcuts)).toBeFalsy();
});

test("two quick first sends share one visitor", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Hold the first response, so the second send happens before it returns.
  await page.route("**/visitors", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  const before = await server.visitorCount();
  await page.goto(`${server.hostOrigin}/plain`);
  await launcher(page).click();
  await input(page).fill("One");
  await input(page).press("Enter");
  await input(page).fill("Two");
  await input(page).press("Enter");
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
  expect(await server.visitorCount()).toBe(before + 1);
  await page.reload();
  await launcher(page).click();
  await expect(page.locator(".msg")).toHaveCount(2);
  await context.close();
});

test("a send whose response is lost is not marked as failed", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.hostOrigin}/plain`);
  await sendMessage(page, "First");
  // The server stores the message, and the browser never gets the response.
  await page.route("**/messages", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await input(page).fill("Response lost");
  await input(page).press("Enter");
  await expect(page.locator(".msg", { hasText: "Response lost" })).toHaveCount(1);
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Not sent" })).toHaveCount(0);
  await context.close();
});

test("a message sent while history loads stays in commit order", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.hostOrigin}/plain`);
  await sendMessage(page, "Older");
  // Hold the stream on the next visit, so the new send returns before the history arrives.
  await page.route("**/stream*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.reload();
  await launcher(page).click();
  await input(page).fill("Newer");
  await input(page).press("Enter");
  await expect(page.locator(".msg")).toHaveText(["Older", "Newer"]);
  await context.close();
});

test("a failed bundle load does not disable the launcher", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let failed = false;
  await page.route("**/widget/widget.js", async (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.abort();
  });
  await page.goto(`${server.hostOrigin}/plain`);
  await launcher(page).click();
  await expect.poll(() => failed).toBe(true);
  await page.waitForTimeout(100);
  await launcher(page).click();
  await expect(input(page)).toBeVisible();
  await context.close();
});

for (const [name, init] of [
  ["with isComposing", { isComposing: true }],
  ["with keyCode 229, as Safari reports it", { keyCode: 229 }],
] as const) {
  test(`Enter during IME composition does not send, ${name}`, async ({ page }) => {
    await page.goto(`${server.hostOrigin}/plain`);
    await launcher(page).click();
    await input(page).fill("unfinished");
    await input(page).evaluate((element, options) => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          ...options,
          key: "Enter",
          bubbles: true,
          composed: true,
        }),
      );
    }, init);
    await expect(input(page)).toHaveValue("unfinished");
  });
}
