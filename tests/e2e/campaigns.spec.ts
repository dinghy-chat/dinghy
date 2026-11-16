import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { startE2EServer } from "../../apps/server/test/e2e-server.ts";
import { openInbox } from "./chat.ts";

// The Campaigns page in the operator app: an owner writes a campaign in the editor's steps, starts
// it, tests it and reads its results, starts one from a template, and a member reads campaigns
// without changing them.

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

/** The editor's preview, which the widget's own code draws. */
const preview = (page: Page) => page.locator(".preview-stage");

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
  await expect(page.getByRole("heading", { name: "Start from a template" })).toBeVisible();
  await page.getByRole("button", { name: "New campaign" }).click();

  await page.getByLabel("Name", { exact: true }).fill("Pro welcome");
  await expect(page.getByRole("textbox", { name: "Key" })).toHaveValue("pro-welcome");
  await expect(page.getByText("Not saved yet")).toBeVisible();

  // Who gets it: the attribute plan is pro, with the count of who matches now in the step's head.
  const who = page.getByRole("region", { name: "Who gets it" });
  await expect(who.getByText("3 people now")).toBeVisible();
  await who.getByRole("button", { name: "Add a rule" }).click();
  await who.getByPlaceholder("Attribute key").fill("plan");
  await who.getByLabel("Value", { exact: true }).fill("pro");
  await expect(who.getByText("2 people now")).toBeVisible();
  await expect(page.getByText("Would have reached 2 people in the last 7 days.")).toBeVisible();

  // When it goes: the customer's code, which shows the call to make.
  await page.getByRole("radio", { name: "From code" }).check();
  await expect(page.getByText('dinghy.campaigns.send("pro-welcome"')).toBeVisible();

  await page.getByLabel("Text", { exact: true }).fill("Welcome to Pro! Want a tour?");
  await page.getByRole("button", { name: "Button", exact: true }).click();
  await page.getByPlaceholder("Button text").fill("Yes please");
  await expect(page.getByPlaceholder("Value in results")).toHaveValue("yes-please");
  await expect(page.getByRole("button", { name: "Edit the button Yes please" })).toBeVisible();
  // The preview draws the message with the widget's own code.
  await expect(preview(page).getByText("Welcome to Pro! Want a tour?")).toBeVisible();
  await expect(preview(page).getByRole("button", { name: "Yes please" })).toBeVisible();

  await page.getByRole("button", { name: "Go live" }).click();
  await expect(page.getByText("Campaign live.")).toBeVisible();
  await expect(page.locator(".campaign-title .chip")).toHaveText("Live");
  await expect(page.getByText(/^Saved/)).toBeVisible();

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

  // The row says who, when and how in one sentence, and the results so far.
  await page.getByRole("button", { name: "Campaigns", exact: true }).first().click();
  await expect(page.getByText("1 live · 1 sent in the last 7 days")).toBeVisible();
  const row = page.getByRole("button", { name: /Pro welcome/ });
  await expect(row.locator(".chip")).toHaveText("Live");
  await expect(row).toContainText("People whose plan is pro, when your code sends it · as a card");
  await expect(row.locator(".row-stat").first()).toContainText("1sent");

  // Pause all campaigns, with who paused them, and the resume.
  await page.getByRole("button", { name: "Pause all" }).click();
  const banner = page.getByRole("status").filter({ hasText: "All campaigns are paused." });
  await expect(banner).toContainText("julien@shipmail.example paused them at");
  await banner.getByRole("button", { name: "Resume all" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause all" })).toBeVisible();

  // The hours between two messages sit in the header's menu.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Hours between campaign messages" }).click();
  const gap = page.getByRole("dialog", { name: "Hours between campaign messages" });
  await gap.getByLabel("Hours").fill("4");
  await gap.getByRole("button", { name: "Save" }).click();
  await expect(gap).toHaveCount(0);
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Hours between campaign messages" }).click();
  await expect(gap.getByLabel("Hours")).toHaveValue("4");
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
  await expect(page.getByRole("button", { name: "Pause all" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Start from a template" })).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Hours between campaign messages" }).click();
  const gap = page.getByRole("dialog", { name: "Hours between campaign messages" });
  await expect(gap.getByLabel("Hours")).toBeDisabled();
  await expect(gap.getByRole("button", { name: "Save" })).toBeDisabled();
  await gap.getByRole("button", { name: "Cancel" }).click();

  const row = page.getByRole("button", { name: /Trial help/ });
  await expect(row).toContainText("Not live yet");
  await row.click();
  await expect(page.getByText("Only owners and admins can change campaigns.")).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toBeDisabled();
  const text = page.getByLabel("Text", { exact: true });
  await expect(text).toHaveText("Your export finished. Need help with it?");
  await expect(text).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("radio", { name: "After an event" })).toBeDisabled();
  // A member still opens a folded part to read it.
  await page.getByRole("button", { name: "Edit Rules" }).click();
  await expect(page.getByLabel("Ends at")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Go live" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Translation" })).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "End campaign" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Copy as code" }).click();
  await expect(page.getByRole("dialog").getByText('"key": "trial-help"')).toBeVisible();
});

