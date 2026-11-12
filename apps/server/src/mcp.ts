import { z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { authenticateRequest, type KeyActor } from "./api-keys.ts";
import { API_KEY } from "./api-security.ts";
import type { App } from "./app.ts";
import { WEBHOOK_EVENTS } from "./db/schema.ts";
import { type Database, writable } from "./db/tenant.ts";
import { errorAnswer, failure, NOT_FOUND, RATE_LIMITED, WRONG_ORIGIN } from "./errors.ts";
import { type Inbox, parseSnooze, SNOOZE_CLOSED, type SnoozeOutcome } from "./inbox.ts";
import { conversationId, UNTRUSTED_TEXT, webhookId } from "./inputs.ts";
import type { Live } from "./live.ts";
import { type ChatToolsOptions, chatTools } from "./mcp-chat-tools.ts";
import { mcpSetupTools, type SetupToolOptions } from "./mcp-setup-tools.ts";
import { closedFailure } from "./member.ts";
import type { RateLimit } from "./rate-limit.ts";
import { assignTo, NOT_A_MEMBER } from "./team.ts";
import type { Webhooks } from "./webhooks.ts";

// MCP over Streamable HTTP, stateless: each POST holds one JSON-RPC message and gets one JSON answer.
// There is no session and no event stream, so GET answers 405, as the spec allows.

/**
 * 2026-07-28 has no `initialize`: each request names its version in `params._meta`, and its headers
 * repeat the version, the method and the tool's name.
 */
const STATELESS_VERSION = "2026-07-28";
/** Newest first. An `initialize` that asks for another version gets the newest. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED_VERSIONS = [STATELESS_VERSION, ...PROTOCOL_VERSIONS];
const PATH = "/v1/mcp";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
// JSON-RPC error codes, and the MCP ones past them.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
/** How long a client may keep the tool list. It depends on the key's level, so it is private. */
const TOOLS_TTL_MS = 5 * 60_000;

const RpcMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
type RpcId = string | number | null;

const rpcError = (id: RpcId, code: number, message: string, data?: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
const rpcResult = (id: RpcId, result: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  id,
  result,
});

/** A tool's answer: its data, or an error body with a stable code, as the HTTP API gives. */
export type Outcome = { data: Record<string, unknown> } | { error: ReturnType<typeof failure> };

interface Context {
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

/** What every client reads first: visitor text is untrusted, and each job has its own connection. */
const INSTRUCTIONS_SAFETY = `${UNTRUSTED_TEXT} A Setup connection is for installing Dinghy on a site. Give the bot that answers chats its own Conversations connection.`;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([0-9a-f-]{36})$/;

const snoozeAnswer = (outcome: SnoozeOutcome): Outcome => {
  if (outcome === "missing") return { error: NOT_FOUND };
  if (outcome === "closed") return { error: SNOOZE_CLOSED };
  return { data: { ok: true } };
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
      run: async ({ q }, { workspaceId }) => ({ data: await inbox.search(workspaceId, null, q) }),
    }),
    tool({
      name: "close_conversation",
      title: "Close a conversation",
      description: "Closes a conversation. A new message from the visitor reopens it.",
      input: z.object({ conversationId }),
      idempotent: true,
      destructive: true,
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
      name: "snooze_conversation",
      title: "Snooze a conversation",
      description:
        "Snoozes an open conversation: it stays open but does not count as waiting until `until`, or with `until` null until the visitor writes. The visitor hears nothing of it. A close ends it.",
      input: z.object({
        conversationId,
        until: z.iso
          .datetime()
          .nullable()
          .describe("When the snooze ends, as an ISO date, or null until the visitor writes"),
      }),
      idempotent: true,
      run: async ({ conversationId: id, until }, { workspaceId }) =>
        snoozeAnswer(await inbox.setSnooze(workspaceId, id, parseSnooze({ until }))),
    }),
    tool({
      name: "unsnooze_conversation",
      title: "Unsnooze a conversation",
      description:
        "Ends a conversation's snooze, so it counts as waiting again when the visitor wrote last.",
      input: z.object({ conversationId }),
      idempotent: true,
      run: async (input, { workspaceId }) =>
        snoozeAnswer(await inbox.setSnooze(workspaceId, input.conversationId, null)),
    }),
    tool({
      name: "assign_conversation",
      title: "Assign a conversation",
      description:
        "Assigns a conversation to a member of the workspace, by their operator ID from list_members, or clears the assignee with null.",
      input: z.object({ conversationId, operatorId: z.uuid().nullable() }),
      idempotent: true,
      async run(input, { workspaceId }) {
        const result = await assignTo(
          db,
          live,
          workspaceId,
          input.conversationId,
          input.operatorId,
          false,
        );
        if (result === "not_member") return { error: NOT_A_MEMBER };
        if (result === "none") return { error: NOT_FOUND };
        return { data: { ok: true } };
      },
    }),
  ];
}

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
  chat: ChatToolsOptions;
  /** Where a client learns to get an OAuth token, or null when OAuth is off. */
  resourceMetadata: string | null;
}

