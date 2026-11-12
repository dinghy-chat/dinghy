import { and, eq } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { fanOutOne } from "./alerts.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import {
  alertDelivery,
  conversation,
  visitor,
  widgetSettings,
  widgetSiteSeen,
  workspaceMember,
} from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { nextStep } from "./setup.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let auth: Auth;
let app: App;
const valkey = new Redis(VALKEY_URL, { lazyConnect: true });

/** One workspace per test, with its owner, a member and a key of each level. */
let space: NewWorkspace;
let boss: { id: string; cookie: string };
let member: { cookie: string };
let setupKey: string;
let chatKey: string;

const inSpace = (path = "", id = space.id) => `/v1/operator/workspaces/${id}${path}`;
const json = (body: unknown) =>
  body === undefined
    ? {}
    : { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
const asOperator = (as: { cookie: string }, method: string, path: string, body?: unknown) => {
  const sent = json(body);
  return app.request(path, {
    method,
    ...sent,
    headers: { cookie: as.cookie, origin: ORIGIN, ...sent.headers },
  });
};
const withKey = (token: string, method: string, path: string, body?: unknown) => {
  const sent = json(body);
  return app.request(path, {
    method,
    ...sent,
    headers: { authorization: `Bearer ${token}`, ...sent.headers },
  });
};

interface ToolAnswer {
  isError: boolean;
  structuredContent: Record<string, unknown>;
}
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await withKey(token, "POST", "/v1/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return ((await response.json()) as { result: ToolAnswer }).result;
}

/** A beat from a page of `site`, as the loader sends it. */
const beat = (site: string, key = space.publicKey) =>
  app.request(`/v1/widget/${key}/beat`, {
    method: "POST",
    headers: { origin: site, "content-type": "application/json" },
    body: JSON.stringify({
      tab: crypto.randomUUID().replaceAll("-", ""),
      page: `${site}/pricing`,
      title: "Pricing",
    }),
  });

async function makeKey(level: "conversations" | "setup") {
  const response = await asOperator(boss, "POST", inSpace("/api-keys"), {
    name: level === "setup" ? "Installer" : "Answerer",
    level,
  });
  return ((await response.json()) as { token: string }).token;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({ db, logger, auth, valkey, checks: { postgres: ok, valkey: ok } });
}, 30_000);

beforeEach(async () => {
  space = await createWorkspace(db, "Setup", [SITE]);
  boss = await signedInOperator({ app, auth, owner, name: "Olga", workspaceId: space.id });
  member = await signedInOperator({ app, auth, owner, workspaceId: space.id, role: "member" });
  setupKey = await makeKey("setup");
  chatKey = await makeKey("conversations");
});

afterAll(async () => {
  valkey.disconnect();
  await database.drop();
});