test("the editor's steps: option cards, value tokens, variables and folded parts", async ({
  page,
}) => {
  await openCampaigns(page, "julien@shipmail.example");
  await page.getByRole("button", { name: "New campaign" }).click();
  for (const step of ["Who gets it", "When it goes", "The message", "How it shows"]) {
    await expect(page.getByRole("heading", { name: step })).toBeVisible();
  }

  // A rule's list takes its values as tokens, each removed with its ×.
  const who = page.getByRole("region", { name: "Who gets it" });
  await who.getByRole("button", { name: "Add a rule" }).click();
  await who.getByPlaceholder("Attribute key").fill("plan");
  await who.getByRole("button", { name: /^Comparison/ }).click();
  await page.getByRole("option", { name: "is one of" }).click();
  const values = who.getByLabel("Value", { exact: true });
  await values.fill("trial");
  await values.press("Enter");
  await values.fill("pro");
  await values.press("Enter");
  await expect(who.locator(".value-token")).toHaveText(["trial", "pro"]);
  await who.getByRole("button", { name: "Remove trial" }).click();
  await expect(who.locator(".value-token")).toHaveText(["pro"]);
  await expect(who.getByRole("button", { name: "And a rule" })).toBeVisible();

  // Each trigger is a card with its help, and its own settings go under the cards.
  const fromCode = page.getByRole("radio", { name: "From code", exact: true });
  await expect(fromCode).toHaveAccessibleDescription("One API call");
  await expect(page.getByRole("radio", { name: "They match" })).toBeChecked();
  await page.getByRole("button", { name: /^Wait before sending/ }).click();
  await page.getByRole("option", { name: "1 hour", exact: true }).click();
  await expect(page.getByText("after they match")).toBeVisible();

  // The variables go in at the caret, and the preview fills them with a sample contact.
  await page.getByLabel("Name", { exact: true }).fill("Variables");
  // The text shows each variable in words, and keeps the template, which "Copy as code" gives.
  const text = page.getByLabel("Text", { exact: true });
  await text.fill("Hi ");
  await page.getByRole("button", { name: "First name", exact: true }).click();
  await expect(text).toHaveText("Hi first name");
  await expect(text.locator(".variable-token")).toHaveAttribute("title", "{{ firstName }}");
  await expect(preview(page).getByText("Hi Alex")).toBeVisible();
  await expect(page.getByText("As a sample contact named Alex")).toBeVisible();
  await page.getByRole("button", { name: "Other field" }).click();
  await page.getByRole("menuitem", { name: "email" }).click();
  await expect(text.locator(".variable-token")).toHaveText(["first name", "email"]);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Copy as code" }).click();
  const code = page.getByRole("dialog", { name: "Copy as code" });
  await expect(code.getByText('"body": "Hi {{ firstName }}{{ email }}"')).toBeVisible();
  await code.getByRole("button", { name: "Done" }).click();
  // With the keyboard: the caret steps over a token, and Backspace removes it whole.
  await text.press("End");
  await text.press("Backspace");
  await expect(text.locator(".variable-token")).toHaveText(["first name"]);
  await text.press("ArrowLeft");
  await text.pressSequentially("dear ");
  await expect(text).toHaveText("Hi dear first name");
  // A tag typed whole becomes a token once the text loses focus.
  await text.press("End");
  await text.pressSequentially("{{ country }}");
  await page.getByLabel("Name", { exact: true }).focus();
  await expect(text.locator(".variable-token")).toHaveText(["first name", "country"]);
  // A variable that does not read is named under the text, so the form does not save.
  await text.fill("Hi {{ nickname }}");
  await expect(page.getByText("There is no variable nickname for this trigger.")).toBeVisible();
  await expect(text).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Not saved yet")).toBeVisible();
  await text.fill("Hi {{ firstName }}");

  // How it shows: a badge leaves only the launcher's dot, so the text is not in the preview.
  await expect(page.getByRole("radio", { name: "Card" })).toBeChecked();
  await page.getByRole("radio", { name: "Badge" }).check();
  await expect(preview(page).getByText("Hi Alex")).toHaveCount(0);

  // A translation and an A/B test start from the message's head.
  await page.getByRole("button", { name: "Translation" }).click();
  await page.getByRole("menuitem", { name: "French" }).click();
  await expect(page.getByRole("radio", { name: "French" }).first()).toBeChecked();
  await page.getByRole("button", { name: "A/B variant" }).click();
  await expect(page.getByRole("heading", { name: "A/B test" })).toBeVisible();
  // A variant's own message adds its own languages, and the message's head offers a language
  // while any message lacks it.
  await page.getByRole("button", { name: "Add a translation to variant b" }).click();
  await page.getByRole("menuitem", { name: "Spanish" }).click();
  await page.getByRole("button", { name: "Translation", exact: true }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["English", "Spanish"]);
  // English goes in both messages, so variant b has every language, and the head still offers
  // Spanish, which only variant b has.
  await page.getByRole("menuitem", { name: "English" }).click();
  await expect(page.getByRole("button", { name: "Add a translation to variant b" })).toHaveCount(0);
  await page.getByRole("button", { name: "Translation", exact: true }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Spanish"]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Stop the test" }).click();
  await expect(page.getByRole("heading", { name: "A/B test" })).toHaveCount(0);

  // Rules, the goal and delivery are folded to one line, and open in place.
  const rules = page.getByRole("region", { name: "Rules" });
  await expect(rules).toContainText("Once per person · any time");
  await rules.getByRole("button", { name: "Edit Rules" }).click();
  await expect(rules.getByRole("group", { name: "How often" })).toBeVisible();
  await rules.getByRole("button", { name: "Close Rules" }).click();
  await expect(rules.getByRole("group", { name: "How often" })).toHaveCount(0);
  const delivery = page.getByRole("region", { name: "Delivery" });
  await expect(delivery).toContainText("Conversation starts on reply");
  await delivery.getByRole("button", { name: "Edit Delivery" }).click();
  await expect(delivery.getByText("Email if unread after")).toBeVisible();
});

