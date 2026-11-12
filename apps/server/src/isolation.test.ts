import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { SignJWT } from "jose";
import { pino } from "pino";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateVAPIDKeys } from "web-push";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { pressLinkButton, signedInOperator } from "../test/operators.ts";
import { claimDeliveries, fanOutOne, planDelivery } from "./alerts.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import {
  apiKey,
  attachment,
  conversation,
  draftReply,
  emailStop,
  event,
  invite,
  message,
  note,
  operator,
  operatorPicture,
  pageView,
  pushSubscription,
  verification,
  visitor,
  webhook,
  widgetSettings,
  workspace,
  workspaceLogo,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import { visitorAuthorId } from "./identity.ts";
import { createImages } from "./images.ts";
import { appendMessage } from "./messages.ts";
import { createPush } from "./push.ts";
import { localStore } from "./storage.ts";
import { emailStopUrl } from "./visitor-email.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const SITE_A = "https://a.example.com";
const SITE_B = "https://b.example.com";
const GOOD_P256DH =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const GOOD_AUTH = "tBHItJI5svbpez7KI4CCXg";
const logger = pino({ level: "silent" });
const pushKeys = { ...generateVAPIDKeys(), subject: "mailto:hello@dinghy.chat" };

let database: TestDatabase;
let owner: Database;

// The live view lives in Valkey, so the beat's attacks need a real one.
const valkey = new Redis(VALKEY_URL, { lazyConnect: true });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  owner = database.connect("migrator").db;
});

