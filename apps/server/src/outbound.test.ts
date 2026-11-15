import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { hostToken } from "../test/host-tokens.ts";
import { setReplyMode } from "../test/keys.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, callTool, withKey } from "../test/requests.ts";
import { readStream } from "../test/sse.ts";
import { SITE, visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import {
  apiKey,
  conversation,
  event,
  message,
  outboundMessage,
  visitor,
  webhook,
  webhookDelivery,
  workspace,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { noLive } from "./live.ts";
import {
  decide,
  expireOutbound,
  materializeOutbound,
  runDueOutbound,
  type Situation,
} from "./outbound.ts";
import { fanOutWebhooksOne, webhookData } from "./webhooks.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });

let database: TestDatabase;
let db: Database;
let workerDb: Database;
let owner: Database;
let app: App;
let space: NewWorkspace;
let boss: { id: string; email: string; cookie: string };
let bot: { id: string; token: string };

const inSpace = (path: string) => `/v1/operator/workspaces/${space.id}${path}`;

interface View {
  id: string;
  status: string;
  statusReason: string | null;
  visitorId: string;
  conversationId: string | null;
  messageId: string | null;
  readAt: string | null;
  button: { value: string | null; label: string } | null;
  sender: unknown;
}

/** A send with a fresh client ID, as the key or a member. */
async function send(body: Record<string, unknown>, token = bot.token) {
  const response = await withKey(app, token, "POST", inSpace("/outbound-messages"), {
    clientId: randomUUID(),
    ...body,
  });
  const json = (await response.json()) as { outboundMessage: View; error?: { code: string } };
  return { status: response.status, ...json };
}

/** A widget request as this visitor's tab. */
async function widget(token: string, method: string, path: string, body?: unknown) {
  const response = await app.request(`/v1/widget/${space.publicKey}${path}`, {
    method,
    headers: {
      origin: SITE,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

const waiting = async (token: string) =>
  (await widget(token, "GET", "/outbound-messages")).json.outboundMessages as {
    id: string;
    body: string;
    authorName: string | null;
    read: boolean;
  }[];

const answer = (token: string, body: string, outboundIds: string[], extra = {}) =>
  widget(token, "POST", "/messages", { clientId: randomUUID(), body, outboundIds, ...extra });

const rowOf = async (id: string) =>
  (await owner.select().from(outboundMessage).where(eq(outboundMessage.id, id)))[0];

const conversationsOf = (visitorId: string) =>
  owner.select().from(conversation).where(eq(conversation.visitorId, visitorId));

/** A signed-in user's ID, new for each test. */
const userId = () => `user-${randomUUID()}`;

/**
 * Runs `waiter` while another transaction holds the workspace lock and has made `change`, which
 * commits after `waiter` read its rows and waits for the lock.
 */
async function whileLocked<T>(
  change: (tx: Transaction) => Promise<unknown>,
  waiter: () => Promise<T>,
) {
  const { started } = await owner.transaction(async (tx) => {
    await tx.execute(sql`select id from workspace where id = ${space.id} for no key update`);
    await change(tx);
    const started = waiter();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { started };
  });
  return started;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  workerDb = database.connect("worker", 5).db;
  owner = database.connect("migrator").db;
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const ok = async () => {};
  app = createApp({ db, logger, auth, checks: { postgres: ok, valkey: ok } });
  space = await createWorkspace(db, "Shipmail", [SITE]);
  boss = await signedInOperator({
    app,
    auth,
    owner,
    workspaceId: space.id,
    name: "Julien Coulaud",
    email: "julien@shipmail.example",
  });
  const made = await asOperator(app, boss.cookie, "POST", inSpace("/api-keys"), {
    name: "Welcome bot",
    replyMode: "send",
    permissions: ["send_as_member"],
  });
  bot = (await made.json()) as { id: string; token: string };
}, 30_000);

beforeEach(async () => {
  await setReplyMode(owner, bot.id, "send");
  await owner
    .update(apiKey)
    .set({ permissions: ["send_as_member"] })
    .where(eq(apiKey.id, bot.id));
  await owner.update(workspace).set({ botsPausedAt: null }).where(eq(workspace.id, space.id));
});

afterAll(async () => {
  await database.drop();
});

describe("a send", () => {
  test("waits on a new contact, with no conversation, until the visitor answers", async () => {
    const user = userId();
    const sent = await send({
      visitor: { userId: user, name: "Ada Lovelace", email: "ada@example.com" },
      sender: { email: "julien@shipmail.example" },
      body: "Welcome to Shipmail!",
      once: "welcome",
    });
    expect(sent.status).toBe(201);
    expect(sent.outboundMessage).toMatchObject({
      status: "pending",
      statusReason: null,
      conversationId: null,
      sender: { operatorId: boss.id, name: "Julien Coulaud" },
    });
    const [contact] = await owner.select().from(visitor).where(eq(visitor.userId, user));
    expect(contact).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(await conversationsOf(sent.outboundMessage.visitorId)).toEqual([]);
    // The same `once` answers the first message, and makes no second one.
    const again = await send({ visitor: { userId: user }, body: "Welcome again", once: "welcome" });
    expect(again.status).toBe(200);
    expect(again.outboundMessage.id).toBe(sent.outboundMessage.id);
  });

  test("a retry with the same client ID answers the first result", async () => {
    const clientId = randomUUID();
    const body = { clientId, visitor: { userId: userId() }, body: "Hello" };
    const first = await withKey(app, bot.token, "POST", inSpace("/outbound-messages"), body);
    const second = await withKey(app, bot.token, "POST", inSpace("/outbound-messages"), body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const ids = [first, second].map(
      async (one) => ((await one.json()) as { outboundMessage: View }).outboundMessage.id,
    );
    const [a, b] = await Promise.all(ids);
    expect(a).toBe(b);
  });

  test("names what to change when it cannot go", async () => {
    await setReplyMode(owner, bot.id, "draft");
    expect((await send({ visitor: { userId: userId() }, body: "Hi" })).error?.code).toBe(
      "send_mode_required",
    );
    await setReplyMode(owner, bot.id, "send");
    await owner.update(apiKey).set({ permissions: [] }).where(eq(apiKey.id, bot.id));
    const asMember = await send({
      visitor: { userId: userId() },
      sender: { operatorId: boss.id },
      body: "Hi",
    });
    expect([asMember.status, asMember.error?.code]).toEqual([403, "send_as_member_required"]);
    await owner
      .update(workspace)
      .set({ botsPausedAt: new Date() })
      .where(eq(workspace.id, space.id));
    const paused = await send({ visitor: { userId: userId() }, body: "Hi" });
    expect([paused.status, paused.error?.code]).toEqual([409, "bots_paused"]);
    // A scheduled message waits for the resume instead.
    expect((await send({ visitor: { userId: userId() }, body: "Hi", delay: "1h" })).status).toBe(
      201,
    );
  });

  test("read messages that the visitor did not answer do not count toward the limit", async () => {
    const user = userId();
    for (let index = 0; index < 5; index++) {
      await send({ visitor: { userId: user }, body: `Read ${index}` });
    }
    const token = await hostToken(space, user);
    for (const one of await waiting(token)) {
      await widget(token, "POST", `/outbound-messages/${one.id}/read`);
    }
    expect((await send({ visitor: { userId: user }, body: "One more" })).status).toBe(201);
  });

  test("a retry that races the first send answers its result", async () => {
    const body = { clientId: randomUUID(), visitor: { userId: userId() }, body: "Raced" };
    // All three pass the first lookup while the lock is held, then take turns.
    const answers = await whileLocked(
      async () => {},
      () =>
        Promise.all(
          [1, 2, 3].map(() => withKey(app, bot.token, "POST", inSpace("/outbound-messages"), body)),
        ),
    );
    expect(answers.map((one) => one.status).sort()).toEqual([200, 200, 201]);
  });

  test("the list's next page keeps rows that share a millisecond", async () => {
    const user = userId();
    const older = await send({ visitor: { userId: user }, body: "Older" });
    const newer = await send({ visitor: { userId: user }, body: "Newer" });
    const at = (id: string, time: string) =>
      owner.execute(sql`update outbound_message set created_at = ${time} where id = ${id}`);
    await at(older.outboundMessage.id, "2026-01-01T00:00:00.000100Z");
    await at(newer.outboundMessage.id, "2026-01-01T00:00:00.000200Z");
    const list = async (query: string) =>
      (await (
        await withKey(app, bot.token, "GET", inSpace(`/outbound-messages?${query}`))
      ).json()) as { outboundMessages: View[]; next: string | null };
    const visitorId = older.outboundMessage.visitorId;
    const first = await list(`visitorId=${visitorId}&limit=1`);
    expect(first.outboundMessages.map((one) => one.id)).toEqual([newer.outboundMessage.id]);
    const second = await list(
      `visitorId=${visitorId}&limit=1&cursor=${encodeURIComponent(first.next ?? "")}`,
    );
    expect(second.outboundMessages.map((one) => one.id)).toEqual([older.outboundMessage.id]);
  });

  test("email needs the key's permission, and a member by hand needs none", async () => {
    const email = { visitor: { userId: userId() }, body: "By email", email: true };
    const refused = await send(email);
    expect([refused.status, refused.error?.code]).toEqual([403, "send_email_required"]);
    await owner
      .update(apiKey)
      .set({ permissions: ["send_email"] })
      .where(eq(apiKey.id, bot.id));
    expect((await send(email)).status).toBe(201);
    const byHand = await asOperator(app, boss.cookie, "POST", inSpace("/outbound-messages"), {
      clientId: randomUUID(),
      ...email,
    });
    expect(byHand.status).toBe(201);
  });

  test("a sixth waiting message for one visitor is refused", async () => {
    const user = userId();
    for (let index = 0; index < 5; index++) {
      expect((await send({ visitor: { userId: user }, body: `Note ${index}` })).status).toBe(201);
    }
    const sixth = await send({ visitor: { userId: user }, body: "One too many" });
    expect([sixth.status, sixth.error?.code]).toEqual([429, "too_many_waiting"]);
  });

  test("a blocked visitor gets none, and a block forgets their messages", async () => {
    // Signed in, so the block leaves no address that would refuse the next tests' visitors.
    const user = userId();
    const started = await answer(await hostToken(space, user), "Hello", []);
    const conversationId = started.json.conversationId as string;
    const [person] = await owner.select().from(visitor).where(eq(visitor.userId, user));
    const visitorId = person?.id ?? "";
    const waits = await send({ visitor: { id: visitorId }, body: "Later", delay: "1h" });
    await asOperator(app, boss.cookie, "POST", inSpace(`/conversations/${conversationId}/block`));
    expect(await rowOf(waits.outboundMessage.id)).toBeUndefined();
    const refused = await send({ visitor: { id: visitorId }, body: "Hi" });
    expect([refused.status, refused.error?.code]).toEqual([403, "blocked"]);
  });
});

describe("the widget", () => {
  test("shows the message, records the read, and puts it before the answer", async () => {
    const user = userId();
    const sent = await send({
      visitor: { userId: user },
      sender: { operatorId: boss.id },
      body: "Stuck on DNS? Ask me here.",
    });
    const token = await hostToken(space, user);
    const [shown] = await waiting(token);
    expect(shown).toMatchObject({ id: sent.outboundMessage.id, authorName: "Julien", read: false });
    expect((await rowOf(sent.outboundMessage.id))?.status).toBe("delivered");
    expect((await widget(token, "POST", `/outbound-messages/${shown?.id}/read`)).status).toBe(200);
    const replied = await answer(token, "Yes, the SPF record", [sent.outboundMessage.id]);
    expect(replied.status).toBe(201);
    const row = await rowOf(sent.outboundMessage.id);
    expect(row).toMatchObject({ status: "replied" });
    const [started] = await conversationsOf(sent.outboundMessage.visitorId);
    // The team started it, and the member it showed as handles it now.
    expect(started).toMatchObject({ startedBy: "team", assigneeOperatorId: boss.id });
    expect(started?.humanSince).not.toBeNull();
    const lines = await owner
      .select({ body: message.body, clientId: message.clientId })
      .from(message)
      .where(eq(message.conversationId, started?.id ?? ""))
      .orderBy(message.seq);
    expect(lines).toEqual([
      { body: "Stuck on DNS? Ask me here.", clientId: `outbound:${sent.outboundMessage.id}` },
      { body: "Yes, the SPF record", clientId: expect.any(String) },
    ]);
  });

  test("an answer that names a message whose read failed still puts it first", async () => {
    const user = userId();
    const sent = await send({ visitor: { userId: user }, body: "Shown, read lost" });
    const token = await hostToken(space, user);
    await waiting(token);
    const replied = await answer(token, "Yes", [sent.outboundMessage.id]);
    expect(replied.json.conversationStarted).toBe(true);
    const row = await rowOf(sent.outboundMessage.id);
    expect(row?.status).toBe("replied");
    const lines = await owner
      .select({ body: message.body })
      .from(message)
      .where(eq(message.conversationId, row?.conversationId ?? ""))
      .orderBy(message.seq);
    expect(lines).toEqual([{ body: "Shown, read lost" }, { body: "Yes" }]);
  });

  test("a value button of an ended message answers with what the visitor typed", async () => {
    const user = userId();
    const sent = await send({
      visitor: { userId: user },
      body: "Want a call?",
      buttons: [{ label: "Yes, please", value: "yes" }],
    });
    const { id } = sent.outboundMessage;
    const token = await hostToken(space, user);
    await waiting(token);
    await withKey(app, bot.token, "POST", inSpace(`/outbound-messages/${id}/cancel`));
    const replied = await answer(token, "Typed instead", [], {
      button: { outboundMessageId: id, index: 0 },
    });
    expect(replied.json).toMatchObject({ body: "Typed instead", button: null });
  });

  test("an answer names every message the visitor read, beyond the waiting limit", async () => {
    const user = userId();
    const token = await hostToken(space, user);
    const ids: string[] = [];
    for (const round of [5, 1]) {
      for (let i = 0; i < round; i += 1) {
        const sent = await send({ visitor: { userId: user }, body: `Message ${ids.length + 1}` });
        ids.push(sent.outboundMessage.id);
      }
      for (const id of ids) await widget(token, "POST", `/outbound-messages/${id}/read`);
    }
    const replied = await answer(token, "Hello", ids);
    expect(replied.status).toBe(201);
    for (const id of ids) expect((await rowOf(id))?.status).toBe("replied");
  });

  test("a stale tab cannot put a cancelled message in the conversation", async () => {
    const user = userId();
    const sent = await send({ visitor: { userId: user }, body: "Soon cancelled" });
    const { id } = sent.outboundMessage;
    const token = await hostToken(space, user);
    await waiting(token);
    await withKey(app, bot.token, "POST", inSpace(`/outbound-messages/${id}/cancel`));
    expect((await widget(token, "POST", `/outbound-messages/${id}/read`)).status).toBe(404);
    await answer(token, "Hello", [id]);
    const [started] = await conversationsOf(sent.outboundMessage.visitorId);
    const bodies = await owner
      .select({ body: message.body })
      .from(message)
      .where(eq(message.conversationId, started?.id ?? ""));
    expect(bodies).toEqual([{ body: "Hello" }]);
  });

  test("another visitor's widget cannot read or answer with someone else's message", async () => {
    const sent = await send({ visitor: { userId: userId() }, body: "Private" });
    const stranger = await hostToken(space, userId());
    const read = await widget(
      stranger,
      "POST",
      `/outbound-messages/${sent.outboundMessage.id}/read`,
    );
    expect(read.status).toBe(404);
    await answer(stranger, "Mine?", [sent.outboundMessage.id]);
    expect((await rowOf(sent.outboundMessage.id))?.conversationId).toBeNull();
  });

  test("two tabs read the same message while the visitor answers from both", async () => {
    const user = userId();
    const sent = await send({ visitor: { userId: user }, body: "One copy only" });
    const id = sent.outboundMessage.id;
    const token = await hostToken(space, user);
    await waiting(token);
    await Promise.all([
      widget(token, "POST", `/outbound-messages/${id}/read`),
      widget(token, "POST", `/outbound-messages/${id}/read`),
    ]);
    const [first, second, read] = await Promise.all([
      answer(token, "From the first tab", [id]),
      answer(token, "From the second tab", [id]),
      widget(token, "POST", `/outbound-messages/${id}/read`),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    // A read that comes after the answer finds the message replied.
    expect([200, 404]).toContain(read.status);
    const lines = await owner
      .select({ body: message.body })
      .from(message)
      .innerJoin(
        conversation,
        and(
          eq(conversation.workspaceId, message.workspaceId),
          eq(conversation.id, message.conversationId),
        ),
      )
      .where(eq(conversation.visitorId, sent.outboundMessage.visitorId))
      .orderBy(message.seq);
    expect(lines[0]).toEqual({ body: "One copy only" });
    expect(
      lines
        .slice(1)
        .map((one) => one.body)
        .sort(),
    ).toEqual(["From the first tab", "From the second tab"]);
    const reads = await owner
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.workspaceId, space.id), eq(event.kind, "outbound_message.read")));
    expect(reads.filter((one) => JSON.stringify(one.payload).includes(id))).toHaveLength(1);
    expect((await rowOf(id))?.status).toBe("replied");
  });

  test("buttons answer with a value, dismiss, or open a page", async () => {
    const user = userId();
    const buttons = [
      { label: "Yes, please", value: "yes" },
      { label: "I'm fine", dismiss: true },
      { label: "Read the guide", url: "https://example.com/dns" },
    ];
    const asked = await send({ visitor: { userId: user }, body: "Check your DNS?", buttons });
    const dismissed = await send({ visitor: { userId: user }, body: "Another?", buttons });
    const token = await hostToken(space, user);
    await waiting(token);
    const click = await widget(
      token,
      "POST",
      `/outbound-messages/${asked.outboundMessage.id}/click`,
      {
        button: 2,
      },
    );
    expect(click.status).toBe(200);
    // A dismiss only takes a dismiss button.
    const wrong = await widget(
      token,
      "POST",
      `/outbound-messages/${dismissed.outboundMessage.id}/dismiss`,
      {
        button: 0,
      },
    );
    expect(wrong.status).toBe(404);
    await widget(token, "POST", `/outbound-messages/${dismissed.outboundMessage.id}/dismiss`, {
      button: 1,
    });
    expect(await rowOf(dismissed.outboundMessage.id)).toMatchObject({ status: "dismissed" });
    expect((await rowOf(dismissed.outboundMessage.id))?.conversationId).toBeNull();
    const replied = await answer(token, "ignored", [], {
      button: { outboundMessageId: asked.outboundMessage.id, index: 0 },
    });
    expect(replied.json).toMatchObject({
      body: "Yes, please",
      button: { value: "yes", label: "Yes, please" },
    });
    const after = await rowOf(asked.outboundMessage.id);
    expect(after?.status).toBe("replied");
    expect(after?.metadata.chosen).toEqual({ value: "yes", label: "Yes, please" });
  });
});

describe("a change that commits while another waits for the lock", () => {
  test("a fetch that waited sees the cancel, and shows nothing", async () => {
    const user = userId();
    const sent = await send({ visitor: { userId: user }, body: "Cancelled meanwhile" });
    const { id } = sent.outboundMessage;
    const token = await hostToken(space, user);
    const shown = await whileLocked(
      (tx) =>
        tx
          .update(outboundMessage)
          .set({ status: "cancelled", statusReason: "cancelled_by_api" })
          .where(eq(outboundMessage.id, id)),
      () => waiting(token),
    );
    expect(shown).toEqual([]);
    expect((await rowOf(id))?.status).toBe("cancelled");
  });
});

describe("a delete", () => {
  test("of a conversation ends its waiting messages, so they never show again", async () => {
    const { visitorId, token, conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const join = await send({
      visitor: { id: visitorId },
      body: "Joined",
      ifOpen: "join",
      once: "deleted-once",
    });
    await waiting(token);
    expect((await rowOf(join.outboundMessage.id))?.conversationId).toBe(conversationId);
    const deleted = await asOperator(
      app,
      boss.cookie,
      "DELETE",
      inSpace(`/conversations/${conversationId}`),
    );
    expect(deleted.status).toBe(200);
    expect(await waiting(token)).toEqual([]);
    expect(await rowOf(join.outboundMessage.id)).toMatchObject({
      status: "cancelled",
      statusReason: "conversation_deleted",
      body: null,
    });
    // Its `once` key is free again, as after any cancel.
    const again = await send({ visitor: { id: visitorId }, body: "Again", once: "deleted-once" });
    expect(again.status).toBe(201);
  });

  test("of its message removes the outbound message's text", async () => {
    const sent = await send({
      visitor: { userId: userId() },
      body: "Deleted later",
      startConversation: "now",
    });
    const row = await rowOf(sent.outboundMessage.id);
    const deleted = await asOperator(
      app,
      boss.cookie,
      "DELETE",
      inSpace(`/conversations/${row?.conversationId}/messages/${row?.messageId}`),
    );
    expect(deleted.status).toBe(200);
    expect((await rowOf(sent.outboundMessage.id))?.body).toBeNull();
  });
});

describe("an answer", () => {
  test("assigns the member who sent one of its messages, not a team message after it", async () => {
    const user = userId();
    const byMember = await send({
      visitor: { userId: user },
      sender: { operatorId: boss.id },
      body: "From Julien",
    });
    const byTeam = await send({
      visitor: { userId: user },
      sender: "team",
      assign: true,
      body: "From the team",
    });
    const token = await hostToken(space, user);
    await waiting(token);
    await answer(token, "Hi both", [byMember.outboundMessage.id, byTeam.outboundMessage.id]);
    const [started] = await conversationsOf(byMember.outboundMessage.visitorId);
    expect(started?.assigneeOperatorId).toBe(boss.id);
  });

  test("to a message that started the conversation sends conversation.created once", async () => {
    const user = userId();
    const sent = await send({ visitor: { userId: user }, body: "First words" });
    const now = await send({
      visitor: { userId: userId() },
      body: "Started now",
      startConversation: "now",
    });
    const token = await hostToken(space, user);
    await waiting(token);
    await answer(token, "Hello", [sent.outboundMessage.id]);
    for (const id of [sent.outboundMessage.id, now.outboundMessage.id]) {
      const conversationId = (await rowOf(id))?.conversationId ?? "";
      const created = await owner
        .select({ id: event.seq })
        .from(event)
        .where(
          and(
            eq(event.workspaceId, space.id),
            eq(event.kind, "message.created"),
            sql`${event.payload}->>'conversationId' = ${conversationId}`,
            sql`(${event.payload}->>'conversationCreated')::boolean`,
          ),
        );
      expect(created).toHaveLength(1);
    }
  });
});

describe("buttons in a conversation", () => {
  test("come with the message, and a value button answers there", async () => {
    const user = userId();
    const buttons = [
      { label: "Send the list", value: "list" },
      { label: "No thanks", dismiss: true },
    ];
    const sent = await send({
      visitor: { userId: user },
      body: "Your import finished. Want the list?",
      buttons,
      startConversation: "now",
    });
    const token = await hostToken(space, user);
    const history = (await widget(token, "GET", "/messages")).json.messages as {
      outboundId: string | null;
      buttons: unknown[];
    }[];
    expect(history.find((one) => one.outboundId === sent.outboundMessage.id)?.buttons).toEqual(
      buttons,
    );
    const replied = await answer(token, "ignored", [], {
      button: { outboundMessageId: sent.outboundMessage.id, index: 0 },
    });
    expect(replied.json).toMatchObject({
      body: "Send the list",
      button: { value: "list", label: "Send the list" },
    });
    expect(await rowOf(sent.outboundMessage.id)).toMatchObject({ status: "replied" });
  });

  test("a dismissed message keeps no buttons after a reload", async () => {
    const user = userId();
    const sent = await send({
      visitor: { userId: user },
      body: "Want a tour?",
      buttons: [{ label: "No thanks", dismiss: true }],
      startConversation: "now",
    });
    const token = await hostToken(space, user);
    const dismissed = await widget(
      token,
      "POST",
      `/outbound-messages/${sent.outboundMessage.id}/dismiss`,
      { button: 0 },
    );
    expect(dismissed.status).toBe(200);
    const history = (await widget(token, "GET", "/messages")).json.messages as {
      outboundId: string | null;
      buttons: unknown[];
    }[];
    expect(history.find((one) => one.outboundId === sent.outboundMessage.id)?.buttons).toEqual([]);
  });
});

describe("when a conversation is open", () => {
  test("hold waits, join goes in, skip cancels", async () => {
    const { visitorId, token, conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    const hold = await send({ visitor: { id: visitorId }, body: "Held" });
    const join = await send({ visitor: { id: visitorId }, body: "Joined", ifOpen: "join" });
    const skip = await send({ visitor: { id: visitorId }, body: "Skipped", ifOpen: "skip" });
    expect(await waiting(token)).toEqual([]);
    expect(await rowOf(hold.outboundMessage.id)).toMatchObject({
      status: "pending",
      statusReason: "open_conversation",
    });
    expect((await rowOf(join.outboundMessage.id))?.conversationId).toBe(conversationId);
    expect(await rowOf(skip.outboundMessage.id)).toMatchObject({
      status: "cancelled",
      statusReason: "open_conversation_skipped",
    });
    await asOperator(app, boss.cookie, "PATCH", inSpace(`/conversations/${conversationId}`), {
      status: "closed",
    });
    expect((await waiting(token)).map((one) => one.body)).toEqual(["Held"]);
  });

  test("a key's message never joins a conversation that a person handles", async () => {
    const { visitorId, token, conversationId } = await visitorStarts(app, space.publicKey, "Hi");
    await asOperator(
      app,
      boss.cookie,
      "POST",
      inSpace(`/conversations/${conversationId}/messages`),
      {
        clientId: randomUUID(),
        body: "I am here",
      },
    );
    const join = await send({ visitor: { id: visitorId }, body: "Bot", ifOpen: "join" });
    await waiting(token);
    expect(await rowOf(join.outboundMessage.id)).toMatchObject({
      statusReason: "human_handling",
      conversationId: null,
    });
  });
});

describe("the worker", () => {
  const due = (id: string) =>
    owner
      .update(outboundMessage)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(eq(outboundMessage.id, id));

  test("sends at sendAt, and `now` starts a conversation that the team started", async () => {
    const user = userId();
    const sent = await send({
      visitor: { userId: user },
      body: "Your import finished",
      delay: "1h",
      startConversation: "now",
    });
    expect(sent.outboundMessage.status).toBe("scheduled");
    await due(sent.outboundMessage.id);
    expect(await runDueOutbound(workerDb, db, noLive, 10)).toBe(true);
    const row = await rowOf(sent.outboundMessage.id);
    expect(row?.status).toBe("pending");
    const [started] = await conversationsOf(sent.outboundMessage.visitorId);
    expect(started).toMatchObject({ id: row?.conversationId, startedBy: "team", status: "open" });
    const listed = await asOperator(
      app,
      boss.cookie,
      "GET",
      inSpace("/conversations?startedBy=team"),
    );
    const ids = ((await listed.json()) as { conversations: { id: string }[] }).conversations.map(
      (one) => one.id,
    );
    expect(ids).toContain(started?.id);
  });

  test("unless cancels at the change of the contact, and a cancel frees `once`", async () => {
    const user = userId();
    const unless = { field: "attributes.domainVerified", op: "eq", value: true };
    const sent = await send({
      visitor: { userId: user, attributes: { domainVerified: false } },
      body: "Not verified yet?",
      delay: "1h",
      unless,
      once: "dns:1",
    });
    const changed = await withKey(app, bot.token, "PUT", inSpace(`/contacts/by-user/${user}`), {
      attributes: { domainVerified: true },
    });
    expect(changed.status).toBe(200);
    expect(await rowOf(sent.outboundMessage.id)).toMatchObject({
      status: "cancelled",
      statusReason: "unless_matched",
    });
    const second = await send({
      visitor: { userId: user },
      body: "Again",
      delay: "1h",
      once: "dns:2",
    });
    const cancel = await withKey(app, bot.token, "POST", inSpace("/outbound-messages/cancel"), {
      visitor: { userId: user },
      once: "dns:2",
    });
    expect(((await cancel.json()) as { outboundMessage: View }).outboundMessage).toMatchObject({
      id: second.outboundMessage.id,
      status: "cancelled",
      statusReason: "cancelled_by_api",
    });
    const third = await send({ visitor: { userId: user }, body: "Free again", once: "dns:2" });
    expect(third.status).toBe(201);
  });

  test("a paused bot's scheduled message waits, and an unread one expires", async () => {
    const sent = await send({ visitor: { userId: userId() }, body: "Later", delay: "1h" });
    await owner
      .update(workspace)
      .set({ botsPausedAt: new Date() })
      .where(eq(workspace.id, space.id));
    await due(sent.outboundMessage.id);
    await runDueOutbound(workerDb, db, noLive, 10);
    expect(await rowOf(sent.outboundMessage.id)).toMatchObject({
      status: "scheduled",
      statusReason: "bots_paused",
    });
    await owner.update(workspace).set({ botsPausedAt: null }).where(eq(workspace.id, space.id));
    const expiring = await send({ visitor: { userId: userId() }, body: "Short" });
    await owner
      .update(outboundMessage)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(outboundMessage.id, expiring.outboundMessage.id));
    expect(await expireOutbound(workerDb, db, noLive, 10)).toBe(true);
    expect((await rowOf(expiring.outboundMessage.id))?.status).toBe("expired");
  });
});

describe("an expired message", () => {
  const expire = (id: string) =>
    owner
      .update(outboundMessage)
      .set({ expiresAt: new Date(Date.now() - 1000), dueAt: new Date(Date.now() - 1000) })
      .where(eq(outboundMessage.id, id));

  test("that the worker reaches late never goes in a conversation", async () => {
    const sent = await send({
      visitor: { userId: userId() },
      body: "Too late",
      delay: "1h",
      startConversation: "now",
    });
    await expire(sent.outboundMessage.id);
    await runDueOutbound(workerDb, db, noLive, 10);
    expect(await rowOf(sent.outboundMessage.id)).toMatchObject({
      status: "expired",
      conversationId: null,
    });
    expect(await conversationsOf(sent.outboundMessage.visitorId)).toEqual([]);
  });

  test("that the worker has not ended yet never shows", async () => {
    const user = userId();
    const sent = await send({ visitor: { userId: user }, body: "Stale" });
    await expire(sent.outboundMessage.id);
    expect(await waiting(await hostToken(space, user))).toEqual([]);
    expect((await rowOf(sent.outboundMessage.id))?.status).toBe("expired");
  });
});

describe("materializeOutbound", () => {
  test("checks the visitor, and a second call adds nothing", async () => {
    const sent = await send({
      visitor: { userId: userId() },
      body: "Once",
      startConversation: "now",
    });
    const { id, visitorId } = sent.outboundMessage;
    const again = await withWorkspace(db, space.id, (tx) =>
      materializeOutbound(tx, space.id, id, visitorId, { answer: false }),
    );
    expect(again).toBeNull();
    const stranger = await withWorkspace(db, space.id, (tx) =>
      materializeOutbound(tx, space.id, id, randomUUID(), { answer: false }),
    );
    expect(stranger).toBeNull();
  });
});

describe("decide", () => {
  const calm: Situation = {
    writable: true,
    blocked: false,
    botsPaused: false,
    key: { revoked: false, replyMode: "send", mayActAsMember: true, maySendEmail: true },
    senderActive: true,
    open: null,
    unlessMatched: false,
  };
  const keyMessage = {
    authorApiKeyId: "k",
    senderKind: "author" as const,
    ifOpen: "join" as const,
    email: false,
  };

  test("follows the reply gate for a key, and joins for a member", () => {
    const handled = { ...calm, open: { id: "c", humanSince: new Date() } };
    expect(decide(keyMessage, handled)).toEqual({ kind: "wait", reason: "human_handling" });
    expect(decide({ ...keyMessage, authorApiKeyId: null }, { ...handled, key: null })).toEqual({
      kind: "join",
      conversationId: "c",
    });
    expect(decide(keyMessage, { ...calm, botsPaused: true })).toEqual({
      kind: "wait",
      reason: "bots_paused",
    });
    expect(decide(keyMessage, { ...calm, unlessMatched: true })).toEqual({
      kind: "cancel",
      reason: "unless_matched",
    });
    expect(decide(keyMessage, { ...calm, writable: false })).toEqual({
      kind: "wait",
      reason: "workspace_inactive",
    });
  });

  test("a key's email message waits while the key may not send email", () => {
    const noEmail = { ...calm, key: calm.key && { ...calm.key, maySendEmail: false } };
    expect(decide({ ...keyMessage, email: true }, noEmail)).toEqual({
      kind: "wait",
      reason: "permission_revoked",
    });
    expect(decide(keyMessage, noEmail)).toEqual({ kind: "go" });
  });
});

describe("an AI agent through MCP", () => {
  test("starts a conversation now, and wait_for_messages picks up the answer", async () => {
    const user = userId();
    const now = await callTool(app, bot.token, "wait_for_messages", {});
    const cursor = now.structuredContent.cursor as string;
    const sent = await callTool(app, bot.token, "send_outbound_message", {
      clientId: randomUUID(),
      visitor: { userId: user },
      body: "Your import finished with 3 skipped messages. Want the list?",
      startConversation: "now",
      once: "import-7781-done",
    });
    expect(sent.isError).toBe(false);
    const made = sent.structuredContent.outboundMessage as View;
    expect(made.conversationId).not.toBeNull();
    const again = await callTool(app, bot.token, "send_outbound_message", {
      clientId: randomUUID(),
      visitor: { userId: user },
      body: "A repeat",
      once: "import-7781-done",
    });
    expect((again.structuredContent.outboundMessage as View).id).toBe(made.id);
    await answer(await hostToken(space, user), "Yes please", []);
    const waited = await callTool(app, bot.token, "wait_for_messages", {
      cursor,
      timeoutSeconds: 5,
    });
    const messages = waited.structuredContent.messages as {
      conversationId: string;
      message: { body: string };
    }[];
    expect(messages.map((one) => [one.conversationId, one.message.body])).toEqual([
      [made.conversationId, "Yes please"],
    ]);
    const listed = await callTool(app, bot.token, "list_outbound_messages", {
      visitorId: made.visitorId,
    });
    expect((listed.structuredContent.outboundMessages as View[]).map((one) => one.status)).toEqual([
      "replied",
    ]);
  });

  test("upserts a contact and cancels by `once`", async () => {
    const user = userId();
    const upserted = await callTool(app, bot.token, "upsert_contact", {
      userId: user,
      attributes: { plan: "trial" },
    });
    expect(upserted.structuredContent).toMatchObject({ created: true });
    await callTool(app, bot.token, "send_outbound_message", {
      clientId: randomUUID(),
      visitor: { userId: user },
      body: "Later",
      delay: "1h",
      once: "trial-ends",
    });
    const cancelled = await callTool(app, bot.token, "cancel_outbound_message", {
      visitor: { userId: user },
      once: "trial-ends",
    });
    expect(cancelled.structuredContent.outboundMessage).toMatchObject({ status: "cancelled" });
    const unclear = await callTool(app, bot.token, "cancel_outbound_message", {
      once: "trial-ends",
    });
    expect(unclear.isError).toBe(true);
  });
});

describe("the event stream and webhooks", () => {
  test("carry each change of an outbound message, with the message", async () => {
    const [current] = await owner
      .select({ generation: workspace.feedGeneration, seq: workspace.eventSeq })
      .from(workspace)
      .where(eq(workspace.id, space.id));
    const sent = await send({ visitor: { userId: userId() }, body: "Watched" });
    const stream = await app.request(
      `/v1/events?types=outbound_message.pending&after=${current?.generation}.${current?.seq}`,
      { headers: { authorization: `Bearer ${bot.token}` } },
    );
    const text = await readStream(stream);
    expect(text).toContain("event: outbound_message.pending");
    expect(text).toContain(sent.outboundMessage.id);
    expect(text).toContain('"body":"Watched"');
    await owner.insert(webhook).values({
      workspaceId: space.id,
      url: "https://hooks.example.com/dinghy",
      secret: "whsec_test",
      events: ["outbound_message.pending"],
    });
    await send({ visitor: { userId: userId() }, body: "Hooked" });
    while (await fanOutWebhooksOne(workerDb)) {}
    const deliveries = await owner
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.workspaceId, space.id));
    expect(deliveries.map((one) => [one.type, one.conversationId === null])).toEqual([
      ["outbound_message.pending", true],
    ]);
    const data = await withWorkspace(db, space.id, (tx) =>
      webhookData(tx, undefined, space.id, [
        { outboundMessageId: deliveries[0]?.outboundMessageId ?? "" },
      ]),
    );
    expect(data[0]).toMatchObject({ outboundMessage: { body: "Hooked", status: "pending" } });
  });
});
