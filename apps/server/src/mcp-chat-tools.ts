import { setTimeout as delay } from "node:timers/promises";
import { z } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";
import { BOT_TYPING_MS, MENTIONS_MAX } from "../../../packages/widget/src/shared.ts";
import {
  AnalyticsQuery,
  analyticsFor,
  medianFirstReplySeconds,
  UNKNOWN_ZONE,
} from "./analytics.ts";
import { ContactListQuery, listContacts, readContact } from "./contacts.ts";
import { conversation, message, visitor, workspace } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { listDrafts } from "./drafts.ts";
import { failure, NOT_FOUND } from "./errors.ts";
import { handOff, setTyping } from "./handling.ts";
import { type Inbox, messageView, type ReplyOutcome, refusedReply } from "./inbox.ts";
import {
  Body,
  clientId,
  conversationId,
  HandoffReason,
  HandoffSummary,
  Mentions,
  replyToMessageId,
  UNTRUSTED_TEXT,
} from "./inputs.ts";
import { type Limits, STREAM_LIMIT } from "./limits.ts";
import { type Live, OPERATORS, type Session } from "./live.ts";
import { type LiveVisitors, liveVisitorList } from "./live-visitors.ts";
import { type Outcome, type Tool, tool } from "./mcp.ts";
import {
  CURSOR_PATTERN,
  type Cursor,
  conversationVisitor,
  formatCursor,
  joinVisitor,
  listWorkspaceEvents,
  messageColumns,
  parseCursor,
  stored,
} from "./messages.ts";
import type { Presence, VisitorPresence } from "./presence.ts";
import { listSavedReplies } from "./saved-replies.ts";
import { listMembers } from "./team.ts";
import { isTimeZone, MINUTE_MS } from "./time.ts";
import type { Uploads } from "./uploads.ts";

/** The days of first replies that `replySeconds` takes its median from, as the widget's header does. */
const REPLY_TIME_DAYS = 30;
/** A long poll holds a stream slot this long at most, past its 30 seconds. */
const WAIT_LEASE_MS = MINUTE_MS;
/** Events read per pass of a long poll. */
const WAIT_PAGE = 100;

/** get_contact takes one of its two IDs. */
const ONE_CONTACT_ID = failure(
  "invalid_request",
  "Pass exactly one of visitorId and conversationId.",
);

export interface ChatToolsOptions {
  db: Database;
  uploads: Uploads | undefined;
  inbox: Inbox;
  limits: Limits;
  live: Live;
  liveVisitors: LiveVisitors;
  presence: Presence;
  visitorPresence: VisitorPresence;
}

const replyAnswer = (outcome: ReplyOutcome): Outcome => {
  if (outcome.kind === "sent") return { data: { status: "sent", message: outcome.message } };
  if (outcome.kind === "drafted") return { data: { status: "drafted", draft: outcome.draft } };
  return { error: refusedReply(outcome).body };
};

/** One line of a Markdown transcript. */
type Line = { seq: bigint; at: string; text: string };

const clock = (iso: string) => iso.slice(11, 16);
const indent = (text: string) => text.replaceAll("\n", "\n    ");

type Read = NonNullable<Awaited<ReturnType<Inbox["read"]>>>["view"];

function messageLine(one: Read["messages"][number]): Line {
  const who = one.fromVisitor
    ? "Visitor"
    : one.authorApiKeyId !== null
      ? `${one.authorName ?? "Bot"} (bot)`
      : (one.authorName ?? "Team");
  if (one.kind === "note") {
    const text = `Note by ${one.authorName ?? "Team"}: ${one.deleted ? "[deleted]" : indent(one.body ?? "")}`;
    return { seq: BigInt(one.seq), at: one.createdAt, text };
  }
  const content = one.deleted
    ? "[deleted]"
    : one.kind === "image"
      ? "[image]"
      : one.kind === "file"
        ? `[file: ${one.file?.name ?? "removed"}]`
        : indent(one.body ?? "");
  const text =
    one.kind === "closed"
      ? `${who} closed the conversation`
      : one.kind === "reopened"
        ? `${who} reopened the conversation`
        : `${who}: ${content}`;
  return { seq: BigInt(one.seq), at: one.createdAt, text };
}

/** Who handles the conversation, in words. */
function handlerText(handler: Read["conversation"]["handler"]): string {
  if (handler === null) return "no one yet: a bot may answer";
  if (handler.kind === "bot") return `the bot ${handler.name}`;
  if (handler.kind === "person") return `${handler.name}, a person, since ${handler.since}`;
  return `the team, people with no assignee, since ${handler.since}`;
}

