import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator, signIn } from "../test/operators.ts";
import { readStream } from "../test/sse.ts";
import { visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import * as schema from "./db/schema.ts";
import { session } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import type { Live, OperatorNotice } from "./live.ts";
import { listConversations } from "./messages.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const WIDGET_ORIGIN = "https://app.example.com";
const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });

let database: TestDatabase;
let db: Database;
let owner: Database;
let app: App;
let a: NewWorkspace;
let b: NewWorkspace;
let cookie: string;
let otherCookie: string;
const wakes: [string, string][] = [];
const tells: [string, OperatorNotice][] = [];

const live: Live = {
  wake(workspaceId, subscriber) {
    wakes.push([workspaceId, subscriber]);
  },
  revoke() {},
  tell(workspaceId, notice) {
    tells.push([workspaceId, notice]);
  },
  tellVisitor() {},
  async subscribe() {
    return () => {};
  },
  stop() {},
};

async function operatorSession(email: string, workspaceId: string, name = "Op"): Promise<string> {
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  return (await signedInOperator({ app, auth, owner, email, name, workspaceId })).cookie;
}

const inA = (path: string) => `/v1/operator/workspaces/${a.id}${path}`;
const get = (path: string, as = cookie) => app.request(path, { headers: { cookie: as } });
const write = (method: string, path: string, body: unknown, as = cookie, origin = ORIGIN) =>
  app.request(path, {
    method,
    headers: { cookie: as, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  const ok = async () => {};
  app = createApp({
    db,
    live,
    logger,
    checks: { postgres: ok, valkey: ok },
    stream: { heartbeatMs: 25_000, lifetimeMs: 60_000 },
    auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL }),
  });
  a = await createWorkspace(db, "Acme", [WIDGET_ORIGIN]);
  b = await createWorkspace(db, "Beta", [WIDGET_ORIGIN]);
  cookie = await operatorSession("a@example.com", a.id);
  otherCookie = await operatorSession("b@example.com", b.id);
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("headers", () => {
  test("operator answers are never stored by a cache", async () => {
    for (const path of [inA(""), inA("/settings"), inA("/conversations"), "/v1/operator/me"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const session = await get("/v1/auth/get-session");
    expect(session.headers.get("cache-control")).toBe("no-store");
  });

  test("HSTS is sent only when the public URL is HTTPS", async () => {
    const at = (baseURL: string) =>
      createApp({
        db,
        logger,
        checks: { postgres: async () => {}, valkey: async () => {} },
        auth: createAuth({ db, secret: AUTH_SECRET, baseURL }),
      }).request("/healthz");
    const secure = await at("https://chat.example.com");
    expect(secure.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect((await at(PUBLIC_URL)).headers.get("strict-transport-security")).toBeNull();
  });
});

describe("membership", () => {
  test("a member reads its workspace", async () => {
    const response = await get(inA(""));
    expect(await response.json()).toEqual({
      id: a.id,
      name: "Acme",
      logoUrl: null,
      botsPaused: false,
      botsPausedBy: null,
      botsPausedAt: null,
    });
  });

  test.each(["", "/conversations", "/stream"])(
    "someone else's workspace answers %s like one that does not exist",
    async (path) => {
      const foreign = await get(inA(path), otherCookie);
      const missing = await get(
        `/v1/operator/workspaces/00000000-0000-4000-8000-000000000000${path}`,
        otherCookie,
      );
      expect(foreign.status).toBe(404);
      expect(await foreign.text()).toBe(await missing.text());
    },
  );

  test("a malformed workspace ID is a 404, not a server error", async () => {
    expect((await get("/v1/operator/workspaces/not-a-uuid")).status).toBe(404);
    expect((await get("/v1/operator/workspaces/not-a-uuid/conversations")).status).toBe(404);
  });

  test("a request with no session is refused", async () => {
    expect((await get(inA("/conversations"), "")).status).toBe(401);
  });

  test("a removed member loses access at the next request", async () => {
    const removed = await operatorSession("gone@example.com", a.id);
    expect((await get(inA(""), removed)).status).toBe(200);
    await owner.execute(
      sql`update workspace_member set removed_at = now()
          where operator_id = (select id from operator where email = 'gone@example.com')`,
    );
    expect((await get(inA(""), removed)).status).toBe(404);
  });

  test("a write from another site is refused", async () => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "hello");
    const response = await write(
      "PATCH",
      inA(`/conversations/${conversationId}`),
      { status: "closed" },
      cookie,
      "https://evil.example.com",
    );
    expect(response.status).toBe(403);
  });
});

describe("conversations", () => {
  test("a visitor's message appears with its context and last message", async () => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "The import stops");
    const response = await get(inA("/conversations"));
    const { conversations } = (await response.json()) as {
      conversations: { id: string; lastMessage: { body: string; fromVisitor: boolean } }[];
    };
    const found = conversations.find((row) => row.id === conversationId);
    expect(found?.lastMessage).toMatchObject({ body: "The import stops", fromVisitor: true });
  });

  test("a signed-in visitor's context reaches the operator", async () => {
    const token = await new SignJWT({
      email: "pat@example.com",
      name: "Pat Doe",
      attributes: { plan: "pro" },
    })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(a.publicKey)
      .setSubject("user-42")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(a.signingSecret));
    const sent = await app.request(`/v1/widget/${a.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: WIDGET_ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "ctx", body: "Signed in" }),
    });
    const { conversationId } = (await sent.json()) as { conversationId: string };
    const response = await get(inA(`/conversations/${conversationId}/messages`));
    const body = (await response.json()) as { conversation: { visitor: unknown } };
    expect(body.conversation.visitor).toMatchObject({
      email: "pat@example.com",
      externalId: "user-42",
      name: "Pat Doe",
      attributes: { plan: "pro" },
    });
  });

  test("the list shows no other workspace's conversations", async () => {
    await visitorStarts(app, b.publicKey, "Private to B");
    const text = await (await get(inA("/conversations"))).text();
    expect(text).not.toContain("Private to B");
  });

  test("another workspace's conversation is a 404", async () => {
    const { conversationId } = await visitorStarts(app, b.publicKey, "Private to B");
    expect((await get(inA(`/conversations/${conversationId}/messages`))).status).toBe(404);
    expect(
      (
        await write("POST", inA(`/conversations/${conversationId}/messages`), {
          clientId: "x",
          body: "cross",
        })
      ).status,
    ).toBe(404);
    expect(
      (await write("PATCH", inA(`/conversations/${conversationId}`), { status: "closed" })).status,
    ).toBe(404);
  });

  test("paging skips nothing when rows share a millisecond", async () => {
    const own = await createWorkspace(db, "Ties", [WIDGET_ORIGIN]);
    const ownCookie = await operatorSession("ties@example.com", own.id);
    for (let i = 0; i < 5; i++) await visitorStarts(app, own.publicKey, `t${i}`);
    await owner.execute(sql`
      update conversation set updated_at = '2026-01-01 00:00:00.123456+00'
      where workspace_id = ${own.id}
    `);
    const base = `/v1/operator/workspaces/${own.id}/conversations?limit=2`;
    const seen: string[] = [];
    let path = base;
    for (let more = true; more; ) {
      const page = (await (await get(path, ownCookie)).json()) as {
        conversations: { id: string; updatedAt: string }[];
        hasMore: boolean;
      };
      seen.push(...page.conversations.map((row) => row.id));
      const last = page.conversations.at(-1);
      path = `${base}&beforeUpdatedAt=${last?.updatedAt}&beforeId=${last?.id}`;
      more = page.hasMore;
    }
    expect(new Set(seen).size).toBe(5);
  });

  test("the list pages by newest activity", async () => {
    const own = await createWorkspace(db, "Paged", [WIDGET_ORIGIN]);
    const ownCookie = await operatorSession("paged@example.com", own.id);
    for (let i = 0; i < 3; i++) await visitorStarts(app, own.publicKey, `m${i}`);
    const base = `/v1/operator/workspaces/${own.id}/conversations`;
    const first = (await (await get(`${base}?limit=2`, ownCookie)).json()) as {
      conversations: { id: string; updatedAt: string; lastMessage: { body: string } }[];
      hasMore: boolean;
    };
    expect(first.conversations.map((row) => row.lastMessage.body)).toEqual(["m2", "m1"]);
    expect(first.hasMore).toBe(true);
    const last = first.conversations.at(-1);
    const second = (await (
      await get(
        `${base}?limit=2&beforeUpdatedAt=${last?.updatedAt}&beforeId=${last?.id}`,
        ownCookie,
      )
    ).json()) as { conversations: { lastMessage: { body: string } }[]; hasMore: boolean };
    expect(second.conversations.map((row) => row.lastMessage.body)).toEqual(["m0"]);
    expect(second.hasMore).toBe(false);
  });

  test("a later list page is one bounded index scan, with no sort, and one probe per last message", async () => {
    const own = await createWorkspace(db, "Planned", [WIDGET_ORIGIN]);
    for (let i = 0; i < 3; i++) await visitorStarts(app, own.publicKey, `p${i}`);
    const queries: { query: string; params: unknown[] }[] = [];
    const traced = drizzle(database.connect("app").pool, {
      schema,
      logger: { logQuery: (query, params) => queries.push({ query, params }) },
    });
    const page = await withWorkspace(traced, own.id, (tx) =>
      listConversations(tx, own.id, null, "open", { kind: "all" }, undefined, 2),
    );
    const last = page.conversations.at(-1);
    queries.length = 0;
    await withWorkspace(traced, own.id, (tx) =>
      listConversations(tx, own.id, null, "open", { kind: "all" }, last, 2),
    );
    const list = queries.filter((one) => one.query.includes('from "conversation"'));
    expect(list).toHaveLength(1);
    const client = await database.connect("migrator", 1).pool.connect();
    try {
      // The test tables are tiny, so make a scan of the whole table look as costly as it would be.
      await client.query("begin");
      // A handful of rows makes any plan cheap, and once autovacuum has counted them the planner
      // may pick a bitmap scan and a sort. These test that the index serves the page in order.
      await client.query("set local enable_seqscan = off");
      await client.query("set local enable_bitmapscan = off");
      await client.query("set local enable_sort = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `explain ${list[0]?.query}`,
        list[0]?.params,
      );
      const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index Scan Backward using conversation_list_idx/);
      expect(text).toMatch(/Index Cond: .*ROW\(updated_at, id\) </);
      expect(text).toMatch(/Index Scan Backward using message_conversation_idx/);
      // The handler's key: one probe of each table's conversation index.
      expect(text).toMatch(/Index Scan Backward using message_api_key_conversation_idx/);
      expect(text).toMatch(/Index Scan Backward using draft_reply_conversation_idx/);
      expect(text).not.toMatch(/Sort/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("the assignee filter", () => {
  type Page = {
    conversations: { id: string; updatedAt: string; assigneeOperatorId: string | null }[];
    hasMore: boolean;
  };

  /** A workspace of two operators, with conversations for each, and some for no one. */
  async function team() {
    const own = await createWorkspace(db, "Filtered", [WIDGET_ORIGIN]);
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const ann = await signedInOperator({ app, auth, owner, name: "Ann", workspaceId: own.id });
    const bo = await signedInOperator({ app, auth, owner, name: "Bo", workspaceId: own.id });
    const base = `/v1/operator/workspaces/${own.id}/conversations`;
    const start = async (body: string, assignee: string | null) => {
      const { conversationId } = await visitorStarts(app, own.publicKey, body);
      if (assignee !== null) {
        const assigned = await write(
          "PUT",
          `${base}/${conversationId}/assignee`,
          { operatorId: assignee },
          ann.cookie,
        );
        expect(assigned.status).toBe(200);
      }
      return conversationId;
    };
    const list = async (query: string, as = ann.cookie) => {
      const response = await get(`${base}?${query}`, as);
      expect(response.status).toBe(200);
      return (await response.json()) as Page;
    };
    return { own, ann, bo, base, start, list };
  }

  test("me lists the caller's, none lists no one's, and no filter lists all", async () => {
    const { ann, bo, start, list } = await team();
    const annOne = await start("for Ann", ann.id);
    const boOne = await start("for Bo", bo.id);
    const nobody = await start("for no one", null);
    const ids = (page: Page) => page.conversations.map((row) => row.id).sort();
    expect(ids(await list("assignee=me"))).toEqual([annOne]);
    expect(ids(await list("assignee=me", bo.cookie))).toEqual([boOne]);
    expect(ids(await list("assignee=none"))).toEqual([nobody]);
    expect(ids(await list(""))).toEqual([annOne, boOne, nobody].sort());
  });

  test("every list counts the open conversations of each filter, for the caller", async () => {
    const { ann, bo, start, list } = await team();
    await start("one for Ann", ann.id);
    await start("two for Ann", ann.id);
    await start("for Bo", bo.id);
    await start("for no one", null);
    const counts = (page: Page) => (page as Page & { openBy: unknown }).openBy;
    expect(counts(await list(""))).toEqual({ all: 4, mine: 2, unassigned: 1 });
    expect(counts(await list("status=closed", bo.cookie))).toEqual({
      all: 4,
      mine: 1,
      unassigned: 1,
    });
    expect(counts(await list("assignee=none"))).toEqual({ all: 4, mine: 2, unassigned: 1 });
  });

  test("the filter applies to closed conversations too", async () => {
    const { ann, base, start, list } = await team();
    const closed = await start("closed for Ann", ann.id);
    await start("open for Ann", ann.id);
    await write("PATCH", `${base}/${closed}`, { status: "closed" }, ann.cookie);
    const page = await list("status=closed&assignee=me");
    expect(page.conversations.map((row) => row.id)).toEqual([closed]);
    expect((await list("status=closed&assignee=none")).conversations).toEqual([]);
  });

  test("paging with a filter skips nothing and never shows another operator's", async () => {
    const { ann, bo, start, list } = await team();
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) {
      mine.push(await start(`mine ${i}`, ann.id));
      await start(`theirs ${i}`, bo.id);
      await start(`no one's ${i}`, null);
    }
    const seen: Page["conversations"] = [];
    let query = "assignee=me&limit=2";
    for (let more = true; more; ) {
      const page = await list(query);
      seen.push(...page.conversations);
      const last = page.conversations.at(-1);
      query = `assignee=me&limit=2&beforeUpdatedAt=${last?.updatedAt}&beforeId=${last?.id}`;
      more = page.hasMore;
    }
    expect(seen.map((row) => row.id).sort()).toEqual(mine.sort());
    expect(seen.every((row) => row.assigneeOperatorId === ann.id)).toBe(true);
  });

  test("a value it does not know is refused", async () => {
    const { base, ann } = await team();
    expect((await get(`${base}?assignee=everyone`, ann.cookie)).status).toBe(400);
  });

  test("a page of one operator's is one bounded scan of the assignee index, with no sort", async () => {
    const { own, ann, start } = await team();
    for (let i = 0; i < 3; i++) await start(`p${i}`, ann.id);
    const queries: { query: string; params: unknown[] }[] = [];
    const traced = drizzle(database.connect("app").pool, {
      schema,
      logger: { logQuery: (query, params) => queries.push({ query, params }) },
    });
    const mine = { kind: "operator", operatorId: ann.id } as const;
    const page = await withWorkspace(traced, own.id, (tx) =>
      listConversations(tx, own.id, null, "open", mine, undefined, 2),
    );
    queries.length = 0;
    await withWorkspace(traced, own.id, (tx) =>
      listConversations(tx, own.id, null, "open", mine, page.conversations.at(-1), 2),
    );
    const list = queries.filter((one) => one.query.includes('from "conversation"'));
    const client = await database.connect("migrator", 1).pool.connect();
    try {
      await client.query("begin");
      // A handful of rows makes any plan cheap, and once autovacuum has counted them the planner
      // may pick a bitmap scan and a sort. These test that the index serves the page in order.
      await client.query("set local enable_seqscan = off");
      await client.query("set local enable_bitmapscan = off");
      await client.query("set local enable_sort = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `explain ${list[0]?.query}`,
        list[0]?.params,
      );
      const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index Scan Backward using conversation_assignee_list_idx/);
      expect(text).toMatch(/Index Cond: .*ROW\(updated_at, id\) </);
      expect(text).not.toMatch(/Sort/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("replies", () => {
  test("a reply reaches the visitor's history and wakes both streams", async () => {
    const { token, conversationId } = await visitorStarts(app, a.publicKey, "Question");
    wakes.length = 0;
    const response = await write("POST", inA(`/conversations/${conversationId}/messages`), {
      clientId: "reply-1",
      body: "Answer",
    });
    expect(response.status).toBe(201);
    const history = await app.request(`/v1/widget/${a.publicKey}/messages`, {
      headers: { origin: WIDGET_ORIGIN, authorization: `Bearer ${token}` },
    });
    const { messages } = (await history.json()) as {
      messages: { body: string; fromVisitor: boolean; clientId: string | null }[];
    };
    expect(messages.at(-1)).toMatchObject({ body: "Answer", fromVisitor: false, clientId: null });
    expect(wakes.map(([, subscriber]) => subscriber)).toContain("operators");
    expect(wakes).toHaveLength(2);
  });

  test("a retry returns the original and creates nothing", async () => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "Question");
    const path = inA(`/conversations/${conversationId}/messages`);
    const body = { clientId: "retry", body: "Once" };
    const first = (await (await write("POST", path, body)).json()) as { id: string };
    const second = await write("POST", path, body);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe(first.id);
  });

  test("a retry after a close still returns the original", async () => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "Question");
    const path = inA(`/conversations/${conversationId}`);
    const body = { clientId: "before-close", body: "Sent before the close" };
    const first = (await (await write("POST", `${path}/messages`, body)).json()) as { id: string };
    await write("PATCH", path, { status: "closed" });
    const retry = await write("POST", `${path}/messages`, body);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { id: string }).id).toBe(first.id);
  });

  test.each([
    ["an empty body", { clientId: "a", body: " " }],
    ["a NUL byte", { clientId: "a", body: "a\0b" }],
    ["a bad client ID", { clientId: "a b", body: "hello" }],
  ])("%s is refused", async (_name, payload) => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "Question");
    const response = await write("POST", inA(`/conversations/${conversationId}/messages`), payload);
    expect(response.status).toBe(400);
  });

  test("the first operator reply assigns an unassigned conversation, with its event", async () => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "Who answers?");
    const path = inA(`/conversations/${conversationId}`);
    const assignee = async () =>
      (
        (await (await get(`${path}/messages`)).json()) as {
          conversation: { assigneeOperatorId: string | null };
        }
      ).conversation.assigneeOperatorId;
    const events = () =>
      owner.execute<{ count: number }>(
        sql`select count(*)::int as count from event
            where workspace_id = ${a.id} and kind = 'conversation.assigned'
              and payload->>'conversationId' = ${conversationId}`,
      );
    expect(await assignee()).toBeNull();
    await write("POST", `${path}/messages`, { clientId: "first-reply", body: "Me" });
    const [replier] = await owner
      .select({ id: schema.operator.id })
      .from(schema.operator)
      .where(eq(schema.operator.email, "a@example.com"));
    expect(await assignee()).toBe(replier?.id);
    expect((await events()).rows[0]?.count).toBe(1);
    // An unassign later is kept: only the first reply assigns.
    await write("PUT", `${path}/assignee`, { operatorId: null });
    await write("POST", `${path}/messages`, { clientId: "second-reply", body: "Again" });
    expect(await assignee()).toBeNull();
  });

  test("a reply keeps the assignee the conversation already has", async () => {
    const own = await createWorkspace(db, "Kept", [WIDGET_ORIGIN]);
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const ann = await signedInOperator({ app, auth, owner, name: "Ann", workspaceId: own.id });
    const bo = await signedInOperator({ app, auth, owner, name: "Bo", workspaceId: own.id });
    const { conversationId } = await visitorStarts(app, own.publicKey, "Hello");
    const path = `/v1/operator/workspaces/${own.id}/conversations/${conversationId}`;
    await write("PUT", `${path}/assignee`, { operatorId: ann.id }, ann.cookie);
    expect(
      (await write("POST", `${path}/messages`, { clientId: "bo", body: "Hi" }, bo.cookie)).status,
    ).toBe(201);
    const read = (await (await get(`${path}/messages`, bo.cookie)).json()) as {
      conversation: { assigneeOperatorId: string | null };
    };
    expect(read.conversation.assigneeOperatorId).toBe(ann.id);
  });

  test("a closed conversation refuses a reply, until it reopens", async () => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "Question");
    const path = inA(`/conversations/${conversationId}`);
    expect((await write("PATCH", path, { status: "closed" })).status).toBe(200);
    const refused = await write("POST", `${path}/messages`, { clientId: "late", body: "Late" });
    expect(refused.status).toBe(409);
    await write("PATCH", path, { status: "open" });
    expect(
      (await write("POST", `${path}/messages`, { clientId: "late", body: "Now" })).status,
    ).toBe(201);
  });
});

