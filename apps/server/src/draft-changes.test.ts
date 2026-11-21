import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { and, eq, gt, max } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { setReplyMode } from "../test/keys.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, callTool, withKey } from "../test/requests.ts";
import { readStream } from "../test/sse.ts";
import { SITE, visitorSays, visitorStarts } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { type Auth, createAuth } from "./auth.ts";
import {
  conversation,
  draftChangeRequest,
  draftReply,
  event,
  webhook,
  webhookDelivery,
  workspace,
} from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createLive } from "./live.ts";
import { localStore } from "./storage.ts";
import { createUploads } from "./uploads.ts";
import { claimWebhookDeliveries, deliverWebhook, fanOutWebhooksOne } from "./webhooks.ts";
import { purgeDeletedWorkspaces } from "./workspace-delete.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let workerDb: Database;
let app: App;
let auth: Auth;
let space: NewWorkspace;
let boss: { id: string; cookie: string };
/** The bot that rewrites its drafts, and one that does not. */
let writer: { id: string; token: string };
let other: { id: string; token: string };
const cleanups: (() => void)[] = [];

const inChat = (conversationId: string, path: string, workspaceId = space.id) =>
  `/v1/operator/workspaces/${workspaceId}/conversations/${conversationId}${path}`;

interface ChangeRequest {
  id: string;
  draftId: string;
  apiKeyId: string;
  instruction: string;
  status: string;
  replacementDraftId: string | null;
}
interface Draft {
  id: string;
  body: string;
  status: string;
  replyToMessageId: string | null;
  canAskToChange: boolean;
  changeRequest: ChangeRequest | null;
}

async function errorCode(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

const listed = async (conversationId: string) =>
  (
    (await (
      await asOperator(app, boss.cookie, "GET", inChat(conversationId, "/drafts"))
    ).json()) as { drafts: Draft[] }
  ).drafts;

const ask = (
  conversationId: string,
  draftId: string,
  instruction = "shorter",
  clientId: string = randomUUID(),
) =>
  asOperator(
    app,
    boss.cookie,
    "POST",
    inChat(conversationId, `/drafts/${draftId}/change-requests`),
    {
      clientId,
      instruction,
    },
  );

/** A key's reply that answers a change request. */
const answer = (
  token: string,
  conversationId: string,
  changeRequestId: string,
  body = "Short.",
  clientId: string = randomUUID(),
) =>
  withKey(app, token, "POST", inChat(conversationId, "/messages"), {
    clientId,
    body,
    changeRequestId,
  });

/** A visitor's chat with a draft of the writer's, quoting the visitor, and an Ask on it. */
async function asked(instruction = "shorter") {
  const chat = await visitorStarts(app, space.publicKey, "Where is my order?");
  const messageId = chat.first.id;
  const made = await withKey(app, writer.token, "POST", inChat(chat.conversationId, "/messages"), {
    clientId: randomUUID(),
    body: "Your order left our warehouse this morning and should arrive in two days.",
    replyToMessageId: messageId,
  });
  const { draft } = (await made.json()) as { draft: Draft };
  const response = await ask(chat.conversationId, draft.id, instruction);
  expect(response.status).toBe(201);
  const { changeRequest } = (await response.json()) as { changeRequest: ChangeRequest };
  return { ...chat, draft, changeRequest, messageId };
}

/** A chat whose request the writer answered, so the request names both drafts. */
async function fulfilled() {
  const chat = await asked();
  const answered = await answer(writer.token, chat.conversationId, chat.changeRequest.id);
  expect(answered.status).toBe(202);
  expect((await changeRequestRow(chat.changeRequest.id))?.status).toBe("fulfilled");
  return chat;
}

const changeRequestRow = async (id: string) =>
  (await owner.select().from(draftChangeRequest).where(eq(draftChangeRequest.id, id)))[0];

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 10).db;
  workerDb = database.connect("worker", 2).db;
  owner = database.connect("migrator").db;
  const publisher = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  publisher.on("error", () => {});
  const live = createLive(publisher, VALKEY_URL, logger);
  cleanups.push(() => {
    live.stop();
    publisher.disconnect();
  });
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  app = createApp({
    db,
    logger,
    auth,
    live,
    uploads: createUploads({
      store: localStore(tmpdir()),
      secret: AUTH_SECRET,
      publicUrl: PUBLIC_URL,
    }),
    checks: { postgres: ok, valkey: ok },
    stream: { heartbeatMs: 200, lifetimeMs: 60_000 },
  });
  space = await createWorkspace(db, "Acme", [SITE]);
  boss = await signedInOperator({ app, auth, owner, name: "Mona", workspaceId: space.id });
  const keys = `/v1/operator/workspaces/${space.id}/api-keys`;
  const made = await asOperator(app, boss.cookie, "POST", keys, { name: "Writer" });
  writer = (await made.json()) as { id: string; token: string };
  const turned = await asOperator(app, boss.cookie, "PATCH", `${keys}/${writer.id}`, {
    rewritesDrafts: true,
  });
  expect(((await turned.json()) as { rewritesDrafts: boolean }).rewritesDrafts).toBe(true);
  const second = await asOperator(app, boss.cookie, "POST", keys, { name: "Other" });
  other = (await second.json()) as { id: string; token: string };
}, 30_000);