/** A compact transcript: a header, then one line per message and note, in order. */
function transcript(read: Read, assigneeName: string | null, replySeconds: number | null): string {
  const { conversation: found } = read;
  const who = [found.visitor.name, found.visitor.email].filter((one) => one !== null).join(", ");
  const lines = read.messages.map(messageLine);
  const wait = replySeconds === null ? "unknown" : `${Math.round(replySeconds)} seconds`;
  return [
    `# Conversation ${found.id}`,
    `Status: ${found.status}. Handled by ${handlerText(found.handler)}. Assignee: ${assigneeName ?? "none"}.`,
    `The team's median first reply over ${REPLY_TIME_DAYS} days (replySeconds): ${wait}.`,
    `Visitor (visitor-written): ${who === "" ? "no name" : who}. Started on: ${found.startedPage ?? "unknown"}.`,
    `Times are UTC. ${UNTRUSTED_TEXT}`,
    "",
    ...lines.map((line) => `[${clock(line.at)}] ${line.text}`),
    ...(read.hasMore
      ? ["", "More messages follow: read again with `after` set to the last seq."]
      : []),
  ].join("\n");
}

/** The time on the visitor's clock now, or null without a zone this server knows. */
function localTime(timeZone: string | null): string | null {
  if (timeZone === null || !isTimeZone(timeZone)) return null;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}

/** New visitor messages in open conversations after a cursor, with what a bot needs to answer. */
async function visitorMessagesAfter(
  db: Database,
  uploads: Uploads | undefined,
  workspaceId: string,
  after: Cursor,
  only: string | undefined,
) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const page = await listWorkspaceEvents(tx, workspaceId, after, WAIT_PAGE);
    const ids = page.events.flatMap((one) =>
      one.kind === "message.created" &&
      one.fromVisitor &&
      (only === undefined || one.conversationId === only)
        ? [(one.payload as { messageId: string }).messageId]
        : [],
    );
    if (ids.length === 0) return { ...page, messages: [] };
    const rows = await tx
      .select({
        ...messageColumns,
        open: eq(conversation.status, "open"),
        humanSince: conversation.humanSince,
        visitorName: visitor.name,
        visitorEmail: visitor.email,
      })
      .from(message)
      .innerJoin(
        conversation,
        and(
          eq(conversation.workspaceId, message.workspaceId),
          eq(conversation.id, message.conversationId),
        ),
      )
      .innerJoin(visitor, joinVisitor())
      .where(and(eq(message.workspaceId, workspaceId), inArray(message.id, ids)))
      .orderBy(message.seq);
    const [place] = await tx
      .select({ botsPausedAt: workspace.botsPausedAt })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    const botsPaused = place?.botsPausedAt !== null;
    const messages = rows
      .filter((row) => row.open && row.deletedAt === null)
      .map(({ open: _open, humanSince, visitorName, visitorEmail, ...row }) => ({
        conversationId: row.conversationId,
        message: messageView(uploads, workspaceId, new Map(), stored(row)),
        visitor: { name: visitorName, email: visitorEmail },
        humanHandling: humanSince !== null,
        botsPaused,
      }));
    return { ...page, messages };
  });
}

/**
 * A long poll: waits on the workspace's signal, reading Postgres again at each, until a visitor
 * writes or the time runs out. It holds a slot in the workspace's stream limit while it waits.
 */
async function waitForMessages(
  { db, uploads, limits, live }: ChatToolsOptions,
  workspaceId: string,
  input: {
    cursor?: string | undefined;
    timeoutSeconds: number;
    conversationId?: string | undefined;
  },
): Promise<Outcome> {
  if (input.cursor === undefined) {
    const now = await withWorkspace(db, workspaceId, (tx) =>
      listWorkspaceEvents(tx, workspaceId, undefined, 1),
    );
    return { data: { messages: [], cursor: formatCursor(now.cursor) } };
  }
  const slot = await limits.openStream(workspaceId, "operator", WAIT_LEASE_MS);
  if (slot === null) return { error: STREAM_LIMIT };
  let signal = () => {};
  const session: Session = { wake: () => signal(), close: () => signal() };
  const unsubscribe = await live.subscribe(workspaceId, OPERATORS, session);
  try {
    const deadline = Date.now() + input.timeoutSeconds * 1000;
    let cursor = parseCursor(input.cursor);
    for (;;) {
      // Before the read, so a signal during it is not lost.
      const woken = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const page = await visitorMessagesAfter(
        db,
        uploads,
        workspaceId,
        cursor,
        input.conversationId,
      );
      cursor = page.cursor;
      const answer = { messages: page.messages, cursor: formatCursor(cursor) };
      if (page.resync) return { data: { ...answer, resync: true } };
      if (page.messages.length > 0 || Date.now() >= deadline) return { data: answer };
      if (!page.hasMore)
        await Promise.race([woken, delay(deadline - Date.now(), undefined, { ref: false })]);
    }
  } finally {
    unsubscribe();
    slot.release();
  }
}