describe("a read-only workspace's welcome chat", () => {
  test("an operator replies there in text and nowhere else, and suspension still stops it", async () => {
    const space = await createWorkspace(db, "Lapsed", [WIDGET_ORIGIN]);
    const as = await operatorSession("lapsed@example.com", space.id);
    const inSpace = (path: string) => `/v1/operator/workspaces/${space.id}${path}`;
    const made = await write("POST", inSpace("/api-keys"), { name: "Bot" }, as);
    const { token } = (await made.json()) as { token: string };
    const welcome = (await visitorStarts(app, space.publicKey, "Hi")).conversationId;
    const other = (await visitorStarts(app, space.publicKey, "Hello")).conversationId;
    await owner
      .update(schema.conversation)
      .set({ welcome: true })
      .where(eq(schema.conversation.id, welcome));
    await owner
      .insert(schema.subscription)
      .values({ workspaceId: space.id, stripeCustomerId: "cus_test", readOnlyAt: new Date() });
    const replyIn = (chat: string, by = as) =>
      write("POST", inSpace(`/conversations/${chat}/messages`), { clientId: "r1", body: "Hi" }, by);

    expect((await replyIn(welcome)).status).toBe(201);
    const refused = await replyIn(other);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: { code: "read_only" } });
    const byKey = await app.request(inSpace(`/conversations/${welcome}/messages`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "k1", body: "Hi" }),
    });
    expect(byKey.status).toBe(402);
    // Closing is another write, which read-only still refuses in the welcome chat.
    expect(
      (await write("PATCH", inSpace(`/conversations/${welcome}`), { status: "closed" }, as)).status,
    ).toBe(402);

    await owner
      .update(schema.workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.workspace.id, space.id));
    const suspended = await write(
      "POST",
      inSpace(`/conversations/${welcome}/messages`),
      { clientId: "r2", body: "Again" },
      as,
    );
    expect(suspended.status).toBe(403);
  });
});

