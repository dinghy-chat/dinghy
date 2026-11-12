import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { conversation, message } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let app: App;
let space: NewWorkspace;
let boss: { id: string; cookie: string };
let token: string;
let conversationId: string;

interface ToolAnswer {
  isError: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/v1/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await post({ jsonrpc: "2.0", id: 7, method, params });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    jsonrpc: string;
    id: number;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

async function callTool(name: string, args: Record<string, unknown>) {
  const answer = await rpc("tools/call", { name, arguments: args });
  return answer.result as unknown as ToolAnswer;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({ db, logger, auth, checks: { postgres: ok, valkey: ok } });
  space = await createWorkspace(db, "Acme", [SITE]);
  const made = await signedInOperator({ app, auth, owner, name: "Mona", workspaceId: space.id });
  boss = { id: made.id, cookie: made.cookie };
  const key = await app.request(`/v1/operator/workspaces/${space.id}/api-keys`, {
    method: "POST",
    headers: { cookie: boss.cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ name: "Claude" }),
  });
  token = ((await key.json()) as { token: string }).token;
  const visitor = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  const { token: visitorToken } = (await visitor.json()) as { token: string };
  const headers = {
    origin: SITE,
    authorization: `Bearer ${visitorToken}`,
    "content-type": "application/json",
  };
  const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ clientId: "v1", body: "My order never came" }),
  });
  conversationId = ((await sent.json()) as { conversationId: string }).conversationId;
  await app.request(`/v1/widget/${space.publicKey}/context`, {
    method: "POST",
    headers,
    body: JSON.stringify({ context: { plan: "pro", orders: 3 } }),
  });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("the protocol", () => {
  test("initialize names the server and its tools capability", async () => {
    const answer = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(answer).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dinghy" },
      },
    });
  });

  test("a version it does not know gets its newest", async () => {
    const answer = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    expect(answer.result?.protocolVersion).toBe("2025-11-25");
  });

  test("a notification is accepted with no body", async () => {
    const response = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("ping answers an empty result", async () => {
    expect((await rpc("ping")).result).toEqual({});
  });

  test("tools/list gives each tool with a JSON Schema from its Zod schema", async () => {
    const { result } = await rpc("tools/list");
    const tools = (result?.tools ?? []) as {
      name: string;
      description: string;
      inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
      annotations: { readOnlyHint: boolean };
    }[];
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_conversations",
      "search_conversations",
      "get_conversation",
      "reply",
      "add_note",
      "close_conversation",
      "reopen_conversation",
      "assign_conversation",
    ]);
    const reply = tools.find((tool) => tool.name === "reply");
    expect(reply?.inputSchema).toMatchObject({
      type: "object",
      properties: { conversationId: { type: "string" }, body: { type: "string" } },
      required: ["conversationId", "body", "clientId"],
    });
    expect(reply?.annotations.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === "get_conversation")?.annotations.readOnlyHint).toBe(
      true,
    );
  });

  test("an unknown method or tool is a JSON-RPC error", async () => {
    expect((await rpc("resources/list")).error?.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "drop_tables", arguments: {} })).error?.code).toBe(
      -32602,
    );
  });

  test("a body that is not one JSON-RPC message is refused", async () => {
    const notJson = await app.request("/v1/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: { code: -32700 } });
    const batch = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ error: { code: -32600 } });
  });

  test("it needs a valid key, and refuses another site's browser", async () => {
    const bare = await app.request("/v1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toContain("Bearer");
    expect(
      (await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer dk_x" }))
        .status,
    ).toBe(401);
    const elsewhere = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: "https://evil.example" },
    );
    expect(elsewhere.status).toBe(403);
  });

  test("an unknown protocol version header is refused", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { "mcp-protocol-version": "1999-01-01" },
    );
    expect(response.status).toBe(400);
  });

  test("GET and DELETE answer 405, because there is no event stream or session", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await app.request("/v1/mcp", {
        method,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });
});

