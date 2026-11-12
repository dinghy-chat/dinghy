import { z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import {
  apiKeyToken,
  authenticateApiKey,
  KEY_INVALID,
  KEY_REQUESTS_PER_MINUTE,
  type KeyActor,
} from "./api-keys.ts";
import { API_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { WEBHOOK_EVENTS } from "./db/schema.ts";
import { type Database, writable } from "./db/tenant.ts";
import { errorAnswer, failure, NOT_FOUND, RATE_LIMITED, WRONG_ORIGIN } from "./errors.ts";
import type { Inbox, ReplyOutcome } from "./inbox.ts";
import type { Live } from "./live.ts";
import { mcpSetupTools, type SetupToolOptions } from "./mcp-setup-tools.ts";
import { closedFailure } from "./member.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";
import { assignTo, NOT_A_MEMBER } from "./team.ts";
import type { Webhooks } from "./webhooks.ts";

// MCP over Streamable HTTP, stateless: each POST holds one JSON-RPC message and gets one JSON answer.
// There is no session and no event stream, so GET answers 405, as the spec allows.

/** Newest first. An `initialize` that asks for another version gets the newest. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const PATH = "/v1/mcp";

const RpcMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
type RpcId = string | number | null;

const rpcError = (id: RpcId, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});
const rpcResult = (id: RpcId, result: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  id,
  result,
});

/** A tool's answer: its data, or an error body with a stable code, as the HTTP API gives. */
export type Outcome = { data: Record<string, unknown> } | { error: ReturnType<typeof failure> };

export interface Context {
  workspaceId: string;
  actor: KeyActor;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  call(args: unknown, context: Context): Promise<Outcome>;
}

/** A tool whose input is checked with its Zod schema, which also gives the JSON Schema it lists. */
export function tool<S extends z.ZodType>(spec: {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  idempotent?: boolean;
  /** It deletes or ends something, so a client asks the person first. */
  destructive?: boolean;
  run(input: z.output<S>, context: Context): Promise<Outcome>;
}): Tool {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(spec.input, { io: "input" });
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema,
    annotations: {
      readOnlyHint: spec.readOnly === true,
      destructiveHint: spec.destructive === true,
      idempotentHint: spec.readOnly === true || spec.idempotent === true,
    },
    async call(args, context) {
      const parsed = spec.input.safeParse(args ?? {});
      if (!parsed.success) {
        const where = parsed.error.issues[0]?.path.join(".") || "arguments";
        return { error: failure("invalid_request", `The ${where} are not valid.`) };
      }
      // The same refusals as the HTTP API's member check: nothing while the workspace waits for
      // payment, and no write while it is read-only or suspended.
      const { access } = context.actor;
      if (access === "waiting_payment" || (spec.readOnly !== true && !writable(access))) {
        return { error: closedFailure(access).body };
      }
      return spec.run(parsed.data, context);
    },
  };
}

const conversationId = z.uuid().describe("The conversation's ID");
const CURSOR = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([0-9a-f-]{36})$/;

const replyAnswer = (outcome: ReplyOutcome): Outcome => {
  if (outcome.kind === "sent") return { data: { message: outcome.message } };
  if (outcome.kind === "missing") return { error: NOT_FOUND };
  if (outcome.kind === "closed") {
    return { error: failure("conversation_closed", "Reopen this conversation to reply.") };
  }
  if (outcome.kind === "invalid_reply_to") {
    return {
      error: failure(
        "invalid_reply_to",
        "Quote a message that people wrote in this conversation and that was not deleted.",
      ),
    };
  }
  return { error: closedFailure(outcome.access).body };
};

function tools(inbox: Inbox, db: Database, live: Live): Tool[] {
  const status =
    (target: "open" | "closed") =>
    async (input: { conversationId: string }, { workspaceId, actor }: Context): Promise<Outcome> =>
      (await inbox.setStatus(workspaceId, actor, input.conversationId, target))
        ? { data: { ok: true } }
        : { error: NOT_FOUND };
  return [
    tool({
      name: "list_conversations",
      title: "List conversations",
      description:
        "Lists conversations, newest activity first, with each visitor and the last message. `waiting` counts the open conversations whose last message is the visitor's. Pass `nextCursor` back as `cursor` for the next page.",
      input: z.object({
        status: z.enum(["open", "closed"]).default("open"),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().regex(CURSOR).optional().describe("The nextCursor of the page before"),
      }),
      readOnly: true,
      async run({ status: wanted, limit, cursor }, { workspaceId }) {
        const match = cursor === undefined ? null : CURSOR.exec(cursor);
        const before =
          match === null ? undefined : { updatedAt: new Date(match[1] ?? ""), id: match[2] ?? "" };
        const page = await inbox.list(workspaceId, null, wanted, { kind: "all" }, before, limit);
        const last = page.conversations.at(-1);
        return {
          data: {
            conversations: page.conversations,
            waiting: page.waiting,
            nextCursor: page.hasMore && last !== undefined ? `${last.updatedAt}|${last.id}` : null,
          },
        };
      },
    }),
    tool({
      name: "search_conversations",
      title: "Search conversations",
      description:
        "Finds open and closed conversations whose visitor's name, email or user ID, or one of whose messages, holds the text, ignoring case. At most 50, newest activity first.",
      input: z.object({ q: z.string().trim().min(3).max(100).describe("At least 3 characters") }),
      readOnly: true,
      run: async ({ q }, { workspaceId }) => ({ data: await inbox.search(workspaceId, q) }),
    }),
    tool({
      name: "get_conversation",
      title: "Read a conversation",
      description:
        "Reads one conversation: its status and assignee, the visitor (with the attributes your site signed), `pageContext` (what the page sent, not verified), the pages the visitor went through, and its messages in order.",
      input: z.object({
        conversationId,
        after: z
          .string()
          .regex(/^\d{1,18}$/)
          .default("0")
          .describe("Only messages after this seq"),
        limit: z.number().int().min(1).max(100).default(100),
      }),
      readOnly: true,
      async run(input, { workspaceId }) {
        const found = await inbox.read(
          workspaceId,
          input.conversationId,
          BigInt(input.after),
          input.limit,
        );
        return found === null ? { error: NOT_FOUND } : { data: found };
      },
    }),
    tool({
      name: "reply",
      title: "Reply to a visitor",
      description:
        "Sends a reply in an open conversation. The visitor sees the API key's name as its author. Pass the same `clientId` when you retry, so a retry cannot send it twice. Pass `replyToMessageId` to quote an earlier message.",
      input: z.object({
        conversationId,
        body: z
          .string()
          .trim()
          .min(1)
          .max(MESSAGE_MAX)
          .regex(/^[^\0]*$/),
        clientId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .describe(
            "Your own ID for this reply, up to 64 letters, digits, - or _. Send the same one on a retry",
          ),
        replyToMessageId: z
          .uuid()
          .optional()
          .describe("An earlier message of this conversation to quote, from get_conversation"),
      }),
      idempotent: true,
      run: async (input, { workspaceId, actor }) =>
        replyAnswer(
          await inbox.reply(workspaceId, actor, input.conversationId, {
            body: input.body,
            clientId: input.clientId,
            replyToMessageId: input.replyToMessageId,
            via: "mcp",
          }),
        ),
    }),
    tool({
      name: "close_conversation",
      title: "Close a conversation",
      description: "Closes a conversation. A new message from the visitor starts a new one.",
      input: z.object({ conversationId }),
      idempotent: true,
      run: status("closed"),
    }),
    tool({
      name: "reopen_conversation",
      title: "Reopen a conversation",
      description: "Reopens a closed conversation, so it can get replies again.",
      input: z.object({ conversationId }),
      idempotent: true,
      run: status("open"),
    }),
    tool({
      name: "assign_conversation",
      title: "Assign a conversation",
      description:
        "Assigns a conversation to a member of the workspace, by their operator ID, or clears the assignee with null. Message authors and assignees carry operator IDs.",
      input: z.object({ conversationId, operatorId: z.uuid().nullable() }),
      idempotent: true,
      async run(input, { workspaceId }) {
        const result = await assignTo(
          db,
          live,
          workspaceId,
          input.conversationId,
          input.operatorId,
        );
        if (result === "not_member") return { error: NOT_A_MEMBER };
        if (result === "none") return { error: NOT_FOUND };
        return { data: { ok: true } };
      },
    }),
  ];
}

const webhookId = z.uuid().describe("The webhook's ID, from list_webhooks or create_webhook");

/** The webhook tools, which only a Setup key lists and calls. */
function setupTools(webhooks: Webhooks): Tool[] {
  return [
    tool({
      name: "list_webhooks",
      title: "List webhooks",
      description:
        "Lists the workspace's webhooks, oldest first: each one's URL, events, whether it is on and who added it. Never the signing secrets.",
      input: z.object({}),
      readOnly: true,
      run: async (_input, { workspaceId }) => ({
        data: { webhooks: await webhooks.list(workspaceId) },
      }),
    }),
    tool({
      name: "create_webhook",
      title: "Add a webhook",
      description: `Adds a webhook that gets a signed POST for each event it asks for: ${WEBHOOK_EVENTS.join(", ")}. The URL must be https. The answer holds the signing secret once: store it to check the \`Dinghy-Signature\` header. A workspace has at most 5 webhooks.`,
      input: z.object({
        url: z.string().trim().max(2000).describe("The https address that receives the events"),
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
      }),
      async run(input, { workspaceId, actor }) {
        const made = await webhooks.create(workspaceId, actor, { ...input, enabled: true });
        if (made.kind === "bad_endpoint") return { error: failure("bad_endpoint", made.reason) };
        if (made.kind === "limit") {
          return { error: failure("webhook_limit", "A workspace can have 5 webhooks.") };
        }
        return { data: { webhook: made.webhook, secret: made.secret } };
      },
    }),
    tool({
      name: "delete_webhook",
      title: "Delete a webhook",
      description: "Deletes a webhook and its deliveries. It gets no more events.",
      input: z.object({ webhookId }),
      idempotent: true,
      destructive: true,
      async run(input, { workspaceId, actor }) {
        const gone = await webhooks.remove(workspaceId, actor, input.webhookId);
        return gone ? { data: { ok: true } } : { error: NOT_FOUND };
      },
    }),
    tool({
      name: "test_webhook",
      title: "Test a webhook",
      description:
        "Sends a signed `webhook.test` event to the webhook now, and answers what it answered: `delivered`, the HTTP `status` and an `error`.",
      input: z.object({ webhookId }),
      async run(input, { workspaceId }) {
        const result = await webhooks.test(workspaceId, input.webhookId);
        return result === null ? { error: NOT_FOUND } : { data: result };
      },
    }),
  ];
}

/** A tool's answer as MCP carries it: text for any client, and the same data as structured content. */
function toolResult(outcome: Outcome): Record<string, unknown> {
  if ("data" in outcome) {
    return {
      content: [{ type: "text", text: JSON.stringify(outcome.data) }],
      structuredContent: outcome.data,
      isError: false,
    };
  }
  const { code, message } = outcome.error.error;
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: outcome.error,
    isError: true,
  };
}