describe("who may set up", () => {
  const routes: [string, string, unknown?][] = [
    ["GET", "/install/snippet?framework=html"],
    ["GET", "/install/check"],
    ["GET", "/install/identity?language=go"],
    ["GET", "/sites"],
    ["POST", "/sites", { origin: "https://new.example.com" }],
    ["DELETE", `/sites?origin=${encodeURIComponent(SITE)}`],
    ["POST", "/test-visitors/messages", { body: "Hi" }],
    ["DELETE", "/test-visitors"],
  ];

  test("a Conversations key and a member get 403 forbidden", async () => {
    for (const [method, path, body] of routes) {
      const byKey = await withKey(chatKey, method, inSpace(path), body);
      expect(byKey.status, `${method} ${path}`).toBe(403);
      expect(await byKey.json()).toMatchObject({ error: { code: "forbidden" } });
      expect((await asOperator(member, method, inSpace(path), body)).status).toBe(403);
    }
  });

  test("an owner and a Setup key get through", async () => {
    for (const [method, path, body] of routes) {
      expect((await withKey(setupKey, method, inSpace(path), body)).status).toBeLessThan(300);
    }
    expect((await asOperator(boss, "GET", inSpace("/sites"))).status).toBe(200);
  });

  test("a Conversations key does not list the Setup tools, and cannot call them", async () => {
    const list = async (token: string) => {
      const response = await withKey(token, "POST", "/v1/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const { result } = (await response.json()) as {
        result: { tools: { name: string; annotations: { destructiveHint: boolean } }[] };
      };
      return result.tools;
    };
    const setupTools = await list(setupKey);
    const names = setupTools.map((one) => one.name);
    for (const name of [
      "get_install_snippet",
      "list_allowed_sites",
      "add_allowed_site",
      "remove_allowed_site",
      "verify_install",
      "get_identity_setup",
      "get_appearance",
      "update_appearance",
      "get_webhook_verification",
      "list_webhook_deliveries",
      "replay_webhook_delivery",
      "simulate_visitor_message",
      "delete_test_visitors",
    ]) {
      expect(names).toContain(name);
    }
    const destructive = setupTools.filter((one) => one.annotations.destructiveHint);
    expect(destructive.map((one) => one.name).sort()).toEqual([
      "close_conversation",
      "delete_test_visitors",
      "delete_webhook",
      "remove_allowed_site",
    ]);
    const chatNames = (await list(chatKey)).map((one) => one.name);
    expect(chatNames).not.toContain("verify_install");
    const refused = await withKey(chatKey, "POST", "/v1/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "add_allowed_site", arguments: { origin: "https://x.example.com" } },
    });
    expect(((await refused.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });
});

describe("the install snippet and identity help", () => {
  test("the snippet route fills in the workspace's key and this server", async () => {
    const response = await withKey(setupKey, "GET", inSpace("/install/snippet?framework=nextjs"));
    expect(await response.json()).toMatchObject({
      framework: "nextjs",
      file: "app/layout.tsx",
      publicKey: space.publicKey,
      serverUrl: ORIGIN,
    });
    const bad = await withKey(setupKey, "GET", inSpace("/install/snippet?framework=cobol"));
    expect(bad.status).toBe(400);
  });

  test("the tools answer the same, and never the signing secret", async () => {
    const snippet = await callTool(setupKey, "get_install_snippet", { framework: "wordpress" });
    expect(snippet.structuredContent).toMatchObject({ publicKey: space.publicKey });
    for (const language of ["typescript", "python", "ruby", "php", "go"]) {
      const identity = await callTool(setupKey, "get_identity_setup", { language });
      expect(identity.isError).toBe(false);
      expect(JSON.stringify(identity)).not.toContain(space.signingSecret);
      expect(identity.structuredContent.serverCode).toContain("DINGHY_SIGNING_SECRET");
    }
    const route = await withKey(setupKey, "GET", inSpace("/install/identity?language=php"));
    expect(await route.text()).not.toContain(space.signingSecret);
    const hook = await callTool(setupKey, "get_webhook_verification", { language: "go" });
    expect(hook.structuredContent.code).toContain("hmac.Equal");
  });
});

describe("allowed sites", () => {
  test("add normalizes and keeps one copy, remove takes it out", async () => {
    const added = await withKey(setupKey, "POST", inSpace("/sites"), {
      origin: "HTTPS://Shop.Example.com/",
    });
    expect(await added.json()).toEqual({ sites: [SITE, "https://shop.example.com"] });
    const again = await callTool(setupKey, "add_allowed_site", {
      origin: "https://shop.example.com",
    });
    expect(again.structuredContent).toEqual({ sites: [SITE, "https://shop.example.com"] });
    const removed = await callTool(setupKey, "remove_allowed_site", { origin: SITE });
    expect(removed.structuredContent).toEqual({ sites: ["https://shop.example.com"] });
    const listed = await callTool(setupKey, "list_allowed_sites");
    expect(listed.structuredContent).toEqual({ sites: ["https://shop.example.com"] });
    const settings = await asOperator(boss, "GET", inSpace("/settings"));
    expect(await settings.json()).toMatchObject({ allowedOrigins: ["https://shop.example.com"] });
  });

  test("a value that is not an origin is refused, as Settings refuses it", async () => {
    for (const origin of ["shop.example.com", "https://shop.example.com/cart", "ftp://x.example"]) {
      const response = await withKey(setupKey, "POST", inSpace("/sites"), { origin });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "bad_origin" } });
      const viaPatch = await asOperator(boss, "PATCH", inSpace("/settings"), {
        allowedOrigins: [origin],
      });
      expect(await viaPatch.json()).toMatchObject({ error: { code: "bad_origin" } });
    }
    const tool = await callTool(setupKey, "remove_allowed_site", { origin: "nope" });
    expect(tool.structuredContent).toMatchObject({ error: { code: "bad_origin" } });
  });

  test("a workspace has at most 20", async () => {
    const many = Array.from({ length: 20 }, (_, index) => `https://s${index}.example.com`);
    await asOperator(boss, "PATCH", inSpace("/settings"), { allowedOrigins: many });
    const over = await withKey(setupKey, "POST", inSpace("/sites"), {
      origin: "https://one-more.example.com",
    });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "site_limit" } });
    // One already there is not an addition.
    const present = await withKey(setupKey, "POST", inSpace("/sites"), { origin: many[0] });
    expect(present.status).toBe(200);
  });
});

