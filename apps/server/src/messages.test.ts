import { and, eq, sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { sendOperatorMessage } from "../test/messages.ts";
import { type App, createApp } from "./app.ts";
import { conversation, event, message, operator, workspace, workspaceMember } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { appendMessage } from "./messages.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = "https://app.example.com";
const OPERATOR = "00000000-0000-4000-8000-0000000000f1";

let database: TestDatabase;
let db: Database;
let owner: Database;
let app: App;
let a: NewWorkspace;
let b: NewWorkspace;

interface WireMessage {
  id: string;
  conversationId: string;
  seq: string;
  clientId: string | null;
  fromVisitor: boolean;
  body: string | null;
}
interface WirePage {
  messages: WireMessage[];
  cursor: string;
  hasMore: boolean;
  resync: boolean;
}

async function newVisitor(key = a.publicKey) {
  const response = await app.request(`/v1/widget/${key}/visitors`, {
    method: "POST",
    headers: { origin: ORIGIN },
  });
  return (await response.json()) as { visitorId: string; token: string };
}

async function send(token: string, clientId: string, body: string, key = a.publicKey) {
  return app.request(`/v1/widget/${key}/messages`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ clientId, body }),
  });
}

async function history(token: string, after?: string, limit?: number): Promise<WirePage> {
  const query = new URLSearchParams();
  if (after !== undefined) query.set("after", after);
  if (limit !== undefined) query.set("limit", String(limit));
  const response = await app.request(`/v1/widget/${a.publicKey}/messages?${query}`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as WirePage;
}

async function count(workspaceId: string) {
  const rows = await withWorkspace(db, workspaceId, async (tx) => ({
    messages: (await tx.select().from(message)).length,
    events: (await tx.select().from(event)).length,
    conversations: (await tx.select().from(conversation)).length,
    seq: (await tx.select().from(workspace))[0]?.eventSeq,
  }));
  return rows;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app").db;
  owner = database.connect("migrator").db;
  const ok = async () => {};
  app = createApp({ db, logger: pino({ level: "silent" }), checks: { postgres: ok, valkey: ok } });
  a = await createWorkspace(db, "A", [ORIGIN]);
  b = await createWorkspace(db, "B", [ORIGIN]);
  await owner.insert(operator).values({ id: OPERATOR, name: "Anna", email: "anna@example.com" });
  await owner
    .insert(workspaceMember)
    .values({ workspaceId: a.id, operatorId: OPERATOR, role: "owner" });
});

afterAll(async () => {
  await database.drop();
});

