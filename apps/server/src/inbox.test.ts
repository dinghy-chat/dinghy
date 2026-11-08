import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import * as schema from "./db/schema.ts";
import { session } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import type { Live } from "./live.ts";
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

const live: Live = {
  wake(workspaceId, subscriber) {
    wakes.push([workspaceId, subscriber]);
  },
  revoke() {},
  async subscribe() {
    return () => {};
  },
  stop() {},
};

async function operatorSession(email: string, workspaceId: string, name = "Op"): Promise<string> {
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger });
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

async function visitorSends(key: string, body: string, clientId = "c1", page?: string) {
  const created = await app.request(`/v1/widget/${key}/visitors`, {
    method: "POST",
    headers: { origin: WIDGET_ORIGIN },
  });
  const { token } = (await created.json()) as { token: string };
  const sent = await app.request(`/v1/widget/${key}/messages`, {
    method: "POST",
    headers: {
      origin: WIDGET_ORIGIN,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ clientId, body, page }),
  });
  const message = (await sent.json()) as { conversationId: string };
  return { token, conversationId: message.conversationId };
}

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
    auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger }),
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
        auth: createAuth({ db, secret: AUTH_SECRET, baseURL, logger }),
      }).request("/healthz");
    const secure = await at("https://chat.example.com");
    expect(secure.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect((await at(PUBLIC_URL)).headers.get("strict-transport-security")).toBeNull();
  });
});

describe("membership", () => {
  test("a member reads its workspace", async () => {
    const response = await get(inA(""));
    expect(await response.json()).toEqual({ id: a.id, name: "Acme" });
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
    const { conversationId } = await visitorSends(a.publicKey, "hello");
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
    const { conversationId } = await visitorSends(a.publicKey, "The import stops");
    const response = await get(inA("/conversations"));
    const { conversations } = (await response.json()) as {
      conversations: { id: string; lastMessage: { body: string; fromVisitor: boolean } }[];
    };
    const found = conversations.find((row) => row.id === conversationId);
    expect(found?.lastMessage).toMatchObject({ body: "The import stops", fromVisitor: true });
  });

  test("a signed-in visitor's context reaches the operator", async () => {
    const token = await new SignJWT({ email: "pat@example.com", claims: { plan: "pro" } })
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
      claims: { plan: "pro" },
    });
  });

  test("the list shows no other workspace's conversations", async () => {
    await visitorSends(b.publicKey, "Private to B");
    const text = await (await get(inA("/conversations"))).text();
    expect(text).not.toContain("Private to B");
  });

  test("another workspace's conversation is a 404", async () => {
    const { conversationId } = await visitorSends(b.publicKey, "Private to B");
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
    for (let i = 0; i < 5; i++) await visitorSends(own.publicKey, `t${i}`);
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
    for (let i = 0; i < 3; i++) await visitorSends(own.publicKey, `m${i}`);
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
    for (let i = 0; i < 3; i++) await visitorSends(own.publicKey, `p${i}`);
    const queries: { query: string; params: unknown[] }[] = [];
    const traced = drizzle(database.connect("app").pool, {
      schema,
      logger: { logQuery: (query, params) => queries.push({ query, params }) },
    });
    const page = await withWorkspace(traced, own.id, (tx) =>
      listConversations(tx, own.id, "open", undefined, 2),
    );
    const last = page.conversations.at(-1);
    queries.length = 0;
    await withWorkspace(traced, own.id, (tx) => listConversations(tx, own.id, "open", last, 2));
    const list = queries.filter((one) => one.query.includes('from "conversation"'));
    expect(list).toHaveLength(1);
    const client = await database.connect("migrator", 1).pool.connect();
    try {
      // The test tables are tiny, so make a scan of the whole table look as costly as it would be.
      await client.query("begin");
      await client.query("set local enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `explain ${list[0]?.query}`,
        list[0]?.params,
      );
      const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index Scan Backward using conversation_list_idx/);
      expect(text).toMatch(/Index Cond: .*ROW\(updated_at, id\) </);
      expect(text).toMatch(/Index Scan Backward using message_conversation_idx/);
      expect(text).not.toMatch(/Sort/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("replies", () => {
  test("a reply reaches the visitor's history and wakes both streams", async () => {
    const { token, conversationId } = await visitorSends(a.publicKey, "Question");
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
    const { conversationId } = await visitorSends(a.publicKey, "Question");
    const path = inA(`/conversations/${conversationId}/messages`);
    const body = { clientId: "retry", body: "Once" };
    const first = (await (await write("POST", path, body)).json()) as { id: string };
    const second = await write("POST", path, body);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe(first.id);
  });

  test("a retry after a close still returns the original", async () => {
    const { conversationId } = await visitorSends(a.publicKey, "Question");
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
    const { conversationId } = await visitorSends(a.publicKey, "Question");
    const response = await write("POST", inA(`/conversations/${conversationId}/messages`), payload);
    expect(response.status).toBe(400);
  });

  test("a closed conversation refuses a reply, until it reopens", async () => {
    const { conversationId } = await visitorSends(a.publicKey, "Question");
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

describe("status", () => {
  test("closing moves a conversation between the lists, and adds one event", async () => {
    const { conversationId } = await visitorSends(a.publicKey, "Question");
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
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (reader !== undefined && !text.includes(until)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader?.cancel();
    return text;
  }

  test("with no cursor it starts at the present", async () => {
    await visitorSends(a.publicKey, "Before connecting");
    const text = await read(inA("/stream"), cookie, "event: ready");
    expect(text).not.toContain("event: change");
    expect(text).toMatch(/"cursor":"\d+\.\d+"/);
  });

  test("from a cursor, an operator catches up on messages and closes", async () => {
    const before = await read(inA("/stream"), cookie, "event: ready");
    const cursor = /"cursor":"(\d+\.\d+)"/.exec(before)?.[1];
    const { conversationId } = await visitorSends(a.publicKey, "While away");
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
    await visitorSends(b.publicKey, "Private to B");
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
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger }),
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
      auth: createAuth({ db: counted, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger }),
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
    await visitorSends(a.publicKey, "Counted");
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
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL, logger }),
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
    const response = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email, password: "a-long-test-password" }),
    });
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }
});

describe("user context from older tokens", () => {
  const sign = (claims: Record<string, unknown>, issuedAt: number) =>
    new SignJWT({ claims })
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
    const { rows } = await owner.execute<{ claims: unknown }>(
      sql`select claims from visitor where external_id = 'two-tokens'`,
    );
    expect(rows[0]?.claims).toEqual({ plan: "pro" });
    await me(await sign({ plan: "team" }, now + 1));
    const after = await owner.execute<{ claims: unknown }>(
      sql`select claims from visitor where external_id = 'two-tokens'`,
    );
    expect(after.rows[0]?.claims).toEqual({ plan: "team" });
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
    const { conversationId } = await visitorSends(team.publicKey, "Hello");
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
    const { conversationId } = await visitorSends(team.publicKey, "Hello");
    const path = `/v1/operator/workspaces/${team.id}/conversations/${conversationId}/messages`;
    await write("POST", path, { clientId: "same", body: "Once" }, cleo);
    const retry = await write("POST", path, { clientId: "same", body: "Once" }, cleo);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ authorName: "Cleo" });
  });

  test("the visitor never learns which operator replied", async () => {
    const { token, conversationId } = await visitorSends(a.publicKey, "Who is there?");
    await write("POST", inA(`/conversations/${conversationId}/messages`), {
      clientId: "private-sender",
      body: "Someone",
    });
    const history = await app.request(`/v1/widget/${a.publicKey}/messages`, {
      headers: { origin: WIDGET_ORIGIN, authorization: `Bearer ${token}` },
    });
    const { messages } = (await history.json()) as { messages: Record<string, unknown>[] };
    const reply = messages.find((message) => message.body === "Someone");
    expect(reply).toBeDefined();
    expect(reply).not.toHaveProperty("authorOperatorId");
    expect(reply).not.toHaveProperty("authorName");
  });
});