beforeEach(async () => {
  await setReplyMode(owner, writer.id, "draft");
  await owner.update(workspace).set({ botsPausedAt: null }).where(eq(workspace.id, space.id));
});

afterAll(async () => {
  for (const cleanup of cleanups) cleanup();
  await database.drop();
});

describe("asking to change a draft", () => {
  test("a draft of a key that rewrites drafts offers it, and shows the request that waits", async () => {
    const chat = await asked();
    expect(chat.draft).toMatchObject({ canAskToChange: true, changeRequest: null });
    expect(chat.changeRequest).toMatchObject({
      draftId: chat.draft.id,
      apiKeyId: writer.id,
      instruction: "shorter",
      status: "pending",
    });
    const [shown] = await listed(chat.conversationId);
    expect(shown?.changeRequest).toEqual(chat.changeRequest);
    const tool = await callTool(app, writer.token, "list_drafts", {
      conversationId: chat.conversationId,
    });
    expect(tool.structuredContent.drafts).toEqual([
      expect.objectContaining({ id: chat.draft.id, changeRequest: chat.changeRequest }),
    ]);
  });

  test("a retry returns the first request, and a second request waits for a cancel", async () => {
    const chat = await asked();
    const clientId = randomUUID();
    const retried = await asOperator(
      app,
      boss.cookie,
      "POST",
      inChat(chat.conversationId, `/drafts/${chat.draft.id}/change-requests`),
      { clientId, instruction: "in Spanish" },
    );
    expect(retried.status).toBe(409);
    const refused = (await retried.json()) as {
      error: { code: string };
      changeRequest: ChangeRequest;
    };
    expect(refused.error.code).toBe("change_request_pending");
    expect(refused.changeRequest.id).toBe(chat.changeRequest.id);
    const cancel = inChat(
      chat.conversationId,
      `/drafts/${chat.draft.id}/change-requests/${chat.changeRequest.id}/cancel`,
    );
    const cancelled = await asOperator(app, boss.cookie, "POST", cancel);
    expect(cancelled.status).toBe(200);
    expect(
      ((await cancelled.json()) as { changeRequest: ChangeRequest }).changeRequest.status,
    ).toBe("cancelled");
    const again = await ask(chat.conversationId, chat.draft.id, "in Spanish", clientId);
    expect(again.status).toBe(201);
    const same = await ask(chat.conversationId, chat.draft.id, "in Spanish", clientId);
    expect(same.status).toBe(200);
    const first = (await again.json()) as { changeRequest: ChangeRequest };
    expect(((await same.json()) as { changeRequest: ChangeRequest }).changeRequest.id).toBe(
      first.changeRequest.id,
    );
    // The cancelled request is closed to the bot.
    const late = await answer(writer.token, chat.conversationId, chat.changeRequest.id);
    expect(late.status).toBe(409);
    expect(await errorCode(late)).toBe("change_request_closed");
  });

  test("a key that does not rewrite drafts refuses an Ask", async () => {
    await setReplyMode(owner, other.id, "draft");
    const chat = await visitorStarts(app, space.publicKey, "Hello?");
    const made = await withKey(app, other.token, "POST", inChat(chat.conversationId, "/messages"), {
      clientId: randomUUID(),
      body: "Hi there.",
    });
    const { draft } = (await made.json()) as { draft: Draft };
    expect(draft.canAskToChange).toBe(false);
    const refused = await ask(chat.conversationId, draft.id);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("rewrites_off");
    expect(
      await owner.select().from(draftChangeRequest).where(eq(draftChangeRequest.draftId, draft.id)),
    ).toEqual([]);
  });

  test("keys cannot ask", async () => {
    const chat = await asked();
    const path = inChat(chat.conversationId, `/drafts/${chat.draft.id}/change-requests`);
    const refused = await withKey(app, writer.token, "POST", path, {
      clientId: randomUUID(),
      instruction: "shorter",
    });
    expect(refused.status).toBe(403);
  });
});