test("a template makes a draft with a free key, and opens it", async ({ page }) => {
  await openCampaigns(page, "julien@shipmail.example");
  await page.getByRole("button", { name: /Welcome new users/ }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Welcome new users");
  await expect(page.locator(".campaign-title .chip")).toHaveText("Draft");
  await expect(page.locator(".campaign-head code")).toHaveText("welcome");
  await expect(page.getByRole("region", { name: "Who gets it" })).toContainText("Signed in");

  await page.getByRole("button", { name: "Campaigns", exact: true }).first().click();
  await expect(page.getByRole("button", { name: /^Welcome new users/ }).first()).toContainText(
    "People who signed in, as they start to match · as a card",
  );
  await page.getByRole("button", { name: /Welcome new users.*Say hello/ }).click();
  await expect(page.locator(".campaign-head code")).toHaveText("welcome-2");
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
  await page.getByRole("button", { name: /^Pause keeps/ }).click();
  await expect(page.getByRole("region", { name: "Rules" })).toContainText(
    "At most every 7 days · any time",
  );
  const text = page.getByLabel("Text", { exact: true });
  await text.fill("A text not saved yet");
  await expect(page.getByText("Changes not saved")).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".campaign-title .chip")).toHaveText("Paused");
  await expect(text).toHaveText("A text not saved yet");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});