describe("the tools", () => {
  test("list_conversations and search_conversations find the visitor's conversation", async () => {
    const listed = await callTool("list_conversations", {});
    expect(listed.isError).toBe(false);
    expect(listed.structuredContent).toMatchObject({
      conversations: [{ id: conversationId, pageContext: { plan: "pro", orders: 3 } }],
      waiting: 1,
      nextCursor: null,
    });
    // The text holds the same data, for a client that reads only text.
    expect(JSON.parse(listed.content[0]?.text ?? "")).toEqual(listed.structuredContent);
    const found = await callTool("search_conversations", { q: "never came" });
    expect(found.structuredContent).toMatchObject({ conversations: [{ id: conversationId }] });
  });

  test("list_conversations pages with a cursor", async () => {
    for (let index = 0; index < 3; index++) {
      const visitor = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
        method: "POST",
        headers: { origin: SITE },
      });
      const { token: visitorToken } = (await visitor.json()) as { token: string };
      await app.request(`/v1/widget/${space.publicKey}/messages`, {
        method: "POST",
        headers: {
          origin: SITE,
          authorization: `Bearer ${visitorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ clientId: `p${index}`, body: `Page ${index}` }),
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const answer = await callTool("list_conversations", {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const { conversations, nextCursor } = answer.structuredContent as {
        conversations: { id: string }[];
        nextCursor: string | null;
      };
      seen.push(...conversations.map((one) => one.id));
      if (nextCursor === null) break;
      cursor = nextCursor;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  test("get_conversation gives the messages, the visitor, pageContext and the pages", async () => {
    const answer = await callTool("get_conversation", { conversationId });
    expect(answer.structuredContent).toMatchObject({
      conversation: { id: conversationId, status: "open", pageContext: { plan: "pro" } },
      messages: [{ body: "My order never came", fromVisitor: true }],
      visitorPages: [],
    });
  });

  test("reply writes under the key's name, and the same clientId does not write twice", async () => {
    const first = await callTool("reply", {
      conversationId,
      body: "Sorry! A new one ships today.",
      clientId: "claude-1",
    });
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({
      message: { authorName: "Claude", fromVisitor: false, clientId: "claude-1" },
    });
    await callTool("reply", {
      conversationId,
      body: "Sorry! A new one ships today.",
      clientId: "claude-1",
    });
    const rows = await owner.select().from(message).where(eq(message.clientId, "claude-1"));
    expect(rows).toHaveLength(1);
    // A random fallback would let a retry after a lost answer send twice, so the ID is required.
    const second = await callTool("reply", { conversationId, body: "Anything else?" });
    expect(second.isError).toBe(true);
  });

  test("close, reopen and assign change the conversation", async () => {
    expect((await callTool("close_conversation", { conversationId })).isError).toBe(false);
    const closed = await callTool("reply", { conversationId, body: "Too late", clientId: "late" });
    expect(closed.isError).toBe(true);
    expect(closed.content[0]?.text).toMatch(/^conversation_closed: /);
    expect(closed.structuredContent).toMatchObject({ error: { code: "conversation_closed" } });
    expect((await callTool("reopen_conversation", { conversationId })).isError).toBe(false);
    expect(
      (await callTool("assign_conversation", { conversationId, operatorId: boss.id })).isError,
    ).toBe(false);
    const [row] = await owner
      .select()
      .from(conversation)
      .where(eq(conversation.id, conversationId));
    expect(row).toMatchObject({ status: "open", assigneeOperatorId: boss.id });
    const stranger = await callTool("assign_conversation", {
      conversationId,
      operatorId: crypto.randomUUID(),
    });
    expect(stranger.structuredContent).toMatchObject({ error: { code: "not_a_member" } });
  });

  test("a bad argument or an unknown conversation is a tool error with its code", async () => {
    const bad = await callTool("get_conversation", { conversationId: "nope" });
    expect(bad).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "invalid_request" } },
    });
    const missing = await callTool("get_conversation", { conversationId: crypto.randomUUID() });
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not_found" } },
    });
    const short = await callTool("search_conversations", { q: "ab" });
    expect(short.isError).toBe(true);
  });
});