describe("the bot's answer", () => {
  test("replaces the draft, keeps its quote, and a retry returns the same new draft", async () => {
    const chat = await asked();
    const clientId = randomUUID();
    const answered = await answer(
      writer.token,
      chat.conversationId,
      chat.changeRequest.id,
      "Ships today, arrives in 2 days.",
      clientId,
    );
    expect(answered.status).toBe(202);
    const { draft } = (await answered.json()) as { draft: Draft };
    expect(draft).toMatchObject({
      body: "Ships today, arrives in 2 days.",
      status: "open",
      replyToMessageId: chat.messageId,
      changeRequest: null,
    });
    expect(await listed(chat.conversationId)).toEqual([expect.objectContaining({ id: draft.id })]);
    const [old] = await owner.select().from(draftReply).where(eq(draftReply.id, chat.draft.id));
    expect(old?.resolved).toBe("replaced");
    expect(await changeRequestRow(chat.changeRequest.id)).toMatchObject({
      status: "fulfilled",
      replacementDraftId: draft.id,
    });
    const retried = await answer(
      writer.token,
      chat.conversationId,
      chat.changeRequest.id,
      "Ships today, arrives in 2 days.",
      clientId,
    );
    expect(retried.status).toBe(202);
    expect(((await retried.json()) as { draft: Draft }).draft.id).toBe(draft.id);
    // A replaced draft can be neither sent as it is nor discarded.
    const base = inChat(chat.conversationId, `/drafts/${chat.draft.id}`);
    expect((await asOperator(app, boss.cookie, "POST", `${base}/send`, {})).status).toBe(404);
    expect((await asOperator(app, boss.cookie, "POST", `${base}/discard`)).status).toBe(404);
  });

  test("an operator's edit of a replaced draft still sends, once", async () => {
    const chat = await fulfilled();
    const send = inChat(chat.conversationId, `/drafts/${chat.draft.id}/send`);
    const edit = { body: "My own words." };
    const first = await asOperator(app, boss.cookie, "POST", send, edit);
    expect(first.status).toBe(201);
    const again = await asOperator(app, boss.cookie, "POST", send, edit);
    expect(((await again.json()) as { id: string }).id).toBe(
      ((await first.json()) as { id: string }).id,
    );
  });

  test("through MCP, as reply with changeRequestId", async () => {
    const chat = await asked();
    const replied = await callTool(app, writer.token, "reply", {
      conversationId: chat.conversationId,
      body: "Short.",
      clientId: randomUUID(),
      changeRequestId: chat.changeRequest.id,
    });
    expect(replied.structuredContent).toMatchObject({
      status: "drafted",
      draft: { body: "Short.", status: "open" },
    });
  });

  test("another key cannot answer it, nor an operator", async () => {
    const chat = await asked();
    await setReplyMode(owner, other.id, "draft");
    const crossed = await answer(other.token, chat.conversationId, chat.changeRequest.id);
    expect(crossed.status).toBe(404);
    const byPerson = await asOperator(
      app,
      boss.cookie,
      "POST",
      inChat(chat.conversationId, "/messages"),
      {
        clientId: randomUUID(),
        body: "Short.",
        changeRequestId: chat.changeRequest.id,
      },
    );
    expect(byPerson.status).toBe(400);
    expect((await changeRequestRow(chat.changeRequest.id))?.status).toBe("pending");
  });

  test("bots paused refuses it, and a person handling the conversation does not", async () => {
    const chat = await asked();
    await owner
      .update(workspace)
      .set({ botsPausedAt: new Date() })
      .where(eq(workspace.id, space.id));
    const paused = await answer(writer.token, chat.conversationId, chat.changeRequest.id);
    expect(paused.status).toBe(409);
    expect(await errorCode(paused)).toBe("bots_paused");
    await owner.update(workspace).set({ botsPausedAt: null }).where(eq(workspace.id, space.id));
    // A send-mode key that a person silenced still drafts its answer.
    await setReplyMode(owner, writer.id, "send");
    await owner
      .update(conversation)
      .set({ humanSince: new Date() })
      .where(eq(conversation.id, chat.conversationId));
    const handled = await answer(writer.token, chat.conversationId, chat.changeRequest.id);
    expect(handled.status).toBe(202);
  });
});

