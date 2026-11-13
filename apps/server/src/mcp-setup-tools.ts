import { z } from "@hono/zod-openapi";
import { RESPONSE_EXCERPT_MAX } from "./db/schema.ts";
import { NOT_FOUND } from "./errors.ts";
import { UNTRUSTED_TEXT, webhookId } from "./inputs.ts";
import { type Outcome, type Tool, tool } from "./mcp.ts";
import { closedFailure } from "./member.ts";
import { Origin, type Setup, SITE_LIMIT } from "./setup.ts";
import {
  FRAMEWORKS,
  IDENTITY_LANGUAGES,
  identitySetup,
  installSnippet,
  SECRET_VARIABLE,
  SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_LANGUAGES,
  webhookVerification,
} from "./setup-code.ts";
import { badOrigin, MAX_ORIGINS } from "./team.ts";
import {
  TEST_MESSAGES_PER_MINUTE,
  TestMessageInput,
  type TestVisitors,
  testMessagesLimited,
} from "./test-visitors.ts";
import { DELIVERIES_SHOWN, type Webhooks } from "./webhooks.ts";
import { type createAppearance, WidgetSettingsSchema } from "./widget-settings.ts";

export interface SetupToolOptions {
  setup: Setup;
  appearance: ReturnType<typeof createAppearance>;
  webhooks: Webhooks;
  testVisitors: TestVisitors;
  /** This server's origin, which the snippets load the widget from. */
  serverUrl: string;
}

const origin = Origin.describe(
  "An exact origin: scheme, host and port if not the default, no path. Such as https://www.example.com",
);

const sitesAnswer = (
  changed: { sites: string[] } | "bad_origin" | "limit",
  value: string,
): Outcome => {
  if (changed === "bad_origin") return { error: badOrigin(value) };
  if (changed === "limit") return { error: SITE_LIMIT };
  return { data: changed };
};

function installTools({ setup, serverUrl }: SetupToolOptions): Tool[] {
  return [
    tool({
      name: "get_install_snippet",
      title: "Get the install snippet",
      description:
        "Gives the code that adds the chat widget to an app made with `framework`, already filled with this workspace's public key and server: `code` to add, `file` where it goes, `placement` in that file, and `notes` such as a package to install. The public key is safe to publish. After deploying it, add the site with add_allowed_site and check with verify_install.",
      input: z.object({
        framework: z.enum(FRAMEWORKS).describe("The app's framework, or html for a plain site"),
      }),
      readOnly: true,
      run: async ({ framework }, { workspaceId }) => ({
        data: installSnippet(framework, {
          serverUrl,
          publicKey: await setup.publicKey(workspaceId),
        }),
      }),
    }),
    tool({
      name: "list_allowed_sites",
      title: "List the allowed sites",
      description:
        "Lists the allowed sites: the exact origins where the widget may load. A page on any other origin, including www versus the bare domain, gets no chat.",
      input: z.object({}),
      readOnly: true,
      run: async (_input, { workspaceId }) => ({ data: { sites: await setup.sites(workspaceId) } }),
    }),
    tool({
      name: "add_allowed_site",
      title: "Allow a site",
      description: `Lets the widget load on one more origin, and answers every allowed site. Adding one that is there already changes nothing. A workspace has at most ${MAX_ORIGINS}: error site_limit past that. Error bad_origin for anything that is not an http or https origin without a path.`,
      input: z.object({ origin }),
      idempotent: true,
      run: async (input, { workspaceId, actor }) =>
        sitesAnswer(await setup.addSite(workspaceId, actor, input.origin), input.origin),
    }),
    tool({
      name: "remove_allowed_site",
      title: "Remove an allowed site",
      description:
        "Stops the widget on an origin, and answers every allowed site. Visitors on that site lose the chat at once, so ask the person first.",
      input: z.object({ origin }),
      idempotent: true,
      destructive: true,
      run: async (input, { workspaceId, actor }) =>
        sitesAnswer(await setup.removeSite(workspaceId, actor, input.origin), input.origin),
    }),
    tool({
      name: "verify_install",
      title: "Check the install",
      description: `Checks whether the widget is installed. \`allowed\`: whether \`origin\` is an allowed site (null without one). \`widgetSeenAt\`: when an allowed site first loaded it. \`sites\`: allowed sites and sites that loaded it, with when (written at most once an hour). \`refused\`: origins whose widget calls were refused in the last 24 hours, a hint that a site is missing. \`liveTabs\`: tabs with the widget open now (null if unknown). \`nextStep\`: the one thing to do next. ${UNTRUSTED_TEXT}`,
      input: z.object({ origin: origin.optional() }),
      readOnly: true,
      async run(input, { workspaceId }) {
        const checked = await setup.check(workspaceId, input.origin);
        return checked === "bad_origin"
          ? { error: badOrigin(input.origin ?? "") }
          : { data: checked };
      },
    }),
    tool({
      name: "get_identity_setup",
      title: "Get the sign-in setup",
      description: `Explains Dinghy.identify(), which shows operators who a signed-in user is, and gives server code in \`language\` that signs its HS256 token from the ${SECRET_VARIABLE} environment variable, plus the browser call. It never gives the signing secret: a person copies it from Settings > Install into the server's environment. Never ask anyone to paste it in a chat.`,
      input: z.object({
        language: z.enum(IDENTITY_LANGUAGES).describe("The language of the app's server"),
      }),
      readOnly: true,
      run: async ({ language }, { workspaceId }) => ({
        data: identitySetup(language, await setup.publicKey(workspaceId)),
      }),
    }),
  ];
}

