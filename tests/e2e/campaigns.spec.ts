import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openInbox } from "./chat.ts";

// The Campaigns page in the operator app: an owner writes a campaign in the editor, starts it,
// tests it and reads its results, and a member reads campaigns without changing them.

let server: Awaited<ReturnType<typeof startE2EServer>>;
/** The customer's server key, which tracks contacts and sends campaigns. */
let serverKey: string;

test.beforeAll(async () => {
  server = await startE2EServer({});
  await server.createOperator("julien@shipmail.example");
  await server.createOperator("ben@shipmail.example", { role: "member" });
  serverKey = await server.sendingKey("Shipmail server", "setup");
});

test.afterAll(async () => {
  await server.stop();
});

/** A call to the API with the server's key. */
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(
    `${server.apiOrigin}/v1/operator/workspaces/${server.workspaceId()}${path}`,
    {
      method,
      headers: { authorization: `Bearer ${serverKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function openCampaigns(page: Page, email: string) {
  await openInbox(page, server, email);
  await page.getByRole("button", { name: "Campaigns", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Campaigns", exact: true })).toBeVisible();
}

test("an owner writes a campaign, starts it, tests it and reads its results", async ({ page }) => {
  // Two customers on the pro plan, and one on a trial.
  for (const [userId, plan] of [
    ["pro-1", "pro"],
    ["pro-2", "pro"],
    ["trial-1", "trial"],
  ] as const) {
    const tracked = await api("POST", "/track", {
      visitor: { userId, name: `Customer ${userId}`, attributes: { plan } },
      name: "signed.up",
    });
    expect(tracked.status).toBe(200);
  }
  await openCampaigns(page, "julien@shipmail.example");
  await expect(page.getByText("No campaigns yet")).toBeVisible();
  await page.getByRole("button", { name: "New campaign" }).first().click();

  await page.getByLabel("Name", { exact: true }).fill("Pro welcome");
  await expect(page.getByRole("textbox", { name: /^Key/ })).toHaveValue("pro-welcome");

  // The audience: the attribute plan is pro, with the count of who matches now.
  await expect(page.getByText("3 people match now.")).toBeVisible();
  await page.getByRole("button", { name: "Add a rule" }).first().click();
  await page.getByPlaceholder("Attribute key").fill("plan");
  await page.getByLabel("Value", { exact: true }).fill("pro");
  await expect(page.getByText("2 people match now.")).toBeVisible();
  await expect(page.getByText("Would have sent to 2 people in the last 7 days.")).toBeVisible();

  // The trigger is the customer's code, which shows the call to make.
  await page.getByRole("radio", { name: "From your code" }).check();
  await expect(page.getByText('dinghy.campaigns.send("pro-welcome"')).toBeVisible();

  await page.getByLabel("Text", { exact: true }).fill("Welcome to Pro! Want a tour?");
  await page.getByRole("button", { name: "Add a button" }).first().click();
  await page.getByPlaceholder("Button text").fill("Yes please");
  await expect(page.getByPlaceholder("Value in results")).toHaveValue("yes-please");
  // The preview draws the message with the widget's own code.
  await expect(
    page.locator(".preview-stage").getByText("Welcome to Pro! Want a tour?"),
  ).toBeVisible();
  await expect(
    page.locator(".preview-stage").getByRole("button", { name: "Yes please" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Go live" }).click();
  await expect(page.getByText("Campaign live.")).toBeVisible();
  await expect(page.locator(".page-title .chip")).toHaveText("Live");

  await page.getByRole("button", { name: "Send a test to me" }).click();
  const test = page.getByRole("dialog", { name: "Test sent" });
  await expect(test.getByText("Nothing would hold a real message now.")).toBeVisible();
  await test.getByRole("button", { name: "Close" }).click();

  const sent = await api("POST", "/campaigns/by-key/pro-welcome/send", {
    clientId: randomUUID(),
    visitor: { userId: "pro-1" },
  });
  expect(sent.status).toBe(201);

  await page.getByRole("radio", { name: "Results" }).check();
  const sentStat = page
    .locator(".stat")
    .filter({ has: page.getByRole("heading", { name: "Sent", exact: true }) });
  await expect(sentStat.locator(".stat-value")).toHaveText("1");
  await expect(page.getByRole("table").getByRole("cell", { name: "1" }).first()).toBeVisible();

  // "Copy as code" gives the JSON and the SDK call.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Copy as code" }).click();
  const code = page.getByRole("dialog", { name: "Copy as code" });
  await expect(code.getByText('"key": "pro-welcome"')).toBeVisible();
  await code.getByRole("radio", { name: "SDK" }).check();
  await expect(code.getByText("dinghy.campaigns.upsert(")).toBeVisible();
  await code.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Campaigns", exact: true }).first().click();
  const row = page.getByRole("row", { name: /Pro welcome/ });
  await expect(row.getByText("Live")).toBeVisible();
  await expect(row.getByText("From your code")).toBeVisible();

  // Pause all campaigns, with who paused them, and the resume.
  await page.getByRole("button", { name: "Pause all campaigns" }).click();
  const banner = page.getByRole("status").filter({ hasText: "All campaigns are paused." });
  await expect(banner).toContainText("julien@shipmail.example paused them at");
  await banner.getByRole("button", { name: "Resume all" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause all campaigns" })).toBeVisible();
});

test("a member reads campaigns and cannot change them", async ({ page }) => {
  const saved = await api("PUT", "/campaigns/by-key/trial-help", {
    key: "trial-help",
    name: "Trial help",
    trigger: { type: "event", name: "export.finished" },
    message: { body: "Your export finished. Need help with it?" },
    presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
  });
  expect(saved.status).toBe(201);
  await openCampaigns(page, "ben@shipmail.example");
  await expect(page.getByRole("button", { name: "New campaign" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause all campaigns" })).toHaveCount(0);
  await expect(page.getByLabel("Hours between two campaign messages")).toBeDisabled();

  await page.getByRole("button", { name: /Trial help/ }).click();
  await expect(page.getByText("Only owners and admins can change campaigns.")).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue(
    "Your export finished. Need help with it?",
  );
  await expect(page.getByRole("button", { name: "Go live" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as draft" })).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "End campaign" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Copy as code" }).click();
  await expect(page.getByRole("dialog").getByText('"key": "trial-help"')).toBeVisible();
});

test("the editor keeps the main sections open, checks the text, and previews it", async ({
  page,
}) => {
  await openCampaigns(page, "julien@shipmail.example");
  await page.getByRole("button", { name: "New campaign" }).first().click();
  // A new campaign shows the main sections, and the others under More options.
  const more = page.getByRole("button", { name: "More options" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { name: "Rules" })).toHaveCount(0);
  await more.click();
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
  // Both email settings sit in Delivery.
  const delivery = page
    .locator(".widget-section")
    .filter({ has: page.getByRole("heading", { name: "Delivery" }) });
  await expect(delivery.getByText("Email if unread after")).toBeVisible();

  // Each trigger is a line with its help.
  const fromCode = page.getByRole("radio", { name: "From your code", exact: true });
  await expect(fromCode).toHaveAccessibleDescription("Only when your code sends it to one person.");

  // The preview fills the variables with a sample contact, and a variable that does not read
  // is named under the text, so the form does not save.
  await page.getByLabel("Name", { exact: true }).fill("Variables");
  const text = page.getByLabel("Text", { exact: true });
  await text.fill(
    'Hi {{ firstName | default: "there" }}, on {{ attributes.plan | default: "trial" }}?',
  );
  await expect(page.locator(".preview-stage").getByText("Hi Alex, on trial?")).toBeVisible();
  await text.fill("Hi {{ nickname }}");
  await expect(page.getByText("There is no variable nickname for this trigger.")).toBeVisible();
  await expect(text).toHaveJSProperty("validity.valid", false);
});

test("a pause keeps the changes not saved yet", async ({ page }) => {
  const saved = await api("PUT", "/campaigns/by-key/pause-keeps", {
    key: "pause-keeps",
    name: "Pause keeps",
    trigger: { type: "api" },
    message: { body: "The saved text" },
    presentation: { startConversation: "on_reply", show: "badge", ifConversationOpen: "skip" },
    rules: { frequency: { every: "7d" }, businessHours: false, endsAt: null },
  });
  expect(saved.status).toBe(201);
  expect((await api("POST", "/campaigns/by-key/pause-keeps/resume")).status).toBe(200);
  await openCampaigns(page, "julien@shipmail.example");
  await page.getByRole("button", { name: /Pause keeps/ }).click();
  // Its rules differ from a new campaign's, so More options starts open.
  await expect(page.getByRole("button", { name: "More options" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const text = page.getByLabel("Text", { exact: true });
  await text.fill("A text not saved yet");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".page-title .chip")).toHaveText("Paused");
  await expect(text).toHaveValue("A text not saved yet");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});