type Params = Record<string, unknown>;

/** The `_meta` of a request's params, where a 2026-07-28 request names its version. */
const metaOf = (params: Params): Params => {
  const meta = params._meta;
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Params) : {};
};

/** An MCP header's value, which a client may send base64-encoded as `=?base64?...?=`. */
function headerValue(value: string | undefined): string | undefined {
  const encoded = value?.match(/^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/)?.[1];
  return encoded === undefined ? value : Buffer.from(encoded, "base64").toString("utf8");
}

/**
 * Whether a 2026-07-28 request's headers differ from its body. A proxy routes on the headers,
 * so they must say what the body does.
 */
function headerMismatch(
  headers: { version: string | undefined; method: string | undefined; name: string | undefined },
  method: string | undefined,
  params: Params,
): boolean {
  if (headers.version !== STATELESS_VERSION || metaOf(params)[META_VERSION] !== STATELESS_VERSION) {
    return true;
  }
  if (method !== undefined && headers.method !== method) return true;
  return method === "tools/call" && headers.name !== params.name;
}

/** The protocol version a request asks for: its body's, or else its header's. */
function versionOf(params: Params, header: string | undefined): string | undefined {
  const asked = metaOf(params)[META_VERSION];
  return typeof asked === "string" ? asked : header;
}

/** The 401 that tells an OAuth client where to get a token (RFC 9728), and that a token failed. */
function challenge(resourceMetadata: string | null, tokenSent: boolean): string {
  if (resourceMetadata === null) return 'Bearer realm="dinghy"';
  const failed = tokenSent ? 'error="invalid_token", ' : "";
  return `Bearer ${failed}resource_metadata="${resourceMetadata}", scope="conversations"`;
}