describe("status", () => {
  test("closing moves a conversation between the lists, and adds one event", async () => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "Question");
    const path = inA(`/conversations/${conversationId}`);
    await write("PATCH", path, { status: "closed" });
    await write("PATCH", path, { status: "closed" });
    const list = async (status: string) => {
      const response = await get(inA(`/conversations?status=${status}&limit=100`));
      const body = (await response.json()) as { conversations: { id: string }[] };
      return body.conversations.map((row) => row.id);
    };
    expect(await list("closed")).toContain(conversationId);
    expect(await list("open")).not.toContain(conversationId);
    const { rows } = await owner.execute<{ count: string }>(sql`
      select count(*) from event
      where kind = 'conversation.closed' and payload->>'conversationId' = ${conversationId}
    `);
    expect(rows[0]?.count).toBe("1");
  });
});

describe("the stream", () => {
  async function read(path: string, as: string, until: string) {
    const response = await get(path, as);
    expect(response.status).toBe(200);
    return readStream(response, until);
  }

  test("with no cursor it starts at the present", async () => {
    await visitorStarts(app, a.publicKey, "Before connecting");
    const text = await read(inA("/stream"), cookie, "event: ready");
    expect(text).not.toContain("event: change");
    expect(text).toMatch(/"cursor":"\d+\.\d+"/);
  });

  test("from a cursor, an operator catches up on messages and closes", async () => {
    const before = await read(inA("/stream"), cookie, "event: ready");
    const cursor = /"cursor":"(\d+\.\d+)"/.exec(before)?.[1];
    const { conversationId } = await visitorStarts(app, a.publicKey, "While away");
    await write("PATCH", inA(`/conversations/${conversationId}`), { status: "closed" });
    const text = await read(inA(`/stream?after=${cursor}`), cookie, "event: ready");
    expect(text).toContain('"kind":"message.created"');
    expect(text).toContain(conversationId);
    // An event names what changed, and holds no chat text.
    expect(text).not.toContain("While away");
    expect(text).toContain('"kind":"conversation.closed"');
  });

  test("it shows no other workspace's changes", async () => {
    const before = await read(inA("/stream"), cookie, "event: ready");
    const cursor = /"cursor":"(\d+\.\d+)"/.exec(before)?.[1];
    await visitorStarts(app, b.publicKey, "Private to B");
    const text = await read(inA(`/stream?after=${cursor}`), cookie, "event: ready");
    expect(text).not.toContain("Private to B");
  });

  test("a stream's session check leaves renewal to requests that can set the cookie", async () => {
    const renewing = await operatorSession("no-refresh@example.com", a.id);
    let wake = () => {};
    const waking: Live = {
      ...live,
      async subscribe(_workspaceId, _subscriber, session) {
        wake = () => session.wake();
        return () => {};
      },
    };
    const instance = createApp({
      db,
      live: waking,
      logger,
      checks: { postgres: async () => {}, valkey: async () => {} },
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL }),
    });
    const response = await instance.request(inA("/stream"), { headers: { cookie: renewing } });
    const reader = response.body?.getReader();
    // Wait for the stream to finish opening, so the opening request's renewal is behind it.
    const decoder = new TextDecoder();
    for (let text = ""; reader !== undefined && !text.includes("event: ready"); ) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    // A renewal is now due, and the next wake's check must not use it up.
    const aged = sql`user_id = (select id from operator where email = 'no-refresh@example.com')`;
    await owner.execute(sql`
      update session set updated_at = now() - interval '2 days',
        expires_at = now() + interval '5 days'
      where ${aged}
    `);
    wake();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { rows } = await owner.execute<{ renewed: boolean }>(
      sql`select expires_at > now() + interval '6 days' as renewed from session where ${aged}`,
    );
    expect(rows[0]?.renewed).toBe(false);
    await reader?.cancel();
  });

  test("each wake of an operator stream takes one connection, for the check and the read", async () => {
    const { pool } = database.connect("app", 5);
    const counted = drizzle(pool, { schema });
    let checkouts = 0;
    pool.on("acquire", () => {
      checkouts += 1;
    });
    let wake = () => {};
    const instance = createApp({
      db: counted,
      live: {
        ...live,
        async subscribe(_workspaceId, _subscriber, session) {
          wake = () => session.wake();
          return () => {};
        },
      },
      logger,
      checks: { postgres: async () => {}, valkey: async () => {} },
      auth: createAuth({ db: counted, secret: AUTH_SECRET, baseURL: PUBLIC_URL }),
    });
    const response = await instance.request(inA("/stream"), { headers: { cookie } });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string, from = 0) => {
      while (reader !== undefined && !text.slice(from).includes(needle)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until("event: ready");
    const before = text.length;
    await visitorStarts(app, a.publicKey, "Counted");
    checkouts = 0;
    wake();
    await until("event: change", before);
    expect(checkouts).toBe(1);
    await reader?.cancel();
  });

  test("a revoked session closes the stream at the next wake", async () => {
    const revoked = await operatorSession("revoked@example.com", a.id);
    let wake = () => {};
    const waking: Live = {
      ...live,
      async subscribe(_workspaceId, _subscriber, session) {
        wake = () => session.wake();
        return () => {};
      },
    };
    const instance = createApp({
      db,
      live: waking,
      logger,
      checks: { postgres: async () => {}, valkey: async () => {} },
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL }),
    });
    const response = await instance.request(inA("/stream"), { headers: { cookie: revoked } });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (reader !== undefined && !text.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until("event: ready");
    await withWorkspace(db, a.id, async () => {});
    await owner.delete(session);
    wake();
    await until("event: close");
    expect(text).toContain('"reason":"unauthorized"');
    // Other tests' sessions are gone too, so sign in again.
    cookie = await signInAgain("a@example.com");
    otherCookie = await signInAgain("b@example.com");
  });

  async function signInAgain(email: string): Promise<string> {
    return signIn(app, createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL }), email);
  }
});

