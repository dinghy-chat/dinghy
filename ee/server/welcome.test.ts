// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fanOutOne } from "../../apps/server/src/alerts.ts";
import { type App, createApp } from "../../apps/server/src/app.ts";
import { createAuth } from "../../apps/server/src/auth.ts";
import {
  alertDelivery,
  attachment,
  conversation,
  event,
  message,
  operator,
  subscription,
  visitor,
  welcomeLink,
  workspace,
  workspaceMember,
} from "../../apps/server/src/db/schema.ts";
import { type Database, withWorkspace } from "../../apps/server/src/db/tenant.ts";
import { createImages } from "../../apps/server/src/images.ts";
import { appendMessage } from "../../apps/server/src/messages.ts";
import { localStore, type ObjectStore } from "../../apps/server/src/storage.ts";
import { exportArchive, importArchive } from "../../apps/server/src/transfer.ts";
import { purgeDeletedWorkspaces } from "../../apps/server/src/workspace-delete.ts";
import { createWorkspace, type NewWorkspace } from "../../apps/server/src/workspaces.ts";
import { createTestDatabase, type TestDatabase } from "../../apps/server/test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../../apps/server/test/env.ts";
import { signedInOperator } from "../../apps/server/test/operators.ts";
import { cloudProblem } from "./index.ts";
import {
  STRIPE_PRICE_ID,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  startFakeStripe,
} from "./test/fake-stripe.ts";
import type { WelcomeSettings } from "./welcome.ts";

const ORIGIN = new URL(PUBLIC_URL).origin;
const WELCOME =
  "Hi, I'm Julien, the founder of Dinghy. This is where you'll read and answer messages from " +
  "your website visitors. Reply here and it comes to my own Dinghy inbox. I read every reply, so " +
  "tell me what you need or what feels confusing.";
/** Room for a small image and not much more, so the image limit can refuse a copy. */
const MAX_IMAGE_BYTES = 10_000;
const logger = pino({ level: "silent" });
const ok = async () => {};

let database: TestDatabase;
let db: Database;
let owner: Database;
let workerDb: Database;
let valkey: Redis;
let stripe: Awaited<ReturnType<typeof startFakeStripe>>;
let directory: string;
let store: ObjectStore;
let auth: ReturnType<typeof createAuth>;
let dinghy: NewWorkspace;
let julien: { id: string; email: string; cookie: string };
let settings: WelcomeSettings;
let early: App;
let paying: App;
let shared: Parameters<typeof createApp>[0];

const newIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;