describe("sending", () => {
  test("a message and its event are stored, and the event holds no text", async () => {
    const { token } = await newVisitor();
    const response = await send(token, "one", "the secret text");
    expect(response.status).toBe(201);
    const sent = (await response.json()) as WireMessage;
    expect(sent.body).toBe("the secret text");
    expect(sent.fromVisitor).toBe(true);
    const events = await withWorkspace(db, a.id, (tx) => tx.select().from(event));
    const mine = events.find(
      (row) => (row.payload as { messageId?: string }).messageId === sent.id,
    );
    expect(mine?.kind).toBe("message.created");
    expect(JSON.stringify(mine?.payload)).not.toContain("secret");
  });

  test("a retry creates one message and returns the original", async () => {
    const { token } = await newVisitor();
    const first = await send(token, "retry", "hello");
    const second = await send(token, "retry", "hello");
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(((await second.json()) as WireMessage).id).toBe(
      ((await first.json()) as WireMessage).id,
    );
    expect((await history(token)).messages).toHaveLength(1);
  });

  test("a retried first message, sent together, creates one conversation and one message", async () => {
    const { token, visitorId } = await newVisitor();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => send(token, "together", "hello")),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(5);
    const conversations = await withWorkspace(db, a.id, (tx) =>
      tx.select().from(conversation).where(eq(conversation.visitorId, visitorId)),
    );
    expect(conversations).toHaveLength(1);
    expect((await history(token)).messages).toHaveLength(1);
  });

  test("two different first messages together share one conversation", async () => {
    const { token } = await newVisitor();
    await Promise.all([send(token, "x", "one"), send(token, "y", "two")]);
    const { messages } = await history(token);
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((m) => m.conversationId)).size).toBe(1);
  });

  test("the same client ID from another visitor is a new message and leaks nothing", async () => {
    const first = await newVisitor();
    const second = await newVisitor();
    const original = (await (await send(first.token, "shared", "private")).json()) as WireMessage;
    const response = await send(second.token, "shared", "mine");
    expect(response.status).toBe(201);
    const other = (await response.json()) as WireMessage;
    expect(other.id).not.toBe(original.id);
    expect(other.body).toBe("mine");
    expect(other.conversationId).not.toBe(original.conversationId);
  });

  test("a closed conversation is not reused", async () => {
    const { token } = await newVisitor();
    const first = (await (await send(token, "before", "one")).json()) as WireMessage;
    await withWorkspace(db, a.id, (tx) =>
      tx
        .update(conversation)
        .set({ status: "closed" })
        .where(and(eq(conversation.workspaceId, a.id), eq(conversation.id, first.conversationId))),
    );
    const second = (await (await send(token, "after", "two")).json()) as WireMessage;
    expect(second.conversationId).not.toBe(first.conversationId);
  });

  test.each([
    ["an empty body", { clientId: "a", body: "" }],
    ["a blank body", { clientId: "a", body: "   " }],
    ["a body over the limit", { clientId: "a", body: "x".repeat(10_001) }],
    ["a NUL byte", { clientId: "a", body: "a\0b" }],
    ["no client ID", { body: "hello" }],
    ["a bad client ID", { clientId: "a b", body: "hello" }],
  ])("%s is refused", async (_name, payload) => {
    const { token } = await newVisitor();
    const response = await app.request(`/v1/widget/${a.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
  });

  test("an oversized body is refused before it is parsed", async () => {
    const { token } = await newVisitor();
    const response = await send(token, "big", "x".repeat(70 * 1024));
    expect(response.status).toBe(413);
  });

  test("a send with no valid token is refused", async () => {
    expect((await send("dbt_wrong", "z", "hello")).status).toBe(401);
  });
});

describe("the read position", () => {
  const read = (token: string, seq: string, key = a.publicKey) =>
    app.request(`/v1/widget/${key}/read`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ seq }),
    });
  const me = async (token: string) => {
    const response = await app.request(`/v1/widget/${a.publicKey}/me`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    });
    return (await response.json()) as { lastReadSeq: string; unread: number };
  };

  async function withReplies(count: number) {
    const { token } = await newVisitor();
    const sent = (await (await send(token, "q", "question")).json()) as WireMessage;
    const replies = [];
    for (let i = 0; i < count; i++) {
      replies.push(await sendOperatorMessage(db, a.id, OPERATOR, sent.conversationId, `r${i}`));
    }
    return { token, replies };
  }

  test("only operator messages count as unread", async () => {
    const { token } = await newVisitor();
    await send(token, "own", "my own message");
    expect((await me(token)).unread).toBe(0);
  });

  test("the count follows the read position", async () => {
    const { token, replies } = await withReplies(3);
    expect((await me(token)).unread).toBe(3);
    expect((await read(token, String(replies[1]?.seq))).status).toBe(200);
    const state = await me(token);
    expect(state.unread).toBe(1);
    expect(state.lastReadSeq).toBe(String(replies[1]?.seq));
  });

  test("the position never moves back", async () => {
    const { token, replies } = await withReplies(2);
    await read(token, String(replies[1]?.seq));
    await read(token, String(replies[0]?.seq));
    expect((await me(token)).unread).toBe(0);
  });

  test("a position past the feed cannot hide later messages", async () => {
    const { token } = await withReplies(1);
    const sent = (await (await send(token, "more", "more")).json()) as WireMessage;
    await read(token, "999999999999999999");
    await sendOperatorMessage(db, a.id, OPERATOR, sent.conversationId, "later");
    expect((await me(token)).unread).toBe(1);
  });

  test("a read reaches only the visitor who sent it", async () => {
    const first = await withReplies(1);
    const second = await withReplies(1);
    await read(first.token, String(first.replies[0]?.seq));
    expect((await me(first.token)).unread).toBe(0);
    expect((await me(second.token)).unread).toBe(1);
  });

  test("another visitor's messages do not count", async () => {
    await withReplies(2);
    const { token } = await newVisitor();
    expect((await me(token)).unread).toBe(0);
  });

  test("a bad position or token is refused", async () => {
    const { token } = await newVisitor();
    expect((await read(token, "abc")).status).toBe(400);
    expect((await read(token, "9223372036854775808")).status).toBe(400);
    expect((await read("dbt_wrong", "1")).status).toBe(401);
  });
});

describe("errors on another site", () => {
  async function post(body: string, token: string) {
    return app.request(`/v1/widget/${a.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
    });
  }

  test("an oversized email update is refused before it is parsed", async () => {
    const { token } = await newVisitor();
    const response = await app.request(`/v1/widget/${a.publicKey}/me`, {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "x".repeat(70_000) }),
    });
    expect(response.status).toBe(413);
  });

  test("an oversized body keeps the CORS header and the error shape", async () => {
    const { token } = await newVisitor();
    const response = await post(JSON.stringify({ clientId: "b", body: "x".repeat(70_000) }), token);
    expect(response.status).toBe(413);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const { error } = (await response.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("too_large");
    expect(error.message).not.toBe("");
  });

  test("malformed JSON keeps the CORS header and the error shape", async () => {
    const { token } = await newVisitor();
    const response = await post("{not json", token);
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
  });

  test("a browser may read Retry-After", async () => {
    const { token } = await newVisitor();
    const response = await post(JSON.stringify({ clientId: "h", body: "hi" }), token);
    expect(response.headers.get("access-control-expose-headers")).toContain("retry-after");
  });
});

