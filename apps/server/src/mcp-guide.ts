import { z } from "@hono/zod-openapi";
import type { KeyActor } from "./api-keys.ts";
import { normalizeOrigin } from "./identity.ts";
import { UNTRUSTED_TEXT } from "./inputs.ts";
import { Origin } from "./setup.ts";
import { FRAMEWORKS } from "./setup-code.ts";

// What the MCP server tells an agent before its first tool call: the instructions that every
// client reads, and the prompts that a client such as Claude Code offers as slash commands.

const LEVEL_NAMES = { conversations: "Chats access", setup: "Full access" } as const;

const ANSWER_LOOP =
  "To answer chats, call wait_for_events with no cursor, read what came before with list_conversations and get_conversation (`format: \"markdown\"` is the shortest), and list_drafts, then call wait_for_events in a loop with each answer's `cursor`. On `resync: true`, read the open conversations and list_drafts again. For each visitor message: get_conversation, list_saved_replies for the team's facts, set_typing, then reply with a `clientId` you make. Call hand_off when the visitor asks for a person, when it is about money, an account or a complaint, or when you are unsure. While a person handles a conversation, write add_note instead of replying.";

const INSTALL_STEPS =
  "To install the chat on a site: get_install_snippet, add_allowed_site, deploy, then verify_install. Test with send_test_message. delete_test_visitors deletes every test visitor of the workspace, not only yours, so ask first. The install prompt holds these steps.";

/** What this connection is and may do now, then how to use it, then the safety rule. */
export function instructions(actor: KeyActor): string {
  const isSetup = actor.level === "setup";
  return [
    `Dinghy is a live support chat. This connection is "${actor.name}", with ${LEVEL_NAMES[actor.level]} to one workspace. Replies and notes show "${actor.name}" as their author.`,
    actor.replyMode === "draft"
      ? 'Its replies are drafts now: reply answers `status: "drafted"`, and a person sends, edits or discards each one. Only an owner or admin can change this, in Settings > API & webhooks.'
      : 'Its replies reach the visitor at once, `status: "sent"`, unless a person handles the conversation.',
    ANSWER_LOOP,
    actor.rewritesDrafts
      ? "Operators may ask it to rewrite its drafts: answer each `draft.change_requested` event with reply and its `changeRequestId`."
      : null,
    isSetup ? INSTALL_STEPS : null,
    UNTRUSTED_TEXT,
    isSetup
      ? "Use this connection to install Dinghy, and give the bot that answers chats its own Chats connection, so visitor text cannot reach the site and webhook tools."
      : null,
  ]
    .filter((line) => line !== null)
    .join(" ");
}

interface Prompt {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  /** Null when the arguments are not valid. */
  text(args: unknown): string | null;
}

/** A blank argument, which a client sends for a field left empty, counts as left out. */
const optional = <S extends z.ZodType>(schema: S) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const InstallArguments = z.object({
  framework: optional(z.enum(FRAMEWORKS)),
  site: optional(
    // Checked as add_allowed_site will get it: normalized, which can change its length.
    z.string().transform((value, context) => {
      const origin = normalizeOrigin(value.trim());
      if (origin !== null && Origin.safeParse(origin).success) return origin;
      context.addIssue("Not an origin");
      return z.NEVER;
    }),
  ),
});

const installPrompt: Prompt = {
  name: "install",
  title: "Install Dinghy on this site",
  description: "Adds the chat to the site in this repository, allows its origin and checks it.",
  arguments: [
    {
      name: "framework",
      description: `The site's framework: ${FRAMEWORKS.join(", ")}. Found in the code when left out.`,
      required: false,
    },
    {
      name: "site",
      description: "The site's origin, such as https://www.example.com",
      required: false,
    },
  ],
  text(args) {
    const parsed = InstallArguments.safeParse(args);
    if (!parsed.success) return null;
    const { framework, site } = parsed.data;
    return `Add the Dinghy live chat to this site.

1. Call get_install_snippet with ${framework === undefined ? `the site's framework (${FRAMEWORKS.join(", ")})` : `framework "${framework}"`}, and add the code where it says.
2. Call add_allowed_site with ${site === undefined ? "the site's origin, such as https://www.example.com" : site}. www and the bare domain are two origins.
3. Deploy the site, or ask me to.
4. Call verify_install with the origin and do its nextStep, at most 5 times.
5. Call send_test_message, and tell me to look for it in the inbox. Ask me before delete_test_visitors: it deletes every test visitor of the workspace.

Ask me before you change anything outside the install. Never ask for a secret or write one in code.`;
  },
};

const answerPrompt: Prompt = {
  name: "answer_chats",
  title: "Answer chats",
  description: "Waits for visitor messages and answers them, handing off to a person when needed.",
  arguments: [],
  text: () =>
    `Answer this workspace's live chats until I stop you.

${ANSWER_LOOP}

${UNTRUSTED_TEXT}`,
};

export const promptsFor = (actor: KeyActor): Prompt[] =>
  actor.level === "setup" ? [installPrompt, answerPrompt] : [answerPrompt];

/** A prompt as `prompts/list` lists it, without its text. */
export const listedPrompt = ({ text: _text, ...listed }: Prompt) => listed;