describe("what cancels a request", () => {
  test("a visitor's new message, so a late answer is refused", async () => {
    const chat = await asked();
    await visitorSays(app, space.publicKey, chat.token, "Actually, never mind.");
    expect((await changeRequestRow(chat.changeRequest.id))?.status).toBe("cancelled");
    const late = await answer(writer.token, chat.conversationId, chat.changeRequest.id);
    expect(late.status).toBe(409);
    expect(await errorCode(late)).toBe("change_request_closed");
    const [stale] = await listed(chat.conversationId);
    expect(stale).toMatchObject({ status: "stale", canAskToChange: false, changeRequest: null });
    const refused = await ask(chat.conversationId, chat.draft.id);
    expect(await errorCode(refused)).toBe("draft_not_waiting");
  });

  test("sending the draft, and discarding it", async () => {
    const sent = await asked();
    const send = inChat(sent.conversationId, `/drafts/${sent.draft.id}/send`);
    expect((await asOperator(app, boss.cookie, "POST", send, {})).status).toBe(201);
    expect((await changeRequestRow(sent.changeRequest.id))?.status).toBe("cancelled");
    const discarded = await asked();
    const discard = inChat(discarded.conversationId, `/drafts/${discarded.draft.id}/discard`);
    expect((await asOperator(app, boss.cookie, "POST", discard)).status).toBe(200);
    expect((await changeRequestRow(discarded.changeRequest.id))?.status).toBe("cancelled");
  });
});