describe("user context from older tokens", () => {
  const sign = (attributes: Record<string, unknown>, issuedAt: number) =>
    new SignJWT({ attributes })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(a.publicKey)
      .setSubject("two-tokens")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(new TextEncoder().encode(a.signingSecret));

  test("a token with a fractional issue time works", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(a.publicKey)
      .setSubject("fractional")
      .setIssuedAt(Date.now() / 1000)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode(a.signingSecret));
    const response = await app.request(`/v1/widget/${a.publicKey}/me`, {
      headers: { origin: WIDGET_ORIGIN, authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  test("a request with an older token cannot overwrite newer context", async () => {
    const now = Math.floor(Date.now() / 1000);
    const me = async (token: string) =>
      app.request(`/v1/widget/${a.publicKey}/me`, {
        headers: { origin: WIDGET_ORIGIN, authorization: `Bearer ${token}` },
      });
    await me(await sign({ plan: "pro" }, now));
    await me(await sign({ plan: "free" }, now - 60));
    const { rows } = await owner.execute<{ attributes: unknown }>(
      sql`select attributes from visitor where external_id = 'two-tokens'`,
    );
    expect(rows[0]?.attributes).toEqual({ plan: "pro" });
    await me(await sign({ plan: "team" }, now + 1));
    const after = await owner.execute<{ attributes: unknown }>(
      sql`select attributes from visitor where external_id = 'two-tokens'`,
    );
    expect(after.rows[0]?.attributes).toEqual({ plan: "team" });
  });
});

interface ThreadPage {
  conversation: { startedPage: string | null };
  messages: {
    body: string;
    fromVisitor: boolean;
    authorOperatorId: string | null;
    authorName: string | null;
  }[];
}

describe("who sent a reply", () => {
  test("each operator reply names its sender, and a visitor's message names no one", async () => {
    const team = await createWorkspace(db, "Team", [WIDGET_ORIGIN]);
    const ana = await operatorSession("ana@example.com", team.id, "Ana");
    const ben = await operatorSession("ben@example.com", team.id, "Ben");
    const { conversationId } = await visitorStarts(app, team.publicKey, "Hello");
    const path = `/v1/operator/workspaces/${team.id}/conversations/${conversationId}/messages`;
    const sent = await write("POST", path, { clientId: "ana-1", body: "Hi from Ana" }, ana);
    expect(await sent.json()).toMatchObject({ authorName: "Ana", fromVisitor: false });
    await write("POST", path, { clientId: "ben-1", body: "Hi from Ben" }, ben);

    const page = (await (await get(path, ana)).json()) as ThreadPage;
    expect(
      page.messages.map(({ body, authorName, fromVisitor }) => ({ body, authorName, fromVisitor })),
    ).toEqual([
      { body: "Hello", authorName: null, fromVisitor: true },
      { body: "Hi from Ana", authorName: "Ana", fromVisitor: false },
      { body: "Hi from Ben", authorName: "Ben", fromVisitor: false },
    ]);
    const [, fromAna, fromBen] = page.messages;
    expect(fromAna?.authorOperatorId).not.toBeNull();
    expect(fromAna?.authorOperatorId).not.toBe(fromBen?.authorOperatorId);
  });

  test("a retry of a reply still names its sender", async () => {
    const team = await createWorkspace(db, "Retry team", [WIDGET_ORIGIN]);
    const cleo = await operatorSession("cleo@example.com", team.id, "Cleo");
    const { conversationId } = await visitorStarts(app, team.publicKey, "Hello");
    const path = `/v1/operator/workspaces/${team.id}/conversations/${conversationId}/messages`;
    await write("POST", path, { clientId: "same", body: "Once" }, cleo);
    const retry = await write("POST", path, { clientId: "same", body: "Once" }, cleo);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ authorName: "Cleo" });
  });

  test("the visitor learns only the replying operator's first name, never an email or an ID", async () => {
    const team = await createWorkspace(db, "Named team", [WIDGET_ORIGIN]);
    const dana = await operatorSession("dana@example.com", team.id, "Dana Lee");
    const { token, conversationId } = await visitorStarts(app, team.publicKey, "Who is there?");
    const path = `/v1/operator/workspaces/${team.id}/conversations/${conversationId}/messages`;
    await write("POST", path, { clientId: "private-sender", body: "Someone" }, dana);
    const history = await app.request(`/v1/widget/${team.publicKey}/messages`, {
      headers: { origin: WIDGET_ORIGIN, authorization: `Bearer ${token}` },
    });
    const { messages } = (await history.json()) as { messages: Record<string, unknown>[] };
    const reply = messages.find((message) => message.body === "Someone");
    expect(reply).toMatchObject({ fromBot: false, authorName: "Dana", authorPictureUrl: null });
    expect(reply).not.toHaveProperty("authorOperatorId");
    expect(JSON.stringify(reply)).not.toContain("@");
  });
});

describe("where a conversation started", () => {
  test("the page is kept as origin and path, with no query string or hash", async () => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "From pricing", {
      page: `${WIDGET_ORIGIN}/pricing/team?coupon=SECRET&email=a@b.c#plans`,
    });
    const page = (await (
      await get(inA(`/conversations/${conversationId}/messages`))
    ).json()) as ThreadPage;
    expect(page.conversation.startedPage).toBe(`${WIDGET_ORIGIN}/pricing/team`);
    const list = (await (await get(inA("/conversations"))).json()) as {
      conversations: { id: string; startedPage: string | null }[];
    };
    expect(list.conversations.find((row) => row.id === conversationId)?.startedPage).toBe(
      `${WIDGET_ORIGIN}/pricing/team`,
    );
  });

  test("a page on another site, or no page, is not kept", async () => {
    for (const page of ["https://evil.example/phish", "not a url", undefined]) {
      const { conversationId } = await visitorStarts(app, a.publicKey, "Hi", { page });
      const thread = (await (
        await get(inA(`/conversations/${conversationId}/messages`))
      ).json()) as ThreadPage;
      expect(thread.conversation.startedPage).toBeNull();
    }
  });

  test("a later message from another page does not change it", async () => {
    const { token, conversationId } = await visitorStarts(app, a.publicKey, "First", {
      page: `${WIDGET_ORIGIN}/start`,
    });
    await app.request(`/v1/widget/${a.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: WIDGET_ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "c2", body: "Second", page: `${WIDGET_ORIGIN}/later` }),
    });
    const thread = (await (
      await get(inA(`/conversations/${conversationId}/messages`))
    ).json()) as ThreadPage;
    expect(thread.conversation.startedPage).toBe(`${WIDGET_ORIGIN}/start`);
  });
});

describe("waiting for a reply", () => {
  test("the list counts open conversations whose newest message is the visitor's", async () => {
    const team = await createWorkspace(db, "Waiting", [WIDGET_ORIGIN]);
    const dee = await operatorSession("dee@example.com", team.id, "Dee");
    const base = `/v1/operator/workspaces/${team.id}`;
    const waiting = async (status = "open") =>
      (
        (await (await get(`${base}/conversations?status=${status}`, dee)).json()) as {
          waiting: number;
        }
      ).waiting;
    expect(await waiting()).toBe(0);

    const first = await visitorStarts(app, team.publicKey, "One");
    const second = await visitorStarts(app, team.publicKey, "Two");
    await visitorStarts(app, team.publicKey, "Three");
    expect(await waiting()).toBe(3);

    await write(
      "POST",
      `${base}/conversations/${first.conversationId}/messages`,
      { clientId: "r1", body: "Answered" },
      dee,
    );
    expect(await waiting()).toBe(2);

    await write(
      "PATCH",
      `${base}/conversations/${second.conversationId}`,
      { status: "closed" },
      dee,
    );
    expect(await waiting()).toBe(1);
    // The same workspace-wide number on the closed tab, so the count does not jump.
    expect(await waiting("closed")).toBe(1);

    // The visitor writes again after the reply, so it waits again.
    const again = await app.request(`/v1/widget/${team.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: WIDGET_ORIGIN,
        authorization: `Bearer ${first.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "again", body: "Thanks, one more thing" }),
    });
    expect(await waiting()).toBe(2);

    // A deleted message no longer counts, so the reply before it is the newest again.
    const { id } = (await again.json()) as { id: string };
    const removed = await app.request(
      `${base}/conversations/${first.conversationId}/messages/${id}`,
      { method: "DELETE", headers: { cookie: dee, origin: ORIGIN } },
    );
    expect(removed.status).toBe(200);
    expect(await waiting()).toBe(1);
  });

  test("another workspace's conversations are not counted", async () => {
    const team = await createWorkspace(db, "Quiet", [WIDGET_ORIGIN]);
    const eve = await operatorSession("eve@example.com", team.id, "Eve");
    await visitorStarts(app, a.publicKey, "Not yours");
    const response = await get(`/v1/operator/workspaces/${team.id}/conversations`, eve);
    expect(((await response.json()) as { waiting: number }).waiting).toBe(0);
  });
});

describe("reply receipts", () => {
  type Read = {
    messages: { id: string; seq: string; fromVisitor: boolean }[];
    receipts: { readSeq: string; emails: { fromSeq: string; toSeq: string; sent: boolean }[] };
  };
  const readThread = async (conversationId: string) =>
    (await (await get(inA(`/conversations/${conversationId}/messages`))).json()) as Read;

  test("a visitor's read moves the receipt and tells the operators, once", async () => {
    const { token, conversationId } = await visitorStarts(app, a.publicKey, "Hi");
    const sent = await write("POST", inA(`/conversations/${conversationId}/messages`), {
      clientId: "receipt-1",
      body: "Hello",
    });
    const reply = (await sent.json()) as { seq: string };
    expect((await readThread(conversationId)).receipts).toEqual({
      readSeq: expect.any(String),
      emails: [],
    });
    expect(BigInt((await readThread(conversationId)).receipts.readSeq)).toBeLessThan(
      BigInt(reply.seq),
    );
    tells.length = 0;
    const markRead = () =>
      app.request(`/v1/widget/${a.publicKey}/read`, {
        method: "POST",
        headers: {
          origin: WIDGET_ORIGIN,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ seq: reply.seq }),
      });
    expect((await markRead()).status).toBe(200);
    expect((await readThread(conversationId)).receipts.readSeq).toBe(reply.seq);
    expect(tells).toEqual([[a.id, { kind: "receipts", visitorId: expect.any(String) }]]);
    // The same position again moves nothing, so it tells nobody.
    expect((await markRead()).status).toBe(200);
    expect(tells).toHaveLength(1);
  });

  test("a visitor reading only their own messages tells no thread to load again", async () => {
    const { token } = await visitorStarts(app, a.publicKey, "Only mine");
    tells.length = 0;
    const response = await app.request(`/v1/widget/${a.publicKey}/read`, {
      method: "POST",
      headers: {
        origin: WIDGET_ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      // Past everything there is: the read stops at the newest position, the visitor's own message.
      body: JSON.stringify({ seq: "1000000" }),
    });
    expect(response.status).toBe(200);
    expect(tells).toEqual([]);
  });

  test("receipts show the replies each sent or failed email carried", async () => {
    const { conversationId } = await visitorStarts(app, a.publicKey, "Email me");
    const reply = async (clientId: string) =>
      (await (
        await write("POST", inA(`/conversations/${conversationId}/messages`), {
          clientId,
          body: clientId,
        })
      ).json()) as { id: string; seq: string };
    const first = await reply("email-first");
    const [row] = (
      await owner.execute<{ visitor_id: string }>(
        sql`select visitor_id from conversation where id = ${conversationId}`,
      )
    ).rows;
    const delivery = (
      line: { id: string; seq: string },
      outcome: "sent" | "failed" | null,
      seq: number,
    ) =>
      owner.execute(sql`
        insert into alert_delivery
          (workspace_id, event_seq, conversation_id, message_id, visitor_id, channel,
           finished_at, outcome, covered_from_seq, covered_to_seq)
        values (${a.id}, ${seq}, ${conversationId}, ${line.id}, ${row?.visitor_id}, 'email',
                ${outcome === null ? null : new Date().toISOString()}::timestamptz, ${outcome},
                ${line.seq}, ${line.seq})`);
    await delivery(first, "sent", 900_001);
    const second = await reply("email-second");
    // A row still waiting, or one that was never planned, carried nothing yet.
    await delivery(second, null, 900_002);
    expect((await readThread(conversationId)).receipts.emails).toEqual([
      { fromSeq: first.seq, toSeq: first.seq, sent: true },
    ]);
    await delivery(second, "failed", 900_003);
    expect((await readThread(conversationId)).receipts.emails).toEqual([
      { fromSeq: first.seq, toSeq: first.seq, sent: true },
      { fromSeq: second.seq, toSeq: second.seq, sent: false },
    ]);
  });
});

describe("the typing preview", () => {
  const typing = (key: string, token: string, draft: string) =>
    app.request(`/v1/widget/${key}/typing`, {
      method: "POST",
      headers: {
        origin: WIDGET_ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ draft }),
    });
  const setPreview = (enabled: boolean, as = cookie) =>
    write("PUT", inA("/widget/typing-preview"), { enabled }, as);

  test("a visitor's draft reaches the operators, and stores nothing", async () => {
    const { token, conversationId } = await visitorStarts(app, a.publicKey, "First");
    const before = await owner.execute<{ count: number }>(
      sql`select count(*)::int as count from message where workspace_id = ${a.id}`,
    );
    tells.length = 0;
    expect((await typing(a.publicKey, token, "Second, half writ")).status).toBe(200);
    expect(tells).toEqual([
      [
        a.id,
        {
          kind: "typing",
          conversationId,
          visitorId: expect.any(String),
          draft: "Second, half writ",
        },
      ],
    ]);
    expect((await typing(a.publicKey, token, "")).status).toBe(200);
    expect(tells.at(-1)?.[1]).toMatchObject({ kind: "typing", draft: "" });
    const after = await owner.execute<{ count: number }>(
      sql`select count(*)::int as count from message where workspace_id = ${a.id}`,
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  test("the workspace setting turns it off, and the widget reads the setting", async () => {
    const { token } = await visitorStarts(app, a.publicKey, "Hello");
    expect((await setPreview(false)).status).toBe(200);
    const look = await app.request(`/v1/widget/${a.publicKey}/appearance`);
    expect(await look.json()).toMatchObject({ typingPreview: false });
    tells.length = 0;
    expect((await typing(a.publicKey, token, "secret")).status).toBe(200);
    expect(tells).toEqual([]);
    expect((await setPreview(true)).status).toBe(200);
    expect((await typing(a.publicKey, token, "now")).status).toBe(200);
    expect(tells).toHaveLength(1);
  });

  test("only an owner or an admin changes the setting", async () => {
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const member = await signedInOperator({ app, auth, owner, workspaceId: a.id, role: "member" });
    expect((await setPreview(false, member.cookie)).status).toBe(403);
  });

  test("a visitor with no open conversation, a long draft and no token send nothing", async () => {
    const created = await app.request(`/v1/widget/${a.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: WIDGET_ORIGIN },
    });
    const { token } = (await created.json()) as { token: string };
    tells.length = 0;
    expect((await typing(a.publicKey, token, "hi")).status).toBe(200);
    expect(tells).toEqual([]);
    expect((await typing(a.publicKey, token, "x".repeat(2001))).status).toBe(400);
    expect((await typing(a.publicKey, "vt_nothing", "hi")).status).toBe(401);
  });
});