describe("verify_install", () => {
  const check = async (origin?: string) =>
    (await callTool(setupKey, "verify_install", origin === undefined ? {} : { origin }))
      .structuredContent as {
      allowed: boolean | null;
      widgetSeenAt: string | null;
      sites: { origin: string; allowed: boolean; lastSeenAt: string | null }[];
      refused: { origin: string }[];
      liveTabs: number | null;
      nextStep: string;
    };

  test("an allowed site that never loaded it: deploy and open the site", async () => {
    const state = await check(SITE);
    expect(state).toMatchObject({
      allowed: true,
      widgetSeenAt: null,
      sites: [{ origin: SITE, allowed: true, lastSeenAt: null }],
      refused: [],
      liveTabs: 0,
    });
    expect(state.nextStep).toMatch(/^Deploy the snippet and open https:\/\/app\.example\.com/);
  });

  test("an origin that is not allowed: add it", async () => {
    const state = await check("https://www.example.com");
    expect(state.allowed).toBe(false);
    expect(state.nextStep).toBe(
      "Add https://www.example.com to the allowed sites, then open a page of it once.",
    );
    const bad = await withKey(setupKey, "GET", inSpace("/install/check?origin=nope"));
    expect(bad.status).toBe(400);
  });

  test("a beat from an allowed site records it, and the check says it is installed", async () => {
    expect((await beat(SITE)).status).toBe(200);
    const [row] = await owner
      .select()
      .from(widgetSiteSeen)
      .where(eq(widgetSiteSeen.workspaceId, space.id));
    expect(row?.origin).toBe(SITE);
    const state = await check();
    expect(state.allowed).toBeNull();
    expect(state.widgetSeenAt).not.toBeNull();
    expect(state.liveTabs).toBe(1);
    expect(state.nextStep).toMatch(
      /^Installed: the widget loaded from https:\/\/app\.example\.com at /,
    );
    // The same process writes an origin at most once an hour.
    await owner
      .update(widgetSiteSeen)
      .set({ lastSeenAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(widgetSiteSeen.workspaceId, space.id));
    await beat(SITE);
    const [after] = await owner
      .select()
      .from(widgetSiteSeen)
      .where(eq(widgetSiteSeen.workspaceId, space.id));
    expect(after?.lastSeenAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("a refused site shows as a hint, until it is allowed", async () => {
    const elsewhere = "https://www.app.example.com";
    expect((await beat(elsewhere)).status).toBe(403);
    const state = await check();
    expect(state.refused.map((one) => one.origin)).toEqual([elsewhere]);
    expect(state.nextStep).toBe(
      `The widget was refused on ${elsewhere}. If that site is yours, add it to the allowed sites.`,
    );
    await callTool(setupKey, "add_allowed_site", { origin: elsewhere });
    expect((await check()).refused).toEqual([]);
  });

  test("nextStep with no allowed site", () => {
    const empty = { origin: undefined, allowedOrigins: [], sites: [], refused: [] };
    expect(nextStep(empty)).toBe(
      "Add the site's origin, such as https://www.example.com, to the allowed sites.",
    );
    expect(nextStep({ ...empty, refused: [{ origin: "https://a.example" }] })).toBe(
      "Add https://a.example to the allowed sites: the widget tried to load there and was refused.",
    );
  });
});

describe("appearance", () => {
  test("a Setup key changes some fields and keeps the rest", async () => {
    await owner
      .update(widgetSettings)
      .set({ greeting: "Ahoy" })
      .where(eq(widgetSettings.workspaceId, space.id));
    const changed = await callTool(setupKey, "update_appearance", {
      title: "Talk to us",
      accent: "#1D4ED8",
    });
    expect(changed.structuredContent).toMatchObject({
      title: "Talk to us",
      accent: "#1d4ed8",
      greeting: "Ahoy",
    });
    const read = await callTool(setupKey, "get_appearance");
    expect(read.structuredContent).toMatchObject({ title: "Talk to us", greeting: "Ahoy" });
    const bad = await callTool(setupKey, "update_appearance", { accent: "blue" });
    expect(bad.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
  });

  test("the REST routes open to a Setup key, but the logo stays an operator's", async () => {
    const read = await withKey(setupKey, "GET", inSpace("/widget"));
    expect(read.status).toBe(200);
    const {
      logoUrl: _logo,
      team: _team,
      faces: _faces,
      typingPreview: _preview,
      ...settings
    } = (await read.json()) as Record<string, unknown>;
    const put = await withKey(setupKey, "PUT", inSpace("/widget"), { ...settings, title: "Hi" });
    expect(put.status).toBe(200);
    expect((await withKey(chatKey, "PUT", inSpace("/widget"), settings)).status).toBe(403);
    expect((await asOperator(member, "PUT", inSpace("/widget"), settings)).status).toBe(403);
    const logo = await app.request(inSpace("/widget/logo"), {
      method: "PUT",
      headers: { authorization: `Bearer ${setupKey}`, "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(logo.status).toBe(403);
    expect((await withKey(setupKey, "DELETE", inSpace("/widget/logo"))).status).toBe(403);
  });
});

describe("test visitors", () => {
  const simulate = async (args: Record<string, unknown>) =>
    (await callTool(setupKey, "simulate_visitor_message", args)).structuredContent as {
      visitorId: string;
      conversationId: string;
      message: { body: string; fromVisitor: boolean };
      error?: { code: string };
    };

  test("a test message goes through the widget's path, marked as a test", async () => {
    const first = await simulate({ body: "Where is my order?", name: "Test Tess" });
    expect(first.message).toMatchObject({ body: "Where is my order?", fromVisitor: true });
    const second = await simulate({ body: "Hello?", conversationId: first.conversationId });
    expect(second).toMatchObject({
      visitorId: first.visitorId,
      conversationId: first.conversationId,
    });
    const [row] = await owner.select().from(visitor).where(eq(visitor.id, first.visitorId));
    expect(row).toMatchObject({ isTest: true, name: "Test Tess", externalId: null });
    const listed = await callTool(chatKey, "list_conversations");
    expect(listed.structuredContent).toMatchObject({
      conversations: [{ id: first.conversationId, visitor: { isTest: true } }],
    });
  });

  test("a conversation that is not a test's is refused", async () => {
    const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: SITE },
    });
    const { token } = (await created.json()) as { token: string };
    const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "real", body: "A real person" }),
    });
    const real = ((await sent.json()) as { conversationId: string }).conversationId;
    const refused = await simulate({ body: "Sneaky", conversationId: real });
    expect(refused.error?.code).toBe("not_found");
    const route = await withKey(setupKey, "POST", inSpace("/test-visitors/messages"), {
      body: "Sneaky",
      conversationId: real,
    });
    expect(route.status).toBe(404);
  });

  test("analytics, contacts, get started and alerts leave them out", async () => {
    await owner
      .update(workspaceMember)
      .set({ alertEmail: true })
      .where(eq(workspaceMember.workspaceId, space.id));
    const sent = await withKey(setupKey, "POST", inSpace("/test-visitors/messages"), {
      body: "Testing",
    });
    expect(sent.status).toBe(201);
    const { conversationId } = (await sent.json()) as { conversationId: string };
    const analytics = await asOperator(boss, "GET", inSpace("/analytics?days=7"));
    expect(await analytics.json()).toMatchObject({ started: 0 });
    const contacts = await asOperator(boss, "GET", inSpace("/contacts"));
    expect(await contacts.json()).toMatchObject({ contacts: [] });
    const steps = await asOperator(boss, "GET", inSpace("/get-started"));
    expect(await steps.json()).toMatchObject({ chat: false });
    const worker = database.connect("worker", 2).db;
    while (await fanOutOne(worker, { push: true, email: true }));
    const alerts = await owner
      .select()
      .from(alertDelivery)
      .where(
        and(
          eq(alertDelivery.workspaceId, space.id),
          eq(alertDelivery.conversationId, conversationId),
        ),
      );
    expect(alerts).toEqual([]);
  });

  test("delete_test_visitors removes them with their conversations, and no one else", async () => {
    const made = await simulate({ body: "Bye" });
    const real = await createWorkspaceVisitor();
    const deleted = await withKey(setupKey, "DELETE", inSpace("/test-visitors"));
    expect(await deleted.json()).toEqual({ deleted: 1 });
    expect(await owner.select().from(visitor).where(eq(visitor.id, made.visitorId))).toEqual([]);
    expect(
      await owner.select().from(conversation).where(eq(conversation.id, made.conversationId)),
    ).toEqual([]);
    expect(await owner.select().from(visitor).where(eq(visitor.id, real))).toHaveLength(1);
    const again = await callTool(setupKey, "delete_test_visitors");
    expect(again.structuredContent).toEqual({ deleted: 0 });
  });

  test(`a workspace sends at most 10 a minute`, async () => {
    for (let index = 0; index < 10; index++) {
      expect((await simulate({ body: `Message ${index}` })).error).toBeUndefined();
    }
    expect((await simulate({ body: "One too many" })).error?.code).toBe("too_many_requests");
    const route = await withKey(setupKey, "POST", inSpace("/test-visitors/messages"), {
      body: "One too many",
    });
    expect(route.status).toBe(429);
  });
});

async function createWorkspaceVisitor(): Promise<string> {
  const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  return ((await created.json()) as { visitorId: string }).visitorId;
}
