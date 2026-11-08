import { type Browser, expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";

const PASSWORD = "a-long-test-password";
const SNIPPET = '<script src="{{API}}/widget/loader.js" data-key="{{PUBLIC_KEY}}" async></script>';

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({
    "/plain": { html: `<!doctype html><title>Host</title>${SNIPPET}` },
  });
  await server.createOperator("anna@example.com", PASSWORD);
  await server.createSecondWorkspace("Elsewhere", "bea@example.com", PASSWORD);
});

test.afterAll(async () => {
  await server.stop();
});

interface DinghyWindow {
  Dinghy: { identify(token: string): void; reset(): void; open(): void };
}

const input = (page: Page) => page.getByRole("textbox", { name: "Your message" });

async function say(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press("Enter");
  await expect(page.locator(".msg.mine", { hasText: text })).toBeVisible();
  await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
}

const identify = (page: Page, token: string) =>
  page.evaluate((value) => {
    const win = window as unknown as DinghyWindow;
    win.Dinghy.identify(value);
    win.Dinghy.open();
  }, token);

async function signIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function freshPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

test("a visitor's chat is gone after sign-out, and the next user sees only their own @smoke", async ({
  browser,
}) => {
  const page = await freshPage(browser);
  await page.goto(`${server.hostOrigin}/plain`);
  await identify(page, await server.hostToken("first-user"));
  await say(page, "Private note from the first user");

  // The first user signs out of the host product, in this same browser tab.
  await page.evaluate(() => (window as unknown as DinghyWindow).Dinghy.reset());
  await expect(page.getByText("Private note from the first user")).toHaveCount(0);

  // The second user signs in, on the same page, with no reload.
  await identify(page, await server.hostToken("second-user"));
  await expect(input(page)).toBeVisible();
  await say(page, "Note from the second user");
  await expect(page.getByText("Private note from the first user")).toHaveCount(0);

  // A reload with the second user's identity still shows nothing from the first.
  await page.reload();
  await identify(page, await server.hostToken("second-user"));
  await expect(page.locator(".msg.mine", { hasText: "Note from the second user" })).toBeVisible();
  await expect(page.getByText("Private note from the first user")).toHaveCount(0);

  // The first user returns and gets their own chat back.
  await page.evaluate(() => (window as unknown as DinghyWindow).Dinghy.reset());
  await identify(page, await server.hostToken("first-user"));
  await expect(
    page.locator(".msg.mine", { hasText: "Private note from the first user" }),
  ).toBeVisible();
  await expect(page.getByText("Note from the second user")).toHaveCount(0);
  await page.context().close();
});

test("a signed-out visitor's token does not survive reset", async ({ browser }) => {
  const page = await freshPage(browser);
  await page.goto(`${server.hostOrigin}/plain`);
  await page.getByRole("button", { name: "Open chat" }).click();
  await say(page, "Note with a browser token");
  const stored = () =>
    page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("dinghy:token:")));
  expect(await stored()).toHaveLength(1);
  await page.evaluate(() => (window as unknown as DinghyWindow).Dinghy.reset());
  await expect.poll(stored).toEqual([]);
  await expect(page.getByText("Note with a browser token")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(input(page)).toBeVisible();
  await expect(page.getByText("Note with a browser token")).toHaveCount(0);
  await page.context().close();
});

test("the next operator on a shared browser sees only their own workspace", async ({ browser }) => {
  await server.seedConversations(1, "anna's customer");
  const page = await freshPage(browser);
  await page.goto(server.apiOrigin);
  await signIn(page, "anna@example.com");
  await page.locator(".row", { hasText: "anna's customer" }).click();
  await expect(page.getByRole("textbox", { name: "Your reply" })).toBeVisible();
  const target = await page.evaluate(async () => {
    const me = await (await fetch("/v1/operator/me")).json();
    const base = `/v1/operator/workspaces/${me.workspaces[0].workspaceId}`;
    const list = await (await fetch(`${base}/conversations`)).json();
    return { workspace: me.workspaces[0].workspaceId, conversation: list.conversations[0].id };
  });

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Dinghy" })).toBeVisible();
  await expect(page.getByText("anna's customer")).toHaveCount(0);

  await signIn(page, "bea@example.com");
  await expect(page.getByRole("heading", { name: "Elsewhere" })).toBeVisible();
  await expect(page.getByText("anna's customer")).toHaveCount(0);

  // Anna's link opens nothing of hers for Bea.
  await page.goto(
    `${server.apiOrigin}/?workspace=${target.workspace}&conversation=${target.conversation}`,
  );
  await expect(page.getByRole("heading", { name: "Elsewhere" })).toBeVisible();
  await expect(page.getByText("anna's customer")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Your reply" })).toHaveCount(0);

  // And direct requests with Bea's session return nothing of Anna's.
  const statuses = await page.evaluate(async (ids) => {
    const base = `/v1/operator/workspaces/${ids.workspace}`;
    const urls = [
      base,
      `${base}/conversations`,
      `${base}/conversations/${ids.conversation}/messages?after=0`,
      `${base}/settings`,
    ];
    return Promise.all(urls.map(async (url) => (await fetch(url)).status));
  }, target);
  expect(statuses).toEqual([404, 404, 404, 404]);
  await page.context().close();
  await server.closeConversations();
});