test("Enter in a field saves, and never starts a draft or resumes a pause", async ({ page }) => {
  const definition = {
    name: "Enter stays",
    trigger: { type: "api" },
    message: { body: "Hello" },
    presentation: { startConversation: "on_reply", show: "badge", ifConversationOpen: "skip" },
  };
  const draft = await api("PUT", "/campaigns/by-key/enter-draft", {
    ...definition,
    key: "enter-draft",
  });
  expect(draft.status).toBe(201);
  await openCampaigns(page, "julien@shipmail.example");
  await page.getByRole("button", { name: /^Enter stays/ }).click();
  const name = page.getByLabel("Name", { exact: true });
  const chip = page.locator(".campaign-title .chip");
  // Nothing to save: Save is there but off, so Enter does nothing.
  await expect(page.getByRole("button", { name: "Save as draft" })).toBeDisabled();
  await name.press("Enter");
  await name.press("Enter");
  await expect(chip).toHaveText("Draft");
  // A change: Enter saves it, and the campaign stays a draft.
  await name.fill("Enter stays here");
  await name.press("Enter");
  await expect(page.getByText("Campaign saved.")).toBeVisible();
  await name.press("Enter");
  await expect(chip).toHaveText("Draft");

  expect((await api("POST", "/campaigns/by-key/enter-draft/resume")).status).toBe(200);
  expect((await api("POST", "/campaigns/by-key/enter-draft/pause")).status).toBe(200);
  await page.getByRole("button", { name: "Campaigns", exact: true }).first().click();
  await page.getByRole("button", { name: /^Enter stays here/ }).click();
  await expect(chip).toHaveText("Paused");
  await name.press("Enter");
  await expect(chip).toHaveText("Paused");
});

test("a campaign keeps its key when it is renamed after its first save", async ({ page }) => {
  await openCampaigns(page, "julien@shipmail.example");
  await page.getByRole("button", { name: "New campaign" }).click();
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("Keeps its key");
  await page.getByLabel("Text", { exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.locator(".campaign-head code")).toHaveText("keeps-its-key");
  await name.fill("Renamed after saving");
  await expect(page.locator(".campaign-head code")).toHaveText("keeps-its-key");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Campaign saved.")).toBeVisible();
  const list = await api("GET", "/campaigns");
  const keys = (list.json.campaigns as { definition: { key: string } }[]).map(
    (one) => one.definition.key,
  );
  expect(keys).toContain("keeps-its-key");
  expect(keys).not.toContain("renamed-after-saving");
});

test("the list: tabs count only what they hold, and a goal's bar counts the control group", async ({
  page,
}) => {
  // Almost everyone is in the control group, which gets no message but counts for the goal.
  const saved = await api("PUT", "/campaigns/by-key/goal-control", {
    key: "goal-control",
    name: "Goal with a control group",
    trigger: { type: "api" },
    message: { body: "Verify your domain?" },
    presentation: { startConversation: "on_reply", show: "badge", ifConversationOpen: "skip" },
    variants: [
      { key: "message", weight: 1 },
      { key: "control", weight: 99, control: true },
    ],
    rules: {
      frequency: "once",
      businessHours: false,
      endsAt: null,
      goal: { field: "attributes.verified", op: "eq", value: true, within: "7d" },
    },
  });
  expect(saved.status).toBe(201);
  expect((await api("POST", "/campaigns/by-key/goal-control/resume")).status).toBe(200);
  for (const userId of ["goal-1", "goal-2", "goal-3"]) {
    const sent = await api("POST", "/campaigns/by-key/goal-control/send", {
      clientId: randomUUID(),
      visitor: { userId },
    });
    expect(sent.status).toBe(201);
    const tracked = await api("POST", "/track", {
      visitor: { userId, attributes: { verified: true } },
      name: "domain.verified",
    });
    expect(tracked.status).toBe(200);
  }
  const list = await api("GET", "/campaigns");
  type Totals = { goalReached: number; entered: number };
  const found = (list.json.campaigns as { definition: { key: string }; totals: Totals }[]).find(
    (one) => one.definition.key === "goal-control",
  );
  const { goalReached, entered } = found?.totals ?? { goalReached: 0, entered: 0 };
  expect(entered).toBe(3);
  await openCampaigns(page, "julien@shipmail.example");
  const tabs = page.getByRole("group", { name: "Status" });
  await expect(tabs.getByRole("radio", { name: /^Drafts/ })).toBeVisible();
  const ended = tabs.locator("label").filter({ hasText: "Ended" });
  await expect(ended.locator(".choice-count")).toHaveCount(0);
  const row = page.getByRole("button", { name: /^Goal with a control group/ });
  const goal = row.locator(".row-stat").last();
  await expect(goal).toContainText(`${goalReached}goal reached`);
  const width = await goal
    .locator(".row-bar > span")
    .evaluate((bar) => Number.parseFloat((bar as HTMLElement).style.width));
  expect(width).toBeCloseTo((goalReached / entered) * 100);
  expect(width).toBeLessThanOrEqual(100);
});