describe("who hears of a request", () => {
  test("only the key that wrote the draft, on wait_for_events and /v1/events", async () => {
    const start = async (token: string) =>
      (await callTool(app, token, "wait_for_events", {})).structuredContent.cursor as string;
    const [mine, theirs] = await Promise.all([start(writer.token), start(other.token)]);
    const chat = await asked("in Spanish");
    const waited = await callTool(app, writer.token, "wait_for_events", {
      cursor: mine,
      timeoutSeconds: 1,
    });
    const events = waited.structuredContent.events as { type: string }[];
    expect(events.map((one) => one.type)).toEqual(["message.created", "draft.change_requested"]);
    expect(events[1]).toEqual({
      type: "draft.change_requested",
      changeRequest: expect.objectContaining({
        id: chat.changeRequest.id,
        instruction: "in Spanish",
      }),
      draft: expect.objectContaining({ id: chat.draft.id, body: chat.draft.body }),
    });
    const elsewhere = await callTool(app, other.token, "wait_for_events", {
      cursor: theirs,
      timeoutSeconds: 1,
    });
    const otherTypes = (elsewhere.structuredContent.events as { type: string }[]).map(
      (one) => one.type,
    );
    expect(otherTypes).toEqual(["message.created"]);

    const stream = (token: string, after: string) =>
      app.request(`/v1/events?after=${after}`, { headers: { authorization: `Bearer ${token}` } });
    const written = await readStream(await stream(writer.token, mine));
    expect(written).toContain("event: draft.change_requested");
    expect(written).toContain('"instruction":"in Spanish"');
    expect(await readStream(await stream(other.token, theirs))).not.toContain(
      "draft.change_requested",
    );
  });

  test("a webhook gets it with the request and the draft", async () => {
    const bodies: string[] = [];
    const receiver = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        bodies.push(body);
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const { port } = receiver.address() as AddressInfo;
    try {
      while (await fanOutWebhooksOne(workerDb)) {}
      await owner.insert(webhook).values({
        workspaceId: space.id,
        url: `http://127.0.0.1:${port}/hook`,
        secret: "whsec_test",
        events: ["draft.change_requested"],
      });
      const chat = await asked("offer a call");
      while (await fanOutWebhooksOne(workerDb)) {}
      const stopping = new AbortController().signal;
      const deliverAll = async () => {
        for (const row of await claimWebhookDeliveries(workerDb, 50, 60_000)) {
          const policy = { allowPrivate: true };
          await deliverWebhook(workerDb, row, { uploads: undefined, policy, retryMs: 1, stopping });
        }
      };
      await deliverAll();
      const delivered = expect.objectContaining({
        type: "draft.change_requested",
        data: {
          changeRequest: expect.objectContaining({
            id: chat.changeRequest.id,
            instruction: "offer a call",
            apiKeyId: writer.id,
          }),
          draft: expect.objectContaining({ id: chat.draft.id }),
        },
      });
      expect(bodies.map((body) => JSON.parse(body))).toEqual([delivered]);
      // A replay names the same request, so it sends the same event.
      const [first] = await owner
        .select()
        .from(webhookDelivery)
        .where(eq(webhookDelivery.changeRequestId, chat.changeRequest.id));
      if (first === undefined) throw new Error("The event made no delivery");
      const replay = `/v1/operator/workspaces/${space.id}/webhooks/${first.webhookId}/deliveries/${first.id}/replay`;
      expect((await asOperator(app, boss.cookie, "POST", replay)).status).toBe(201);
      await deliverAll();
      expect(bodies.map((body) => JSON.parse(body))).toEqual([delivered, delivered]);
    } finally {
      await owner.delete(webhook).where(eq(webhook.workspaceId, space.id));
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
    }
  });
});

describe("deleting what a request names", () => {
  test("deleting a conversation takes a fulfilled request and both its drafts", async () => {
    const chat = await fulfilled();
    const path = `/v1/operator/workspaces/${space.id}/conversations/${chat.conversationId}`;
    expect((await asOperator(app, boss.cookie, "DELETE", path)).status).toBe(200);
    expect(await changeRequestRow(chat.changeRequest.id)).toBeUndefined();
    expect(
      await owner
        .select()
        .from(draftReply)
        .where(eq(draftReply.conversationId, chat.conversationId)),
    ).toEqual([]);
  });

  test("purging a workspace takes a fulfilled request", async () => {
    const doomed = await createWorkspace(db, "Doomed", [SITE]);
    const mona = await signedInOperator({ app, auth, owner, workspaceId: doomed.id });
    const keys = `/v1/operator/workspaces/${doomed.id}/api-keys`;
    const bot = (await (
      await asOperator(app, mona.cookie, "POST", keys, { name: "Writer" })
    ).json()) as { id: string; token: string };
    await asOperator(app, mona.cookie, "PATCH", `${keys}/${bot.id}`, { rewritesDrafts: true });
    await setReplyMode(owner, bot.id, "draft");
    const chat = await visitorStarts(app, doomed.publicKey, "Hello?");
    const messages = inChat(chat.conversationId, "/messages", doomed.id);
    const made = await withKey(app, bot.token, "POST", messages, {
      clientId: randomUUID(),
      body: "Hi there, how can I help you today?",
    });
    const { draft } = (await made.json()) as { draft: Draft };
    const asking = await asOperator(
      app,
      mona.cookie,
      "POST",
      inChat(chat.conversationId, `/drafts/${draft.id}/change-requests`, doomed.id),
      { clientId: randomUUID(), instruction: "shorter" },
    );
    const { changeRequest } = (await asking.json()) as { changeRequest: ChangeRequest };
    const answered = await withKey(app, bot.token, "POST", messages, {
      clientId: randomUUID(),
      body: "Hi!",
      changeRequestId: changeRequest.id,
    });
    expect(answered.status).toBe(202);
    await owner.update(workspace).set({ deletedAt: new Date() }).where(eq(workspace.id, doomed.id));
    await purgeDeletedWorkspaces(workerDb);
    expect(await changeRequestRow(changeRequest.id)).toBeUndefined();
    expect(await owner.select().from(workspace).where(eq(workspace.id, doomed.id))).toEqual([]);
  });
});

