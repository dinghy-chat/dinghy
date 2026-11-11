// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { expect, type Page, test } from "@playwright/test";
import { openLink } from "../../tests/e2e/links.ts";
import { openSettings } from "../../tests/e2e/settings.ts";
import { startCloudE2EServer } from "../server/test/e2e-cloud.ts";

type Server = Awaited<ReturnType<typeof startCloudE2EServer>>;

/** The account step: the email only, then the link that comes back to it. */
async function createAccount(
  page: Page,
  server: Server,
  email: string,
  { index = 0, button = "Get started" } = {},
) {
  await page.goto(server.apiOrigin);
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveCount(0);
  await expect(page.getByLabel("Workspace name")).toHaveCount(0);
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-up link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await openLink(page, await server.linkTo(email, index), button);
}

/** The onboarding step: the operator's name and the workspace's. */
async function onboard(page: Page, workspaceName: string) {
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
  await page.getByLabel("Your name").fill("Nora");
  await page.getByLabel("Workspace name").fill(workspaceName);
  // Early signup creates the workspace at once, and paid signup goes on to Stripe.
  await page.getByRole("button", { name: /^(Create workspace|Continue to payment)$/ }).click();
}

async function signUp(page: Page, server: Server, workspaceName: string) {
  await createAccount(page, server, `nora-${Date.now()}@example.com`);
  await onboard(page, workspaceName);
}

async function signIn(page: Page, server: Server, email: string) {
  await openLink(page, await server.signInLink(email));
}

/** Deletes the signed-in account from the screen it is on, with the link that `index` emails. */
async function deleteAccount(page: Page, server: Server, email: string, index: number) {
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Email me the link" }).click();
  await expect(
    page.getByText(`We sent a confirmation link to ${email}`, { exact: false }),
  ).toBeVisible();
  await openLink(page, await server.linkTo(email, index), "Delete my account");
  await expect(page.getByRole("heading", { name: "Your account was deleted." })).toBeVisible();
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
    await expect(page.getByText("Waiting for Stripe to confirm your payment...")).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Activate your workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Pay on Stripe" }).click();
    await onCheckout(page, server);
  });

  test("an owner who never paid deletes the workspace from the payment screen, then the account", async ({
    page,
  }) => {
    const email = `nora-${Date.now()}@example.com`;
    await createAccount(page, server, email);
    await onboard(page, "Never Paid");
    await onCheckout(page, server);
    await page.goto(server.apiOrigin);
    await expect(page.getByRole("heading", { name: "Activate your workspace" })).toBeVisible();

    // The owner deletes the workspace here, before it was ever paid.
    await page.getByRole("button", { name: "Delete workspace" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByLabel("Type Never Paid to confirm").fill("Never Paid");
    await dialog.getByRole("button", { name: "Delete the workspace" }).click();

    // With no workspace left, the onboarding is where the account's delete is.
    await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
    await deleteAccount(page, server, email, 1);
  });

  test("an unpaid second workspace keeps a way back to the paid one", async ({ page }) => {
    await signUp(page, server, "Paid Shop");
    const { sessionId } = await onCheckout(page, server);
    await server.completeCheckout(sessionId);
    await page.goto(server.apiOrigin);
    await expect(page.getByRole("heading", { name: "Paid Shop" })).toBeVisible();

    // The same account starts a second workspace and leaves before paying.
    const second = await page.request.post(`${server.apiOrigin}/v1/operator/workspaces`, {
      headers: { origin: server.apiOrigin },
      data: { name: "Nora", workspaceName: "Unpaid Shop" },
    });
    expect(second.status()).toBe(200);
    const { workspaceId } = (await second.json()) as { workspaceId: string };
    await page.goto(`${server.apiOrigin}/?workspace=${workspaceId}`);
    await expect(page.getByRole("heading", { name: "Activate your workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Paid Shop" }).click();
    // With two workspaces, the rail shows a picker instead of one name.
    const picked = page.getByRole("button", { name: /^Workspace:/ });
    await expect(picked).toHaveAccessibleName("Workspace: Paid Shop");
    // The choice is remembered, so a reload does not go back to the payment screen.
    await page.goto(server.apiOrigin);
    await expect(picked).toHaveAccessibleName("Workspace: Paid Shop");
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
    // A self-hosted server's screens belong to its team, so the logo does not go to dinghy.chat.
    await expect(page.getByRole("link", { name: "Back to dinghy.chat" })).toHaveCount(0);
    expect((await page.request.get(`${server.apiOrigin}/signup`)).status()).toBe(404);
  });

  test("an operator with no workspace is asked for an invite, not onboarded", async ({ page }) => {
    const email = `lone-${Date.now()}@example.com`;
    await server.createOperator(email, { member: false });
    await signIn(page, server, email);
    await expect(
      page.getByText(
        "You are not in a workspace on this server. Ask a workspace's owner for an invite.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Set up your workspace" })).toHaveCount(0);
    const create = await page.request.post(`${server.apiOrigin}/v1/operator/workspaces`, {
      headers: { origin: server.apiOrigin },
      data: { name: "Nora", workspaceName: "X" },
    });
    expect(create.status()).toBe(404);
  });

  test("an operator with no workspace can still delete their account", async ({ page }) => {
    const email = `lone-${Date.now()}@example.com`;
    await server.createOperator(email, { member: false });
    await signIn(page, server, email);
    await deleteAccount(page, server, email, 0);
  });
});