interface McpOptions {
  db: Database;
  webhooks: Webhooks;
  live: Live;
  rateLimit: RateLimit;
  inbox: Inbox;
  /** The server's own origin. A browser request from any other is refused. */
  publicOrigin: string;
  version: string;
  setup: SetupToolOptions;
}

export function registerMcp(
  app: App,
  { db, webhooks, live, rateLimit, inbox, publicOrigin, version, setup }: McpOptions,
): void {
  const everyKey = tools(inbox, db, live);
  const setupOnly = [...setupTools(webhooks), ...mcpSetupTools(setup)];
  /** A Conversations key does not see the Setup tools at all. */
  const toolsFor = (actor: KeyActor) =>
    actor.level === "setup" ? [...everyKey, ...setupOnly] : everyKey;

  /** Answers one JSON-RPC request. Null for a notification, which gets no answer. */
  const answer = async (
    id: RpcId,
    method: string,
    params: Record<string, unknown>,
    actor: KeyActor,
  ) => {
    if (method === "initialize") {
      const asked = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion:
          typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dinghy", title: "Dinghy", version },
        instructions:
          actor.level === "setup"
            ? "Dinghy is a live support chat. These tools read and answer the conversations of one workspace, the API key's, and set up its webhooks. Replies show the key's name as their author."
            : "Dinghy is a live support chat. These tools read and answer the conversations of one workspace, the API key's. Replies show the key's name as their author.",
      });
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") {
      return rpcResult(id, {
        tools: toolsFor(actor).map(({ call: _call, ...listed }) => listed),
      });
    }
    if (method === "tools/call") {
      const found = toolsFor(actor).find((one) => one.name === params.name);
      if (found === undefined) return rpcError(id, -32602, "There is no tool with this name.");
      const outcome = await found.call(params.arguments, {
        workspaceId: actor.workspaceId,
        actor,
      });
      return rpcResult(id, toolResult(outcome));
    }
    return rpcError(id, -32601, "This method does not exist.");
  };

  app.use(PATH, bodyLimit({ maxSize: 64 * 1024 }));

  app.post(PATH, async (c) => {
    // A page on another site must not reach this through a visitor's browser.
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const token = apiKeyToken(c.req.header("authorization"));
    const actor = token === null ? null : await authenticateApiKey(db, token);
    if (actor === null) {
      c.header("www-authenticate", 'Bearer realm="dinghy"');
      return c.json(KEY_INVALID, 401);
    }
    const wait = await rateLimit.hit("api-key", actor.apiKeyId, KEY_REQUESTS_PER_MINUTE, 60);
    if (wait !== null) return tooManyRequests(c, wait);
    const asked = c.req.header("mcp-protocol-version");
    if (asked !== undefined && !PROTOCOL_VERSIONS.includes(asked)) {
      return c.json(rpcError(null, -32600, "This protocol version is not supported."), 400);
    }
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw === undefined) return c.json(rpcError(null, -32700, "The body is not JSON."), 400);
    const parsed = RpcMessage.safeParse(raw);
    if (!parsed.success) {
      return c.json(rpcError(null, -32600, "Send one JSON-RPC 2.0 message."), 400);
    }
    const { id, method, params = {} } = parsed.data;
    // A notification, such as notifications/initialized, or a response: accepted, with no answer.
    if (id === undefined || method === undefined) return c.body(null, 202);
    return c.json(await answer(id, method, params, actor), 200);
  });

  // No event stream and no session, so there is nothing to GET or DELETE.
  app.on(["GET", "DELETE"], PATH, (c) => {
    c.header("allow", "POST");
    return c.json(failure("invalid_request", "Use POST. This server has no event stream."), 405);
  });

  app.openAPIRegistry.registerPath({
    method: "post",
    path: PATH,
    security: API_KEY,
    summary: "MCP (Model Context Protocol) over Streamable HTTP, stateless, with JSON answers",
    description:
      "One JSON-RPC 2.0 message per request. Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. The tools are `list_conversations`, `search_conversations`, `get_conversation`, `reply`, `close_conversation`, `reopen_conversation` and `assign_conversation`, in the API key's workspace. A Setup key also gets `list_webhooks`, `create_webhook`, `delete_webhook` and `test_webhook`. A notification gets 202 with no body. A tool that fails answers with `isError: true` and the error's stable code. `GET` answers 405, because there is no event stream.",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              jsonrpc: z.literal("2.0"),
              id: z.union([z.string(), z.number()]).optional(),
              method: z.string(),
              params: z.record(z.string(), z.unknown()).optional(),
            }),
            example: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          },
        },
      },
    },
    responses: {
      200: {
        description: "The JSON-RPC answer",
        content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
      },
      202: { description: "A notification was accepted" },
      400: errorAnswer("A JSON-RPC parse error or invalid request, in JSON-RPC form"),
      401: errorAnswer("unauthorized: the API key is not valid or was revoked"),
      403: errorAnswer("origin_not_allowed: a browser on another site sent this"),
      ...RATE_LIMITED,
    },
  });
}