describe("waiting counts across workspaces", () => {
  test("each of the operator's workspaces has its count, and no other workspace shows", async () => {
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const first = await createWorkspace(db, "First", [WIDGET_ORIGIN]);
    const second = await createWorkspace(db, "Second", [WIDGET_ORIGIN]);
    const stranger = await createWorkspace(db, "Stranger", [WIDGET_ORIGIN]);
    const kim = await signedInOperator({ app, auth, owner, name: "Kim", workspaceId: first.id });
    await owner
      .insert(schema.workspaceMember)
      .values({ workspaceId: second.id, operatorId: kim.id, role: "member" });
    await visitorStarts(app, first.publicKey, "one");
    await visitorStarts(app, first.publicKey, "two");
    await visitorStarts(app, stranger.publicKey, "not Kim's");
    const response = await get("/v1/operator/waiting", kim.cookie);
    expect(response.status).toBe(200);
    const { workspaces } = (await response.json()) as {
      workspaces: { workspaceId: string; waiting: number }[];
    };
    expect(workspaces.sort((x, y) => y.waiting - x.waiting)).toEqual([
      { workspaceId: first.id, waiting: 2 },
      { workspaceId: second.id, waiting: 0 },
    ]);
  });

  test("it needs a session", async () => {
    expect((await app.request("/v1/operator/waiting")).status).toBe(401);
  });
});