export function registerMcp(
  app: App,
  {
    db,
    webhooks,
    live,
    rateLimit,
    inbox,
    publicOrigin,
    version,
    setup,
    chat,
    resourceMetadata,
  }: McpOptions,
): void {
  const everyKey = [...tools(inbox, db, live), ...chatTools(chat)];
  const setupOnly = [...setupTools(webhooks), ...mcpSetupTools(setup)];
  /** A Conversations key does not see the Setup tools at all. */
  const toolsFor = (actor: KeyActor) =>
    actor.level === "setup" ? [...everyKey, ...setupOnly] : everyKey;
  const serverInfo = { name: "dinghy", title: "Dinghy", version };
  const capabilities = { tools: { listChanged: false } };
  const instructions = (actor: KeyActor) =>
    `${
      actor.level === "setup"
        ? "Dinghy is a live support chat. These tools read and answer the conversations of one workspace, the key's, add notes that only the team sees, and install Dinghy on a site: the snippet, allowed sites, appearance, webhooks and test visitors. Replies and notes show the key's name as their author."
        : "Dinghy is a live support chat. These tools read and answer the conversations of one workspace, the key's, and add notes that only the team sees. Replies and notes show the key's name as their author."
    } ${INSTRUCTIONS_SAFETY}`;
  const listTools = (actor: KeyActor) =>
    toolsFor(actor).map(({ call: _call, ...listed }) => listed);
  const callTool = async (id: RpcId, params: Params, actor: KeyActor) => {
    const found = toolsFor(actor).find((one) => one.name === params.name);
    if (found === undefined)
      return rpcError(id, INVALID_PARAMS, "There is no tool with this name.");
    const outcome = await found.call(params.arguments, { workspaceId: actor.workspaceId, actor });
    return rpcResult(id, toolResult(outcome));
  };

  /** Answers one request of the versions with a session handshake. */
  const answerLegacy = async (id: RpcId, method: string, params: Params, actor: KeyActor) => {
    if (method === "initialize") {
      const asked = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion:
          typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0],
        capabilities,
        serverInfo,
        instructions: instructions(actor),
      });
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: listTools(actor) });
    if (method === "tools/call") return callTool(id, params, actor);
    return rpcError(id, METHOD_NOT_FOUND, "This method does not exist.");
  };

  /** Answers one 2026-07-28 request, whose every result says it is complete and who answered. */
  const answerStateless = async (id: RpcId, method: string, params: Params, actor: KeyActor) => {
    const complete = (result: Record<string, unknown>) =>
      rpcResult(id, {
        ...result,
        resultType: "complete",
        _meta: { [META_SERVER_INFO]: serverInfo },
      });
    if (method === "server/discover") {
      return complete({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities,
        serverInfo,
        instructions: instructions(actor),
      });
    }
    if (method === "ping") return complete({});
    if (method === "tools/list") {
      return complete({ tools: listTools(actor), ttlMs: TOOLS_TTL_MS, cacheScope: "private" });
    }
    if (method === "tools/call") {
      const answer = await callTool(id, params, actor);
      return "result" in answer ? complete(answer.result) : answer;
    }
    return null;
  };

  app.use(PATH, bodyLimit({ maxSize: 64 * 1024 }));

  app.post(PATH, async (c) => {
    // A page on another site must not reach this through a visitor's browser.
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== publicOrigin) return c.json(WRONG_ORIGIN, 403);
    const actor = await authenticateRequest(c, db, rateLimit);
    if (actor instanceof Response) {
      if (actor.status === 401) {
        const tokenSent = c.req.header("authorization") !== undefined;
        actor.headers.set("www-authenticate", challenge(resourceMetadata, tokenSent));
      }
      return actor;
    }
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw === undefined) return c.json(rpcError(null, PARSE_ERROR, "The body is not JSON."), 400);
    const parsed = RpcMessage.safeParse(raw);
    if (!parsed.success) {
      return c.json(rpcError(null, INVALID_REQUEST, "Send one JSON-RPC 2.0 message."), 400);
    }
    const { id, method, params = {} } = parsed.data;
    const header = c.req.header("mcp-protocol-version");
    const asked = versionOf(params, header);
    if (asked !== undefined && !SUPPORTED_VERSIONS.includes(asked)) {
      const data = { supported: SUPPORTED_VERSIONS, requested: asked };
      return c.json(
        rpcError(id ?? null, UNSUPPORTED_VERSION, "This protocol version is not supported.", data),
        400,
      );
    }
    const stateless = asked === STATELESS_VERSION || header === STATELESS_VERSION;
    if (stateless) {
      const headers = {
        version: header,
        method: headerValue(c.req.header("mcp-method")),
        name: headerValue(c.req.header("mcp-name")),
      };
      if (headerMismatch(headers, method, params)) {
        return c.json(
          rpcError(id ?? null, HEADER_MISMATCH, "The MCP headers do not match the body."),
          400,
        );
      }
    }
    // A notification, such as notifications/initialized, or a response: accepted, with no answer.
    if (id === undefined || method === undefined) return c.body(null, 202);
    if (!stateless) return c.json(await answerLegacy(id, method, params, actor), 200);
    const answer = await answerStateless(id, method, params, actor);
    if (answer === null)
      return c.json(rpcError(id, METHOD_NOT_FOUND, "This method does not exist."), 404);
    return c.json(answer, 200);
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
      "One JSON-RPC 2.0 message per request. Protocol 2026-07-28 is stateless: each request names its version in `params._meta[\"io.modelcontextprotocol/protocolVersion\"]`, its `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers must match the body (400, -32020 otherwise), and its methods are `server/discover`, `ping`, `tools/list` and `tools/call`. The versions 2025-11-25, 2025-06-18 and 2025-03-26 use `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. An unknown version answers 400 with -32022 and the supported list. Every key gets `list_conversations`, `search_conversations`, `get_conversation`, `reply`, `close_conversation`, `reopen_conversation`, `snooze_conversation`, `unsnooze_conversation`, `assign_conversation`, `add_note`, `list_drafts`, `hand_off`, `list_members`, `set_typing`, `wait_for_messages`, `get_contact`, `list_contacts`, `search_contacts`, `get_live_visitors` and `get_analytics`, in the key's workspace. A Setup key also gets the webhook, install, allowed site, appearance and test visitor tools. A notification gets 202 with no body. A tool that fails answers with `isError: true` and the error's stable code. `GET` answers 405, because there is no event stream.",
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
      401: errorAnswer(
        "unauthorized: the API key or OAuth access token is not valid, expired or was revoked. With OAuth on, `WWW-Authenticate` names the resource metadata",
      ),
      404: {
        description: "A 2026-07-28 request for a method that does not exist, in JSON-RPC form",
      },
      403: errorAnswer("origin_not_allowed: a browser on another site sent this"),
      ...RATE_LIMITED,
    },
  });
}
