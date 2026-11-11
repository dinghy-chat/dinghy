import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { csvCell } from "./contacts.ts";
import { conversation, message, visitor } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const SITE = "https://app.example.com";
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

/** A signed-out visitor who sent one message, and their visitor ID. */
async function visitorChats(body = "Hello") {
  const created = await app.request(`/v1/widget/${space.publicKey}/visitors`, {
    method: "POST",
    headers: { origin: SITE },
  });
  const { token, visitorId } = (await created.json()) as { token: string; visitorId: string };
  const sent = await app.request(`/v1/widget/${space.publicKey}/messages`, {
    method: "POST",
    headers: { origin: SITE, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ clientId: crypto.randomUUID(), body }),
  });
  const { conversationId } = (await sent.json()) as { conversationId: string };
  return { token, visitorId, conversationId };
}

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
    const first = await visitorChats();
    const second = await visitorChats();
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
    for (let index = 0; index < 5; index += 1) await visitorChats();
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
    const { visitorId, conversationId } = await visitorChats("Where is my order?");
    const read = await get(path(`/${visitorId}`));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      id: visitorId,
      note: null,
      conversations: [{ id: conversationId, status: "open", lastBody: "Where is my order?" }],
      pages: [],
    });
  });

  test("a member writes the note, and a signed-out contact's name and email", async () => {
    const { visitorId } = await visitorChats();
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
    const { visitorId, conversationId } = await visitorChats("Forget me");
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
    expect((await get(path(`/${visitorId}`))).status).toBe(404);
    expect((await send("DELETE", path(`/${visitorId}`))).status).toBe(404);
  });
});

describe("the CSV export", () => {
  test("lists every contact, with each cell safe for a spreadsheet", async () => {
    const { visitorId } = await visitorChats();
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