describe("what a key sees of other keys' requests", () => {
  test("list_drafts shows a request only to the key that wrote the draft", async () => {
    const chat = await asked("mention the refund");
    const tool = async (token: string) =>
      (
        (await callTool(app, token, "list_drafts", { conversationId: chat.conversationId }))
          .structuredContent.drafts as Draft[]
      )[0]?.changeRequest;
    expect((await tool(writer.token))?.instruction).toBe("mention the refund");
    expect(await tool(other.token)).toBeNull();
    // Keys cannot read the drafts route.
    const route = await withKey(app, other.token, "GET", inChat(chat.conversationId, "/drafts"));
    expect(route.status).toBe(403);
    // Operators see every request.
    expect((await listed(chat.conversationId))[0]?.changeRequest?.id).toBe(chat.changeRequest.id);
  });
});

describe("an answer's clientId", () => {
  test("that made another draft is refused, and a retry of this answer is not", async () => {
    const first = await asked();
    const clientId = randomUUID();
    const answered = await answer(
      writer.token,
      first.conversationId,
      first.changeRequest.id,
      "A.",
      clientId,
    );
    expect(answered.status).toBe(202);
    const { draft } = (await answered.json()) as { draft: Draft };
    const second = await asked();
    const reused = await answer(
      writer.token,
      second.conversationId,
      second.changeRequest.id,
      "B.",
      clientId,
    );
    expect(reused.status).toBe(409);
    expect(await errorCode(reused)).toBe("client_id_reused");
    expect((await changeRequestRow(second.changeRequest.id))?.status).toBe("pending");
    const retried = await answer(
      writer.token,
      first.conversationId,
      first.changeRequest.id,
      "A.",
      clientId,
    );
    expect(retried.status).toBe(202);
    expect(((await retried.json()) as { draft: Draft }).draft.id).toBe(draft.id);
  });
});

describe("turning draft rewrites off and on", () => {
  test("tells open operator apps to load the key's waiting drafts again", async () => {
    const chat = await asked();
    const [last] = await owner
      .select({ seq: max(event.seq) })
      .from(event)
      .where(eq(event.workspaceId, space.id));
    const changed = async () =>
      (
        await owner
          .select({ kind: event.kind, payload: event.payload })
          .from(event)
          .where(and(eq(event.workspaceId, space.id), gt(event.seq, last?.seq ?? 0n)))
      ).filter(
        (one) =>
          one.kind === "draft.changed" &&
          (one.payload as { conversationId: string }).conversationId === chat.conversationId,
      ).length;
    const keyPath = `/v1/operator/workspaces/${space.id}/api-keys/${writer.id}`;
    try {
      await asOperator(app, boss.cookie, "PATCH", keyPath, { rewritesDrafts: false });
      expect(await changed()).toBe(1);
      expect((await listed(chat.conversationId))[0]?.canAskToChange).toBe(false);
    } finally {
      await asOperator(app, boss.cookie, "PATCH", keyPath, { rewritesDrafts: true });
    }
    expect(await changed()).toBe(2);
    // A change to anything else leaves the drafts as they are.
    await asOperator(app, boss.cookie, "PATCH", keyPath, { replyMode: "draft" });
    expect(await changed()).toBe(2);
  });
});
