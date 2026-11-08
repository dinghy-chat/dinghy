import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";

const PASSWORD = "a-long-test-password";

let server: Awaited<ReturnType<typeof startE2EServer>>;

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("anna@example.com", PASSWORD);
});

test.afterAll(async () => {
  await server.stop();
});

// A browser in CI cannot reach a real push service, so only the call to it is replaced. A real
// phone check covers that part by hand.
const FAKE_PUSH = () => {
  let current: unknown = null;
  const fake = {
    endpoint: "https://fcm.googleapis.com/fcm/send/e2e",
    toJSON: () => ({
      endpoint: fake.endpoint,
      keys: {
        p256dh:
          "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
        auth: "tBHItJI5svbpez7KI4CCXg",
      },
    }),
    unsubscribe: async () => {
      current = null;
      return true;
    },
  };
  PushManager.prototype.subscribe = async () => {
    current = fake;
    return fake as unknown as PushSubscription;
  };
  PushManager.prototype.getSubscription = async () => current as PushSubscription | null;
};

async function signedIn(page: Page) {
  await page.goto(server.apiOrigin);
  await page.getByLabel("Email").fill("anna@example.com");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E" })).toBeVisible();
}

test("an operator turns on notifications and receives a test, and sign-out ends them @smoke", async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Only Chromium grants notifications in a headless test");
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.grantPermissions(["notifications"], { origin: server.apiOrigin });
  await page.addInitScript(FAKE_PUSH);
  await signedIn(page);

  const before = server.pushed.length;
  await page.getByRole("button", { name: "Alerts" }).click();
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("status")).toContainText("The test was sent");
  expect(server.pushed.length).toBe(before + 1);
  expect(server.pushed.at(-1)).toContain("fcm.googleapis.com");
  await page.getByRole("button", { name: "Send a test" }).click();
  await expect.poll(() => server.pushed.length).toBe(before + 2);

  // With no mail server, the settings say what that means.
  await expect(page.getByText("This server cannot send email.")).toBeVisible();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator(".page")).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Dinghy" })).toBeVisible();
  const remaining = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.pushManager.getSubscription();
  });
  expect(remaining).toBeNull();
  await context.close();
});

test("the service worker registers from the root under the page's CSP", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.apiOrigin);
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/sw.js");
    return registration.scope;
  });
  expect(scope).toBe(`${server.apiOrigin}/`);
  await context.close();
});

test("a link from a notification opens its conversation", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await server.seedConversations(1, "deep link");
  await signedIn(page);
  await expect(page.locator(".row", { hasText: "deep link" })).toBeVisible();
  await page.locator(".row", { hasText: "deep link" }).click();
  await expect(page.getByRole("textbox", { name: "Your reply" })).toBeVisible();
  const target = await page.evaluate(async () => {
    const me = await (await fetch("/v1/operator/me")).json();
    const base = `/v1/operator/workspaces/${me.workspaces[0].workspaceId}`;
    const list = await (await fetch(`${base}/conversations?status=open&limit=1`)).json();
    return {
      workspaceId: me.workspaces[0].workspaceId as string,
      conversationId: list.conversations[0].id as string,
    };
  });
  const fresh = await context.newPage();
  await fresh.goto(
    `${server.apiOrigin}/?workspace=${target.workspaceId}&conversation=${target.conversationId}`,
  );
  await expect(fresh.getByRole("textbox", { name: "Your reply" })).toBeVisible();
  await server.closeConversations();
  await context.close();
});