describe("where a conversation started", () => {
  test("the page is kept as origin and path, with no query string or hash", async () => {
    const { conversationId } = await visitorSends(
      a.publicKey,
      "From pricing",
      "c1",
      `${WIDGET_ORIGIN}/pricing/team?coupon=SECRET&email=a@b.c#plans`,
    );
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
      const { conversationId } = await visitorSends(a.publicKey, "Hi", "c1", page);
      const thread = (await (
        await get(inA(`/conversations/${conversationId}/messages`))
      ).json()) as ThreadPage;
      expect(thread.conversation.startedPage).toBeNull();
    }
  });

  test("a later message from another page does not change it", async () => {
    const { token, conversationId } = await visitorSends(
      a.publicKey,
      "First",
      "c1",
      `${WIDGET_ORIGIN}/start`,
    );
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

    const first = await visitorSends(team.publicKey, "One");
    const second = await visitorSends(team.publicKey, "Two");
    await visitorSends(team.publicKey, "Three");
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
    await app.request(`/v1/widget/${team.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: WIDGET_ORIGIN,
        authorization: `Bearer ${first.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "again", body: "Thanks, one more thing" }),
    });
    expect(await waiting()).toBe(2);
  });

  test("another workspace's conversations are not counted", async () => {
    const team = await createWorkspace(db, "Quiet", [WIDGET_ORIGIN]);
    const eve = await operatorSession("eve@example.com", team.id, "Eve");
    await visitorSends(a.publicKey, "Not yours");
    const response = await get(`/v1/operator/workspaces/${team.id}/conversations`, eve);
    expect(((await response.json()) as { waiting: number }).waiting).toBe(0);
  });
});