describe("unread conversations", () => {
  type Listed = { conversations: { id: string; unread: boolean }[] };

  /** A workspace of two operators, Ann and Bo, and helpers that read as either. */
  async function team() {
    const own = await createWorkspace(db, "Unread", [WIDGET_ORIGIN]);
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const ann = await signedInOperator({ app, auth, owner, name: "Ann", workspaceId: own.id });
    const bo = await signedInOperator({ app, auth, owner, name: "Bo", workspaceId: own.id });
    const base = `/v1/operator/workspaces/${own.id}/conversations`;
    const unread = async (conversationId: string, as: string) => {
      const listed = (await (await get(base, as)).json()) as Listed;
      return listed.conversations.find((row) => row.id === conversationId)?.unread;
    };
    const markRead = (conversationId: string, seq: string, as: string) =>
      write("POST", `${base}/${conversationId}/read`, { seq }, as);
    const newestSeq = async (conversationId: string) => {
      const read = await get(`${base}/${conversationId}/messages`, ann.cookie);
      const { messages } = (await read.json()) as { messages: { seq: string }[] };
      return messages.at(-1)?.seq ?? "0";
    };
    return { own, ann, bo, base, unread, markRead, newestSeq };
  }

  const visitorWritesAgain = (key: string, token: string, clientId: string) =>
    app.request(`/v1/widget/${key}/messages`, {
      method: "POST",
      headers: {
        origin: WIDGET_ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId, body: "One more thing" }),
    });

  test("each operator reads on their own, and a later visitor message is unread again", async () => {
    const { own, ann, bo, base, unread, markRead, newestSeq } = await team();
    const { token, conversationId } = await visitorStarts(app, own.publicKey, "Hello");
    expect(await unread(conversationId, ann.cookie)).toBe(true);
    expect(await unread(conversationId, bo.cookie)).toBe(true);

    const marked = await markRead(conversationId, await newestSeq(conversationId), ann.cookie);
    expect(marked.status).toBe(200);
    expect(await marked.json()).toEqual({ ok: true });
    expect(await unread(conversationId, ann.cookie)).toBe(false);
    expect(await unread(conversationId, bo.cookie)).toBe(true);
    // Search and a single read say the same.
    const found = (await (await get(`${base}/search?q=Hello`, ann.cookie)).json()) as Listed;
    expect(found.conversations.map((row) => row.unread)).toEqual([false]);
    const one = await get(`${base}/${conversationId}/messages`, bo.cookie);
    expect(((await one.json()) as { conversation: { unread: boolean } }).conversation.unread).toBe(
      true,
    );

    expect((await visitorWritesAgain(own.publicKey, token, "again")).status).toBe(201);
    expect(await unread(conversationId, ann.cookie)).toBe(true);
  });

  test("an operator's own reply does not make a conversation unread", async () => {
    const { own, ann, base, unread, markRead, newestSeq } = await team();
    const { conversationId } = await visitorStarts(app, own.publicKey, "Hi");
    await markRead(conversationId, await newestSeq(conversationId), ann.cookie);
    const replied = await write(
      "POST",
      `${base}/${conversationId}/messages`,
      { clientId: "r1", body: "Hello there" },
      ann.cookie,
    );
    expect(replied.status).toBe(201);
    expect(await unread(conversationId, ann.cookie)).toBe(false);
  });

  test("a note never makes a conversation unread", async () => {
    const { own, ann, bo, base, unread, markRead, newestSeq } = await team();
    const { conversationId } = await visitorStarts(app, own.publicKey, "Hi");
    await markRead(conversationId, await newestSeq(conversationId), bo.cookie);
    const noted = await write(
      "POST",
      `${base}/${conversationId}/messages`,
      { clientId: "n1", body: "VIP customer", note: true },
      ann.cookie,
    );
    expect(noted.status).toBe(201);
    expect(await unread(conversationId, bo.cookie)).toBe(false);
  });

  test("a bot's test visitor is never unread", async () => {
    const { own, ann, unread } = await team();
    const sent = await write(
      "POST",
      `/v1/operator/workspaces/${own.id}/test-visitors/messages`,
      { body: "Testing the bot" },
      ann.cookie,
    );
    expect(sent.status).toBe(201);
    const { conversationId } = (await sent.json()) as { conversationId: string };
    expect(await unread(conversationId, ann.cookie)).toBe(false);
  });

  test("a lower seq does not move the position back, and a higher one stops at the newest", async () => {
    const { own, ann, unread, markRead, newestSeq } = await team();
    const { token, conversationId } = await visitorStarts(app, own.publicKey, "First");
    const first = await newestSeq(conversationId);
    await visitorWritesAgain(own.publicKey, token, "second");
    await markRead(conversationId, await newestSeq(conversationId), ann.cookie);
    expect((await markRead(conversationId, first, ann.cookie)).status).toBe(200);
    expect(await unread(conversationId, ann.cookie)).toBe(false);

    // A position past the newest message does not hide the next one.
    await markRead(conversationId, "999999999999", ann.cookie);
    await visitorWritesAgain(own.publicKey, token, "third");
    expect(await unread(conversationId, ann.cookie)).toBe(true);
  });

  test("a conversation of another workspace is not found", async () => {
    const { ann, markRead } = await team();
    const { conversationId } = await visitorStarts(app, a.publicKey, "Elsewhere");
    expect((await markRead(conversationId, "1", ann.cookie)).status).toBe(404);
  });

  test("an API key sees nothing unread and has no read position", async () => {
    const { own, ann, base } = await team();
    const { conversationId } = await visitorStarts(app, own.publicKey, "For the key");
    const made = await write(
      "POST",
      `/v1/operator/workspaces/${own.id}/api-keys`,
      { name: "Bot" },
      ann.cookie,
    );
    const { token } = (await made.json()) as { token: string };
    const asKey = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    const listed = (await (await asKey(base)).json()) as Listed;
    expect(listed.conversations.map((row) => row.unread)).toEqual([false]);
    const found = (await (await asKey(`${base}/search?q=For the key`)).json()) as Listed;
    expect(found.conversations.map((row) => row.unread)).toEqual([false]);
    const marked = await asKey(`${base}/${conversationId}/read`, {
      method: "POST",
      body: JSON.stringify({ seq: "1" }),
    });
    expect(marked.status).toBe(403);
  });
});