function appearanceTools({ appearance }: SetupToolOptions): Tool[] {
  return [
    tool({
      name: "get_appearance",
      title: "Get the widget's look",
      description:
        "Reads the widget's saved look, words and behavior: title, greeting, away text, colors, position, theme, launcher, boat, corners, when it asks for an email, branding, sound, transcript, whether visitors can send files, header and language. `logoUrl` and `team` are read only. The words were written by the team, not visitors.",
      input: z.object({}),
      readOnly: true,
      run: async (_input, { workspaceId }) => ({ data: await appearance.read(workspaceId) }),
    }),
    tool({
      name: "update_appearance",
      title: "Change the widget's look",
      description:
        "Changes the fields you pass and keeps the others, then answers the saved settings. Colors are full hex such as #1d4ed8; a text of null goes back to Dinghy's default. Sites show a change within 5 minutes. The logo cannot change here: a person uploads it in Settings > Appearance.",
      input: WidgetSettingsSchema.partial(),
      idempotent: true,
      run: async (fields, { workspaceId }) => ({
        data: await appearance.update(workspaceId, fields),
      }),
    }),
  ];
}

function webhookHelpTools({ webhooks }: SetupToolOptions): Tool[] {
  return [
    tool({
      name: "get_webhook_verification",
      title: "Get webhook signature code",
      description: `Gives code in \`language\` that checks a webhook request's Dinghy-Signature header (t=, v1=: the HMAC-SHA256 of \`<t>.<raw body>\` with the webhook's secret), compares in constant time and refuses one older than ${SIGNATURE_TOLERANCE_SECONDS / 60} minutes.`,
      input: z.object({ language: z.enum(WEBHOOK_LANGUAGES) }),
      readOnly: true,
      run: async ({ language }) => ({ data: webhookVerification(language) }),
    }),
    tool({
      name: "list_webhook_deliveries",
      title: "List webhook deliveries",
      description: `Lists a webhook's newest ${DELIVERIES_SHOWN} deliveries: each one's event ID and type, \`status\` (pending, sent or failed), attempts, the last HTTP status and error, \`responseExcerpt\` (the start of the receiver's refusing answer, up to ${RESPONSE_EXCERPT_MAX / 1024} KB) and \`replayOf\`. ${UNTRUSTED_TEXT}`,
      input: z.object({ webhookId }),
      readOnly: true,
      run: async (input, { workspaceId }) => ({
        data: { deliveries: await webhooks.deliveries(workspaceId, input.webhookId) },
      }),
    }),
    tool({
      name: "replay_webhook_delivery",
      title: "Replay a webhook delivery",
      description:
        "Sends a delivery's event again, now, as a new delivery with the same event ID (the Dinghy-Event-Id header), so a receiver that already has it can drop it. It is retried like any other. Answers the new delivery; check it with list_webhook_deliveries.",
      input: z.object({
        webhookId,
        deliveryId: z.uuid().describe("The delivery's ID, from list_webhook_deliveries"),
      }),
      async run(input, { workspaceId, actor }) {
        const delivery = await webhooks.replay(
          workspaceId,
          actor,
          input.webhookId,
          input.deliveryId,
        );
        return delivery === null ? { error: NOT_FOUND } : { data: { delivery } };
      },
    }),
  ];
}

function testVisitorTools({ testVisitors }: SetupToolOptions): Tool[] {
  return [
    tool({
      name: "send_test_message",
      title: "Send a test visitor message",
      description: `Sends a message as a test visitor, through the widget's own path, so webhooks, events and the inbox see it (with visitor.isTest true and a Test label). Use it to test a bot from end to end. Without \`conversationId\`, a new test visitor starts a new conversation; pass an earlier answer's \`conversationId\` to write in it again. Analytics, contacts and alerts leave test visitors out. At most ${TEST_MESSAGES_PER_MINUTE} a minute per workspace. Delete them with delete_test_visitors when done.`,
      input: TestMessageInput,
      async run(input, { workspaceId }) {
        const sent = await testVisitors.send(workspaceId, input);
        if (sent.kind === "missing") return { error: NOT_FOUND };
        if (sent.kind === "closed") return { error: closedFailure(sent.access).body };
        if (sent.kind === "limited") return { error: testMessagesLimited(sent.waitSeconds) };
        const { kind: _kind, ...data } = sent;
        return { data };
      },
    }),
    tool({
      name: "delete_test_visitors",
      title: "Delete the test visitors",
      description:
        "Deletes every test visitor that send_test_message made, with their conversations, messages and images, and answers how many. Real visitors are never touched.",
      input: z.object({}),
      idempotent: true,
      destructive: true,
      run: async (_input, { workspaceId }) => ({
        data: { deleted: await testVisitors.deleteAll(workspaceId) },
      }),
    }),
  ];
}

/** The install, appearance, webhook help and test tools, which only a Setup key lists and calls. */
export function mcpSetupTools(options: SetupToolOptions): Tool[] {
  return [
    ...installTools(options),
    ...appearanceTools(options),
    ...webhookHelpTools(options),
    ...testVisitorTools(options),
  ];
}
