import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import webPush from "web-push";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { pressLinkButton, signedInOperator } from "../test/operators.ts";
import { claimDeliveries, emailStopUrl, fanOutOne, planDelivery } from "./alerts.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import {
  attachment,
  conversation,
  emailStop,
  event,
  invite,
  message,
  operator,
  pageView,
  pushSubscription,
  verification,
  visitor,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { createImages } from "./images.ts";
import { appendMessage } from "./messages.ts";
import { createPush } from "./push.ts";
import { localStore } from "./storage.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const SITE_A = "https://a.example.com";
const SITE_B = "https://b.example.com";
const GOOD_P256DH =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const GOOD_AUTH = "tBHItJI5svbpez7KI4CCXg";
const logger = pino({ level: "silent" });
const pushKeys = { ...webPush.generateVAPIDKeys(), subject: "mailto:hello@dinghy.chat" };

let database: TestDatabase;
let owner: Database;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  owner = database.connect("migrator").db;
});

afterAll(async () => {
  await database.drop();
});

/**
 * Every route an outside caller can reach, and the attack on it. The test below compares this list
 * with the router, so a new route fails the suite until someone writes its attack here.
 */
type Attack = (world: World) => Promise<void>;

interface VisitorWorld {
  id: string;
  token: string;
  conversationId: string;
  image: { url: string };
}

interface World {
  server: App;
  a: NewWorkspace;
  b: NewWorkspace;
  anna: { id: string; cookie: string };
  bea: { id: string; cookie: string };
  /** In both workspaces, so a query that filters only by operator reaches the wrong row. */
  sam: { id: string; cookie: string };
  /** Made first, so a query with no filter that takes the first row gets this one. */
  decoy: NewWorkspace;
  one: VisitorWorld;
  two: VisitorWorld;
  other: VisitorWorld;
  inviteB: { id: string; token: string };
  /** Strings that belong to someone else, for each kind of caller. */
  secrets: { two: string; b: string };
  widget(
    key: string,
    method: string,
    path: string,
    token: string | null,
    origin: string,
    body?: unknown,
  ): Promise<Response>;
  operator(as: { cookie: string }, method: string, path: string, body?: unknown): Promise<Response>;
}

const inWorkspace = (id: string, path = "") => `/v1/operator/workspaces/${id}${path}`;

/** Reads a stream until the marker, then closes it. */
async function readStream(response: Response, until = "event: ready"): Promise<string> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5000;
  while (reader !== undefined && !text.includes(until) && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader?.cancel();
  return text;
}

const png = () =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: "#123456" } })
    .png()
    .toBuffer();

