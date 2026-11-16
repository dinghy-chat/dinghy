import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Dinghy, DinghyError } from "../../../packages/sdk/src/index.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { setReplyMode } from "../test/keys.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator } from "../test/requests.ts";
import { SITE } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { visitor } from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { createWorkspace } from "./workspaces.ts";

let database: TestDatabase;
let owner: Database;
let app: App;
let dinghy: Dinghy;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  const { db } = database.connect("app", 10);
  owner = database.connect("migrator").db;
  const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
  const ok = async () => {};
  app = createApp({
    db,
    logger: pino({ level: "silent" }),
    auth,
    checks: { postgres: ok, valkey: ok },
  });
  const space = await createWorkspace(db, "Shipmail", [SITE]);
  const boss = await signedInOperator({
    app,
    auth,
    owner,
    workspaceId: space.id,
    name: "Julien Coulaud",
    email: "julien@shipmail.example",
  });
  const made = await asOperator(
    app,
    boss.cookie,
    "POST",
    `/v1/operator/workspaces/${space.id}/api-keys`,
    {
      name: "Welcome bot",
      replyMode: "send",
    },
  );
  const key = (await made.json()) as { id: string; token: string };
  await setReplyMode(owner, key.id, "send");
  dinghy = new Dinghy({
    url: PUBLIC_URL,
    apiKey: key.token,
    fetch: (input, init) => app.request(input, init),
  });
}, 30_000);

afterAll(async () => {
  await database.drop();
});

// The SDK against the real routes: its types and paths must match what the server answers.
test("sends once, upserts a contact and cancels by the visitor and the dedupe key", async () => {
  const userId = `user-${randomUUID()}`;
  const welcome = {
    visitor: { userId },
    body: "Is your domain verified?",
    delay: "1h",
    dedupeKey: "dns:7",
  };
  const sent = await dinghy.outboundMessages.send(welcome);
  expect(sent.outboundMessage).toMatchObject({ status: "scheduled", dedupeKey: "dns:7" });
  const again = await dinghy.outboundMessages.send(welcome);
  expect(again.outboundMessage.id).toBe(sent.outboundMessage.id);

  await dinghy.contacts.upsert({ userId, name: "Ada Lovelace", attributes: { plan: "pro" } });
  const [contact] = await owner.select().from(visitor).where(eq(visitor.userId, userId));
  expect(contact).toMatchObject({ name: "Ada Lovelace", attributes: { plan: "pro" } });

  const cancelled = await dinghy.outboundMessages.cancel({
    visitor: { userId },
    dedupeKey: "dns:7",
  });
  expect(cancelled.outboundMessage).toMatchObject({
    id: sent.outboundMessage.id,
    status: "cancelled",
  });
  expect((await dinghy.outboundMessages.get(sent.outboundMessage.id)).outboundMessage.status).toBe(
    "cancelled",
  );
});

test("throws the server's error", async () => {
  const missing = dinghy.outboundMessages.get(randomUUID());
  await expect(missing).rejects.toBeInstanceOf(DinghyError);
  await expect(missing).rejects.toMatchObject({ status: 404, code: "not_found" });
});
