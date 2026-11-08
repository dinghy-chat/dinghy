// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { expect, type Page, test } from "@playwright/test";
import { startCloudE2EServer } from "../server/test/e2e-cloud.ts";

const PASSWORD = "a-long-test-password";

type Server = Awaited<ReturnType<typeof startCloudE2EServer>>;

/** The account step: email and password only. */
async function createAccount(page: Page, server: Server, email: string) {
  await page.goto(server.apiOrigin);
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveCount(0);
  await expect(page.getByLabel("Workspace name")).toHaveCount(0);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password, at least 10 characters").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
}

/** The onboarding step: the operator's name and the workspace's. */
async function onboard(page: Page, workspaceName: string) {
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
  await page.getByLabel("Your name").fill("Nora");
  await page.getByLabel("Workspace name").fill(workspaceName);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function signUp(page: Page, server: Server, workspaceName: string) {
  await createAccount(page, server, `nora-${Date.now()}@example.com`);
  await onboard(page, workspaceName);
}

async function signIn(page: Page, server: Server, email: string) {
  await page.goto(server.apiOrigin);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** The fake Checkout page's session, and the workspace it pays for. */
async function onCheckout(page: Page, server: Server) {
  const stripe = server.stripe;
  if (stripe === null) throw new Error("Billing is off");
  await expect(page.getByRole("heading", { name: "Fake Checkout" })).toBeVisible();
  expect(page.url().startsWith(`${stripe.apiBase}/pay/`)).toBe(true);
  const sessionId = page.url().split("/").at(-1) ?? "";
  const workspaceId = stripe.sessions.get(sessionId)?.params.get("client_reference_id") ?? "";
  return { sessionId, workspaceId };
}

test.describe("with billing on", () => {
  let server: Server;

  test.beforeAll(async () => {
    server = await startCloudE2EServer({ billing: true });
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("sign up, pay on Checkout, and land in the inbox @smoke", async ({ page }) => {
    await signUp(page, server, "Harbor Shop");
    const { sessionId, workspaceId } = await onCheckout(page, server);

    // Stripe sends the browser back before its webhook arrives.
    await page.goto(`${server.apiOrigin}/billing/return?workspace=${workspaceId}`);
    await expect(page.getByText("Waiting for the payment to clear...")).toBeVisible();
    await server.completeCheckout(sessionId);
    await expect(page.getByRole("heading", { name: "Harbor Shop" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("an abandoned Checkout leaves the workspace waiting, with a way back to pay", async ({
    page,
  }) => {
    await signUp(page, server, "Left Behind");
    await onCheckout(page, server);
    await page.goto(server.apiOrigin);
    await expect(page.getByRole("heading", { name: "Finish payment" })).toBeVisible();
    await page.getByRole("button", { name: "Pay on Stripe" }).click();
    await onCheckout(page, server);
  });

  test("an unpaid second workspace keeps a way back to the paid one", async ({ page }) => {
    await signUp(page, server, "Paid Shop");
    const { sessionId } = await onCheckout(page, server);
    await server.completeCheckout(sessionId);
    await page.goto(server.apiOrigin);
    await expect(page.getByRole("heading", { name: "Paid Shop" })).toBeVisible();

    // The same account starts a second workspace and leaves before paying.
    const me = (await (await page.request.get(`${server.apiOrigin}/v1/operator/me`)).json()) as {
      email: string;
    };
    const again = await page.request.post(`${server.apiOrigin}/v1/signup`, {
      headers: { origin: server.apiOrigin },
      data: { email: me.email, password: PASSWORD },
    });
    expect(again.status()).toBe(200);
    const second = await page.request.post(`${server.apiOrigin}/v1/operator/workspaces`, {
      headers: { origin: server.apiOrigin },
      data: { name: "Nora", workspaceName: "Unpaid Shop" },
    });
    expect(second.status()).toBe(200);
    const { workspaceId } = (await second.json()) as { workspaceId: string };
    await page.goto(`${server.apiOrigin}/?workspace=${workspaceId}`);
    await expect(page.getByRole("heading", { name: "Finish payment" })).toBeVisible();
    await page.getByRole("button", { name: "Open Paid Shop" }).click();
    // With two workspaces, the rail shows a picker instead of one name.
    const picked = page.getByRole("combobox", { name: "Workspace" }).locator("option:checked");
    await expect(picked).toHaveText("Paid Shop");
    // The choice is remembered, so a reload does not go back to the payment screen.
    await page.goto(server.apiOrigin);
    await expect(picked).toHaveText("Paid Shop");
  });
});

test.describe("with no Stripe keys", () => {
  let server: Server;

  test.beforeAll(async () => {
    server = await startCloudE2EServer();
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("a self-hosted install shows no billing", async ({ page }) => {
    await page.goto(server.apiOrigin);
    await expect(page.getByRole("heading", { name: "Sign in to Dinghy" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Create an account" })).toHaveCount(0);
    expect((await page.request.get(`${server.apiOrigin}/signup`)).status()).toBe(404);
  });

  test("an operator with no workspace is asked for an invite, not onboarded", async ({ page }) => {
    const email = `lone-${Date.now()}@example.com`;
    await server.createOperator(email, PASSWORD, { member: false });
    await signIn(page, server, email);
    await expect(
      page.getByText("You are not in a workspace yet. Ask its owner for an invite."),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Set up your workspace" })).toHaveCount(0);
    const create = await page.request.post(`${server.apiOrigin}/v1/operator/workspaces`, {
      headers: { origin: server.apiOrigin },
      data: { name: "Nora", workspaceName: "X" },
    });
    expect(create.status()).toBe(404);
  });
});

test.describe("with early signup and no Stripe keys", () => {
  let server: Server;

  test.beforeAll(async () => {
    server = await startCloudE2EServer({ early: true });
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("sign up, land in the inbox with the sample conversation, reply, and see no install code yet @smoke", async ({
    page,
  }) => {
    const email = `nora-${Date.now()}@example.com`;
    await page.goto(server.apiOrigin);
    await page.getByRole("link", { name: "Create an account" }).click();
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    // No helper line under the form, and no payment.
    await expect(page.locator(".card .note")).toHaveCount(0);
    await expect(page.getByText(/pay|Stripe/i)).toHaveCount(0);
    await createAccount(page, server, email);
    await expect(page.getByText(/pay|Stripe/i)).toHaveCount(0);
    await onboard(page, "Early Shop");

    await expect(page.getByRole("heading", { name: "Early Shop" })).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Dinghy Cloud opens soon." }),
    ).toHaveText(
      `Dinghy Cloud opens soon. Your workspace is ready, and we will email you at ${email} when you can turn it on.`,
    );
    await page.locator(".row", { hasText: "Sample visitor" }).click();
    await expect(
      page.getByText("Hi! This is a sample conversation.", { exact: false }),
    ).toHaveCount(2);
    const reply = page.getByRole("textbox", { name: "Your reply" });
    await reply.fill("Thanks, got it!");
    await reply.press("Enter");
    await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
    await expect(page.getByText("Thanks, got it!").last()).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Your install code appears when the cloud opens.")).toBeVisible();
    await expect(page.getByText("/widget/loader.js", { exact: false })).toHaveCount(0);
    // The banner is on every page.
    await expect(page.getByText("Dinghy Cloud opens soon.", { exact: false })).toBeVisible();
  });

  test("an account that left after the first step finishes onboarding at its next sign-in", async ({
    page,
    context,
  }) => {
    const email = `nora-${Date.now()}@example.com`;
    await createAccount(page, server, email);
    await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
    await context.clearCookies();

    await signIn(page, server, email);
    await onboard(page, "Late Shop");
    await expect(page.getByRole("heading", { name: "Late Shop" })).toBeVisible();
    await expect(page.locator(".row", { hasText: "Sample visitor" })).toBeVisible();
  });

  test("an existing account signs up again with its password to add a workspace", async ({
    page,
    context,
  }) => {
    const email = `nora-${Date.now()}@example.com`;
    await createAccount(page, server, email);
    await onboard(page, "First Shop");
    await expect(page.getByRole("heading", { name: "First Shop" })).toBeVisible();
    await context.clearCookies();

    // A wrong password gets the usual answer.
    await page.goto(`${server.apiOrigin}/signup`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password, at least 10 characters").fill("a-wrong-long-password");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("This email already has an account.", { exact: false }),
    ).toBeVisible();

    await createAccount(page, server, email);
    // The form keeps the account's name.
    await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
    await expect(page.getByLabel("Your name")).toHaveValue("Nora");
    await page.getByLabel("Workspace name").fill("Second Shop");
    await page.getByRole("button", { name: "Continue" }).click();
    const picked = page.getByRole("combobox", { name: "Workspace" }).locator("option:checked");
    await expect(picked).toHaveText("Second Shop");
  });
});