test.describe("with early signup and no Stripe keys", () => {
  let server: Server;

  test.beforeAll(async () => {
    server = await startCloudE2EServer({ early: true, welcome: true });
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("on the cloud, the logo on the account screens goes back to dinghy.chat", async ({
    page,
  }) => {
    for (const path of ["/", "/signup"]) {
      await page.goto(`${server.apiOrigin}${path}`);
      await expect(page.getByRole("link", { name: "Back to dinghy.chat" })).toHaveAttribute(
        "href",
        "https://dinghy.chat",
      );
    }
  });

  test("sign up, land in the inbox with the founder's welcome, reply, and see no install code yet @smoke", async ({
    page,
  }) => {
    const email = `nora-${Date.now()}@example.com`;
    await page.goto(server.apiOrigin);
    await page.getByRole("link", { name: "Create an account" }).click();
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    // One line about the product, and no payment.
    await expect(page.locator(".card .note")).toHaveText(/live chat for your website/);
    await expect(page.getByText(/pay|Stripe/i)).toHaveCount(0);
    await createAccount(page, server, email);
    await expect(page.getByText(/pay|Stripe/i)).toHaveCount(0);
    await onboard(page, "Early Shop");

    await expect(page.getByRole("heading", { name: "Early Shop" })).toBeVisible();
    // A wide screen shows the long line, with the email.
    await expect(page.getByRole("status").locator(".long-text")).toHaveText(
      `Visitor chat is not available yet. We'll email ${email} when you can activate this workspace.`,
    );
    // The welcome chat opens by itself, with no click.
    await expect(page.getByText("Welcome chat with the founder")).toBeVisible();
    await expect(
      page.getByText("Hi, I'm Julien, the founder of Dinghy.", { exact: false }),
    ).toHaveCount(2);
    const reply = page.getByRole("textbox", { name: "Your reply" });
    await reply.fill("Thanks, got it!");
    await reply.press("Enter");
    await expect(page.locator(".state", { hasText: "Sending" })).toHaveCount(0);
    await expect(page.getByText("Thanks, got it!").last()).toBeVisible();

    await openSettings(page, "Install");
    await expect(
      page.getByText("Visitor chat is not available for this workspace yet.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("/widget/loader.js", { exact: false })).toHaveCount(0);
    // The banner is on every page.
    await expect(page.getByRole("status").locator(".long-text")).toBeVisible();
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
    await expect(page.locator(".row", { hasText: "Julien from Dinghy" })).toBeVisible();
  });

  test("an existing account that signs up again gets a sign-in link, then adds a workspace", async ({
    page,
    context,
  }) => {
    const email = `nora-${Date.now()}@example.com`;
    await createAccount(page, server, email);
    await onboard(page, "First Shop");
    await expect(page.getByRole("heading", { name: "First Shop" })).toBeVisible();
    await context.clearCookies();

    // The welcome came after the workspace. Then the same answer as a new email gets, and the
    // email is a sign-in link instead.
    await expect.poll(() => server.mail.filter((one) => one.to === email).length).toBe(2);
    // An email with an account gets a sign-in link, which lands on the workspace setup.
    await createAccount(page, server, email, { index: 2, button: "Sign in" });
    const sent = server.mail.filter((one) => one.to === email);
    expect(sent.map((one) => one.subject)).toEqual([
      "Finish signing up for Dinghy",
      "First Shop is ready",
      "Your Dinghy sign-in link",
    ]);
    expect(sent[1]?.text.startsWith("Hi Nora,")).toBe(true);
    expect(sent[1]?.text).not.toMatch(/opens soon|coming/i);
    // The widget does not run before the cloud opens, so the welcome does not ask for it.
    expect(sent[1]?.text).not.toContain("widget");
    expect(sent[2]?.text).toContain("tried to sign up");
    // The link lands on the workspace setup, which is why the person signed up again.
    await onboard(page, "Second Shop");
    const picked = page.getByRole("button", { name: /^Workspace:/ });
    await expect(picked).toHaveAccessibleName("Workspace: Second Shop");
    // On Dinghy Cloud the switcher also starts another workspace, at the signup's second step.
    await picked.click();
    await expect(page.getByRole("menuitemradio", { name: "Second Shop" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("menuitem", { name: "Create a workspace" }).click();
    await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/signup");
    // With a workspace already, the setup has Cancel, which goes back to it, and no sign-out.
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Workspace: Second Shop" })).toBeVisible();
  });
});