describe("the logs", () => {
  test("a failed send logs the failure, but not the message text or client ID", async () => {
    const lines: string[] = [];
    const logged = createApp({
      db,
      logger: pino({ level: "info" }, { write: (line: string) => lines.push(line) }),
      checks: { postgres: async () => {}, valkey: async () => {} },
    });
    const { token } = await newVisitor();
    // A real database failure on the insert, with no change to the product code.
    await owner.execute(
      sql`alter table message add constraint test_refuse check (body <> 'private-chat-text')`,
    );
    try {
      const response = await logged.request(`/v1/widget/${a.publicKey}/messages`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ clientId: "private-client-id", body: "private-chat-text" }),
      });
      expect(response.status).toBe(500);
    } finally {
      await owner.execute(sql`alter table message drop constraint test_refuse`);
    }
    const output = lines.join("");
    expect(output).toContain('"code":"23514"');
    expect(output).toContain("test_refuse");
    expect(output).not.toContain("private-chat-text");
    expect(output).not.toContain("private-client-id");
  });
});

describe("the transaction", () => {
  test("a failure leaves no message, no event and no sequence change", async () => {
    const { visitorId } = await newVisitor(b.publicKey);
    const before = await count(b.id);
    await expect(
      withWorkspace(db, b.id, async (tx) => {
        await appendMessage(
          tx,
          b.id,
          { kind: "visitor", visitorId },
          { clientId: "lost", body: "hi" },
        );
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await count(b.id)).toEqual(before);
  });

  test("a delayed first commit loses nothing after a reconnect", async () => {
    const { token, visitorId } = await newVisitor();
    let releaseFirst = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstHasLock = () => {};
    const locked = new Promise<void>((resolve) => {
      firstHasLock = resolve;
    });
    // The first transaction takes its sequence, then waits before it commits.
    const first = withWorkspace(db, a.id, async (tx) => {
      const result = await appendMessage(
        tx,
        a.id,
        { kind: "visitor", visitorId },
        { clientId: "slow", body: "first" },
      );
      firstHasLock();
      await held;
      return result;
    });
    await locked;

    // The second send has to wait for the first commit.
    let secondDone = false;
    const second = send(token, "fast", "second").then((response) => {
      secondDone = true;
      return response;
    });
    const empty = await history(token);
    expect(empty.messages).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondDone).toBe(false);

    releaseFirst();
    await first;
    await second;

    // A client that stored the empty cursor gets both, in commit order, with nothing skipped.
    const page = await history(token, empty.cursor);
    expect(page.messages.map((m) => m.body)).toEqual(["first", "second"]);
  });

  test("another workspace can send while one workspace's row is held, and the held send gets a 503", async () => {
    const visitorA = await newVisitor();
    const visitorB = await newVisitor(b.publicKey);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = owner.transaction(async (tx) => {
      await tx.execute(sql`select id from workspace where id = ${a.id} for update`);
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const blocked = send(visitorA.token, "blocked", "waits");
    expect((await send(visitorB.token, "free", "passes", b.publicKey)).status).toBe(201);

    const response = await blocked;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    release();
    await holder;

    // The same client ID then succeeds, so the retry was safe.
    expect((await send(visitorA.token, "blocked", "waits")).status).toBe(201);
  }, 15_000);
});

describe("history", () => {
  test("a visitor reads only its own messages in the same workspace", async () => {
    const first = await newVisitor();
    const second = await newVisitor();
    await send(first.token, "m", "private to first");
    await send(second.token, "m", "private to second");
    const seen = (await history(second.token)).messages.map((m) => m.body);
    expect(seen).toEqual(["private to second"]);
  });

  test("only a visitor's own message carries its client ID, and every message has a position", async () => {
    const { token } = await newVisitor();
    const sent = (await (await send(token, "mine", "question")).json()) as WireMessage;
    await sendOperatorMessage(db, a.id, OPERATOR, sent.conversationId, "answer", "operator-id");
    const { messages } = await history(token);
    expect(messages.map((m) => m.clientId)).toEqual(["mine", null]);
    expect(BigInt(messages[1]?.seq ?? 0) > BigInt(messages[0]?.seq ?? 0)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain("operator-id");
  });

  test("an operator reply appears in the visitor's history", async () => {
    const { token } = await newVisitor();
    const sent = (await (await send(token, "q", "question")).json()) as WireMessage;
    await sendOperatorMessage(db, a.id, OPERATOR, sent.conversationId, "answer");
    const { messages } = await history(token);
    expect(messages.map((m) => [m.body, m.fromVisitor])).toEqual([
      ["question", true],
      ["answer", false],
    ]);
  });

  test("a reply cannot join a conversation in another workspace", async () => {
    const other = await newVisitor(b.publicKey);
    const sent = (await (
      await send(other.token, "q", "question", b.publicKey)
    ).json()) as WireMessage;
    await expect(
      sendOperatorMessage(db, a.id, OPERATOR, sent.conversationId, "cross"),
    ).rejects.toThrow();
  });

  test("pages return each message once and in order while new ones arrive", async () => {
    const { token } = await newVisitor();
    for (let i = 0; i < 5; i++) await send(token, `p${i}`, `m${i}`);
    const first = await history(token, undefined, 2);
    expect(first.messages.map((m) => m.body)).toEqual(["m0", "m1"]);
    expect(first.hasMore).toBe(true);
    await send(token, "p5", "m5");
    const second = await history(token, first.cursor, 10);
    expect(second.messages.map((m) => m.body)).toEqual(["m2", "m3", "m4", "m5"]);
    expect(second.hasMore).toBe(false);
    const empty = await history(token, second.cursor);
    expect(empty.messages).toEqual([]);
    expect(empty.cursor).toBe(second.cursor);
  });

  test("a cursor from another feed generation gets a resync", async () => {
    const { token } = await newVisitor();
    await send(token, "g", "m");
    const { cursor } = await history(token);
    const stale = `${Number(cursor.split(".")[0]) + 1}.${cursor.split(".")[1]}`;
    const page = await history(token, stale);
    expect(page.resync).toBe(true);
    expect(page.messages).toEqual([]);
    expect((await history(token, page.cursor)).messages).toHaveLength(1);
  });

  test.each([
    "abc",
    "1",
    "1.",
    ".1",
    "1.2.3",
    "-1.1",
    "1.9223372036854775808",
    "1.9999999999999999999",
    "9999999999.1",
  ])("the cursor %s is refused", async (bad) => {
    const { token } = await newVisitor();
    const response = await app.request(
      `/v1/widget/${a.publicKey}/messages?after=${encodeURIComponent(bad)}`,
      { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(400);
  });

  test("history with no valid token is refused", async () => {
    const response = await app.request(`/v1/widget/${a.publicKey}/messages`, {
      headers: { origin: ORIGIN, authorization: "Bearer dbt_wrong" },
    });
    expect(response.status).toBe(401);
  });
});