afterAll(async () => {
  valkey.disconnect();
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

/** A body that invites a new email as a member. */
const invitation = () => ({ email: `invited-${randomUUID()}@example.com`, role: "member" });

interface World {
  server: App;
  a: NewWorkspace;
  b: NewWorkspace;
  anna: { id: string; email: string; cookie: string };
  bea: { id: string; email: string; cookie: string };
  /** In both workspaces, so a query that filters only by operator reaches the wrong row. */
  sam: { id: string; cookie: string };
  /** Made first, so a query with no filter that takes the first row gets this one. */
  decoy: NewWorkspace;
  one: VisitorWorld;
  two: VisitorWorld;
  other: VisitorWorld;
  inviteB: { id: string; email: string; token: string };
  /** An API key in each workspace, and a webhook in the other one. */
  keyA: { id: string; token: string };
  keyB: { id: string; token: string };
  hookB: { id: string; secret: string; url: string };
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
  /** A request with an API key, as a script sends it: a bearer header and no Origin. */
  withKey(token: string, method: string, path: string, body?: unknown): Promise<Response>;
}

const inWorkspace = (id: string, path = "") => `/v1/operator/workspaces/${id}${path}`;

/** A draft by the key, waiting in the conversation, written straight to the database. */
async function draftIn(workspaceId: string, conversationId: string, apiKeyId: string) {
  const [row] = await owner
    .insert(draftReply)
    .values({ workspaceId, conversationId, apiKeyId, clientId: randomUUID(), body: "a draft" })
    .returning({ id: draftReply.id });
  return row?.id ?? "";
}

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

/** Sets a workspace's logo straight in the table, with bytes that name the workspace. */
const plantLogo = (workspaceId: string) =>
  owner
    .insert(workspaceLogo)
    .values({ workspaceId, data: Buffer.from(`logo of ${workspaceId}`) })
    .onConflictDoNothing();

const logoOf = async (workspaceId: string) =>
  (await owner.select().from(workspaceLogo).where(eq(workspaceLogo.workspaceId, workspaceId)))[0];

const widgetSettingsOf = async (workspaceId: string) =>
  (await owner.select().from(widgetSettings).where(eq(widgetSettings.workspaceId, workspaceId)))[0];

const pictureOf = async (operatorId: string) =>
  (await owner.select().from(operatorPicture).where(eq(operatorPicture.operatorId, operatorId)))[0];

/** A conversation's first message, read past row-level security. */
const firstMessageOf = async (conversationId: string) => {
  const [row] = await owner
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(message.seq)
    .limit(1);
  if (row === undefined) throw new Error("The conversation has no message");
  return row;
};

/** Another workspace's message, through this workspace's path and through the other's. */
const crossedMessagePaths = (mine: string, theirs: string, conversationId: string, id: string) => [
  inWorkspace(mine, `/conversations/${conversationId}/messages/${id}`),
  inWorkspace(theirs, `/conversations/${conversationId}/messages/${id}`),
];

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
  "GET /v1/widget/:key/presence": async ({ widget, operator: as, a, b, anna }) => {
    expect((await widget(a.publicKey, "GET", "presence", null, SITE_B)).status).toBe(403);
    // Online in one workspace is not online in another.
    const beat = { viewing: null, left: null, hidden: false };
    expect((await as(anna, "PUT", inWorkspace(a.id, "/presence"), beat)).status).toBe(200);
    const own = await widget(b.publicKey, "GET", "presence", null, SITE_B);
    const body = (await own.json()) as { members: string[] };
    expect(Object.keys(body)).toEqual(["online", "members", "emailReplies", "replySeconds"]);
    expect(body.members).not.toContain(visitorAuthorId(anna.id));
  },
  "GET /v1/widget/:key/appearance": async ({ server, a, b, secrets }) => {
    await owner
      .update(widgetSettings)
      .set({ title: `title of ${b.id}` })
      .where(eq(widgetSettings.workspaceId, b.id));
    const text = await (await server.request(`/v1/widget/${a.publicKey}/appearance`)).text();
    expect(text).not.toContain(b.id);
    expect(text).not.toContain(secrets.b);
    // Members' first names and pictures only, never an email.
    expect(text).not.toContain("@");
    // The public key is the only way in: an ID in its place finds nothing.
    expect((await server.request(`/v1/widget/${b.id}/appearance`)).status).toBe(404);
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
  "GET /v1/operator/waiting": async ({ operator: as, anna, a, b }) => {
    const { workspaces } = (await (await as(anna, "GET", "/v1/operator/waiting")).json()) as {
      workspaces: { workspaceId: string }[];
    };
    expect(workspaces.map((one) => one.workspaceId)).toContain(a.id);
    expect(workspaces.map((one) => one.workspaceId)).not.toContain(b.id);
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
  "PATCH /v1/operator/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId":
    async ({ operator: as, anna, a, b, one, other }) => {
      const target = await firstMessageOf(other.conversationId);
      for (const path of crossedMessagePaths(a.id, b.id, other.conversationId, target.id)) {
        expect((await as(anna, "PATCH", path, { body: "changed across" })).status).toBe(404);
      }
      // A quote cannot reach into the other workspace either.
      const quoted = await as(
        anna,
        "POST",
        inWorkspace(a.id, `/conversations/${one.conversationId}/messages`),
        {
          clientId: randomUUID(),
          body: "quoting across",
          replyToMessageId: target.id,
        },
      );
      expect(quoted.status).toBe(400);
      expect((await firstMessageOf(other.conversationId)).body).toBe(target.body);
    },
  "DELETE /v1/operator/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId":
    async ({ operator: as, anna, a, b, other }) => {
      const target = await firstMessageOf(other.conversationId);
      for (const path of crossedMessagePaths(a.id, b.id, other.conversationId, target.id)) {
        expect((await as(anna, "DELETE", path)).status).toBe(404);
      }
      expect((await firstMessageOf(other.conversationId)).deletedAt).toBeNull();
    },
  "GET /v1/operator/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/receipt":
    async ({ operator: as, anna, a, b, other }) => {
      const target = await firstMessageOf(other.conversationId);
      for (const path of crossedMessagePaths(a.id, b.id, other.conversationId, target.id)) {
        expect((await as(anna, "GET", `${path}/receipt`)).status).toBe(404);
      }
    },
  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/transcript": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    const here = inWorkspace(a.id, `/conversations/${other.conversationId}/transcript`);
    const there = inWorkspace(b.id, `/conversations/${other.conversationId}/transcript`);
    for (const path of [here, there]) {
      expect((await as(anna, "POST", path, {})).status).toBe(404);
    }
    const requested = await owner
      .select()
      .from(event)
      .where(and(eq(event.workspaceId, b.id), eq(event.kind, "transcript.requested")));
    expect(requested).toEqual([]);
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
    const body = { viewing: null, left: null, hidden: false };
    expect((await as(anna, "PUT", inWorkspace(b.id, "/presence"), body)).status).toBe(404);
  },
  "POST /v1/operator/workspaces/:workspaceId/presence/leave": async ({ operator: as, anna, b }) => {
    const body = { conversationId: null, signingOut: true };
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
    const role = { role: "member" };
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
    const body = { email: `invited-${randomUUID()}@example.com`, role: "member" };
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
  "PATCH /v1/operator/workspaces/:workspaceId": async ({ operator: as, anna, a, b }) => {
    expect((await as(anna, "PATCH", inWorkspace(b.id, ""), { name: "Taken" })).status).toBe(404);
    // A real rename here must not reach the other workspace.
    expect((await as(anna, "PATCH", inWorkspace(a.id, ""), { name: "Acme Two" })).status).toBe(200);
    const [row] = await owner.select().from(workspace).where(eq(workspace.id, b.id));
    expect(row?.name).toBe("Beta");
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
  "GET /v1/operator/workspaces/:workspaceId/widget": async ({ operator: as, anna, a, b }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/widget"))).status).toBe(404);
    const own = await as(anna, "GET", inWorkspace(a.id, "/widget"));
    expect(own.status).toBe(200);
    expect(await own.text()).not.toContain(b.id);
  },
  "PUT /v1/operator/workspaces/:workspaceId/widget": async ({ operator: as, anna, a, b }) => {
    const before = await widgetSettingsOf(b.id);
    const read = await as(anna, "GET", inWorkspace(a.id, "/widget"));
    const {
      logoUrl: _logo,
      team: _team,
      ...settings
    } = (await read.json()) as Record<string, unknown>;
    const body = { ...settings, title: "Crossing over" };
    expect((await as(anna, "PUT", inWorkspace(b.id, "/widget"), body)).status).toBe(404);
    // A real change here must not reach the other workspace.
    expect((await as(anna, "PUT", inWorkspace(a.id, "/widget"), body)).status).toBe(200);
    expect(await widgetSettingsOf(b.id)).toEqual(before);
  },
  "PUT /v1/operator/workspaces/:workspaceId/widget/logo": async ({ server, anna, a, b }) => {
    const upload = async (workspaceId: string) =>
      server.request(inWorkspace(workspaceId, "/widget/logo"), {
        method: "PUT",
        headers: { cookie: anna.cookie, origin: ORIGIN, "content-type": "image/png" },
        body: await png(),
      });
    const before = await logoOf(b.id);
    expect((await upload(b.id)).status).toBe(404);
    // A real upload here must not reach the other workspace.
    const own = await upload(a.id);
    expect(own.status).toBe(200);
    expect(await own.text()).not.toContain(b.publicKey);
    expect(await logoOf(b.id)).toEqual(before);
  },
  "DELETE /v1/operator/workspaces/:workspaceId/widget/logo": async ({
    operator: as,
    anna,
    a,
    b,
  }) => {
    await plantLogo(b.id);
    expect((await as(anna, "DELETE", inWorkspace(b.id, "/widget/logo"))).status).toBe(404);
    expect((await as(anna, "DELETE", inWorkspace(a.id, "/widget/logo"))).status).toBe(200);
    expect(await logoOf(b.id)).toBeDefined();
  },
  "PUT /v1/operator/me/picture": async ({ server, anna, bea }) => {
    const response = await server.request("/v1/operator/me/picture", {
      method: "PUT",
      headers: { cookie: anna.cookie, origin: ORIGIN, "content-type": "image/png" },
      body: await png(),
    });
    expect(response.status).toBe(200);
    // Only the caller's own picture changes.
    expect(await pictureOf(anna.id)).toBeDefined();
    expect(await pictureOf(bea.id)).toBeUndefined();
  },
  "PUT /v1/operator/me/status": async ({ operator: as, anna, bea }) => {
    expect((await as(anna, "PUT", "/v1/operator/me/status", { away: true })).status).toBe(200);
    // Only the caller's own status changes.
    const [other] = await owner
      .select({ away: operator.away })
      .from(operator)
      .where(eq(operator.id, bea.id));
    expect(other?.away).toBe(false);
    await as(anna, "PUT", "/v1/operator/me/status", { away: false });
  },
  "DELETE /v1/operator/me/picture": async ({ operator: as, anna, bea }) => {
    await owner
      .insert(operatorPicture)
      .values({ operatorId: bea.id, data: Buffer.from("bea") })
      .onConflictDoNothing();
    expect((await as(anna, "DELETE", "/v1/operator/me/picture")).status).toBe(200);
    expect(await pictureOf(bea.id)).toBeDefined();
  },
  "GET /v1/pictures/:operatorId": async ({ server, anna, bea }) => {
    await owner
      .insert(operatorPicture)
      .values({ operatorId: bea.id, data: Buffer.from(`picture of ${bea.id}`) })
      .onConflictDoNothing();
    const served = await server.request(`/v1/pictures/${bea.id}`);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(
      Buffer.from((await pictureOf(bea.id))?.data ?? []),
    );
    expect(await (await server.request(`/v1/pictures/${anna.id}x`)).text()).not.toContain(bea.id);
  },
  "GET /v1/widget/:key/logo": async ({ server, a, b }) => {
    await plantLogo(a.id);
    await plantLogo(b.id);
    const own = await server.request(`/v1/widget/${a.publicKey}/logo`);
    expect(Buffer.from(await own.arrayBuffer())).toEqual(
      Buffer.from((await logoOf(a.id))?.data ?? []),
    );
    // The public key is the only way in: an ID in its place finds nothing.
    expect((await server.request(`/v1/widget/${b.id}/logo`)).status).toBe(404);
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

  "POST /v1/widget/:key/beat": async ({ widget, operator: as, anna, a, b, one }) => {
    const tab = `iso${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const body = { tab, page: `${SITE_B}/secret-page` };
    // B's site beating into B: A's operators must not see it.
    expect((await widget(b.publicKey, "POST", "beat", null, SITE_B, body)).status).toBe(200);
    expect(await (await as(anna, "GET", inWorkspace(a.id, "/visitors/live"))).text()).not.toContain(
      tab,
    );
    // A's token sent to B's key counts the tab in B with no visitor of A's.
    expect((await widget(b.publicKey, "POST", "beat", one.token, SITE_B, body)).status).toBe(200);
    const [row] = await owner.select().from(visitor).where(eq(visitor.id, one.id));
    expect(row?.country ?? null).toBeNull();
  },
  "POST /v1/widget/:key/leave": async ({ widget, operator: as, anna, a, b }) => {
    const tab = `iso${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    expect(
      (await widget(a.publicKey, "POST", "beat", null, SITE_A, { tab, page: `${SITE_A}/x` }))
        .status,
    ).toBe(200);
    // A leave sent to B's key leaves A's tab alone.
    expect((await widget(b.publicKey, "POST", `leave?tab=${tab}`, null, SITE_B)).status).toBe(200);
    expect(await (await as(anna, "GET", inWorkspace(a.id, "/visitors/live"))).text()).toContain(
      tab,
    );
  },
  "GET /v1/operator/workspaces/:workspaceId/get-started": async ({ operator: as, anna, a, b }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/get-started"))).status).toBe(404);
    expect((await as(anna, "GET", inWorkspace(a.id, "/get-started"))).status).toBe(200);
  },
  "POST /v1/operator/workspaces/:workspaceId/get-started/dismiss": async ({
    operator: as,
    anna,
    bea,
    b,
  }) => {
    expect((await as(anna, "POST", inWorkspace(b.id, "/get-started/dismiss"))).status).toBe(404);
    const [row] = await owner
      .select({ dismissed: workspaceMember.getStartedDismissedAt })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, b.id), eq(workspaceMember.operatorId, bea.id)));
    expect(row?.dismissed ?? null).toBeNull();
  },
  "GET /v1/operator/workspaces/:workspaceId/visitors/live": async ({ operator: as, anna, b }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/visitors/live"))).status).toBe(404);
  },
  "GET /v1/operator/workspaces/:workspaceId/visitors/live/count": async ({
    operator: as,
    anna,
    b,
  }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/visitors/live/count"))).status).toBe(404);
  },
  "POST /v1/widget/:key/typing": async ({ widget, a, b, one, other }) => {
    const draft = { draft: "half a message" };
    expect((await widget(b.publicKey, "POST", "typing", one.token, SITE_B, draft)).status).toBe(
      401,
    );
    expect((await widget(a.publicKey, "POST", "typing", other.token, SITE_A, draft)).status).toBe(
      401,
    );
    expect((await widget(a.publicKey, "POST", "typing", one.token, SITE_A, draft)).status).toBe(
      200,
    );
  },
  "PUT /v1/operator/workspaces/:workspaceId/widget/typing-preview": async ({
    operator: as,
    anna,
    a,
    b,
  }) => {
    const before = await widgetSettingsOf(b.id);
    const path = "/widget/typing-preview";
    expect((await as(anna, "PUT", inWorkspace(b.id, path), { enabled: false })).status).toBe(404);
    expect((await as(anna, "PUT", inWorkspace(a.id, path), { enabled: false })).status).toBe(200);
    expect(await widgetSettingsOf(b.id)).toEqual(before);
    await as(anna, "PUT", inWorkspace(a.id, path), { enabled: true });
  },
  "GET /v1/operator/workspaces/:workspaceId/contacts": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    expect((await as(anna, "GET", inWorkspace(b.id, "/contacts"))).status).toBe(404);
    const text = await (await as(anna, "GET", inWorkspace(a.id, "/contacts?limit=100"))).text();
    expect(text).not.toContain(other.id);
  },
  "GET /v1/operator/workspaces/:workspaceId/contacts/export": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    const email = `other-${other.id}@example.com`;
    await owner.update(visitor).set({ email }).where(eq(visitor.id, other.id));
    expect((await as(anna, "GET", inWorkspace(b.id, "/contacts/export"))).status).toBe(404);
    const text = await (await as(anna, "GET", inWorkspace(a.id, "/contacts/export"))).text();
    expect(text.startsWith("name,email")).toBe(true);
    expect(text).not.toContain(email);
  },
  "GET /v1/operator/workspaces/:workspaceId/contacts/:visitorId": async ({
    operator: as,
    anna,
    a,
    b,
    one,
    other,
  }) => {
    expect((await as(anna, "GET", inWorkspace(a.id, `/contacts/${other.id}`))).status).toBe(404);
    expect((await as(anna, "GET", inWorkspace(b.id, `/contacts/${other.id}`))).status).toBe(404);
    expect((await as(anna, "GET", inWorkspace(a.id, `/contacts/${one.id}`))).status).toBe(200);
  },
  "PATCH /v1/operator/workspaces/:workspaceId/contacts/:visitorId": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    const noteOf = async () =>
      (await owner.select().from(visitor).where(eq(visitor.id, other.id)))[0]?.note;
    const before = await noteOf();
    const change = { note: "Crossing over", name: "Moved" };
    expect(
      (await as(anna, "PATCH", inWorkspace(a.id, `/contacts/${other.id}`), change)).status,
    ).toBe(404);
    expect(
      (await as(anna, "PATCH", inWorkspace(b.id, `/contacts/${other.id}`), change)).status,
    ).toBe(404);
    expect(await noteOf()).toBe(before);
  },
  "DELETE /v1/operator/workspaces/:workspaceId/contacts/:visitorId": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    expect((await as(anna, "DELETE", inWorkspace(a.id, `/contacts/${other.id}`))).status).toBe(404);
    expect((await as(anna, "DELETE", inWorkspace(b.id, `/contacts/${other.id}`))).status).toBe(404);
    expect(await owner.select().from(visitor).where(eq(visitor.id, other.id))).toHaveLength(1);
    expect(
      await owner.select().from(conversation).where(eq(conversation.id, other.conversationId)),
    ).toHaveLength(1);
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
      role: "member",
      email: `crossed-${randomUUID()}@example.com`,
      mailed: false,
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
    const moved = inviteB.token.replace(inviteB.token.split(".")[0] ?? "", a.id);
    const response = await server.request("/v1/invites/join", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token: moved, name: "Mover" }),
    });
    expect(response.status).toBe(404);
    const invited = await owner.select().from(operator).where(eq(operator.email, inviteB.email));
    expect(invited).toEqual([]);
  },
  "POST /v1/invites/open": async ({ server, inviteB, a, bea }) => {
    // A join link that names workspace A with workspace B's invite, as a tampered row would.
    const token = randomUUID();
    await owner.insert(verification).values({
      identifier: `invite-join:${createHash("sha256").update(token).digest("hex")}`,
      value: JSON.stringify({
        workspaceId: a.id,
        inviteHash: createHash("sha256").update(inviteB.token).digest("hex"),
        name: "Mover",
        email: bea.email,
      }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const opened = await pressLinkButton(server, `${PUBLIC_URL}/link?for=join&token=${token}`);
    expect(opened.status).toBe(404);
    expect(await opened.json()).toMatchObject({ error: { code: "invite_invalid" } });
    expect(opened.headers.getSetCookie()).toEqual([]);
    const joined = await owner
      .select()
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, a.id), eq(workspaceMember.operatorId, bea.id)));
    expect(joined).toEqual([]);
    const [row] = await owner.select().from(invite).where(eq(invite.id, inviteB.id));
    expect(row?.usedAt).toBeNull();
    // A made-up link opens nothing.
    const forged = await pressLinkButton(server, `${PUBLIC_URL}/link?for=join&token=forged`);
    expect(await forged.json()).toMatchObject({ error: { code: "link_invalid" } });
  },
  "POST /v1/operator/account/delete": async ({ operator: as, anna, bea }) => {
    // With no mail server the typed email confirms, and only the caller's own email does.
    const response = await as(anna, "POST", "/v1/operator/account/delete", { email: bea.email });
    expect(response.status).toBe(400);
    const rows = await owner
      .select({ deletedAt: operator.deletedAt })
      .from(operator)
      .where(sql`${operator.id} in (${anna.id}, ${bea.id})`);
    expect(rows).toEqual([{ deletedAt: null }, { deletedAt: null }]);
  },
  "POST /v1/account/delete": async ({ server, bea }) => {
    // A join link's row that names Bea: a delete link reads only its own kind of row.
    const token = randomUUID();
    await owner.insert(verification).values({
      identifier: `invite-join:${createHash("sha256").update(token).digest("hex")}`,
      value: JSON.stringify({ operatorId: bea.id, email: bea.email }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await server.request("/v1/account/delete", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(400);
    const [row] = await owner.select().from(operator).where(eq(operator.id, bea.id));
    expect(row?.deletedAt).toBeNull();
  },
  "POST /v1/operator/invites/accept": async ({ operator: as, anna, a, inviteB }) => {
    const moved = inviteB.token.replace(inviteB.token.split(".")[0] ?? "", a.id);
    expect((await as(anna, "POST", "/v1/operator/invites/accept", { token: moved })).status).toBe(
      404,
    );
    const [row] = await owner.select().from(invite).where(eq(invite.id, inviteB.id));
    expect(row?.usedAt).toBeNull();
  },

  // ---- API keys, webhooks and MCP.
  "POST /v1/widget/:key/context": async ({ widget, a, b, one, two }) => {
    const contextOf = async (id: string) =>
      (await owner.select().from(visitor).where(eq(visitor.id, id)))[0]?.pageContext;
    const before = await contextOf(two.id);
    const context = { plan: `isolation-${randomUUID()}` };
    expect(
      (await widget(a.publicKey, "POST", "context", one.token, SITE_A, { context })).status,
    ).toBe(200);
    expect(await contextOf(one.id)).toEqual(context);
    expect(await contextOf(two.id)).toEqual(before);
    expect(
      (await widget(b.publicKey, "POST", "context", one.token, SITE_B, { context })).status,
    ).toBe(401);
  },
  "GET /v1/operator/workspaces/:workspaceId/api-keys": async (world) => {
    const { operator: as, withKey, anna, a, b, keyA } = world;
    expect((await as(anna, "GET", inWorkspace(b.id, "/api-keys"))).status).toBe(404);
    const text = await (await as(anna, "GET", inWorkspace(a.id, "/api-keys"))).text();
    expect(text).toContain("Helper A");
    expect(text).not.toContain("Helper B");
    // A key never manages keys, and never reaches the other workspace.
    expect((await withKey(keyA.token, "GET", inWorkspace(a.id, "/api-keys"))).status).toBe(403);
    expect((await withKey(keyA.token, "GET", inWorkspace(b.id, "/conversations"))).status).toBe(
      404,
    );
    expect((await withKey(keyA.token, "GET", "/v1/operator/me")).status).toBe(403);
  },
  "POST /v1/operator/workspaces/:workspaceId/api-keys": async (world) => {
    const { operator: as, withKey, anna, a, b, keyA } = world;
    const body = { name: "Crossing" };
    expect((await as(anna, "POST", inWorkspace(b.id, "/api-keys"), body)).status).toBe(404);
    expect((await withKey(keyA.token, "POST", inWorkspace(a.id, "/api-keys"), body)).status).toBe(
      403,
    );
    const rows = await owner.select().from(apiKey).where(eq(apiKey.workspaceId, b.id));
    expect(rows.map((row) => row.name)).not.toContain("Crossing");
  },
  "DELETE /v1/operator/workspaces/:workspaceId/api-keys/:keyId": async (world) => {
    const { operator: as, withKey, anna, a, b, keyB } = world;
    await as(anna, "DELETE", inWorkspace(a.id, `/api-keys/${keyB.id}`));
    expect((await as(anna, "DELETE", inWorkspace(b.id, `/api-keys/${keyB.id}`))).status).toBe(404);
    const [row] = await owner.select().from(apiKey).where(eq(apiKey.id, keyB.id));
    expect(row?.revokedAt).toBeNull();
    expect((await withKey(keyB.token, "GET", inWorkspace(b.id, "/conversations"))).status).toBe(
      200,
    );
  },
  "GET /v1/operator/workspaces/:workspaceId/webhooks": async (world) => {
    const { operator: as, withKey, anna, a, b, keyA, hookB } = world;
    expect((await as(anna, "GET", inWorkspace(b.id, "/webhooks"))).status).toBe(404);
    const text = await (await as(anna, "GET", inWorkspace(a.id, "/webhooks"))).text();
    expect(text).not.toContain(hookB.url);
    expect(text).not.toContain(hookB.secret);
    expect((await withKey(keyA.token, "GET", inWorkspace(a.id, "/webhooks"))).status).toBe(403);
  },
  "POST /v1/operator/workspaces/:workspaceId/webhooks": async ({ operator: as, anna, b }) => {
    const body = { url: "https://93.184.215.14/crossing", events: ["message.created"] };
    expect((await as(anna, "POST", inWorkspace(b.id, "/webhooks"), body)).status).toBe(404);
    const rows = await owner.select().from(webhook).where(eq(webhook.workspaceId, b.id));
    expect(rows.map((row) => row.url)).not.toContain(body.url);
  },
  "PATCH /v1/operator/workspaces/:workspaceId/webhooks/:webhookId": async (world) => {
    const { operator: as, anna, a, b, hookB } = world;
    const body = { url: "https://93.184.215.14/stolen" };
    expect((await as(anna, "PATCH", inWorkspace(a.id, `/webhooks/${hookB.id}`), body)).status).toBe(
      404,
    );
    expect((await as(anna, "PATCH", inWorkspace(b.id, `/webhooks/${hookB.id}`), body)).status).toBe(
      404,
    );
    const [row] = await owner.select().from(webhook).where(eq(webhook.id, hookB.id));
    expect(row?.url).toBe(hookB.url);
  },
  "DELETE /v1/operator/workspaces/:workspaceId/webhooks/:webhookId": async (world) => {
    const { operator: as, anna, a, b, hookB } = world;
    await as(anna, "DELETE", inWorkspace(a.id, `/webhooks/${hookB.id}`));
    expect((await as(anna, "DELETE", inWorkspace(b.id, `/webhooks/${hookB.id}`))).status).toBe(404);
    expect(await owner.select().from(webhook).where(eq(webhook.id, hookB.id))).toHaveLength(1);
  },
  "POST /v1/operator/workspaces/:workspaceId/webhooks/:webhookId/rotate-secret": async (world) => {
    const { operator: as, anna, a, b, hookB } = world;
    for (const space of [a.id, b.id]) {
      const path = inWorkspace(space, `/webhooks/${hookB.id}/rotate-secret`);
      expect((await as(anna, "POST", path, {})).status).toBe(404);
    }
    const [row] = await owner.select().from(webhook).where(eq(webhook.id, hookB.id));
    expect(row?.secret).toBe(hookB.secret);
  },
  "POST /v1/operator/workspaces/:workspaceId/webhooks/:webhookId/test": async (world) => {
    const { operator: as, anna, a, b, hookB } = world;
    for (const space of [a.id, b.id]) {
      const path = inWorkspace(space, `/webhooks/${hookB.id}/test`);
      expect((await as(anna, "POST", path, {})).status).toBe(404);
    }
  },
  "GET /v1/operator/workspaces/:workspaceId/webhooks/:webhookId/deliveries": async (world) => {
    const { operator: as, anna, a, b, hookB } = world;
    const own = await as(anna, "GET", inWorkspace(a.id, `/webhooks/${hookB.id}/deliveries`));
    expect(await own.json()).toEqual({ deliveries: [] });
    expect(
      (await as(anna, "GET", inWorkspace(b.id, `/webhooks/${hookB.id}/deliveries`))).status,
    ).toBe(404);
  },
  "GET /v1/operator/workspaces/:workspaceId/conversations/:conversationId/drafts": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    for (const id of [a.id, b.id]) {
      const path = inWorkspace(id, `/conversations/${other.conversationId}/drafts`);
      expect((await as(anna, "GET", path)).status).toBe(404);
    }
  },
  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/drafts/:draftId/send":
    async ({ operator: as, anna, a, b, other, keyB }) => {
      const draft = await draftIn(b.id, other.conversationId, keyB.id);
      for (const id of [a.id, b.id]) {
        const path = inWorkspace(id, `/conversations/${other.conversationId}/drafts/${draft}/send`);
        expect((await as(anna, "POST", path, {})).status).toBe(404);
      }
      const [row] = await owner.select().from(draftReply).where(eq(draftReply.id, draft));
      expect(row?.resolved).toBeNull();
    },
  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/drafts/:draftId/discard":
    async ({ operator: as, anna, a, b, one, other, keyB }) => {
      const draft = await draftIn(b.id, other.conversationId, keyB.id);
      for (const path of [
        inWorkspace(a.id, `/conversations/${other.conversationId}/drafts/${draft}/discard`),
        inWorkspace(b.id, `/conversations/${other.conversationId}/drafts/${draft}/discard`),
        // Its own conversation, with the other workspace's draft.
        inWorkspace(a.id, `/conversations/${one.conversationId}/drafts/${draft}/discard`),
      ]) {
        expect((await as(anna, "POST", path)).status).toBe(404);
      }
      const [row] = await owner.select().from(draftReply).where(eq(draftReply.id, draft));
      expect(row?.resolved).toBeNull();
    },
  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/notes": async ({
    operator: as,
    withKey,
    anna,
    a,
    b,
    one,
    other,
    keyA,
    keyB,
    secrets,
  }) => {
    const body = { clientId: randomUUID(), body: "a note crossing over" };
    for (const id of [a.id, b.id]) {
      const path = inWorkspace(id, `/conversations/${other.conversationId}/notes`);
      expect((await as(anna, "POST", path, body)).status).toBe(404);
      expect((await withKey(keyA.token, "POST", path, body)).status).toBe(404);
    }
    expect(await owner.select().from(note).where(eq(note.body, body.body))).toEqual([]);
    // The other workspace's own note never shows in this one's thread. Written straight to the
    // database, because the attacks must not move the other workspace's feed.
    await owner.insert(note).values({
      workspaceId: b.id,
      conversationId: other.conversationId,
      seq: 1n,
      authorApiKeyId: keyB.id,
      clientId: randomUUID(),
      body: `${secrets.b}, a note`,
    });
    const read = inWorkspace(a.id, `/conversations/${one.conversationId}/messages`);
    expect(await (await as(anna, "GET", read)).text()).not.toContain(secrets.b);
  },
  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/handoff": async ({
    withKey,
    a,
    b,
    bea,
    one,
    other,
    keyA,
  }) => {
    const body = { clientId: randomUUID(), reason: "crossing", visitorMessage: "crossing over" };
    for (const id of [a.id, b.id]) {
      const path = inWorkspace(id, `/conversations/${other.conversationId}/handoff`);
      expect((await withKey(keyA.token, "POST", path, body)).status).toBe(404);
    }
    // Bea is real, and only in the other workspace.
    const own = inWorkspace(a.id, `/conversations/${one.conversationId}/handoff`);
    const toBea = { clientId: randomUUID(), reason: "crossing", operatorId: bea.id };
    expect((await withKey(keyA.token, "POST", own, toBea)).status).toBe(400);
    const [row] = await owner
      .select()
      .from(conversation)
      .where(eq(conversation.id, other.conversationId));
    expect(row?.humanSince).toBeNull();
    expect(await owner.select().from(message).where(eq(message.body, "crossing over"))).toEqual([]);
  },
  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/give-back": async ({
    operator: as,
    anna,
    a,
    b,
    other,
  }) => {
    const since = new Date("2026-01-02T03:04:05.000Z");
    await owner
      .update(conversation)
      .set({ humanSince: since })
      .where(eq(conversation.id, other.conversationId));
    for (const id of [a.id, b.id]) {
      const path = inWorkspace(id, `/conversations/${other.conversationId}/give-back`);
      expect((await as(anna, "POST", path)).status).toBe(404);
    }
    const [row] = await owner
      .select()
      .from(conversation)
      .where(eq(conversation.id, other.conversationId));
    expect(row?.humanSince).toEqual(since);
    await owner
      .update(conversation)
      .set({ humanSince: null })
      .where(eq(conversation.id, other.conversationId));
  },
  "PUT /v1/operator/workspaces/:workspaceId/bots-paused": async ({
    operator: as,
    anna,
    sam,
    a,
    b,
  }) => {
    expect(
      (await as(anna, "PUT", inWorkspace(b.id, "/bots-paused"), { paused: true })).status,
    ).toBe(404);
    // Sam is an admin in both, and a pause stays in its own workspace.
    expect((await as(sam, "PUT", inWorkspace(a.id, "/bots-paused"), { paused: true })).status).toBe(
      200,
    );
    const [row] = await owner.select().from(workspace).where(eq(workspace.id, b.id));
    expect(row?.botsPausedAt).toBeNull();
    await as(sam, "PUT", inWorkspace(a.id, "/bots-paused"), { paused: false });
  },
  "POST /v1/operator/workspaces/:workspaceId/conversations/:conversationId/typing": async ({
    withKey,
    a,
    b,
    other,
    keyA,
  }) => {
    for (const id of [a.id, b.id]) {
      const path = inWorkspace(id, `/conversations/${other.conversationId}/typing`);
      expect((await withKey(keyA.token, "POST", path, { typing: true })).status).toBe(404);
    }
  },
  "GET /v1/events": async ({ withKey, keyA, other, secrets }) => {
    expect((await withKey("dk_none", "GET", "/v1/events")).status).toBe(401);
    // From the start of the feed, so anything from the other workspace would show.
    const own = await withKey(keyA.token, "GET", "/v1/events?after=1.0");
    expect(own.status).toBe(200);
    const text = await readStream(own);
    expect(text).toContain("message.created");
    expect(text).not.toContain(other.conversationId);
    expect(text).not.toContain(secrets.b);
  },
  "POST /v1/mcp": async ({ withKey, keyA, other, secrets }) => {
    const call = async (name: string, args: unknown) =>
      (await (
        await withKey(keyA.token, "POST", "/v1/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        })
      ).json()) as { result: { isError: boolean; content: { text: string }[] } };
    const crossed = await call("get_conversation", { conversationId: other.conversationId });
    expect(crossed.result.isError).toBe(true);
    expect(crossed.result.content[0]?.text).toMatch(/^not_found/);
    const replied = await call("reply", { conversationId: other.conversationId, body: "crossing" });
    expect(replied.result.isError).toBe(true);
    for (const [name, args] of [
      ["list_conversations", {}],
      ["list_conversations", { status: "closed" }],
      ["search_conversations", { q: "written" }],
    ] as const) {
      const text = JSON.stringify(await call(name, args));
      expect(text).not.toContain(other.conversationId);
      expect(text).not.toContain(secrets.b);
    }
    expect(JSON.stringify(await call("search_conversations", { q: "written" }))).toContain(
      "written by one",
    );
    const crossing = { conversationId: other.conversationId, clientId: randomUUID() };
    for (const [name, args] of [
      ["get_contact", { conversationId: other.conversationId }],
      ["get_contact", { visitorId: other.id }],
      ["add_note", { ...crossing, body: "crossing" }],
      ["handoff", { ...crossing, reason: "crossing" }],
      ["set_typing", { conversationId: other.conversationId }],
    ] as const) {
      const answer = await call(name, args);
      expect(answer.result.content[0]?.text, name).toMatch(/^not_found/);
    }
    for (const [name, args] of [
      ["list_drafts", { status: "all" }],
      ["wait_for_messages", { cursor: "1.0", timeoutSeconds: 1 }],
      ["list_contacts", {}],
      ["search_contacts", { q: "written" }],
      ["get_live_visitors", {}],
      ["get_analytics", { days: 90 }],
    ] as const) {
      const text = JSON.stringify(await call(name, args));
      expect(text, name).not.toContain(other.conversationId);
      expect(text, name).not.toContain(other.id);
      expect(text, name).not.toContain(secrets.b);
    }
    // Without a key, nothing.
    const bare = await withKey("dk_none", "POST", "/v1/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(bare.status).toBe(401);
  },
  "GET /v1/mcp": async ({ withKey, keyA }) => {
    expect((await withKey(keyA.token, "GET", "/v1/mcp")).status).toBe(405);
  },
  "DELETE /v1/mcp": async ({ withKey, keyA }) => {
    expect((await withKey(keyA.token, "DELETE", "/v1/mcp")).status).toBe(405);
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
    valkey,
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
    email: `invited-${randomUUID()}@example.com`,
    role: "member",
  });
  const withKey: World["withKey"] = (token, method, path, body) =>
    Promise.resolve(
      server.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const madeKey = async (as: { cookie: string }, space: NewWorkspace, name: string) =>
    (await (
      await operatorCall(as, "POST", inWorkspace(space.id, "/api-keys"), { name })
    ).json()) as {
      id: string;
      token: string;
    };
  const madeHook = await operatorCall(bea, "POST", inWorkspace(b.id, "/webhooks"), {
    url: "https://93.184.215.14/b-hook",
    events: ["message.created"],
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
    inviteB: (await madeInvite.json()) as { id: string; email: string; token: string },
    keyA: await madeKey(anna, a, "Helper A"),
    keyB: await madeKey(bea, b, "Helper B"),
    hookB: (await madeHook.json()) as { id: string; secret: string; url: string },
    secrets: { two: "written by two", b: "written in the other workspace" },
    widget,
    operator: operatorCall,
    withKey,
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
      await as(anna, "PATCH", inWorkspace(a.id, `/members/${sam.id}`), { role: "member" });
      expect((await memberOf(a.id, sam.id))?.role).toBe("member");
      expect((await memberOf(b.id, sam.id))?.role).toBe("admin");
      // A member here may not invite here, and an admin there still may invite there.
      expect((await as(sam, "POST", inWorkspace(a.id, "/invites"), invitation())).status).toBe(403);
      expect((await as(sam, "POST", inWorkspace(b.id, "/invites"), invitation())).status).toBe(201);
      await as(anna, "PATCH", inWorkspace(a.id, `/members/${sam.id}`), { role: "owner" });
    });

    test("removal and its revoked links stay in their workspace", async () => {
      const { operator: as, anna, sam, a, b } = world;
      const here = await as(sam, "POST", inWorkspace(a.id, "/invites"), invitation());
      const hereId = ((await here.json()) as { id: string }).id;
      const there = await as(sam, "POST", inWorkspace(b.id, "/invites"), invitation());
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
      expect((await as(sam, "POST", inWorkspace(a.id, "/invites"), invitation())).status).toBe(404);
      await owner
        .update(workspaceMember)
        .set({ removedAt: null, role: "owner" })
        .where(and(eq(workspaceMember.workspaceId, a.id), eq(workspaceMember.operatorId, sam.id)));
    });
  });

  test("a member of another workspace can still join this one by invite", async () => {
    const { operator: as, anna, bea, a } = world;
    const made = await as(anna, "POST", inWorkspace(a.id, "/invites"), {
      email: bea.email,
      role: "member",
    });
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
    // Other tests leave due rows too, so this claims until it holds this workspace's row.
    const claimMine = async () => {
      for (;;) {
        const claims = await claimDeliveries(worker, 50, 60_000);
        const found = claims.find((claim) => claim.workspaceId === space.id);
        if (found !== undefined) return found;
        if (claims.length === 0) throw new Error("No claim for this workspace");
      }
    };
    const mine = await claimMine();
    const plan = await planDelivery(worker, mine, {
      publicUrl: PUBLIC_URL,
      secret: AUTH_SECRET,
      imageOrigin: PUBLIC_URL,
    });
    expect(plan?.channel === "push" && plan.payload.title).toBe("The right workspace");
  });
});