/** Runs against a route as the one caller that must be refused or see only its own data. */
const ATTACKS: Record<string, Attack> = {
  "GET /v1/meta": async ({ server, secrets }) => {
    const text = await (await server.request("/v1/meta")).text();
    expect(text).not.toContain(secrets.b);
    expect(text).not.toContain(secrets.two);
  },

  "GET /v1/openapi.json": async ({ server, a, secrets }) => {
    const text = await (await server.request("/v1/openapi.json")).text();
    expect(text).not.toContain(a.id);
    expect(text).not.toContain(secrets.b);
  },

  // ---- A visitor against another visitor, and against another workspace.
  "POST /v1/widget/:key/visitors": async ({ widget, a, b }) => {
    // A site allowed for one workspace cannot start a visitor in the other.
    expect((await widget(b.publicKey, "POST", "visitors", null, SITE_A)).status).toBe(403);
    expect((await widget(a.publicKey, "POST", "visitors", null, SITE_B)).status).toBe(403);
  },
  "GET /v1/widget/:key/messages": async ({ widget, a, b, one, other, secrets }) => {
    const own = await widget(a.publicKey, "GET", "messages", one.token, SITE_A);
    expect(own.status).toBe(200);
    const text = await own.text();
    expect(text).toContain("written by one");
    expect(text).not.toContain(secrets.two);
    expect(text).not.toContain(secrets.b);
    expect((await widget(b.publicKey, "GET", "messages", one.token, SITE_B)).status).toBe(401);
    expect((await widget(a.publicKey, "GET", "messages", other.token, SITE_A)).status).toBe(401);
  },
  "POST /v1/widget/:key/messages": async ({ widget, b, one }) => {
    const body = { clientId: randomUUID(), body: "crossing over" };
    expect((await widget(b.publicKey, "POST", "messages", one.token, SITE_B, body)).status).toBe(
      401,
    );
    const rows = await owner.select().from(message).where(eq(message.body, "crossing over"));
    expect(rows).toEqual([]);
  },
  "GET /v1/widget/:key/stream": async ({ widget, a, b, one, secrets }) => {
    const own = await widget(a.publicKey, "GET", "stream", one.token, SITE_A);
    expect(own.status).toBe(200);
    const text = await readStream(own);
    expect(text).toContain("written by one");
    expect(text).not.toContain(secrets.two);
    expect(text).not.toContain(secrets.b);
    expect((await widget(b.publicKey, "GET", "stream", one.token, SITE_B)).status).toBe(401);
  },
  "POST /v1/widget/:key/images": async ({ server, b, one }) => {
    const before = await owner.select().from(attachment).where(eq(attachment.workspaceId, b.id));
    const response = await server.request(`/v1/widget/${b.publicKey}/images?clientId=x1`, {
      method: "POST",
      headers: {
        origin: SITE_B,
        authorization: `Bearer ${one.token}`,
        "content-type": "image/png",
      },
      body: await png(),
    });
    expect(response.status).toBe(401);
    const after = await owner.select().from(attachment).where(eq(attachment.workspaceId, b.id));
    expect(after).toHaveLength(before.length);
  },
  "POST /v1/widget/:key/read": async ({ widget, a, b, one, two }) => {
    const position = async (id: string) =>
      (await owner.select().from(visitor).where(eq(visitor.id, id)))[0]?.lastReadSeq;
    const before = await position(two.id);
    expect(
      (await widget(a.publicKey, "POST", "read", one.token, SITE_A, { seq: "999999" })).status,
    ).toBe(200);
    expect(await position(two.id)).toBe(before);
    expect(
      (await widget(b.publicKey, "POST", "read", one.token, SITE_B, { seq: "1" })).status,
    ).toBe(401);
  },
  "GET /v1/widget/:key/me": async ({ widget, a, b, one, two }) => {
    const own = await widget(a.publicKey, "GET", "me", one.token, SITE_A);
    expect(((await own.json()) as { visitorId: string }).visitorId).toBe(one.id);
    expect((await widget(a.publicKey, "GET", "me", two.token, SITE_B)).status).toBe(403);
    expect((await widget(b.publicKey, "GET", "me", one.token, SITE_B)).status).toBe(401);
  },
  "PATCH /v1/widget/:key/me": async ({ widget, a, b, one, other }) => {
    const email = `${randomUUID()}@example.com`;
    const own = await widget(a.publicKey, "PATCH", "me", one.token, SITE_A, { email });
    expect(own.status).toBe(200);
    const holders = await owner.select().from(visitor).where(eq(visitor.email, email));
    expect(holders.map((row) => row.id)).toEqual([one.id]);
    expect((await widget(b.publicKey, "PATCH", "me", other.token, SITE_A, { email })).status).toBe(
      403,
    );
    expect((await widget(b.publicKey, "PATCH", "me", one.token, SITE_B, { email })).status).toBe(
      401,
    );
  },
  "GET /v1/widget/:key/presence": async ({ widget, a, b }) => {
    expect((await widget(a.publicKey, "GET", "presence", null, SITE_B)).status).toBe(403);
    const own = await widget(b.publicKey, "GET", "presence", null, SITE_B);
    expect(Object.keys((await own.json()) as object)).toEqual(["online", "emailReplies", "texts"]);
  },
  "POST /v1/widget/:key/page": async ({ widget, a, b, one, two, other }) => {
    const pageOf = async (id: string) =>
      (await owner.select().from(visitor).where(eq(visitor.id, id)))[0]?.lastPage;
    const journeyOf = async (id: string) =>
      (await owner.select().from(pageView).where(eq(pageView.visitorId, id))).map(
        (row) => `${row.workspaceId} ${row.path}`,
      );
    const before = await pageOf(two.id);
    const twoBefore = await journeyOf(two.id);
    const otherBefore = await journeyOf(other.id);
    const page = `${SITE_A}/isolation-${randomUUID()}`;
    expect((await widget(a.publicKey, "POST", "page", one.token, SITE_A, { page })).status).toBe(
      200,
    );
    expect(await pageOf(one.id)).toBe(page);
    expect(await journeyOf(one.id)).toContain(`${a.id} ${page}`);
    expect(await pageOf(two.id)).toBe(before);
    expect(await journeyOf(two.id)).toEqual(twoBefore);
    expect(await journeyOf(other.id)).toEqual(otherBefore);
    expect(
      (await widget(b.publicKey, "POST", "page", one.token, SITE_B, { page: `${SITE_B}/x` }))
        .status,
    ).toBe(401);
  },

  // ---- An image and a stop link, whose signatures name one workspace.
  "GET /v1/files/:workspaceId/:attachmentId": async ({ server, a, b, one, other }) => {
    const local = (url: string) => {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    };
    expect((await server.request(local(one.image.url))).status).toBe(200);
    // The other workspace's ID with this signature, and this ID with the other's file.
    const moved = local(one.image.url).replace(a.id, b.id);
    expect((await server.request(moved)).status).toBe(404);
    const attachmentB = new URL(other.image.url).pathname.split("/").at(-1) ?? "";
    const swapped = local(one.image.url).replace(
      new URL(one.image.url).pathname.split("/").at(-1) ?? "",
      attachmentB,
    );
    expect((await server.request(swapped)).status).toBe(404);
    // A valid signature that pairs this workspace with the other's file reaches the query itself.
    const signed = new URL(signer.url(a.id, attachmentB));
    expect((await server.request(`${signed.pathname}${signed.search}`)).status).toBe(404);
  },
  "GET /v1/email-stop/:workspaceId/:addressHash": async ({ server, a, b }) => {
    const url = new URL(emailStopUrl(PUBLIC_URL, AUTH_SECRET, a.id, "x@example.com"));
    expect((await server.request(`${url.pathname}${url.search}`)).status).toBe(200);
    const moved = url.pathname.replace(a.id, b.id);
    expect((await server.request(`${moved}${url.search}`)).status).toBe(404);
  },
  "POST /v1/email-stop/:workspaceId/:addressHash": async ({ server, a, b }) => {
    const url = new URL(emailStopUrl(PUBLIC_URL, AUTH_SECRET, a.id, "y@example.com"));
    const moved = url.pathname.replace(a.id, b.id);
    const forged = await server.request(`${moved}${url.search}`, { method: "POST" });
    expect(forged.status).toBe(404);
    expect(
      (await owner.select().from(emailStop).where(eq(emailStop.workspaceId, b.id))).length,
    ).toBe(0);
    await server.request(`${url.pathname}${url.search}`, { method: "POST" });
    const rows = await owner.select().from(emailStop).where(eq(emailStop.workspaceId, a.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(
      (await owner.select().from(emailStop).where(eq(emailStop.workspaceId, b.id))).length,
    ).toBe(0);
  },

  // ---- An operator of workspace A against workspace B.
  "GET /v1/operator/me": async ({ operator: as, anna, a, b, secrets }) => {
    const text = await (await as(anna, "GET", "/v1/operator/me")).text();
    expect(text).toContain(a.id);
    // With the name of this workspace, and no other.
    expect(text).toContain('"name":"Acme"');
    expect(text).not.toContain("Decoy");
    expect(text).not.toContain(b.id);
    expect(text).not.toContain(secrets.b);
  },
  "GET /v1/operator/workspaces/:workspaceId": async ({ operator: as, anna, a, b }) => {
    expect((await as(anna, "GET", inWorkspace(b.id))).status).toBe(404);
    const own = (await (await as(anna, "GET", inWorkspace(a.id))).json()) as { id: string };
    expect(own.id).toBe(a.id);
  },
  "GET /v1/operator/workspaces/:workspaceId/analytics": async ({
    operator: as,
    anna,
    sam,
    a,
    b,
    secrets,
  }) => {
    const numbers = async (who: { cookie: string }, id: string) => {
      const response = await as(who, "GET", inWorkspace(id, "/analytics?days=7&tz=UTC"));
      return { status: response.status, text: await response.text() };
    };
    expect((await numbers(anna, b.id)).status).toBe(404);
    const count = async (id: string) =>
      (await owner.select().from(conversation).where(eq(conversation.workspaceId, id))).length;
    // Sam is in both, and each workspace gives its own numbers.
    for (const id of [a.id, b.id]) {
      const { status, text } = await numbers(sam, id);
      expect(status).toBe(200);
      expect((JSON.parse(text) as { started: number }).started).toBe(await count(id));
    }
    const own = await numbers(anna, a.id);
    expect(own.text).not.toContain(secrets.b);
    expect(own.text).not.toContain(b.id);
  },
  "GET /v1/operator/workspaces/:workspaceId/conversations/search": async ({
    operator: as,
    anna,
    a,
    b,
    one,
    other,
    secrets,
  }) => {
    const search = (id: string, q: string) =>
      as(anna, "GET", inWorkspace(id, `/conversations/search?q=${encodeURIComponent(q)}`));
    expect((await search(b.id, "written")).status).toBe(404);
    const text = await (await search(a.id, "written")).text();
    expect(text).toContain(one.conversationId);
    expect(text).not.toContain(other.conversationId);
    expect(text).not.toContain(secrets.b);
  },
  "GET /v1/operator/workspaces/:workspaceId/conversations": async ({
    operator: as,
    anna,
    a,
    b,
    one,
    other,
    secrets,
  }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/conversations"))).status).toBe(404);
    const text = await (await as(anna, "GET", inWorkspace(a.id, "/conversations"))).text();
    expect(text).toContain(one.conversationId);
    expect(text).not.toContain(other.conversationId);
    expect(text).not.toContain(secrets.b);
  },
  "GET /v1/operator/workspaces/:workspaceId/conversations/:conversationId/messages": async ({
    operator: as,
    anna,
    a,
    b,
    one,
    other,
    secrets,
  }) => {
    const here = inWorkspace(a.id, `/conversations/${other.conversationId}/messages?after=0`);
    const crossed = await as(anna, "GET", here);
    expect(crossed.status).toBe(404);
    expect(await crossed.text()).not.toContain(secrets.b);
    const there = inWorkspace(b.id, `/conversations/${other.conversationId}/messages?after=0`);
    expect((await as(anna, "GET", there)).status).toBe(404);
    // A conversation's page journey is its own visitor's, never another one's.
    const own = await as(
      anna,
      "GET",
      inWorkspace(a.id, `/conversations/${one.conversationId}/messages`),
    );
    const { visitorPages } = (await own.json()) as { visitorPages: { title: string | null }[] };
    const titles = visitorPages.map((page) => page.title);
    expect(titles).toContain("written by one, the page");
    expect(titles.join(" ")).not.toContain(secrets.two);
    expect(titles.join(" ")).not.toContain(secrets.b);
  },
  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/messages": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    const body = { clientId: randomUUID(), body: "an operator crossing over" };
    const here = inWorkspace(a.id, `/conversations/${other.conversationId}/messages`);
    expect((await as(anna, "POST", here, body)).status).toBe(404);
    const there = inWorkspace(b.id, `/conversations/${other.conversationId}/messages`);
    expect((await as(anna, "POST", there, body)).status).toBe(404);
    const rows = await owner
      .select()
      .from(message)
      .where(eq(message.body, "an operator crossing over"));
    expect(rows).toEqual([]);
  },
  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/images": async ({
    server,
    anna,
    a,
    other,
  }) => {
    const before = await owner.select().from(attachment);
    const response = await server.request(
      inWorkspace(a.id, `/conversations/${other.conversationId}/images?clientId=x2`),
      {
        method: "POST",
        headers: { cookie: anna.cookie, origin: ORIGIN, "content-type": "image/png" },
        body: await png(),
      },
    );
    expect(response.status).toBe(404);
    expect(await owner.select().from(attachment)).toHaveLength(before.length);
  },
  "PATCH /v1/operator/workspaces/:workspaceId/conversations/:conversationId": async ({
    operator: as,
    anna,
    a,
    other,
  }) => {
    const path = inWorkspace(a.id, `/conversations/${other.conversationId}`);
    expect((await as(anna, "PATCH", path, { status: "closed" })).status).toBe(404);
    const [row] = await owner
      .select()
      .from(conversation)
      .where(eq(conversation.id, other.conversationId));
    expect(row?.status).toBe("open");
  },
  "PUT /v1/operator/workspaces/:workspaceId/conversations/:conversationId/assignee": async ({
    operator: as,
    anna,
    bea,
    a,
    one,
    other,
  }) => {
    const crossed = inWorkspace(a.id, `/conversations/${other.conversationId}/assignee`);
    expect((await as(anna, "PUT", crossed, { operatorId: anna.id })).status).toBe(404);
    // Bea is real, and only in the other workspace.
    const own = inWorkspace(a.id, `/conversations/${one.conversationId}/assignee`);
    expect((await as(anna, "PUT", own, { operatorId: bea.id })).status).toBe(400);
    const [row] = await owner
      .select()
      .from(conversation)
      .where(eq(conversation.id, other.conversationId));
    expect(row?.assigneeOperatorId).toBeNull();
  },
  "GET /v1/operator/workspaces/:workspaceId/stream": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/stream"))).status).toBe(404);
    // From the start of the feed, so anything from the other workspace would show.
    const own = await as(anna, "GET", inWorkspace(a.id, "/stream?after=1.0"));
    expect(own.status).toBe(200);
    expect(await readStream(own)).not.toContain(other.conversationId);
  },
  "PUT /v1/operator/workspaces/:workspaceId/presence": async ({ operator: as, anna, b }) => {
    const body = { viewing: null, left: null };
    expect((await as(anna, "PUT", inWorkspace(b.id, "/presence"), body)).status).toBe(404);
  },
  "POST /v1/operator/workspaces/:workspaceId/presence/leave": async ({ operator: as, anna, b }) => {
    const body = { conversationId: null };
    expect((await as(anna, "POST", inWorkspace(b.id, "/presence/leave"), body)).status).toBe(404);
  },
  "GET /v1/operator/workspaces/:workspaceId/members": async ({ operator: as, anna, bea, a, b }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/members"))).status).toBe(404);
    const text = await (await as(anna, "GET", inWorkspace(a.id, "/members"))).text();
    expect(text).toContain(anna.id);
    expect(text).not.toContain(bea.id);
  },
  "PATCH /v1/operator/workspaces/:workspaceId/members/:operatorId": async ({
    operator: as,
    anna,
    bea,
    a,
    b,
  }) => {
    const role = { role: "agent" };
    expect((await as(anna, "PATCH", inWorkspace(a.id, `/members/${bea.id}`), role)).status).toBe(
      404,
    );
    expect((await as(anna, "PATCH", inWorkspace(b.id, `/members/${bea.id}`), role)).status).toBe(
      404,
    );
    const [row] = await owner
      .select()
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, b.id), eq(workspaceMember.operatorId, bea.id)));
    expect(row?.role).toBe("owner");
  },
  "DELETE /v1/operator/workspaces/:workspaceId/members/:operatorId": async ({
    operator: as,
    anna,
    bea,
    a,
    b,
  }) => {
    expect((await as(anna, "DELETE", inWorkspace(a.id, `/members/${bea.id}`))).status).toBe(404);
    expect((await as(anna, "DELETE", inWorkspace(b.id, `/members/${bea.id}`))).status).toBe(404);
    const [row] = await owner
      .select()
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, b.id), eq(workspaceMember.operatorId, bea.id)));
    expect(row?.removedAt).toBeNull();
  },
  "GET /v1/operator/workspaces/:workspaceId/invites": async ({
    operator: as,
    anna,
    a,
    b,
    inviteB,
  }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/invites"))).status).toBe(404);
    const text = await (await as(anna, "GET", inWorkspace(a.id, "/invites"))).text();
    expect(text).not.toContain(inviteB.id);
  },
  "POST /v1/operator/workspaces/:workspaceId/invites": async ({ operator: as, anna, a, b }) => {
    const body = { role: "agent" };
    expect((await as(anna, "POST", inWorkspace(b.id, "/invites"), body)).status).toBe(404);
    const made = await as(anna, "POST", inWorkspace(a.id, "/invites"), body);
    const { token } = (await made.json()) as { token: string };
    expect(token.startsWith(a.id)).toBe(true);
  },
  "DELETE /v1/operator/workspaces/:workspaceId/invites/:inviteId": async ({
    operator: as,
    anna,
    a,
    b,
    inviteB,
  }) => {
    await as(anna, "DELETE", inWorkspace(a.id, `/invites/${inviteB.id}`));
    expect((await as(anna, "DELETE", inWorkspace(b.id, `/invites/${inviteB.id}`))).status).toBe(
      404,
    );
    const [row] = await owner.select().from(invite).where(eq(invite.id, inviteB.id));
    expect(row?.revokedAt).toBeNull();
  },
  "DELETE /v1/operator/workspaces/:workspaceId": async ({ operator: as, anna, sam, b }) => {
    const [target] = await owner.select().from(workspace).where(eq(workspace.id, b.id));
    const body = { name: target?.name ?? "" };
    // Not a member, then a member who is not an owner.
    expect((await as(anna, "DELETE", inWorkspace(b.id), body)).status).toBe(404);
    expect((await as(sam, "DELETE", inWorkspace(b.id), body)).status).toBe(403);
    const [after] = await owner.select().from(workspace).where(eq(workspace.id, b.id));
    expect(after?.deletedAt).toBeNull();
  },
  "GET /v1/operator/workspaces/:workspaceId/settings": async ({ operator: as, anna, a, b }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/settings"))).status).toBe(404);
    const text = await (await as(anna, "GET", inWorkspace(a.id, "/settings"))).text();
    expect(text).toContain(a.publicKey);
    expect(text).toContain(a.signingSecret);
    expect(text).not.toContain(b.publicKey);
    expect(text).not.toContain(b.signingSecret);
  },
  "PATCH /v1/operator/workspaces/:workspaceId/settings": async ({ operator: as, anna, a, b }) => {
    const body = { allowedOrigins: ["https://evil.example"] };
    expect((await as(anna, "PATCH", inWorkspace(b.id, "/settings"), body)).status).toBe(404);
    // A real change here must not reach the other workspace.
    await as(anna, "PATCH", inWorkspace(a.id, "/settings"), { allowedOrigins: [SITE_A] });
    const [row] = await owner.select().from(workspace).where(eq(workspace.id, b.id));
    expect(row?.allowedOrigins).toEqual([SITE_B]);
  },
  "POST /v1/operator/workspaces/:workspaceId/settings/rotate-secret": async (world) => {
    const { operator: as, anna, a, b } = world;
    expect((await as(anna, "POST", inWorkspace(b.id, "/settings/rotate-secret"), {})).status).toBe(
      404,
    );
    const made = await as(anna, "POST", inWorkspace(a.id, "/settings/rotate-secret"), {});
    a.signingSecret = ((await made.json()) as { signingSecret: string }).signingSecret;
    const [row] = await owner.select().from(workspace).where(eq(workspace.id, b.id));
    expect(row?.signingSecret).toBe(b.signingSecret);
    const [own] = await owner.select().from(workspace).where(eq(workspace.id, a.id));
    expect(own?.signingSecret).toBe(a.signingSecret);
  },
  "GET /v1/operator/workspaces/:workspaceId/alerts": async ({ operator: as, anna, b }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/alerts"))).status).toBe(404);
  },
  "PATCH /v1/operator/workspaces/:workspaceId/alerts": async ({
    operator: as,
    anna,
    bea,
    a,
    b,
  }) => {
    expect((await as(anna, "PATCH", inWorkspace(b.id, "/alerts"), { email: true })).status).toBe(
      404,
    );
    await as(anna, "PATCH", inWorkspace(a.id, "/alerts"), { email: true });
    const [row] = await owner
      .select()
      .from(workspaceMember)
      .where(eq(workspaceMember.operatorId, bea.id));
    expect(row?.alertEmail).toBe(false);
  },

  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/block": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    const path = `/conversations/${other.conversationId}/block`;
    expect((await as(anna, "POST", inWorkspace(a.id, path), {})).status).toBe(404);
    expect((await as(anna, "POST", inWorkspace(b.id, path), {})).status).toBe(404);
    const [row] = await owner.select().from(visitor).where(eq(visitor.id, other.id));
    expect(row?.blockedAt).toBeNull();
  },
  "DELETE /v1/operator/workspaces/:workspaceId/conversations/:conversationId/block": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    const path = `/conversations/${other.conversationId}/block`;
    await owner.update(visitor).set({ blockedAt: new Date() }).where(eq(visitor.id, other.id));
    expect((await as(anna, "DELETE", inWorkspace(a.id, path))).status).toBe(404);
    expect((await as(anna, "DELETE", inWorkspace(b.id, path))).status).toBe(404);
    const [row] = await owner.select().from(visitor).where(eq(visitor.id, other.id));
    expect(row?.blockedAt).toBeInstanceOf(Date);
    await owner.update(visitor).set({ blockedAt: null }).where(eq(visitor.id, other.id));
  },
  "DELETE /v1/operator/workspaces/:workspaceId/conversations/:conversationId": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    const path = `/conversations/${other.conversationId}`;
    expect((await as(anna, "DELETE", inWorkspace(a.id, path))).status).toBe(404);
    expect((await as(anna, "DELETE", inWorkspace(b.id, path))).status).toBe(404);
    const rows = await owner
      .select()
      .from(conversation)
      .where(eq(conversation.id, other.conversationId));
    expect(rows).toHaveLength(1);
    expect(
      await owner.select().from(message).where(eq(message.conversationId, other.conversationId)),
    ).not.toEqual([]);
  },

  "GET /v1/operator/workspaces/:workspaceId/blocked-visitors": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    await owner.update(visitor).set({ blockedAt: new Date() }).where(eq(visitor.id, other.id));
    expect((await as(anna, "GET", inWorkspace(b.id, "/blocked-visitors"))).status).toBe(404);
    const text = await (await as(anna, "GET", inWorkspace(a.id, "/blocked-visitors"))).text();
    expect(text).not.toContain(other.id);
    await owner.update(visitor).set({ blockedAt: null }).where(eq(visitor.id, other.id));
  },
  "DELETE /v1/operator/workspaces/:workspaceId/blocked-visitors/:visitorId": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    await owner.update(visitor).set({ blockedAt: new Date() }).where(eq(visitor.id, other.id));
    const path = `/blocked-visitors/${other.id}`;
    expect((await as(anna, "DELETE", inWorkspace(a.id, path))).status).toBe(404);
    expect((await as(anna, "DELETE", inWorkspace(b.id, path))).status).toBe(404);
    const [row] = await owner.select().from(visitor).where(eq(visitor.id, other.id));
    expect(row?.blockedAt).toBeInstanceOf(Date);
    await owner.update(visitor).set({ blockedAt: null }).where(eq(visitor.id, other.id));
  },

  "GET /v1/operator/workspaces/:workspaceId/export": async ({
    operator: as,
    anna,
    bea,
    decoy,
    a,
    b,
    one,
    other,
    secrets,
  }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/export"))).status).toBe(404);
    // A row in the other workspace, so a missing filter on this table has something to show.
    await owner
      .insert(emailStop)
      .values({ workspaceId: b.id, addressHash: `stop-of-${b.id}` })
      .onConflictDoNothing();
    const own = await as(anna, "GET", inWorkspace(a.id, "/export"));
    expect(own.status).toBe(200);
    const text = Buffer.from(await own.arrayBuffer()).toString("latin1");
    expect(text).toContain(one.id);
    expect(text).toContain(secrets.two);
    expect(text).not.toContain(other.id);
    expect(text).not.toContain(other.conversationId);
    expect(text).not.toContain(new URL(other.image.url).pathname.split("/").at(-1));
    expect(text).not.toContain(bea.id);
    expect(text).not.toContain(`stop-of-${b.id}`);
    // The first row in the table, which a query with no filter would take.
    expect(text).not.toContain(decoy.id);
    expect(text).toContain(a.publicKey);
    expect(text).not.toContain(secrets.b);
    expect(text).not.toContain(a.signingSecret);
  },

  // ---- Global routes, where the operator and the token decide everything.
  "PUT /v1/operator/push-subscription": async ({ operator: as, anna }) => {
    const body = {
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      keys: { p256dh: GOOD_P256DH, auth: GOOD_AUTH },
    };
    expect((await as(anna, "PUT", "/v1/operator/push-subscription", body)).status).toBe(200);
    const [row] = await owner
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.endpoint, body.endpoint));
    expect(row?.operatorId).toBe(anna.id);
  },
  "DELETE /v1/operator/push-subscription": async ({ operator: as, anna, bea }) => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    await owner
      .insert(pushSubscription)
      .values({ operatorId: bea.id, endpoint, p256dh: GOOD_P256DH, auth: GOOD_AUTH });
    expect((await as(anna, "DELETE", "/v1/operator/push-subscription", { endpoint })).status).toBe(
      200,
    );
    const rows = await owner
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.endpoint, endpoint));
    expect(rows).toHaveLength(1);
  },
  "POST /v1/operator/push-test": async ({ operator: as, anna }) => {
    const before = pushed.length;
    const mine = await owner
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.operatorId, anna.id));
    const response = await as(anna, "POST", "/v1/operator/push-test", {});
    expect(response.status).toBe(200);
    // Only Anna's devices, and Bea has one.
    expect(pushed.length - before).toBe(mine.length);
  },
  "POST /v1/invites/preview": async ({ server, inviteB, a, b, bea }) => {
    // A row in the other workspace whose token names this one, so the hash alone would match it.
    const token = `${a.id}.${randomUUID()}`;
    await owner.insert(invite).values({
      workspaceId: b.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      role: "agent",
      createdBy: bea.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const crossed = await server.request("/v1/invites/preview", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(crossed.status).toBe(404);
    const moved = inviteB.token.replace(inviteB.token.split(".")[0] ?? "", a.id);
    const response = await server.request("/v1/invites/preview", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token: moved }),
    });
    expect(response.status).toBe(404);
  },
  "POST /v1/invites/join": async ({ server, inviteB, a }) => {
    const email = `moved-${randomUUID()}@example.com`;
    const moved = inviteB.token.replace(inviteB.token.split(".")[0] ?? "", a.id);
    const response = await server.request("/v1/invites/join", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token: moved, name: "Mover", email }),
    });
    expect(response.status).toBe(404);
    expect(await owner.select().from(operator).where(eq(operator.email, email))).toEqual([]);
  },
  "POST /v1/invites/open": async ({ server, inviteB, a }) => {
    // A join link that names workspace A with workspace B's invite, as a tampered row would.
    const email = `opened-${randomUUID()}@example.com`;
    const token = randomUUID();
    await owner.insert(verification).values({
      identifier: `invite-join:${createHash("sha256").update(token).digest("hex")}`,
      value: JSON.stringify({
        workspaceId: a.id,
        inviteHash: createHash("sha256").update(inviteB.token).digest("hex"),
        name: "Mover",
        email,
        proven: true,
      }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const opened = await pressLinkButton(server, `${PUBLIC_URL}/link?for=join&token=${token}`);
    expect(opened.status).toBe(404);
    expect(await opened.json()).toMatchObject({ error: { code: "invite_invalid" } });
    expect(opened.headers.getSetCookie()).toEqual([]);
    expect(await owner.select().from(operator).where(eq(operator.email, email))).toEqual([]);
    const [row] = await owner.select().from(invite).where(eq(invite.id, inviteB.id));
    expect(row?.usedAt).toBeNull();
    // A made-up link opens nothing.
    const forged = await pressLinkButton(server, `${PUBLIC_URL}/link?for=join&token=forged`);
    expect(await forged.json()).toMatchObject({ error: { code: "link_invalid" } });
  },
  "POST /v1/operator/invites/accept": async ({ operator: as, anna, a, inviteB }) => {
    const moved = inviteB.token.replace(inviteB.token.split(".")[0] ?? "", a.id);
    expect((await as(anna, "POST", "/v1/operator/invites/accept", { token: moved })).status).toBe(
      409,
    );
    const [row] = await owner.select().from(invite).where(eq(invite.id, inviteB.id));
    expect(row?.usedAt).toBeNull();
  },
};

const pushed: string[] = [];
const signer = createImages({
  store: localStore(tmpdir()),
  secret: AUTH_SECRET,
  publicUrl: PUBLIC_URL,
});

async function buildWorld(db: Database): Promise<World> {
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const server = createApp({
    alerts: {
      push: createPush(pushKeys, (async (url: string) => {
        pushed.push(url);
        return new Response(null, { status: 201 });
      }) as typeof fetch),
      emailAvailable: true,
      secret: AUTH_SECRET,
    },
    auth,
    db,
    images: createImages({
      store: localStore(await mkdtemp(join(tmpdir(), "dinghy-isolation-"))),
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    }),
    logger,
    checks: { postgres: async () => {}, valkey: async () => {} },
    stream: { heartbeatMs: 25_000, lifetimeMs: 60_000 },
  });
  const decoy = await createWorkspace(db, "Decoy", [SITE_A, SITE_B]);
  await owner
    .update(workspace)
    .set({ feedGeneration: 7, eventSeq: 5000n })
    .where(eq(workspace.id, decoy.id));
  const a = await createWorkspace(db, "Acme", [SITE_A]);
  const b = await createWorkspace(db, "Beta", [SITE_B]);

  const person = (workspaceId: string, name: string) =>
    signedInOperator({
      app: server,
      auth,
      owner,
      email: `${name.toLowerCase()}-${randomUUID()}@example.com`,
      name,
      workspaceId,
    });

  const widget: World["widget"] = (key, method, path, token, origin, body) =>
    Promise.resolve(
      server.request(`/v1/widget/${key}/${path}`, {
        method,
        headers: {
          origin,
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const visitorIn = async (space: NewWorkspace, site: string, text: string) => {
    const created = await widget(space.publicKey, "POST", "visitors", null, site);
    const { visitorId, token } = (await created.json()) as { visitorId: string; token: string };
    const sent = await widget(space.publicKey, "POST", "messages", token, site, {
      clientId: randomUUID(),
      body: text,
    });
    const { conversationId } = (await sent.json()) as { conversationId: string };
    const uploaded = await server.request(
      `/v1/widget/${space.publicKey}/images?clientId=${randomUUID()}`,
      {
        method: "POST",
        headers: { origin: site, authorization: `Bearer ${token}`, "content-type": "image/png" },
        body: await png(),
      },
    );
    const { image } = (await uploaded.json()) as { image: { url: string } };
    // A page in the visitor's journey, whose title holds their secret.
    await widget(space.publicKey, "POST", "page", token, site, {
      page: `${site}/journey`,
      title: `${text}, the page`,
    });
    return { id: visitorId, token, conversationId, image };
  };

  const anna = await person(a.id, "Anna");
  const bea = await person(b.id, "Bea");
  const sam = await person(a.id, "Sam");
  await owner
    .insert(workspaceMember)
    .values({ workspaceId: b.id, operatorId: sam.id, role: "admin", alertEmail: false });
  const operatorCall: World["operator"] = (as, method, path, body) =>
    Promise.resolve(
      server.request(path, {
        method,
        headers: {
          cookie: as.cookie,
          origin: ORIGIN,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  await owner.insert(pushSubscription).values({
    operatorId: bea.id,
    endpoint: `https://fcm.googleapis.com/fcm/send/bea-${randomUUID()}`,
    p256dh:
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    auth: "tBHItJI5svbpez7KI4CCXg",
  });
  const madeInvite = await operatorCall(bea, "POST", inWorkspace(b.id, "/invites"), {
    role: "agent",
  });
  return {
    server,
    a,
    b,
    anna,
    bea,
    sam,
    decoy,
    one: await visitorIn(a, SITE_A, "written by one"),
    two: await visitorIn(a, SITE_A, "written by two, in the same workspace"),
    other: await visitorIn(b, SITE_B, "written in the other workspace"),
    inviteB: (await madeInvite.json()) as { id: string; token: string },
    secrets: { two: "written by two", b: "written in the other workspace" },
    widget,
    operator: operatorCall,
  };
}

describe.each([
  ["the app role, with row-level security", "app"],
  ["a BYPASSRLS role, so only the application's own filters protect the data", "bypass"],
] as const)("as %s", (_name, kind) => {
  let world: World;
  let bSeqAtStart: bigint | undefined;

  beforeAll(async () => {
    world = await buildWorld(
      kind === "app" ? database.connect("app", 10).db : database.connectBypass("app"),
    );
    bSeqAtStart = (await owner.select().from(workspace).where(eq(workspace.id, world.b.id)))[0]
      ?.eventSeq;
  }, 30_000);

  test.each(Object.keys(ATTACKS))("%s", async (route) => {
    await ATTACKS[route]?.(world);
  });

  test("the attacks moved nothing in the other workspace", async () => {
    const { b } = world;
    const [row] = await owner.select().from(workspace).where(eq(workspace.id, b.id));
    expect(row?.eventSeq).toBe(bSeqAtStart);
    const inB = await owner.select().from(message).where(eq(message.workspaceId, b.id));
    expect(inB.map((one) => one.body).filter((body) => body?.includes("crossing"))).toEqual([]);
  });

  const memberOf = async (workspaceId: string, operatorId: string) =>
    (
      await owner
        .select()
        .from(workspaceMember)
        .where(
          and(
            eq(workspaceMember.workspaceId, workspaceId),
            eq(workspaceMember.operatorId, operatorId),
          ),
        )
    )[0];

  describe("an operator in both workspaces", () => {
    test("alert settings stay in their workspace", async () => {
      const { operator: as, sam, a, b } = world;
      await as(sam, "PATCH", inWorkspace(a.id, "/alerts"), { email: true });
      expect((await memberOf(a.id, sam.id))?.alertEmail).toBe(true);
      expect((await memberOf(b.id, sam.id))?.alertEmail).toBe(false);
      const there = await as(sam, "GET", inWorkspace(b.id, "/alerts"));
      expect(((await there.json()) as { email: boolean }).email).toBe(false);
      await as(sam, "PATCH", inWorkspace(a.id, "/alerts"), { email: false });
    });

    test("a role change stays in its workspace, and so does the role that allows it", async () => {
      const { operator: as, anna, sam, a, b } = world;
      await as(anna, "PATCH", inWorkspace(a.id, `/members/${sam.id}`), { role: "agent" });
      expect((await memberOf(a.id, sam.id))?.role).toBe("agent");
      expect((await memberOf(b.id, sam.id))?.role).toBe("admin");
      // An agent here may not invite here, and an admin there still may invite there.
      expect((await as(sam, "POST", inWorkspace(a.id, "/invites"), { role: "agent" })).status).toBe(
        403,
      );
      expect((await as(sam, "POST", inWorkspace(b.id, "/invites"), { role: "agent" })).status).toBe(
        201,
      );
      await as(anna, "PATCH", inWorkspace(a.id, `/members/${sam.id}`), { role: "owner" });
    });

    test("removal and its revoked links stay in their workspace", async () => {
      const { operator: as, anna, sam, a, b } = world;
      const here = await as(sam, "POST", inWorkspace(a.id, "/invites"), { role: "agent" });
      const hereId = ((await here.json()) as { id: string }).id;
      const there = await as(sam, "POST", inWorkspace(b.id, "/invites"), { role: "agent" });
      const thereId = ((await there.json()) as { id: string }).id;

      await as(anna, "DELETE", inWorkspace(a.id, `/members/${sam.id}`));
      expect((await memberOf(a.id, sam.id))?.removedAt).toBeInstanceOf(Date);
      expect((await memberOf(b.id, sam.id))?.removedAt).toBeNull();
      const revoked = async (id: string) =>
        (await owner.select().from(invite).where(eq(invite.id, id)))[0]?.revokedAt;
      expect(await revoked(hereId)).toBeInstanceOf(Date);
      expect(await revoked(thereId)).toBeNull();

      // Still a member there means no assignment here, and no invite here.
      const id = world.one.conversationId;
      expect(
        (
          await as(anna, "PUT", inWorkspace(a.id, `/conversations/${id}/assignee`), {
            operatorId: sam.id,
          })
        ).status,
      ).toBe(400);
      expect((await as(sam, "POST", inWorkspace(a.id, "/invites"), { role: "agent" })).status).toBe(
        404,
      );
      await owner
        .update(workspaceMember)
        .set({ removedAt: null, role: "owner" })
        .where(and(eq(workspaceMember.workspaceId, a.id), eq(workspaceMember.operatorId, sam.id)));
    });
  });

  test("a member of another workspace can still join this one by invite", async () => {
    const { operator: as, anna, bea, a } = world;
    const made = await as(anna, "POST", inWorkspace(a.id, "/invites"), { role: "agent" });
    const { token } = (await made.json()) as { token: string };
    const accepted = await as(bea, "POST", "/v1/operator/invites/accept", { token });
    expect(accepted.status).toBe(200);
    await owner
      .delete(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, a.id), eq(workspaceMember.operatorId, bea.id)));
  });

  test("one host user ID in two workspaces is two separate visitors", async () => {
    const { widget, a, b } = world;
    const signed = (space: NewWorkspace) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ email: `${space.id}@example.com` })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience(space.publicKey)
        .setSubject("same-user")
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(new TextEncoder().encode(space.signingSecret));
    };
    // The rotate attack replaced this workspace's secret in the world, so this token is current.
    const tokenA = await signed(a);
    const tokenB = await signed(b);
    const inA = await widget(a.publicKey, "POST", "messages", tokenA, SITE_A, {
      clientId: randomUUID(),
      body: "same user, first workspace",
    });
    expect(inA.status).toBeLessThan(300);
    const inB = await widget(b.publicKey, "POST", "messages", tokenB, SITE_B, {
      clientId: randomUUID(),
      body: "same user, second workspace",
    });
    expect(inB.status).toBeLessThan(300);
    const rows = await owner.select().from(visitor).where(eq(visitor.externalId, "same-user"));
    const here = rows.filter((row) => row.workspaceId === a.id);
    const there = rows.filter((row) => row.workspaceId === b.id);
    expect(here).toHaveLength(1);
    expect(there).toHaveLength(1);
    expect(here[0]?.id).not.toBe(there[0]?.id);
    const read = await widget(a.publicKey, "GET", "messages", tokenA, SITE_A);
    expect(await read.text()).not.toContain("second workspace");
  });

  test("each feed's cursor comes from its own workspace", async () => {
    const { widget, operator: as, anna, a, one } = world;
    const visitorRead = await widget(a.publicKey, "GET", "stream", one.token, SITE_A);
    expect(await readStream(visitorRead)).toMatch(/"cursor":"1\./);
    const operatorRead = await as(anna, "GET", inWorkspace(a.id, "/stream"));
    expect(await readStream(operatorRead)).toMatch(/"cursor":"1\.(?!5000)/);
  });

  test("a client behind one workspace's pruned feed gets resync, whatever the others hold", async () => {
    const { operator: as, anna, a } = world;
    await owner.delete(event).where(eq(event.workspaceId, a.id));
    const opened = await as(anna, "GET", inWorkspace(a.id, "/stream?after=1.1"));
    expect(await readStream(opened, "event: resync")).toContain("event: resync");
  });

  test("nothing in this run moved the decoy workspace", async () => {
    const [row] = await owner.select().from(workspace).where(eq(workspace.id, world.decoy.id));
    expect(row?.eventSeq).toBe(5000n);
  });

  test("the role is what this run says it is", async () => {
    const db = kind === "app" ? database.connect("app", 1).db : database.connectBypass("app");
    const result = await db.execute<{ rolbypassrls: boolean }>(
      sql`select rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(result.rows[0]?.rolbypassrls).toBe(kind === "bypass");
  });
});

describe("the list of routes", () => {
  test("every route in the router has an attack, and every attack has a route", async () => {
    const db = database.connect("app", 1).db;
    const server = createApp({
      alerts: { emailAvailable: true, secret: AUTH_SECRET },
      auth: createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL }),
      db,
      images: createImages({
        store: localStore(tmpdir()),
        secret: AUTH_SECRET,
        publicUrl: PUBLIC_URL,
      }),
      logger,
      checks: { postgres: async () => {}, valkey: async () => {} },
    });
    const routes = server.routes
      // Sign-in lives in the auth library, and its tables are global, with no tenant data.
      .filter((route) => route.method !== "ALL" && route.method !== "OPTIONS")
      .filter((route) => route.path.startsWith("/v1/") && !route.path.startsWith("/v1/auth/"))
      .map((route) => `${route.method} ${route.path}`);
    expect([...new Set(routes)].sort()).toEqual(Object.keys(ATTACKS).sort());
  });

  test("a sign-in link signs in only its own operator, who sees only their own workspaces", async () => {
    const db = database.connect("app", 2).db;
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const server = createApp({
      auth,
      db,
      logger,
      checks: { postgres: async () => {}, valkey: async () => {} },
    });
    const a = await createWorkspace(db, "Link A", [SITE_A]);
    const b = await createWorkspace(db, "Link B", [SITE_A]);
    const anna = await signedInOperator({
      app: server,
      auth,
      owner,
      email: `link-anna-${randomUUID()}@example.com`,
      workspaceId: a.id,
    });
    await signedInOperator({
      app: server,
      auth,
      owner,
      email: `link-bea-${randomUUID()}@example.com`,
      workspaceId: b.id,
    });
    const me = await server.request("/v1/operator/me", { headers: { cookie: anna.cookie } });
    const body = (await me.json()) as { id: string; workspaces: { workspaceId: string }[] };
    expect(body.id).toBe(anna.id);
    expect(body.workspaces.map((one) => one.workspaceId)).toEqual([a.id]);
    // The link route answers the same for any email, so it tells nobody about another tenant.
    const ask = (email: string) =>
      server.request("/v1/auth/sign-in/magic-link", {
        method: "POST",
        headers: { origin: new URL(PUBLIC_URL).origin, "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    expect(await (await ask(anna.email)).text()).toBe(
      await (await ask(`nobody-${randomUUID()}@example.com`)).text(),
    );
  });
});

describe("the worker with no row-level security", () => {
  test("an alert uses its own workspace's name and message", async () => {
    const worker = database.connectBypass("worker");
    const app = database.connect("app", 2).db;
    await createWorkspace(app, "A workspace made first", [SITE_A]);
    const space = await createWorkspace(app, "The right workspace", [SITE_A]);
    const [row] = await owner
      .insert(operator)
      .values({ name: "W", email: `w-${randomUUID()}@example.com`, emailVerified: true })
      .returning({ id: operator.id });
    const operatorId = row?.id ?? "";
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: space.id, operatorId, role: "owner" });
    await owner.insert(pushSubscription).values({
      operatorId,
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: "p",
      auth: "a",
    });
    const visitorId = randomUUID();
    await owner
      .insert(visitor)
      .values({ workspaceId: space.id, id: visitorId, tokenHash: randomUUID() });
    await withWorkspace(app, space.id, (tx) =>
      appendMessage(
        tx,
        space.id,
        { kind: "visitor", visitorId },
        {
          clientId: randomUUID(),
          body: "Hello",
        },
      ),
    );
    while (await fanOutOne(worker, { push: true, email: false }));
    const claims = await claimDeliveries(worker, 50, 60_000);
    const mine = claims.find((claim) => claim.workspaceId === space.id);
    if (mine === undefined) throw new Error("No claim for this workspace");
    const plan = await planDelivery(worker, mine, { publicUrl: PUBLIC_URL, secret: AUTH_SECRET });
    expect(plan?.channel === "push" && plan.payload.title).toBe("The right workspace");
  });
});