const request = (
  server: App,
  method: string,
  path: string,
  { cookie, body }: { cookie: string; body?: unknown },
) =>
  server.request(path, {
    method,
    headers: {
      origin: ORIGIN,
      cookie,
      "x-forwarded-for": newIp(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const inWorkspace = (id: string, path = "") => `/v1/operator/workspaces/${id}${path}`;

interface Customer {
  workspaceId: string;
  cookie: string;
  operatorId: string;
}

/** A new account names itself and creates a cloud workspace, as the onboarding does. */
async function signUp(server: App, workspaceName = "Acme"): Promise<Customer> {
  const ana = await signedInOperator({ app: server, auth, owner, name: "Ana" });
  const response = await request(server, "POST", "/v1/operator/workspaces", {
    cookie: ana.cookie,
    body: { name: "Ana", workspaceName },
  });
  expect(response.status).toBe(200);
  const { workspaceId } = (await response.json()) as { workspaceId: string };
  return { workspaceId, cookie: ana.cookie, operatorId: ana.id };
}

/** Both sides of a customer's welcome chat. */
async function linkOf(customerWorkspaceId: string) {
  const [link] = await owner
    .select()
    .from(welcomeLink)
    .where(eq(welcomeLink.customerWorkspaceId, customerWorkspaceId));
  if (link === undefined) throw new Error("No welcome link");
  return link;
}

/** A conversation's messages, oldest first, as the owner sees them. */
const messagesIn = (workspaceId: string, conversationId: string) =>
  owner
    .select()
    .from(message)
    .where(and(eq(message.workspaceId, workspaceId), eq(message.conversationId, conversationId)))
    .orderBy(message.seq);

const reply = (server: App, cookie: string, workspaceId: string, chatId: string, body: string) =>
  request(server, "POST", inWorkspace(workspaceId, `/conversations/${chatId}/messages`), {
    cookie,
    body: { clientId: randomUUID(), body },
  });

/** A valid one-pixel PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const replyImage = (server: App, cookie: string, workspaceId: string, chatId: string) =>
  server.request(
    inWorkspace(workspaceId, `/conversations/${chatId}/images?clientId=${randomUUID()}`),
    {
      method: "POST",
      headers: { origin: ORIGIN, cookie, "content-type": "image/png" },
      body: PNG,
    },
  );

const readChat = async (server: App, cookie: string, workspaceId: string, chatId: string) => {
  const response = await request(
    server,
    "GET",
    inWorkspace(workspaceId, `/conversations/${chatId}/messages`),
    { cookie },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    welcome: unknown;
    visitorPages: unknown[];
    conversation: { visitor: { pictureUrl: string | null } };
  };
};

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  db = database.connect("app", 20).db;
  owner = database.connect("migrator").db;
  workerDb = database.connect("worker", 2).db;
  valkey = new Redis(VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  stripe = await startFakeStripe();
  directory = await mkdtemp(join(tmpdir(), "dinghy-welcome-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Dinghy</title>");
  store = localStore(join(directory, "images"));
  auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  shared = {
    auth,
    db,
    logger,
    valkey,
    trustedProxyHops: 1,
    limitScale: 100,
    alerts: { emailAvailable: true, secret: AUTH_SECRET },
    images: createImages({ store, secret: AUTH_SECRET, publicUrl: PUBLIC_URL }),
    checks: { postgres: ok, valkey: ok },
  };
  dinghy = await createWorkspace(db, "Dinghy", []);
  const bootstrap = createApp(shared);
  julien = await signedInOperator({
    app: bootstrap,
    auth,
    owner,
    name: "Julien",
    workspaceId: dinghy.id,
  });
  settings = { workspaceId: dinghy.id, operatorEmail: julien.email };
  const limits = { maxImageBytes: MAX_IMAGE_BYTES };
  early = createApp({ ...shared, cloud: { signup: "early", welcome: settings, limits } });
  paying = createApp({
    ...shared,
    cloud: {
      welcome: settings,
      limits,
      billing: {
        secretKey: STRIPE_SECRET_KEY,
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        priceId: STRIPE_PRICE_ID,
        apiBase: stripe.apiBase,
      },
    },
  });
}, 30_000);

afterAll(async () => {
  valkey.disconnect();
  await stripe.stop();
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

describe("a new workspace's welcome chat", () => {
  test.each([
    ["early", () => early, "waiting_cloud"],
    ["payment", () => paying, "waiting_payment"],
  ] as const)("starts at signup in %s mode", async (_mode, server, access) => {
    const acme = await signUp(server(), `Acme ${randomUUID()}`);
    const link = await linkOf(acme.workspaceId);
    expect(link.founderWorkspaceId).toBe(dinghy.id);

    const [customerSide] = await owner
      .select({ chat: conversation, guest: visitor })
      .from(conversation)
      .innerJoin(
        visitor,
        and(
          eq(visitor.workspaceId, conversation.workspaceId),
          eq(visitor.id, conversation.visitorId),
        ),
      )
      .where(eq(conversation.workspaceId, acme.workspaceId));
    expect(customerSide?.chat).toMatchObject({
      id: link.customerConversationId,
      welcome: true,
      status: "open",
    });
    expect(customerSide?.guest).toMatchObject({ name: "Julien from Dinghy", email: null });
    expect(await messagesIn(acme.workspaceId, link.customerConversationId)).toMatchObject([
      { body: WELCOME, authorVisitorId: customerSide?.guest.id },
    ]);

    const [founderSide] = await owner
      .select({ chat: conversation, guest: visitor })
      .from(conversation)
      .innerJoin(
        visitor,
        and(
          eq(visitor.workspaceId, conversation.workspaceId),
          eq(visitor.id, conversation.visitorId),
        ),
      )
      .where(
        and(
          eq(conversation.workspaceId, dinghy.id),
          eq(conversation.id, link.founderConversationId),
        ),
      );
    expect(founderSide?.chat).toMatchObject({ welcome: true, assigneeOperatorId: julien.id });
    expect(founderSide?.guest.name).toMatch(/^Ana, Acme /);
    expect(founderSide?.guest.email).toBeNull();
    expect(await messagesIn(dinghy.id, link.founderConversationId)).toMatchObject([
      { body: WELCOME, authorOperatorId: julien.id },
    ]);

    // Nobody hears about the welcome itself: the new owner is in the app already.
    const events = await owner.select().from(event).where(eq(event.workspaceId, acme.workspaceId));
    expect(events.map((one) => [one.kind, one.needsAlert])).toEqual([["message.created", false]]);
    // The workspace still waits, for the cloud or for its payment.
    const state = await owner.execute<{ access: string }>(
      sql`select workspace_access(${acme.workspaceId}) as access`,
    );
    expect(state.rows[0]?.access).toBe(access);

    // Julien's side names the new workspace and says it takes his replies, or not yet.
    expect(
      (await readChat(server(), julien.cookie, dinghy.id, link.founderConversationId)).welcome,
    ).toMatchObject({ with: "workspace", access });
  });

  test("the server refuses to start unless the operator is an active member", async () => {
    expect(await cloudProblem(undefined, db)).toBeNull();
    expect(await cloudProblem({ signup: "early", welcome: settings }, db)).toBeNull();
    const elsewhere = await createWorkspace(db, "Elsewhere", []);
    expect(
      await cloudProblem(
        { signup: "early", welcome: { ...settings, workspaceId: elsewhere.id } },
        db,
      ),
    ).toBe("CLOUD_WELCOME_OPERATOR_EMAIL is not an active member of CLOUD_WELCOME_WORKSPACE_ID");
    expect(
      await cloudProblem(
        { signup: "early", welcome: { ...settings, operatorEmail: "nobody@example.com" } },
        db,
      ),
    ).not.toBeNull();
    const leaver = await signedInOperator({ app: early, auth, owner, workspaceId: dinghy.id });
    await owner
      .update(workspaceMember)
      .set({ removedAt: new Date() })
      .where(eq(workspaceMember.operatorId, leaver.id));
    expect(
      await cloudProblem(
        { signup: "early", welcome: { ...settings, operatorEmail: leaver.email } },
        db,
      ),
    ).not.toBeNull();
  });
});

describe("the founder's picture", () => {
  test("the new workspace's chat carries it, its list too, and the founder's side does not", async () => {
    await owner.update(operator).set({ pictureUpdatedAt: null }).where(eq(operator.id, julien.id));
    const acme = await signUp(early, `Acme ${randomUUID()}`);
    const chat = (await linkOf(acme.workspaceId)).customerConversationId;
    const before = await readChat(early, acme.cookie, acme.workspaceId, chat);
    expect(before.welcome).toEqual({ with: "founder", pictureUrl: null });

    const at = new Date("2026-11-11T10:00:00Z");
    await owner.update(operator).set({ pictureUpdatedAt: at }).where(eq(operator.id, julien.id));
    const after = await readChat(early, acme.cookie, acme.workspaceId, chat);
    const pictureUrl = after.conversation.visitor.pictureUrl;
    expect(after.welcome).toEqual({ with: "founder", pictureUrl });
    // The operator picture route's own address, so no new image route is needed.
    expect(pictureUrl).toMatch(new RegExp(`^${PUBLIC_URL}/v1/pictures/${julien.id}\\?v=\\d+$`));
    const list = await request(early, "GET", inWorkspace(acme.workspaceId, "/conversations"), {
      cookie: acme.cookie,
    });
    const listed = (await list.json()) as {
      conversations: { id: string; visitor: { pictureUrl: string | null } }[];
    };
    expect(listed.conversations.find((one) => one.id === chat)?.visitor.pictureUrl).toBe(
      pictureUrl,
    );
    // Dinghy's side shows the new workspace, which has no picture.
    const founderList = await request(early, "GET", inWorkspace(dinghy.id, "/conversations"), {
      cookie: julien.cookie,
    });
    const founderRows = (await founderList.json()) as {
      conversations: { visitor: { pictureUrl: string | null } }[];
    };
    expect(founderRows.conversations.every((one) => one.visitor.pictureUrl === null)).toBe(true);
  });
});

describe("copies between the two sides", () => {
  test("a reply goes each way as a visitor message, and a copy is never copied back", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    const customerChat = link.customerConversationId;
    const founderChat = link.founderConversationId;

    const fromAna = await reply(early, acme.cookie, acme.workspaceId, customerChat, "Hi Julien!");
    expect(fromAna.status).toBe(201);
    const founderMessages = await messagesIn(dinghy.id, founderChat);
    expect(founderMessages.map((one) => [one.body, one.authorVisitorId !== null])).toEqual([
      [WELCOME, false],
      ["Hi Julien!", true],
    ]);

    const fromJulien = await reply(early, julien.cookie, dinghy.id, founderChat, "Hi Ana!");
    expect(fromJulien.status).toBe(201);
    const customerMessages = await messagesIn(acme.workspaceId, customerChat);
    expect(customerMessages.map((one) => [one.body, one.authorVisitorId !== null])).toEqual([
      [WELCOME, true],
      ["Hi Julien!", false],
      ["Hi Ana!", true],
    ]);
    // Each copy happened once, and no copy made another.
    expect(await messagesIn(dinghy.id, founderChat)).toHaveLength(3);

    // A visitor message on either side stays there.
    const guest = customerMessages[0]?.authorVisitorId ?? "";
    await withWorkspace(db, acme.workspaceId, (tx) =>
      appendMessage(
        tx,
        acme.workspaceId,
        { kind: "visitor", visitorId: guest },
        {
          clientId: randomUUID(),
          body: "Only here",
        },
      ),
    );
    expect(await messagesIn(dinghy.id, founderChat)).toHaveLength(3);

    // The panel names the other side, and has no visit or pages.
    const customerView = await readChat(early, acme.cookie, acme.workspaceId, customerChat);
    expect(customerView).toMatchObject({ welcome: { with: "founder" }, visitorPages: [] });
    const founderView = await readChat(early, julien.cookie, dinghy.id, founderChat);
    expect(founderView.welcome).toEqual({
      with: "workspace",
      name: "Acme",
      access: "waiting_cloud",
    });
  });

  test("replies that cross, one on each side, all go and are all copied", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    const rounds = Array.from({ length: 8 }, (_, i) => i);
    const sent = await Promise.all(
      rounds.flatMap((i) => [
        reply(early, acme.cookie, acme.workspaceId, link.customerConversationId, `Ana ${i}`),
        reply(early, julien.cookie, dinghy.id, link.founderConversationId, `Julien ${i}`),
      ]),
    );
    expect(sent.map((one) => one.status)).toEqual(sent.map(() => 201));
    expect(await messagesIn(dinghy.id, link.founderConversationId)).toHaveLength(1 + 16);
    expect(await messagesIn(acme.workspaceId, link.customerConversationId)).toHaveLength(1 + 16);
  });

  test("an API key's reply is copied", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    const made = await request(early, "POST", inWorkspace(acme.workspaceId, "/api-keys"), {
      cookie: acme.cookie,
      body: { name: "Helper" },
    });
    const { token } = (await made.json()) as { token: string };
    const sent = await early.request(
      inWorkspace(acme.workspaceId, `/conversations/${link.customerConversationId}/messages`),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ clientId: "key-1", body: "From a script" }),
      },
    );
    expect(sent.status).toBe(201);
    const founderMessages = await messagesIn(dinghy.id, link.founderConversationId);
    expect(founderMessages.at(-1)).toMatchObject({ body: "From a script" });
    expect(founderMessages.at(-1)?.authorVisitorId).not.toBeNull();
  });

  test("an image goes each way as a file of the receiving workspace", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    expect(
      (await replyImage(early, acme.cookie, acme.workspaceId, link.customerConversationId)).status,
    ).toBe(201);
    expect(
      (await replyImage(early, julien.cookie, dinghy.id, link.founderConversationId)).status,
    ).toBe(201);
    for (const [workspaceId, chatId] of [
      [dinghy.id, link.founderConversationId],
      [acme.workspaceId, link.customerConversationId],
    ] as const) {
      const copy = (await messagesIn(workspaceId, chatId)).find(
        (one) => one.kind === "image" && one.authorVisitorId !== null,
      );
      expect(copy).toBeDefined();
      const [file] = await owner
        .select()
        .from(attachment)
        .where(
          and(eq(attachment.workspaceId, workspaceId), eq(attachment.messageId, copy?.id ?? "")),
        );
      expect(file?.storageKey.startsWith(`${workspaceId}/`)).toBe(true);
      expect(await store.get(file?.storageKey ?? "")).not.toBeNull();
    }
  });

  test("an image stays when the reply's commit is lost, since the reply may have committed", async () => {
    let loseCommit = false;
    // Postgres commits the reply, and the connection drops before its answer arrives.
    const lossy = new Proxy(db, {
      get(target, key) {
        if (key !== "transaction") return Reflect.get(target, key);
        return async (...args: Parameters<Database["transaction"]>) => {
          const result: unknown = await target.transaction(...args);
          if (
            loseCommit &&
            typeof result === "object" &&
            result !== null &&
            "visitorId" in result
          ) {
            loseCommit = false;
            throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" });
          }
          return result;
        };
      },
    });
    const server = createApp({
      ...shared,
      db: lossy,
      cloud: { signup: "early", welcome: settings, limits: { maxImageBytes: MAX_IMAGE_BYTES } },
    });
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    loseCommit = true;
    expect(
      (await replyImage(server, julien.cookie, dinghy.id, link.founderConversationId)).status,
    ).toBe(500);
    const copy = (await messagesIn(acme.workspaceId, link.customerConversationId)).find(
      (one) => one.kind === "image",
    );
    const [file] = await owner
      .select()
      .from(attachment)
      .where(
        and(eq(attachment.workspaceId, acme.workspaceId), eq(attachment.messageId, copy?.id ?? "")),
      );
    expect(file).toBeDefined();
    expect(await store.get(file?.storageKey ?? "")).not.toBeNull();
  });

  test("an image over the receiving workspace's limit is skipped, and the reply still goes", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    // Acme's storage is full, from an image a visitor sent.
    const guest = await owner
      .insert(visitor)
      .values({ workspaceId: acme.workspaceId, tokenHash: randomUUID() })
      .returning({ id: visitor.id });
    await withWorkspace(db, acme.workspaceId, (tx) =>
      appendMessage(
        tx,
        acme.workspaceId,
        { kind: "visitor", visitorId: guest[0]?.id ?? "" },
        {
          clientId: randomUUID(),
          image: {
            attachmentId: randomUUID(),
            storageKey: `${acme.workspaceId}/full`,
            byteSize: MAX_IMAGE_BYTES,
            contentType: "image/png",
            width: 1,
            height: 1,
          },
        },
      ),
    );
    const before = await messagesIn(acme.workspaceId, link.customerConversationId);
    expect(
      (await replyImage(early, julien.cookie, dinghy.id, link.founderConversationId)).status,
    ).toBe(201);
    expect(await messagesIn(acme.workspaceId, link.customerConversationId)).toHaveLength(
      before.length,
    );
  });

  test("a closed chat reopens with the copy", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    const closing = await request(
      early,
      "PATCH",
      inWorkspace(dinghy.id, `/conversations/${link.founderConversationId}`),
      { cookie: julien.cookie, body: { status: "closed" } },
    );
    expect(closing.status).toBe(200);
    await reply(early, acme.cookie, acme.workspaceId, link.customerConversationId, "Still there?");
    const [chat] = await owner
      .select({ status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, link.founderConversationId));
    expect(chat?.status).toBe("open");
    expect((await messagesIn(dinghy.id, link.founderConversationId)).at(-1)?.body).toBe(
      "Still there?",
    );
  });

  test("a block on either side stops copies both ways", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    const blocked = await request(
      early,
      "POST",
      inWorkspace(dinghy.id, `/conversations/${link.founderConversationId}/block`),
      { cookie: julien.cookie },
    );
    expect(blocked.status).toBe(200);
    const founderBefore = await messagesIn(dinghy.id, link.founderConversationId);
    const customerBefore = await messagesIn(acme.workspaceId, link.customerConversationId);
    expect(
      (await reply(early, acme.cookie, acme.workspaceId, link.customerConversationId, "Hello?"))
        .status,
    ).toBe(201);
    expect(
      (await reply(early, julien.cookie, dinghy.id, link.founderConversationId, "Bye")).status,
    ).toBe(201);
    expect(await messagesIn(dinghy.id, link.founderConversationId)).toHaveLength(
      founderBefore.length + 1,
    );
    expect(await messagesIn(acme.workspaceId, link.customerConversationId)).toHaveLength(
      customerBefore.length + 1,
    );
  });
});

describe("alerts and analytics", () => {
  test("the bridged visitors get no email, and each side's operators get their usual alerts", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    await owner
      .update(workspaceMember)
      .set({ alertEmail: true })
      .where(eq(workspaceMember.workspaceId, acme.workspaceId));
    await reply(early, acme.cookie, acme.workspaceId, link.customerConversationId, "Question");
    await reply(early, julien.cookie, dinghy.id, link.founderConversationId, "Answer");
    while (await fanOutOne(workerDb, { push: true, email: true }));
    const deliveries = await owner
      .select()
      .from(alertDelivery)
      .where(eq(alertDelivery.conversationId, link.customerConversationId));
    // Julien's answer reached Acme as a visitor message, so Ana hears of it, by email.
    expect(deliveries.map((one) => [one.operatorId, one.channel])).toEqual([
      [acme.operatorId, "email"],
    ]);
    const toVisitors = await owner
      .select()
      .from(alertDelivery)
      .where(isNotNull(alertDelivery.visitorId));
    expect(toVisitors).toEqual([]);
  });

  test("analytics leave welcome chats out on both sides", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    await reply(early, julien.cookie, dinghy.id, link.founderConversationId, "Any questions?");
    for (const [workspaceId, cookie] of [
      [acme.workspaceId, acme.cookie],
      [dinghy.id, julien.cookie],
    ] as const) {
      const response = await request(
        early,
        "GET",
        inWorkspace(workspaceId, "/analytics?days=7&tz=UTC"),
        { cookie },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ started: 0, answered: 0, operators: [] });
    }
  });
});

/** The subscription ended: the workspace is read-only. */
const endSubscription = (workspaceId: string) =>
  owner
    .insert(subscription)
    .values({ workspaceId, stripeCustomerId: "cus_test", readOnlyAt: new Date() });

describe("while the new workspace has not paid, or its subscription ended", () => {
  test.each([
    ["waiting_payment", () => paying, async () => {}],
    ["read_only", () => early, endSubscription],
  ] as const)("Julien's reply is copied into it while it is %s", async (access, server, change) => {
    const acme = await signUp(server(), "Acme");
    const link = await linkOf(acme.workspaceId);
    await change(acme.workspaceId);
    expect(
      (await reply(server(), julien.cookie, dinghy.id, link.founderConversationId, "Still there?"))
        .status,
    ).toBe(201);
    const copies = await messagesIn(acme.workspaceId, link.customerConversationId);
    expect(copies.at(-1)).toMatchObject({ body: "Still there?", authorOperatorId: null });
    expect(copies.at(-1)?.authorVisitorId).not.toBeNull();
    expect(
      (await readChat(server(), julien.cookie, dinghy.id, link.founderConversationId)).welcome,
    ).toEqual({ with: "workspace", name: "Acme", access });
  });

  test("its operator still replies in the welcome chat in text, and only there", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    const [guest] = await owner
      .insert(visitor)
      .values({ workspaceId: acme.workspaceId, externalId: "bea", name: "Bea" })
      .returning({ id: visitor.id });
    const [other] = await owner
      .insert(conversation)
      .values({ workspaceId: acme.workspaceId, visitorId: guest?.id ?? "" })
      .returning({ id: conversation.id });
    await endSubscription(acme.workspaceId);

    const answer = await reply(
      early,
      acme.cookie,
      acme.workspaceId,
      link.customerConversationId,
      "Paying soon",
    );
    expect(answer.status).toBe(201);
    expect((await messagesIn(dinghy.id, link.founderConversationId)).at(-1)).toMatchObject({
      body: "Paying soon",
      authorOperatorId: null,
    });

    const elsewhere = await reply(early, acme.cookie, acme.workspaceId, other?.id ?? "", "Hi Bea");
    expect(elsewhere.status).toBe(402);
    expect(await elsewhere.json()).toMatchObject({ error: { code: "read_only" } });
    // Text only: an upload stays refused before it is read.
    const image = await replyImage(
      early,
      acme.cookie,
      acme.workspaceId,
      link.customerConversationId,
    );
    expect(image.status).toBe(402);

    await owner
      .update(workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(workspace.id, acme.workspaceId));
    const suspended = await reply(
      early,
      acme.cookie,
      acme.workspaceId,
      link.customerConversationId,
      "Hello?",
    );
    expect(suspended.status).toBe(403);
  });
});

describe("when the new workspace stops taking messages", () => {
  test.each([
    ["suspended", { suspendedAt: new Date() }],
    ["deleted", { deletedAt: new Date() }],
  ] as const)(
    "Julien's reply still goes when it is %s, and is not copied",
    async (access, change) => {
      const acme = await signUp(early, "Acme");
      const link = await linkOf(acme.workspaceId);
      await owner.update(workspace).set(change).where(eq(workspace.id, acme.workspaceId));
      const before = await messagesIn(acme.workspaceId, link.customerConversationId);
      expect(
        (await reply(early, julien.cookie, dinghy.id, link.founderConversationId, "Hello?")).status,
      ).toBe(201);
      expect(await messagesIn(acme.workspaceId, link.customerConversationId)).toHaveLength(
        before.length,
      );
      expect(
        (await readChat(early, julien.cookie, dinghy.id, link.founderConversationId)).welcome,
      ).toEqual({ with: "workspace", name: "Acme", access });
    },
  );

  test("a suspension before the first payment stops the copies too", async () => {
    const acme = await signUp(paying, "Acme");
    const link = await linkOf(acme.workspaceId);
    await owner
      .update(workspace)
      .set({ suspendedAt: new Date() })
      .where(eq(workspace.id, acme.workspaceId));
    const before = await messagesIn(acme.workspaceId, link.customerConversationId);
    expect(
      (await reply(paying, julien.cookie, dinghy.id, link.founderConversationId, "Hello?")).status,
    ).toBe(201);
    expect(await messagesIn(acme.workspaceId, link.customerConversationId)).toHaveLength(
      before.length,
    );
  });

  test("its deletion takes the link, and Dinghy keeps its side as history", async () => {
    const acme = await signUp(early);
    const link = await linkOf(acme.workspaceId);
    await reply(early, acme.cookie, acme.workspaceId, link.customerConversationId, "Bye");
    await owner
      .update(workspace)
      .set({ deletedAt: new Date() })
      .where(eq(workspace.id, acme.workspaceId));
    await purgeDeletedWorkspaces(workerDb);
    expect(
      await owner
        .select()
        .from(welcomeLink)
        .where(eq(welcomeLink.customerWorkspaceId, acme.workspaceId)),
    ).toEqual([]);
    expect(await messagesIn(dinghy.id, link.founderConversationId)).toHaveLength(2);
    expect(
      (await readChat(early, julien.cookie, dinghy.id, link.founderConversationId)).welcome,
    ).toEqual({ with: "deleted" });
    expect(
      (await reply(early, julien.cookie, dinghy.id, link.founderConversationId, "Still here"))
        .status,
    ).toBe(201);
  });

  test("an export leaves the link out, and imports as plain history", async () => {
    const acme = await signUp(early);
    const parts: Uint8Array[] = [];
    for await (const part of exportArchive(db, store, acme.workspaceId)) parts.push(part);
    const archive = Buffer.concat(parts);
    expect(archive.toString("utf8")).not.toMatch(/welcome_?link|"welcome":/i);

    await owner
      .update(workspace)
      .set({ deletedAt: new Date() })
      .where(eq(workspace.id, acme.workspaceId));
    await purgeDeletedWorkspaces(workerDb);
    await importArchive(
      db,
      store,
      (async function* () {
        yield archive;
      })(),
    );
    const chats = await owner
      .select({ welcome: conversation.welcome })
      .from(conversation)
      .where(eq(conversation.workspaceId, acme.workspaceId));
    expect(chats).toEqual([{ welcome: false }]);
    expect(
      await owner
        .select()
        .from(welcomeLink)
        .where(eq(welcomeLink.customerWorkspaceId, acme.workspaceId)),
    ).toEqual([]);
  });
});
