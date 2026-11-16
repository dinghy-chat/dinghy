import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { hostToken } from "../test/host-tokens.ts";
import { signedInOperator } from "../test/operators.ts";
import { SITE, visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { upsertContact } from "./contact-fields.ts";
import { csvCell } from "./contacts.ts";
import {
  apiKey,
  conversation,
  draftReply,
  message,
  operator,
  outboundMessage,
  visitor,
} from "./db/schema.ts";
import { type Database, withWorkspace } from "./db/tenant.ts";
import type { ContactFields } from "./inputs.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const logger = pino({ level: "silent" });

let database: TestDatabase;
let db: Database;
let owner: Database;
let app: App;
let space: NewWorkspace;
let boss: { id: string; cookie: string };
let member: { id: string; cookie: string };

const path = (rest = "") => `/v1/operator/workspaces/${space.id}/contacts${rest}`;
const get = (url: string, as = boss.cookie) => app.request(url, { headers: { cookie: as } });
const send = (method: string, url: string, body?: unknown, as = boss.cookie) =>
  app.request(url, {
    method,
    headers: { cookie: as, origin: ORIGIN, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type Contact = {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  signedIn: boolean;
  conversationCount: number;
};

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  owner = database.connect("migrator").db;
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const ok = async () => {};
  app = createApp({ db, logger, auth, checks: { postgres: ok, valkey: ok } });
  space = await createWorkspace(db, "Contacts", [SITE]);
  boss = await signedInOperator({ app, auth, owner, workspaceId: space.id });
  member = await signedInOperator({ app, auth, owner, workspaceId: space.id, role: "member" });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

describe("the list", () => {
  test("only people with a conversation, newest seen first, found by name, email or ID", async () => {
    const first = await visitorStarts(app, space.publicKey, "Hello");
    const second = await visitorStarts(app, space.publicKey, "Hello");
    // A visitor who never wrote is no contact.
    await app.request(`/v1/widget/${space.publicKey}/visitors`, {
      method: "POST",
      headers: { origin: SITE },
    });
    await owner
      .update(visitor)
      .set({ name: "Ada Lovelace", email: "ada@example.com", attributes: { company: "Engines" } })
      .where(eq(visitor.id, first.visitorId));
    await owner
      .update(visitor)
      .set({ lastSeenAt: new Date(Date.now() + 60_000) })
      .where(eq(visitor.id, second.visitorId));
    const all = (await (await get(path())).json()) as { contacts: Contact[] };
    expect(all.contacts.map((one) => one.id).slice(0, 2)).toEqual([
      second.visitorId,
      first.visitorId,
    ]);
    expect(all.contacts.map((one) => one.conversationCount)).toEqual([1, 1]);
    const found = (await (await get(path("?q=lovelace"))).json()) as { contacts: Contact[] };
    expect(found.contacts).toMatchObject([
      { id: first.visitorId, name: "Ada Lovelace", company: "Engines", signedIn: false },
    ]);
    const byEmail = (await (await get(path("?q=ADA@exa"))).json()) as { contacts: Contact[] };
    expect(byEmail.contacts.map((one) => one.id)).toEqual([first.visitorId]);
  });

  test("pages by cursor skip nothing and repeat nothing, in each sort", async () => {
    for (let index = 0; index < 5; index += 1) await visitorStarts(app, space.publicKey, "Hello");
    for (const sort of ["lastSeen", "firstSeen"]) {
      const seen: string[] = [];
      let next: string | null = null;
      do {
        const query: string = `?sort=${sort}&limit=2${next === null ? "" : `&before=${next}`}`;
        const page = (await (await get(path(query))).json()) as {
          contacts: Contact[];
          next: string | null;
        };
        seen.push(...page.contacts.map((one) => one.id));
        next = page.next;
      } while (next !== null);
      const total = (await (await get(path("?limit=100"))).json()) as { contacts: Contact[] };
      expect(seen).toHaveLength(total.contacts.length);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  test("a malformed cursor is refused with 400, not a server error", async () => {
    const id = "0b9e3c4a-1f2d-4e5f-8a6b-7c8d9e0f1a2b";
    for (const before of [
      `2026-11-11T10:00:00Z,${id}`,
      `2026-11-11T10:00:00.1.2.3Z,${id}`,
      `2026-02-30T10:00:00.000000Z,${id}`,
      `2026-13-01T10:00:00.000000Z,${id}`,
      "2026-11-11T10:00:00.000000Z,------------------------------------",
    ]) {
      expect((await get(path(`?before=${encodeURIComponent(before)}`))).status).toBe(400);
    }
    expect((await get(path(`?before=2026-11-11T10:00:00.000000Z,${id}`))).status).toBe(200);
  });

  test("a page is one bounded index scan", async () => {
    const plan = await owner.execute<{ "QUERY PLAN": string }>(sql`
      explain select id from visitor
      where workspace_id = ${space.id}
      order by workspace_id desc, coalesce(last_seen_at, created_at) desc, id desc limit 51`);
    expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(/visitor_seen_idx/);
  });
});

describe("one contact", () => {
  test("reads the conversations, the note and the pages", async () => {
    const { visitorId, conversationId } = await visitorStarts(
      app,
      space.publicKey,
      "Where is my order?",
    );
    const read = await get(path(`/${visitorId}`));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      id: visitorId,
      note: null,
      conversations: [{ id: conversationId, status: "open", lastBody: "Where is my order?" }],
      pages: [],
    });
  });

  test("each conversation's message count, assignee, closer and first reply time", async () => {
    const { visitorId, conversationId } = await visitorStarts(
      app,
      space.publicKey,
      "Can I pay yearly?",
    );
    await owner.update(operator).set({ name: "Sam" }).where(eq(operator.id, boss.id));
    const conversationPath = `/v1/operator/workspaces/${space.id}/conversations/${conversationId}`;
    const reply = await send("POST", `${conversationPath}/messages`, {
      clientId: crypto.randomUUID(),
      body: "Yes",
    });
    expect(reply.status).toBe(201);
    // The reply came exactly two minutes after the start, however long the request took.
    await owner
      .update(conversation)
      .set({
        createdAt: sql`(select ${message.createdAt} - interval '2 minutes' from ${message} where ${message.conversationId} = ${conversationId} and ${message.authorVisitorId} is null order by ${message.seq} limit 1)`,
      })
      .where(eq(conversation.id, conversationId));
    expect(
      (await send("PUT", `${conversationPath}/assignee`, { operatorId: boss.id })).status,
    ).toBe(200);
    const open = { id: conversationId, status: "open", messageCount: 2, assigneeName: "Sam" };
    expect(await (await get(path(`/${visitorId}`))).json()).toMatchObject({
      online: null,
      conversations: [{ ...open, closedBy: null, firstReplySeconds: 120 }],
    });
    expect((await send("PATCH", conversationPath, { status: "closed" })).status).toBe(200);
    expect(await (await get(path(`/${visitorId}`))).json()).toMatchObject({
      conversations: [{ ...open, status: "closed", closedBy: "Sam" }],
    });
  });

  test("a deleted message is not a conversation's preview", async () => {
    const { visitorId, conversationId } = await visitorStarts(
      app,
      space.publicKey,
      "Typo with my password",
    );
    const [written] = await owner
      .select({ id: message.id })
      .from(message)
      .where(eq(message.conversationId, conversationId));
    const removed = await send(
      "DELETE",
      `/v1/operator/workspaces/${space.id}/conversations/${conversationId}/messages/${written?.id}`,
    );
    expect(removed.status).toBe(200);
    expect(await (await get(path(`/${visitorId}`))).json()).toMatchObject({
      conversations: [{ id: conversationId, lastBody: null }],
    });
  });

  test("a member writes the note, and a signed-out contact's name and email", async () => {
    const { visitorId } = await visitorStarts(app, space.publicKey, "Hello");
    const changed = await send(
      "PATCH",
      path(`/${visitorId}`),
      { note: "Pays yearly", name: "Grace", email: "grace@example.com" },
      member.cookie,
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      note: "Pays yearly",
      name: "Grace",
      email: "grace@example.com",
    });
    // An empty note clears it.
    expect(await (await send("PATCH", path(`/${visitorId}`), { note: "  " })).json()).toMatchObject(
      { note: null },
    );
  });

  test("a signed-in contact's name and email stay the host site's", async () => {
    const token = await new SignJWT({ name: "Signed Sam", email: "sam@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(space.publicKey)
      .setSubject(`user-${crypto.randomUUID()}`)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(space.signingSecret));
    const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "signed", body: "Hi" }),
    });
    const { conversationId } = (await sent.json()) as { conversationId: string };
    const [row] = await owner
      .select({ visitorId: conversation.visitorId })
      .from(conversation)
      .where(eq(conversation.id, conversationId));
    const contact = path(`/${row?.visitorId}`);
    expect((await send("PATCH", contact, { name: "Changed" })).status).toBe(409);
    expect((await send("PATCH", contact, { note: "VIP" })).status).toBe(200);
    expect(await (await get(contact)).json()).toMatchObject({
      name: "Signed Sam",
      signedIn: true,
      note: "VIP",
    });
  });

  test("a delete removes the person, their conversations and messages, for owners and admins", async () => {
    const { visitorId, conversationId } = await visitorStarts(app, space.publicKey, "Forget me");
    // A draft that quotes the visitor, whose foreign keys the delete must clear first.
    const [said] = await owner
      .select({ id: message.id })
      .from(message)
      .where(eq(message.conversationId, conversationId));
    const [key] = await owner
      .insert(apiKey)
      .values({ workspaceId: space.id, name: "Bot", tokenHash: "forget-key", createdBy: boss.id })
      .returning({ id: apiKey.id });
    await owner.insert(draftReply).values({
      workspaceId: space.id,
      conversationId,
      apiKeyId: key?.id ?? "",
      clientId: "forget-draft",
      body: "Hello",
      replyToMessageId: said?.id ?? "",
    });
    expect((await send("DELETE", path(`/${visitorId}`), undefined, member.cookie)).status).toBe(
      403,
    );
    expect((await send("DELETE", path(`/${visitorId}`))).status).toBe(200);
    expect(await owner.select().from(visitor).where(eq(visitor.id, visitorId))).toEqual([]);
    expect(
      await owner.select().from(conversation).where(eq(conversation.id, conversationId)),
    ).toEqual([]);
    expect(
      await owner.select().from(message).where(eq(message.conversationId, conversationId)),
    ).toEqual([]);
    expect(
      await owner.select().from(draftReply).where(eq(draftReply.conversationId, conversationId)),
    ).toEqual([]);
    expect((await get(path(`/${visitorId}`))).status).toBe(404);
    expect((await send("DELETE", path(`/${visitorId}`))).status).toBe(404);
  });
});

describe("the CSV export", () => {
  test("lists every contact, with each cell safe for a spreadsheet", async () => {
    const { visitorId } = await visitorStarts(app, space.publicKey, "Hello");
    await owner
      .update(visitor)
      .set({ name: '=HYPERLINK("http://evil")', email: "csv@example.com" })
      .where(eq(visitor.id, visitorId));
    const response = await get(path("/export"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    const text = await response.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "name,email,user_id,company,country,time_zone,device,last_page,last_seen,first_seen,conversations",
    );
    const list = (await (await get(path("?limit=100"))).json()) as { contacts: Contact[] };
    expect(lines).toHaveLength(list.contacts.length + 1);
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")",csv@example.com`);
  });

  test("csvCell quotes what a CSV needs and stops formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell(null)).toBe("");
    expect(csvCell(3)).toBe("3");
  });
});

// Last, because its 502 rows in another workspace would change the plan the index test reads.
describe("ties", () => {
  test("contacts that share a time to the microsecond page fully, in the list and the export", async () => {
    // More than one page of the export, all seen at the same moment, which a millisecond cursor
    // would cut short.
    const tie = "2020-01-01T00:00:00.123456Z";
    const own = await createWorkspace(db, "Ties", [SITE]);
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const { cookie } = await signedInOperator({ app, auth, owner, workspaceId: own.id });
    const list = (rest: string) => get(`/v1/operator/workspaces/${own.id}/contacts${rest}`, cookie);
    await owner.execute(sql`
      with made as (
        insert into visitor (workspace_id, id, token_hash, created_at, last_seen_at)
        select ${own.id}, gen_random_uuid(), md5(random()::text), ${tie}::timestamptz,
               ${tie}::timestamptz
        from generate_series(1, 502)
        returning workspace_id, id)
      insert into conversation (workspace_id, visitor_id) select workspace_id, id from made`);
    for (const sort of ["lastSeen", "firstSeen"]) {
      const seen = new Set<string>();
      let next: string | null = null;
      do {
        const query: string = `?sort=${sort}&limit=100${next === null ? "" : `&before=${next}`}`;
        const page = (await (await list(query)).json()) as {
          contacts: Contact[];
          next: string | null;
        };
        for (const one of page.contacts) seen.add(one.id);
        next = page.next;
      } while (next !== null);
      expect(seen.size).toBe(502);
    }
    const csv = await (await list("/export")).text();
    expect(csv.trim().split("\r\n")).toHaveLength(503);
  });
});

describe("the upsert by user ID", () => {
  const upsert = (user: string, body: unknown) =>
    send("PUT", path(`/by-user/${encodeURIComponent(user)}`), body);
  const contactOf = async (user: string) =>
    (await owner.select().from(visitor).where(eq(visitor.userId, user)))[0];

  test("creates a contact with no conversation, then merges attributes key by key", async () => {
    const user = `upsert-${randomUUID()}`;
    const created = await upsert(user, {
      name: "Grace Hopper",
      email: "grace@example.com",
      attributes: { plan: "trial", seats: 3 },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: "Grace Hopper", conversationCount: 0 });
    const changed = await upsert(user, { attributes: { plan: "pro", seats: null } });
    expect(changed.status).toBe(200);
    expect((await contactOf(user))?.attributes).toEqual({ plan: "pro" });
    expect((await contactOf(user))?.name).toBe("Grace Hopper");
  });

  test("a host token signed before the server's write does not overwrite it", async () => {
    const user = `upsert-${randomUUID()}`;
    await upsert(user, { attributes: { plan: "pro" } });
    const older = await hostToken(
      space,
      user,
      { attributes: { plan: "trial", team: "a" } },
      Math.floor(Date.now() / 1000) - 60,
    );
    const me = await app.request(`/v1/widget/${space.publicKey}/me`, {
      headers: { origin: SITE, authorization: `Bearer ${older}` },
    });
    expect(me.status).toBe(200);
    // The plan is the server's, newer. The new key had no write yet, so the token sets it.
    expect((await contactOf(user))?.attributes).toEqual({ plan: "pro", team: "a" });
    const newer = await hostToken(
      space,
      user,
      { attributes: { plan: "enterprise" } },
      Math.floor(Date.now() / 1000) + 1,
    );
    await app.request(`/v1/widget/${space.publicKey}/me`, {
      headers: { origin: SITE, authorization: `Bearer ${newer}` },
    });
    expect((await contactOf(user))?.attributes).toEqual({ plan: "enterprise", team: "a" });
  });

  test("the list leaves contacts with no conversation out, until Has chatted is off", async () => {
    const user = `upsert-${randomUUID()}`;
    await upsert(user, { name: "Never Chatted", attributes: { plan: "pro" } });
    const listed = async (query: string) =>
      ((await (await get(path(`?q=Never%20Chatted&${query}`))).json()) as { contacts: Contact[] })
        .contacts;
    expect(await listed("")).toEqual([]);
    expect((await listed("hasChatted=false")).map((one) => one.name)).toEqual(["Never Chatted"]);
    const pro = encodeURIComponent(
      JSON.stringify({ field: "attributes.plan", op: "eq", value: "pro" }),
    );
    const trial = encodeURIComponent(
      JSON.stringify({ field: "attributes.plan", op: "eq", value: "trial" }),
    );
    expect(await listed(`hasChatted=false&filter=${pro}`)).toHaveLength(1);
    expect(await listed(`hasChatted=false&filter=${trial}`)).toEqual([]);
    expect((await get(path(`?filter=${encodeURIComponent("{not json")}`))).status).toBe(400);
  });

  test("a delete forgets the contact's outbound messages", async () => {
    const user = `upsert-${randomUUID()}`;
    const created = (await (await upsert(user, {})).json()) as { id: string };
    await send("POST", `/v1/operator/workspaces/${space.id}/outbound-messages`, {
      clientId: randomUUID(),
      visitor: { id: created.id },
      body: "Hello",
    });
    expect((await send("DELETE", path(`/${created.id}`))).status).toBe(200);
    expect(
      await owner.select().from(outboundMessage).where(eq(outboundMessage.visitorId, created.id)),
    ).toEqual([]);
  });
});

describe("upsertContact", () => {
  test("a later write wins for each field, and the same write again changes nothing", async () => {
    const userId = `merge-${randomUUID()}`;
    const write = (fields: ContactFields, at: number) =>
      withWorkspace(db, space.id, (tx) => upsertContact(tx, space.id, userId, fields, at));
    expect(await write({ name: "Ada", attributes: { plan: "pro" } }, 100)).toMatchObject({
      created: true,
    });
    expect(await write({ name: "Ada", attributes: { plan: "pro" } }, 100)).toMatchObject({
      changed: [],
    });
    expect(await write({ name: "Old" }, 50)).toMatchObject({ changed: [] });
    // The fields that changed, as conditions name them, so only campaigns that read them check.
    expect(await write({ name: "Ada L", attributes: { plan: null, seats: 2 } }, 200)).toMatchObject(
      {
        created: false,
        changed: ["name", "firstName", "attributes.plan", "attributes.seats"],
      },
    );
    const [row] = await owner
      .select({
        name: visitor.name,
        attributes: visitor.attributes,
        fieldTimes: visitor.fieldTimes,
      })
      .from(visitor)
      .where(eq(visitor.userId, userId));
    expect(row).toEqual({
      name: "Ada L",
      attributes: { seats: 2 },
      fieldTimes: { name: 200, "attributes.plan": 200, "attributes.seats": 200 },
    });
  });
});
