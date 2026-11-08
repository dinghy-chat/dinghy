import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, fromSocket, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { pruneOnce } from "./alerts.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { chatLinkWorkspace, createChatLink } from "./chat-link.ts";
import { chatLink, conversation, pageView, visitor, workspace } from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { deviceLine } from "./device.ts";
import { verifyHostToken } from "./identity.ts";
import { recordPage } from "./journey.ts";
import { createLive, type Live } from "./live.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const OWN = new URL(PUBLIC_URL).origin;
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const logger = pino({ level: "silent" });

let database: TestDatabase;
let db: Database;
let owner: Database;
let valkey: Redis;
let live: Live;
let app: App;
let a: NewWorkspace;
let b: NewWorkspace;
let ownerCookie: string;
let agentCookie: string;

const inA = (path: string) => `/v1/operator/workspaces/${a.id}${path}`;
const asOperator = (path: string, cookie = ownerCookie, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { cookie, origin: OWN, "content-type": "application/json" },
  });

/** A request to the widget API, from the host site unless told otherwise. */
function widget(
  key: string,
  path: string,
  token: string | null,
  init: {
    method?: string;
    body?: unknown;
    origin?: string | null;
    agent?: string;
    from?: string;
  } = {},
) {
  const origin = init.origin === undefined ? SITE : init.origin;
  return app.request(
    `/v1/widget/${key}/${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        ...(origin === null ? {} : { origin }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.agent === undefined ? {} : { "user-agent": init.agent }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    // Each call from its own address, so the per-address limits never decide a test by accident.
    fromSocket(init.from ?? randomAddress()),
  );
}

const randomAddress = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

async function newVisitor(key = a.publicKey, agent?: string) {
  const response = await widget(key, "visitors", null, {
    method: "POST",
    ...(agent === undefined ? {} : { agent }),
  });
  return (await response.json()) as { visitorId: string; token: string };
}

async function send(token: string, body: string, key = a.publicKey) {
  const response = await widget(key, "messages", token, {
    method: "POST",
    body: { clientId: randomUUID(), body },
  });
  return (await response.json()) as { conversationId: string };
}

const visitorRow = async (id: string) =>
  (await owner.select().from(visitor).where(eq(visitor.id, id)))[0];

const hostToken = (payload: Record<string, unknown>, subject: string = randomUUID()) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(a.publicKey)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(a.signingSecret));

/** Reads a stream until the marker, then leaves it open for the caller to cancel. */
async function readUntil(response: Response, marker: string) {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("No stream");
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5000;
  while (!text.includes(marker) && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return { text, reader };
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  valkey = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
  live = createLive(valkey, VALKEY_URL, logger);
  const ok = async () => {};
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({
    db,
    logger,
    valkey,
    live,
    auth,
    publicUrl: PUBLIC_URL,
    checks: { postgres: ok, valkey: ok },
    stream: { heartbeatMs: 25_000, lifetimeMs: 60_000 },
  });
  a = await createWorkspace(db, "Acme", [SITE]);
  b = await createWorkspace(db, "Beta", [SITE]);
  ownerCookie = (await signedInOperator({ app, auth, owner, workspaceId: a.id })).cookie;
  agentCookie = (await signedInOperator({ app, auth, owner, workspaceId: a.id, role: "agent" }))
    .cookie;
}, 30_000);

afterAll(async () => {
  await live.stop();
  valkey.disconnect();
  await database.drop();
});

describe("host token attributes and name", () => {
  const verify = async (payload: Record<string, unknown>) =>
    verifyHostToken(await hostToken(payload), a.signingSecret, a.publicKey);

  test("attributes, and claims as the 0.5.0 name for them", async () => {
    expect((await verify({ attributes: { plan: "pro" } }))?.attributes).toEqual({ plan: "pro" });
    expect((await verify({ claims: { plan: "old" } }))?.attributes).toEqual({ plan: "old" });
    const both = await verify({ attributes: { plan: "new" }, claims: { plan: "old" } });
    expect(both?.attributes).toEqual({ plan: "new" });
  });

  test("attributes over 2 KB refuse the token", async () => {
    expect(await verify({ attributes: { big: "x".repeat(3000) } })).toBeNull();
  });

  test("a name is trimmed, and a name that is not one short line is dropped", async () => {
    expect((await verify({ name: "  Ana Lima  " }))?.name).toBe("Ana Lima");
    for (const name of ["Ana\nLima", "x".repeat(101), "   ", 42]) {
      const identity = await verify({ name });
      expect(identity).not.toBeNull();
      expect(identity?.name).toBeUndefined();
    }
  });

  test("the name and attributes reach the visitor row", async () => {
    const token = await hostToken({ name: "Ana", attributes: { plan: "pro" } });
    const me = (await (await widget(a.publicKey, "me", token)).json()) as { visitorId: string };
    const row = await visitorRow(me.visitorId);
    expect(row?.name).toBe("Ana");
    expect(row?.attributes).toEqual({ plan: "pro" });
  });
});

describe("device line", () => {
  test.each([
    [CHROME_MAC, "Chrome on macOS"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1",
      "Chrome on iPad",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Edge on Windows",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      "Samsung Internet on Android",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0",
      "Opera on Windows",
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Chrome on ChromeOS",
    ],
    ["curl/8.5.0", "Unknown"],
  ])("%s", (agent, line) => {
    expect(deviceLine(agent)).toBe(line);
  });

  test("no User-Agent is Unknown", () => {
    expect(deviceLine(undefined)).toBe("Unknown");
  });
});

describe("page reports", () => {
  test("keep the origin and path, the time and the device, and no User-Agent", async () => {
    const { visitorId, token } = await newVisitor();
    await send(token, "Hi");
    const response = await widget(a.publicKey, "page", token, {
      method: "POST",
      body: { page: `${SITE}/pricing?coupon=secret#plans` },
      agent: CHROME_MAC,
    });
    expect(response.status).toBe(200);
    const row = await visitorRow(visitorId);
    expect(row?.lastPage).toBe(`${SITE}/pricing`);
    expect(row?.device).toBe("Chrome on macOS");
    expect(row?.lastSeenAt).not.toBeNull();
    expect(
      Object.values(row ?? {})
        .map(String)
        .join(" "),
    ).not.toContain("Mozilla");
  });

  test("ignore a page on another site", async () => {
    const { visitorId, token } = await newVisitor();
    await send(token, "Hi");
    await widget(a.publicKey, "page", token, { method: "POST", body: { page: `${SITE}/a` } });
    await widget(a.publicKey, "page", token, {
      method: "POST",
      body: { page: "https://evil.example.com/b" },
    });
    expect((await visitorRow(visitorId))?.lastPage).toBe(`${SITE}/a`);
  });

  test("a new visitor gets its device line", async () => {
    const { visitorId } = await newVisitor(a.publicKey, CHROME_MAC);
    expect((await visitorRow(visitorId))?.device).toBe("Chrome on macOS");
  });

  test("are rate-limited per address", async () => {
    const { token } = await newVisitor(b.publicKey);
    const from = randomAddress();
    const statuses: number[] = [];
    for (let index = 0; index < 32; index++) {
      const response = await widget(b.publicKey, "page", token, {
        method: "POST",
        body: { page: `${SITE}/${index}` },
        from,
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("page journey", () => {
  const report = (token: string, page: string, title?: string, key = a.publicKey) =>
    widget(key, "page", token, {
      method: "POST",
      body: { page: `${SITE}${page}`, ...(title === undefined ? {} : { title }) },
    });
  const journey = (visitorId: string) =>
    owner
      .select()
      .from(pageView)
      .where(eq(pageView.visitorId, visitorId))
      .orderBy(desc(pageView.viewedAt));
  const pagesFor = async (conversationId: string) =>
    (
      (await (await asOperator(inA(`/conversations/${conversationId}/messages`))).json()) as {
        visitorPages: { path: string; title: string | null; viewedAt: string }[];
      }
    ).visitorPages;

  test("a visitor who never chatted is stored nowhere, signed in or not", async () => {
    const anonymous = await newVisitor();
    expect((await report(anonymous.token, "/pricing", "Pricing")).status).toBe(200);
    expect(await journey(anonymous.visitorId)).toEqual([]);
    expect((await visitorRow(anonymous.visitorId))?.lastPage).toBeNull();

    // A host token alone creates no visitor through a page report.
    const subject = randomUUID();
    const signedIn = await hostToken({ name: "Never chatted" }, subject);
    expect((await report(signedIn, "/account")).status).toBe(200);
    const rows = await owner.select().from(visitor).where(eq(visitor.externalId, subject));
    expect(rows).toEqual([]);
    expect(
      await owner
        .select()
        .from(pageView)
        .where(eq(pageView.path, `${SITE}/account`)),
    ).toEqual([]);
  });

  test("a bad token is refused", async () => {
    expect((await report("v1.nope", "/a")).status).toBe(401);
  });

  test("records each page with its title, newest first, and skips a repeat", async () => {
    const { visitorId, token } = await newVisitor();
    const { conversationId } = await send(token, "Hi");
    await report(token, "/pricing?coupon=secret#plans", "  Pricing \n  plans ");
    await report(token, "/pricing", "Pricing plans");
    await report(token, "/docs/start", "");
    // A single-page app sets the title after the address: the repeat fills it in.
    await report(token, "/docs/start", "Getting started");
    const rows = await journey(visitorId);
    expect(rows.map((row) => [row.path, row.title])).toEqual([
      [`${SITE}/docs/start`, "Getting started"],
      [`${SITE}/pricing`, "Pricing plans"],
    ]);
    const pages = await pagesFor(conversationId);
    expect(pages.map((page) => page.title)).toEqual(["Getting started", "Pricing plans"]);
    expect(Date.parse(pages[0]?.viewedAt ?? "")).not.toBeNaN();
    // The visitor's last page moves with it.
    expect((await visitorRow(visitorId))?.lastPage).toBe(`${SITE}/docs/start`);
  });

  test("a signed-in visitor who chatted is recorded", async () => {
    const token = await hostToken({ name: "Ana" });
    const { conversationId } = await send(token, "Hello");
    await report(token, "/account", "Your account");
    expect((await pagesFor(conversationId)).map((page) => page.path)).toEqual([`${SITE}/account`]);
  });

  test("the title is one line of 200 characters, and the path 2,000", async () => {
    const { visitorId, token } = await newVisitor();
    await send(token, "Hi");
    await report(token, `/${"p".repeat(2500)}`, `${"t".repeat(250)}`);
    const [row] = await journey(visitorId);
    expect(row?.title).toHaveLength(200);
    expect(row?.path).toHaveLength(2000);
    expect((await report(token, "/x", "t".repeat(2001))).status).toBe(400);
  });

  test("a page on another site adds no row", async () => {
    const { visitorId, token } = await newVisitor();
    await send(token, "Hi");
    await widget(a.publicKey, "page", token, {
      method: "POST",
      body: { page: "https://evil.example.com/b", title: "Evil" },
    });
    expect(await journey(visitorId)).toEqual([]);
  });

  test("keeps the newest 100 rows of a visitor, and operators see 20", async () => {
    const { visitorId, token } = await newVisitor(b.publicKey);
    await send(token, "Hi", b.publicKey);
    // Older rows straight into the table, past the report rate limit.
    await owner.insert(pageView).values(
      Array.from({ length: 100 }, (_, index) => ({
        workspaceId: b.id,
        visitorId,
        path: `${SITE}/old/${index}`,
        viewedAt: new Date(Date.now() - (200 - index) * 1000),
      })),
    );
    await report(token, "/new", "New", b.publicKey);
    const rows = await journey(visitorId);
    expect(rows).toHaveLength(100);
    expect(rows[0]?.path).toBe(`${SITE}/new`);
    expect(rows.some((row) => row.path === `${SITE}/old/0`)).toBe(false);
    expect(rows.at(-1)?.path).toBe(`${SITE}/old/1`);
  });

  test("operators see the newest 20", async () => {
    const { visitorId, token } = await newVisitor();
    const { conversationId } = await send(token, "Hi");
    await owner.insert(pageView).values(
      Array.from({ length: 30 }, (_, index) => ({
        workspaceId: a.id,
        visitorId,
        path: `${SITE}/p/${index}`,
        viewedAt: new Date(Date.now() - (30 - index) * 1000),
      })),
    );
    const pages = await pagesFor(conversationId);
    expect(pages).toHaveLength(20);
    expect(pages[0]?.path).toBe(`${SITE}/p/29`);
  });

  test("the worker deletes rows older than 90 days", async () => {
    const { visitorId, token } = await newVisitor();
    await send(token, "Hi");
    await owner.insert(pageView).values([
      {
        workspaceId: a.id,
        visitorId,
        path: `${SITE}/old`,
        viewedAt: new Date(Date.now() - 91 * 86_400_000),
      },
      {
        workspaceId: a.id,
        visitorId,
        path: `${SITE}/recent`,
        viewedAt: new Date(Date.now() - 89 * 86_400_000),
      },
    ]);
    const worker = database.connect("worker").db;
    await pruneOnce(worker, new Date(0));
    expect((await journey(visitorId)).map((row) => row.path)).toEqual([`${SITE}/recent`]);
  });

  test("deleting the visitor's last conversation deletes the journey", async () => {
    const { visitorId, token } = await newVisitor();
    const first = await send(token, "One");
    await report(token, "/one", "One");
    const remove = (id: string) =>
      asOperator(inA(`/conversations/${id}`), ownerCookie, { method: "DELETE" });
    // A second conversation, after the first one closes.
    await asOperator(inA(`/conversations/${first.conversationId}`), ownerCookie, {
      method: "PATCH",
      body: JSON.stringify({ status: "closed" }),
    });
    const second = await send(token, "Two");
    expect(second.conversationId).not.toBe(first.conversationId);
    expect((await remove(first.conversationId)).status).toBe(200);
    expect(await journey(visitorId)).toHaveLength(1);
    expect((await remove(second.conversationId)).status).toBe(200);
    expect(await journey(visitorId)).toEqual([]);
  });

  test("a report racing the delete of the last conversation leaves no page behind", async () => {
    const { visitorId, token } = await newVisitor();
    const { conversationId } = await send(token, "Hi");
    let deleted: Promise<Response> | undefined;
    let doneWhileReporting = false;
    await withWorkspace(db, a.id, async (tx) => {
      // The report has checked the conversation and written its row, and has not committed.
      await recordPage(tx, a.id, visitorId, { path: `${SITE}/race`, title: null, device: "x" });
      const pending = Promise.resolve(
        asOperator(inA(`/conversations/${conversationId}`), ownerCookie, { method: "DELETE" }),
      );
      deleted = pending;
      void pending.then(() => {
        doneWhileReporting = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(doneWhileReporting).toBe(false);
    expect((await deleted)?.status).toBe(200);
    expect(await journey(visitorId)).toEqual([]);
  });

  test("goes with its visitor", async () => {
    const [row] = await owner
      .insert(visitor)
      .values({ workspaceId: a.id, tokenHash: randomUUID() })
      .returning({ id: visitor.id });
    const visitorId = row?.id ?? "";
    await owner.insert(pageView).values({ workspaceId: a.id, visitorId, path: `${SITE}/a` });
    await owner.delete(visitor).where(eq(visitor.id, visitorId));
    expect(await journey(visitorId)).toEqual([]);
  });
});

describe("visitor details for operators", () => {
  test("the conversation carries the name, device, last page and online state", async () => {
    const token = await hostToken({ name: "Ana", attributes: { site: "https://acme.example" } });
    const { conversationId } = await send(token, "Hello");
    await widget(a.publicKey, "page", token, {
      method: "POST",
      body: { page: `${SITE}/docs` },
      agent: CHROME_MAC,
    });
    const read = async () =>
      (await (await asOperator(inA(`/conversations/${conversationId}/messages`))).json()) as {
        conversation: { visitor: Record<string, unknown> };
        visitorOnline: boolean | null;
      };
    const before = await read();
    expect(before.conversation.visitor).toMatchObject({
      name: "Ana",
      attributes: { site: "https://acme.example" },
      device: "Chrome on macOS",
      lastPage: `${SITE}/docs`,
    });
    expect(before.visitorOnline).toBe(false);

    const stream = await widget(a.publicKey, "stream", token);
    const { reader } = await readUntil(stream, "event: ready");
    expect((await read()).visitorOnline).toBe(true);
    await reader.cancel();
    // The release runs as the stream ends, a moment after the cancel.
    const deadline = Date.now() + 3000;
    while ((await read()).visitorOnline !== false && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await read()).visitorOnline).toBe(false);
  });

  test("with no Valkey, the online state is unknown, not false", async () => {
    const ok = async () => {};
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const bare = createApp({ db, logger, auth, checks: { postgres: ok, valkey: ok } });
    const { cookie } = await signedInOperator({ app: bare, auth, owner, workspaceId: a.id });
    const { token } = await newVisitor();
    const { conversationId } = await send(token, "Anyone?");
    const response = await bare.request(inA(`/conversations/${conversationId}/messages`), {
      headers: { cookie },
    });
    expect(((await response.json()) as { visitorOnline: unknown }).visitorOnline).toBeNull();
  });

  test("a change for a new message says who wrote it", async () => {
    const stream = await asOperator(inA("/stream"));
    const { reader } = await readUntil(stream, "event: ready");
    const { token } = await newVisitor();
    await send(token, "Ping");
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5000;
    while (!text.includes("fromVisitor") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toContain('"kind":"message.created"');
    expect(text).toContain('"fromVisitor":true');
  });
});

describe("widget texts", () => {
  const patch = (body: unknown, cookie = ownerCookie) =>
    asOperator(inA("/settings"), cookie, { method: "PATCH", body: JSON.stringify(body) });

  test("an owner sets them, the widget gets them, and empty means the default", async () => {
    const saved = await patch({
      widgetTexts: { title: " Talk to Acme ", greeting: "Ask us anything.", away: "" },
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { widgetTexts: unknown }).widgetTexts).toEqual({
      title: "Talk to Acme",
      greeting: "Ask us anything.",
      away: null,
    });
    const presence = await widget(a.publicKey, "presence", null);
    expect(((await presence.json()) as { texts: unknown }).texts).toEqual({
      title: "Talk to Acme",
      greeting: "Ask us anything.",
      away: null,
    });
    // A change to the origins alone keeps the texts.
    await patch({ allowedOrigins: [SITE] });
    const [row] = await owner
      .select({ title: workspace.widgetTitle })
      .from(workspace)
      .where(eq(workspace.id, a.id));
    expect(row?.title).toBe("Talk to Acme");
  });

  test("the limits hold", async () => {
    const texts = { title: null, greeting: null, away: null };
    expect((await patch({ widgetTexts: { ...texts, title: "x".repeat(41) } })).status).toBe(400);
    expect((await patch({ widgetTexts: { ...texts, greeting: "x".repeat(201) } })).status).toBe(
      400,
    );
    expect((await patch({ widgetTexts: { ...texts, away: "x".repeat(201) } })).status).toBe(400);
    expect((await patch({ widgetTexts: { ...texts, title: "a\u0000b" } })).status).toBe(400);
  });

  test("an agent cannot change them", async () => {
    const texts = { title: "Mine", greeting: null, away: null };
    expect((await patch({ widgetTexts: texts }, agentCookie)).status).toBe(403);
  });
});

describe("search", () => {
  const search = async (q: string) => {
    const response = await asOperator(inA(`/conversations/search?q=${encodeURIComponent(q)}`));
    return {
      status: response.status,
      body: (await response.json()) as {
        conversations: { id: string; lastMessage: { body: string } | null }[];
      },
    };
  };

  test("finds a conversation by name, email, user ID or message, open or closed", async () => {
    const tag = randomUUID().slice(0, 8);
    const token = await hostToken(
      { name: `Searchable ${tag}`, email: `find-${tag}@example.com` },
      `user-${tag}`,
    );
    const { conversationId } = await send(token, `The invoice ${tag} is wrong`);
    await send(token, "Something else, later");
    await asOperator(inA(`/conversations/${conversationId}`), ownerCookie, {
      method: "PATCH",
      body: JSON.stringify({ status: "closed" }),
    });
    for (const q of [`searchable ${tag}`, `FIND-${tag}`, `user-${tag}`]) {
      expect((await search(q)).body.conversations.map((row) => row.id)).toEqual([conversationId]);
    }
    const byText = await search(`invoice ${tag}`);
    expect(byText.body.conversations.map((row) => row.id)).toEqual([conversationId]);
    // The matching message is the preview, not the newest one.
    expect(byText.body.conversations[0]?.lastMessage?.body).toBe(`The invoice ${tag} is wrong`);
  });

  test("a match in an answered message does not make the conversation look waiting", async () => {
    const tag = randomUUID().slice(0, 8);
    const { token } = await newVisitor();
    const { conversationId } = await send(token, `Refund ${tag} please`);
    await asOperator(inA(`/conversations/${conversationId}/messages`), ownerCookie, {
      method: "POST",
      body: JSON.stringify({ clientId: randomUUID(), body: "Done." }),
    });
    const [row] = (await search(`refund ${tag}`)).body.conversations as {
      lastMessage: { body: string; fromVisitor: boolean } | null;
    }[];
    expect(row?.lastMessage).toMatchObject({ body: `Refund ${tag} please`, fromVisitor: false });
  });

  test("% and _ match only themselves", async () => {
    const tag = randomUUID().slice(0, 8);
    const { token } = await newVisitor();
    const { conversationId } = await send(token, `discount 50%_off ${tag}`);
    const { token: other } = await newVisitor();
    await send(other, `discount 50 percent off ${tag}`);
    expect((await search(`50%_off ${tag}`)).body.conversations.map((row) => row.id)).toEqual([
      conversationId,
    ]);
  });

  test("another workspace's conversations never show", async () => {
    const tag = randomUUID().slice(0, 8);
    const { token } = await newVisitor(b.publicKey);
    await send(token, `secret ${tag}`, b.publicKey);
    expect((await search(`secret ${tag}`)).body.conversations).toEqual([]);
  });

  test("a query must be 2 to 100 characters", async () => {
    expect((await search("a")).status).toBe(400);
    expect((await search("x".repeat(101))).status).toBe(400);
  });
});

describe("chat links", () => {
  // The page's limit counts per address alone, so each run uses its own.
  const address = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  const open = (token: string, from = address) =>
    app.request(`/chat/${token}`, {}, fromSocket(from));

  /** A visitor of A with a conversation, and a link to it. */
  async function linked(expiresInMs?: number) {
    const { visitorId, token } = await newVisitor();
    const { conversationId } = await send(token, "Help me");
    const now = expiresInMs === undefined ? Date.now() : Date.now() - 30 * 86_400_000 + expiresInMs;
    const link = await withWorkspace(owner, a.id, (tx) =>
      createChatLink(tx, a.id, visitorId, conversationId, now),
    );
    return { visitorId, conversationId, link };
  }

  test("the token names its workspace, and only its hash is stored", async () => {
    const { link } = await linked();
    expect(chatLinkWorkspace(link)).toBe(a.id);
    const rows = await owner.select().from(chatLink).where(eq(chatLink.workspaceId, a.id));
    expect(JSON.stringify(rows)).not.toContain(link);
  });

  test("the page opens the chat with a strict policy and no cache", async () => {
    const { link } = await linked();
    const response = await open(link);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain(`data-key="${a.publicKey}"`);
    expect(page).toContain('src="/widget/widget.js"');
    expect(page).not.toContain(link);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  test("an unknown, malformed or expired link shows a clear page", async () => {
    const { link } = await linked(-1000);
    const unknown = `dcl_${a.id.replaceAll("-", "")}${"A".repeat(43)}`;
    for (const token of [link, unknown, "nonsense"]) {
      const response = await open(token);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("This link has expired");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("a deleted conversation takes its links with it", async () => {
    const { link, conversationId } = await linked();
    await asOperator(inA(`/conversations/${conversationId}`), ownerCookie, { method: "DELETE" });
    expect((await open(link)).status).toBe(404);
  });

  test("a blocked visitor and a suspended workspace get a clear page", async () => {
    const { link, conversationId } = await linked();
    await asOperator(inA(`/conversations/${conversationId}/block`), ownerCookie, {
      method: "POST",
      body: "{}",
    });
    const blocked = await open(link);
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toContain("You cannot send messages");

    const space = await createWorkspace(db, "Paused", [SITE]);
    const { visitorId, token } = await newVisitor(space.publicKey);
    const sent = await send(token, "Hi", space.publicKey);
    const other = await withWorkspace(owner, space.id, (tx) =>
      createChatLink(tx, space.id, visitorId, sent.conversationId),
    );
    await owner
      .update(workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(workspace.id, space.id));
    const suspended = await open(other);
    expect(suspended.status).toBe(403);
    expect(await suspended.text()).toContain("not available");
  });

  test("its token reads and writes as the visitor from this server's own page", async () => {
    const { link, visitorId, conversationId } = await linked();
    // A same-origin GET carries no Origin header.
    const me = await widget(a.publicKey, "me", link, { origin: null });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { visitorId: string }).visitorId).toBe(visitorId);
    const history = await widget(a.publicKey, "messages", link, { origin: null });
    const page = (await history.json()) as { messages: { body: string }[] };
    expect(page.messages.map((message) => message.body)).toContain("Help me");
    const clientId = randomUUID();
    const reply = (origin: string) =>
      widget(a.publicKey, "messages", link, {
        method: "POST",
        origin,
        body: { clientId, body: "Thanks", page: `${OWN}/chat/${link}` },
      });
    const sent = await reply(OWN);
    expect(sent.status).toBe(201);
    expect(((await sent.json()) as { conversationId: string }).conversationId).toBe(conversationId);
    // A retry with the same client ID returns the first message.
    expect((await reply(OWN)).status).toBe(200);
    // The page's address holds the token, so it is never kept.
    const [row] = await owner
      .select({ startedPage: conversation.startedPage })
      .from(conversation)
      .where(eq(conversation.id, conversationId));
    expect(row?.startedPage ?? "").not.toContain("dcl_");
    const presence = await widget(a.publicKey, "presence", link, { origin: null });
    expect(presence.status).toBe(200);
    const stream = await widget(a.publicKey, "stream", link, { origin: null });
    const { text, reader } = await readUntil(stream, "event: ready");
    await reader.cancel();
    expect(text).toContain("Thanks");
  });

  test("its token works nowhere else, and other tokens do not work from this server", async () => {
    const { link } = await linked();
    // From a site, even an allowed one.
    expect((await widget(a.publicKey, "me", link)).status).toBe(403);
    expect((await widget(a.publicKey, "me", link, { origin: "https://evil.example" })).status).toBe(
      403,
    );
    // With another workspace's key.
    expect((await widget(b.publicKey, "me", link, { origin: null })).status).toBe(401);
    // A browser token cannot skip the Origin check by leaving it out, or by using this origin.
    const { token } = await newVisitor();
    expect((await widget(a.publicKey, "me", token, { origin: null })).status).toBe(403);
    expect((await widget(a.publicKey, "me", token, { origin: OWN })).status).toBe(403);
    // A visitor who came by a link cannot change the email the replies go to.
    const changed = await widget(a.publicKey, "me", link, {
      method: "PATCH",
      origin: OWN,
      body: { email: "someone@example.com" },
    });
    expect(changed.status).toBe(403);
  });

  test("an expired link stops working in the API too, and the worker prunes it", async () => {
    const { link } = await linked(-1000);
    expect((await widget(a.publicKey, "me", link, { origin: null })).status).toBe(401);
    const worker = database.connect("worker").db;
    await pruneOnce(worker, new Date(0));
    const left = await owner.execute(
      sql`select 1 from chat_link where expires_at < now() and workspace_id = ${a.id}`,
    );
    expect(left.rows).toEqual([]);
  });

  test("lookups are rate-limited per address", async () => {
    const statuses: number[] = [];
    const from = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    for (let index = 0; index < 31; index++) {
      statuses.push((await open(`nonsense-${index}`, from)).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});