/** The tools that answer chats and read the workspace, for every key. */
export function chatTools(options: ChatToolsOptions): Tool[] {
  const { db, inbox, live } = options;
  return [
    tool({
      name: "get_conversation",
      title: "Read a conversation",
      description: `Reads one conversation: its status, assignee and \`handler\` (\`person\`: the assignee handles it since \`since\`; \`team\`: people handle it with no assignee; \`bot\`: no person handles it and this key took part last; null: no one yet), the visitor (with the attributes your site signed), \`pageContext\` (what the page sent, not verified), the pages the visitor went through, and its messages in order. A message of \`kind: "note"\` is an internal note that only the team sees, never the visitor. A message of \`kind: "file"\` has \`file\` with its name, size and a download URL, and the Markdown shows it by name. \`replySeconds\` is the team's median first reply time over 30 days, to tell a visitor how long a person takes. With \`format: "markdown"\` it answers \`{ markdown }\`, a short transcript. ${UNTRUSTED_TEXT}`,
      input: z.object({
        conversationId,
        after: z
          .string()
          .regex(/^\d{1,18}$/)
          .default("0")
          .describe("Only messages after this seq"),
        limit: z.number().int().min(1).max(100).default(100),
        format: z.enum(["json", "markdown"]).default("json"),
      }),
      readOnly: true,
      async run(input, { workspaceId }) {
        const found = await inbox.read(
          workspaceId,
          null,
          input.conversationId,
          BigInt(input.after),
          input.limit,
        );
        if (found === null) return { error: NOT_FOUND };
        const replySeconds = await withWorkspace(db, workspaceId, (tx) =>
          medianFirstReplySeconds(tx, workspaceId, REPLY_TIME_DAYS),
        );
        if (input.format === "json") return { data: { ...found.view, replySeconds } };
        return { data: { markdown: transcript(found.view, found.assigneeName, replySeconds) } };
      },
    }),
    tool({
      name: "reply",
      title: "Reply to a visitor",
      description:
        'Replies in an open conversation, as the API key\'s reply mode says. A key that sends directly answers `{ status: "sent", message }`: the visitor sees it, with the key\'s name as its author. A key in draft mode answers `{ status: "drafted", draft }`: nothing reached the visitor, and an operator sends, edits or discards it. Errors: `human_handling` when a person handles the conversation and the key sends directly (write a note, or wait for them to give it back), and `bots_paused` when an owner paused every bot. Pass the same `clientId` when you retry, so a retry cannot send it twice. Pass `replyToMessageId` to quote an earlier message.',
      input: z.object({ conversationId, body: Body, clientId, replyToMessageId }),
      idempotent: true,
      run: async (input, { workspaceId, actor }) =>
        replyAnswer(
          await inbox.reply(workspaceId, actor, input.conversationId, {
            ...input,
            source: { via: "mcp" },
            note: false,
          }),
        ),
    }),
    tool({
      name: "add_note",
      title: "Add an internal note",
      description:
        "Adds a note to a conversation, open or closed, that only the team sees. The visitor never sees it. It alerts nobody, unless it mentions members: pass their IDs from list_members in `mentions`, and each gets an alert with the note's text. Write `@Name` in the text too, so people reading it see who it is for. Use it to pass on what you found, or to suggest an answer while a person handles the conversation: a note works while a person handles it and while bots are paused. Markdown works as in messages, but links in a key's note show as plain text. Pass the same `clientId` when you retry. Pass `replyToMessageId` to quote an earlier message or note.",
      input: z.object({
        conversationId,
        body: Body,
        clientId,
        replyToMessageId,
        mentions: Mentions.optional().describe(
          `Members to alert, by their id from list_members, at most ${MENTIONS_MAX}`,
        ),
      }),
      idempotent: true,
      run: async (input, { workspaceId, actor }) =>
        replyAnswer(
          await inbox.reply(workspaceId, actor, input.conversationId, {
            ...input,
            source: { via: "mcp" },
            note: true,
          }),
        ),
    }),
    tool({
      name: "list_drafts",
      title: "List draft replies",
      description:
        "Lists the drafts that keys in draft mode wrote, newest first, at most 100: `open` ones wait for an operator, `stale` ones wait but the visitor wrote after them, `all` adds the ones sent or discarded. A sent draft names the message an operator sent from it.",
      input: z.object({
        conversationId: conversationId.optional(),
        status: z.enum(["open", "stale", "all"]).default("open"),
      }),
      readOnly: true,
      run: async (input, { workspaceId }) => ({
        data: {
          drafts: await withWorkspace(db, workspaceId, (tx) =>
            listDrafts(tx, workspaceId, input.conversationId, input.status),
          ),
        },
      }),
    }),
    tool({
      name: "hand_off",
      title: "Hand a conversation to people",
      description:
        "Hands a conversation to the team when you cannot or should not answer. From then on a person handles it, and your direct replies answer `human_handling`. A note holds `reason` and `summary` for the person who picks it up. With `operatorId`, from list_members, the conversation is assigned to that member, who gets an alert. Without it, every member with alerts on gets one. `visitorMessage` is your last message to the visitor, such as \"I've passed this to the team\". Use `replySeconds` from get_conversation to say how long a person takes. The answer's `visitorMessage` says what became of it: `sent`, `drafted` (your key writes drafts), `not_sent` (bots are paused), or null when you passed none. A retry with the same clientId changes nothing and answers the first result.",
      input: z.object({
        conversationId,
        clientId,
        reason: HandoffReason.describe("Why a person should take it, in a sentence"),
        summary: HandoffSummary.optional().describe(
          "What the visitor needs and what you found, for the person who picks it up",
        ),
        operatorId: z
          .uuid()
          .optional()
          .describe("A member's id from list_members. Leave it out for the whole team"),
        visitorMessage: Body.optional().describe("Your last message to the visitor"),
      }),
      idempotent: true,
      async run(input, { workspaceId, actor }) {
        const outcome = await handOff(options, workspaceId, actor, input.conversationId, input, {
          via: "mcp",
        });
        if (outcome.kind === "failed") return { error: outcome.body };
        return { data: { status: "handed_off", visitorMessage: outcome.visitorMessage } };
      },
    }),
    tool({
      name: "list_members",
      title: "List the team",
      description:
        "Lists the workspace's members by name: `id` (the operatorId that assign_conversation and hand_off take, and add_note takes in `mentions`), `name`, `role` (owner, admin or member) and `online`: true while their operator app is open and they are not away, null when the server cannot tell now.",
      input: z.object({}),
      readOnly: true,
      async run(_input, { workspaceId }) {
        const [rows, online] = await Promise.all([
          withWorkspace(db, workspaceId, (tx) => listMembers(tx, workspaceId)),
          options.presence.online(workspaceId),
        ]);
        const members = rows.map(({ id, name, role }) => ({
          id,
          name,
          role,
          online: online === null ? null : online.includes(id),
        }));
        return { data: { members } };
      },
    }),
    tool({
      name: "list_saved_replies",
      title: "List the team's saved replies",
      description:
        "Lists the replies the team saved for common questions, by `shortcut`, with their `body` in Markdown. Use them to answer in the team's own words and with its facts, such as a refund policy. A body is the team's text, so you may adapt it to the visitor.",
      input: z.object({}),
      readOnly: true,
      run: async (_input, { workspaceId }) => ({
        data: {
          savedReplies: await withWorkspace(db, workspaceId, (tx) =>
            listSavedReplies(tx, workspaceId),
          ),
        },
      }),
    }),
    tool({
      name: "set_typing",
      title: "Show that you are typing",
      description: `Shows the visitor "<key name> is typing..." for ${BOT_TYPING_MS / 1000} seconds, or until the next message, so call it again while you write. Operators see it too. A key in draft mode shows it to operators only. Errors like \`reply\`: \`bots_paused\`, and \`human_handling\` for a key that sends directly.`,
      input: z.object({ conversationId, typing: z.boolean().default(true) }),
      idempotent: true,
      async run(input, { workspaceId, actor }) {
        const result = await setTyping(
          db,
          live,
          workspaceId,
          actor,
          input.conversationId,
          input.typing,
        );
        if (result.kind !== "ok") return { error: refusedReply(result).body };
        return { data: { ok: true } };
      },
    }),
    tool({
      name: "wait_for_messages",
      title: "Wait for visitor messages",
      description: `Waits up to \`timeoutSeconds\` for new visitor messages in open conversations, and answers them at once when they come: \`{ messages: [{ conversationId, message, visitor: { name, email }, humanHandling, botsPaused }], cursor }\`. Call it first with no cursor: it answers at once with no messages and the cursor for now. Messages from before then are in list_conversations and get_conversation. Then pass back the cursor of each answer. With \`humanHandling\` a person handles the conversation, and with \`botsPaused\` no bot may reply. \`resync: true\` means the cursor was too old: read the open conversations again. ${UNTRUSTED_TEXT}`,
      input: z.object({
        cursor: z
          .string()
          .regex(CURSOR_PATTERN)
          .optional()
          .describe("The cursor of the answer before"),
        timeoutSeconds: z.number().int().min(1).max(30).default(25),
        conversationId: conversationId.optional().describe("Only this conversation's messages"),
      }),
      readOnly: true,
      run: (input, { workspaceId }) => waitForMessages(options, workspaceId, input),
    }),
    tool({
      name: "get_contact",
      title: "Read a contact",
      description: `Reads who a visitor is, by \`visitorId\` or by a \`conversationId\` of theirs: name, email and user ID, the attributes your site signed, \`pageContext\`, country, time zone and \`localTime\` (the time on their clock now), whether they are online, their newest 20 pages, the team's private note, and their other conversations. ${UNTRUSTED_TEXT}`,
      input: z.object({
        visitorId: z.uuid().optional().describe("The visitor's ID. Pass this or conversationId"),
        conversationId: conversationId
          .optional()
          .describe("One of the visitor's conversations. Pass this or visitorId"),
      }),
      readOnly: true,
      async run(input, { workspaceId }) {
        const { visitorId: byVisitor, conversationId: byConversation } = input;
        if ((byVisitor === undefined) === (byConversation === undefined)) {
          return { error: ONE_CONTACT_ID };
        }
        const found = await withWorkspace(db, workspaceId, async (tx) => {
          const visitorId =
            byConversation === undefined
              ? byVisitor
              : (await conversationVisitor(tx, workspaceId, byConversation))?.id;
          return visitorId === undefined ? null : readContact(tx, workspaceId, visitorId);
        });
        if (found === null) return { error: NOT_FOUND };
        const online = await options.visitorPresence.online(workspaceId, found.id);
        return { data: { contact: { ...found, online, localTime: localTime(found.timeZone) } } };
      },
    }),
    tool({
      name: "list_contacts",
      title: "List contacts",
      description: `Lists the people who have a conversation, newest first by \`sort\`. \`q\` matches the name, email or user ID. Pass \`next\` back as \`before\` for the next page. ${UNTRUSTED_TEXT}`,
      input: ContactListQuery,
      readOnly: true,
      run: async (input, { workspaceId }) => ({
        data: await withWorkspace(db, workspaceId, (tx) => listContacts(tx, workspaceId, input)),
      }),
    }),
    tool({
      name: "search_contacts",
      title: "Search contacts",
      description: `Finds people by name, email or user ID, ignoring case, newest seen first, at most 20. ${UNTRUSTED_TEXT}`,
      input: z.object({ q: z.string().trim().min(1).max(100) }),
      readOnly: true,
      run: async ({ q }, { workspaceId }) => ({
        data: await withWorkspace(db, workspaceId, (tx) =>
          listContacts(tx, workspaceId, { q, sort: "lastSeen", limit: 20 }),
        ),
      }),
    }),
    tool({
      name: "get_live_visitors",
      title: "List who is on the site now",
      description: `Lists the tabs of the site open now, newest first: the page, its title, the device and country, and the visitor when they have chatted. \`visitors\` is null when the server cannot tell now. ${UNTRUSTED_TEXT}`,
      input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      readOnly: true,
      async run({ limit }, { workspaceId }) {
        const visitors = await liveVisitorList(db, options.liveVisitors, workspaceId);
        return { data: { visitors: visitors?.slice(0, limit) ?? null } };
      },
    }),
    tool({
      name: "get_analytics",
      title: "Read support numbers",
      description:
        "The Analytics page's numbers for the last 7, 30 or 90 days in a time zone: conversations started and closed, first reply times (median, 90th percentile, within 5 minutes), the previous period, conversations per day, who replied first and the busy hours.",
      input: AnalyticsQuery,
      readOnly: true,
      async run(input, { workspaceId }) {
        const numbers = await analyticsFor(db, workspaceId, input);
        return numbers === null ? { error: UNKNOWN_ZONE } : { data: numbers };
      },
    }),
  ];
}
