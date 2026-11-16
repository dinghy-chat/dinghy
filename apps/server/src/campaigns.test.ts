import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { untilWaiting } from "../test/locks.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, callTool, withKey } from "../test/requests.ts";
import { newVisitor, SITE, visitorSays } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { campaignRow } from "./campaign-checks.ts";
import { enterCampaign } from "./campaign-entry.ts";
import { latestOccurrence, openRuns, runCampaignRuns } from "./campaign-runs.ts";
import { CampaignDefinitionSchema } from "./campaign-schemas.ts";
import { endDueCampaigns } from "./campaigns.ts";
import {
  apiKey,
  businessHours,
  campaign,
  campaignRun,
  conversation,
  message,
  outboundMessage,
  visitor,
  workspace,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { createReplyAddress } from "./inbound-email.ts";
import { lockVisitors } from "./journey.ts";
import { noLive } from "./live.ts";
import { lockWorkspace } from "./messages.ts";
import { runDueOutbound } from "./outbound.ts";
import { signature } from "./webhooks.ts";
import { createWorkspace, type NewWorkspace } from "./workspaces.ts";

const logger = pino({ level: "silent" });

let database: TestDatabase;
let db: Database;
let workerDb: Database;
let owner: Database;
let app: App;
let space: NewWorkspace;
let boss: { id: string; email: string; cookie: string };
/** A Full access key, which may change campaigns and send as a member. */
let admin: { id: string; token: string };
/** A Chats key, which reads campaigns, sends them and tracks events. */
let server: { id: string; token: string };

const inSpace = (path: string) => `/v1/operator/workspaces/${space.id}${path}`;

interface Message {
  id: string;
  status: string;
  statusReason: string | null;
  visitorId: string;
  body: string | null;
  buttons: { label: string; value?: string }[];
  conversationId: string | null;
  sendAt: string;
}

interface CampaignView {
  id: string;
  status: string;
  version: number;
  definition: Record<string, unknown> & { key: string };
  totals: Record<string, number> & { clicks: Record<string, number> };
}

/** A unique campaign key for each test. */
const keyOf = (name: string) => `${name}-${randomUUID().slice(0, 8)}`;
const userId = () => `user-${randomUUID()}`;

/** A definition, with the parts a test does not care about filled in. */
function definitionOf(key: string, parts: Record<string, unknown> = {}) {
  return {
    key,
    name: `Campaign ${key}`,
    trigger: { type: "api" },
    message: { body: "Hello there" },
    presentation: { startConversation: "on_reply", show: "badge", ifConversationOpen: "skip" },
    ...parts,
  };
}

async function json<T>(
  response: Response,
): Promise<T & { error?: { code: string; message: string } }> {
  return (await response.json()) as T & { error?: { code: string; message: string } };
}

/** Saves a definition by key with the Full access key, and starts it unless told not to. */
async function live(key: string, parts: Record<string, unknown> = {}, start = true) {
  const saved = await withKey(app, admin.token, "PUT", inSpace(`/campaigns/by-key/${key}`), {
    ...definitionOf(key, parts),
  });
  const body = await json<{ campaign: CampaignView }>(saved);
  expect(saved.status, body.error?.message).toBeLessThan(300);
  if (start) {
    const resumed = await withKey(
      app,
      admin.token,
      "POST",
      inSpace(`/campaigns/by-key/${key}/resume`),
    );
    expect(resumed.status).toBe(200);
  }
  return body.campaign;
}

const upsertContact = (user: string, fields: Record<string, unknown>) =>
  withKey(app, server.token, "PUT", inSpace(`/contacts/by-user/${user}`), fields);

const messagesOf = async (visitorId: string) =>
  owner
    .select()
    .from(outboundMessage)
    .where(eq(outboundMessage.visitorId, visitorId))
    .orderBy(outboundMessage.createdAt);

const campaignMessages = (campaignId: string) =>
  owner
    .select()
    .from(outboundMessage)
    .where(eq(outboundMessage.campaignId, campaignId))
    .orderBy(outboundMessage.createdAt);

const visitorOf = async (user: string) =>
  (await owner.select().from(visitor).where(eq(visitor.userId, user)))[0];

const sendCampaign = async (key: string, body: Record<string, unknown>) => {
  const response = await withKey(
    app,
    server.token,
    "POST",
    inSpace(`/campaigns/by-key/${key}/send`),
    {
      clientId: randomUUID(),
      ...body,
    },
  );
  return { status: response.status, ...(await json<{ outboundMessage: Message }>(response)) };
};

/** Makes the worker see a message's time as come. */
const due = (id: string) =>
  owner
    .update(outboundMessage)
    .set({ dueAt: new Date(Date.now() - 1000) })
    .where(eq(outboundMessage.id, id));

const rowOf = async (id: string) =>
  (await owner.select().from(outboundMessage).where(eq(outboundMessage.id, id)))[0];

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
  const key = async (name: string, level: string, permissions: string[]) => {
    const made = await asOperator(app, boss.cookie, "POST", inSpace("/api-keys"), {
      name,
      level,
      replyMode: "send",
      permissions,
    });
    return (await made.json()) as { id: string; token: string };
  };
  admin = await key("Deploy", "setup", ["send_as_member", "send_email"]);
  server = await key("Shipmail server", "conversations", []);
}, 30_000);

beforeEach(async () => {
  await owner
    .update(workspace)
    .set({ campaignsPausedAt: null, campaignGapHours: 0, botsPausedAt: null })
    .where(eq(workspace.id, space.id));
  await owner.delete(businessHours).where(eq(businessHours.workspaceId, space.id));
});

afterAll(async () => {
  await database.drop();
});

describe("the definition", () => {
  test("is one JSON object, saved as a draft, and a save never changes the status", async () => {
    const key = keyOf("welcome");
    const made = await withKey(app, admin.token, "POST", inSpace("/campaigns"), definitionOf(key));
    const { campaign: created } = await json<{ campaign: CampaignView }>(made);
    expect(made.status).toBe(201);
    expect(created).toMatchObject({ status: "draft", version: 1 });
    expect(created.definition).toMatchObject({
      key,
      delivery: { sendEmail: false },
      rules: { frequency: "once", businessHours: false, endsAt: null },
    });
    const again = await withKey(app, admin.token, "POST", inSpace("/campaigns"), definitionOf(key));
    expect((await json(again)).error?.code).toBe("campaign_key_taken");
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${created.id}/pause`));
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/by-key/${key}/resume`));
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/by-key/${key}/pause`));
    const upserted = await withKey(app, admin.token, "PUT", inSpace(`/campaigns/by-key/${key}`), {
      ...definitionOf(key),
      name: "Renamed",
    });
    expect(upserted.status).toBe(200);
    expect((await json<{ campaign: CampaignView }>(upserted)).campaign).toMatchObject({
      status: "paused",
      version: 2,
    });
    const patched = await withKey(app, admin.token, "PATCH", inSpace(`/campaigns/${created.id}`), {
      rules: { frequency: { every: "7d" } },
    });
    const { campaign: after } = await json<{ campaign: CampaignView }>(patched);
    expect(after.definition).toMatchObject({
      name: "Renamed",
      rules: { frequency: { every: "7d" } },
    });
    const byKey = await withKey(app, server.token, "GET", inSpace(`/campaigns/by-key/${key}`));
    expect((await json<{ campaign: CampaignView }>(byKey)).campaign.id).toBe(created.id);
  });

  test("names what does not fit", async () => {
    const key = keyOf("bad");
    const refusals = [
      {
        trigger: { type: "page", url: "/pricing*", seconds: 20 },
        presentation: { startConversation: "on_reply", show: "chat", ifConversationOpen: "skip" },
      },
      { message: { body: "Hi {{ nickname }}" } },
      { message: { body: "Hi {{ firstName | shout }}" } },
      { message: { body: "Pick one", buttons: [{ label: "Yes", url: "https://example.com" }] } },
      { presentation: { startConversation: "on_reply", show: "badge" } },
      {
        variants: [
          { key: "a", weight: 1, control: true },
          { key: "b", weight: 1, control: true },
        ],
      },
    ];
    for (const parts of refusals) {
      const response = await withKey(
        app,
        admin.token,
        "PUT",
        inSpace(`/campaigns/by-key/${key}`),
        definitionOf(key, parts),
      );
      expect(response.status, JSON.stringify(parts)).toBe(400);
    }
  });

  test("a Chats key reads and sends, and only a Full access key or an admin changes", async () => {
    const key = keyOf("rights");
    await live(key);
    const change = await withKey(
      app,
      server.token,
      "PUT",
      inSpace(`/campaigns/by-key/${key}`),
      definitionOf(key),
    );
    expect([401, 403]).toContain(change.status);
    const pause = await withKey(
      app,
      server.token,
      "POST",
      inSpace(`/campaigns/by-key/${key}/pause`),
    );
    expect([401, 403]).toContain(pause.status);
    expect((await withKey(app, server.token, "GET", inSpace("/campaigns"))).status).toBe(200);
  });

  test("a key without the permission cannot stand behind a member's message", async () => {
    await owner.update(apiKey).set({ permissions: [] }).where(eq(apiKey.id, admin.id));
    try {
      const key = keyOf("as-member");
      const response = await withKey(
        app,
        admin.token,
        "PUT",
        inSpace(`/campaigns/by-key/${key}`),
        definitionOf(key, {
          message: { sender: { email: boss.email }, body: "Hi" },
        }),
      );
      expect((await json(response)).error?.code).toBe("send_as_member_required");
    } finally {
      await owner
        .update(apiKey)
        .set({ permissions: ["send_as_member", "send_email"] })
        .where(eq(apiKey.id, admin.id));
    }
  });
});

describe("a match trigger", () => {
  const audience = { field: "attributes.plan", op: "eq", value: "trial" };

  test("sends when a contact starts to match, with the text in their language", async () => {
    const key = keyOf("trial");
    const made = await live(key, {
      audience,
      trigger: { type: "match", delay: "1h" },
      message: {
        sender: { email: boss.email },
        body: 'Hi {{ firstName | default: "there" }}, on {{ attributes.plan | upcase }}?',
        buttons: [{ label: "Yes", value: "yes" }],
        translations: {
          fr: {
            body: 'Bonjour{{ firstName | prepend: " " }}, ça va ?',
            buttons: [{ label: "Oui", value: "yes" }],
          },
        },
      },
    });
    const ada = userId();
    await upsertContact(ada, { name: "Ada Lovelace", attributes: { plan: "pro" } });
    expect(await campaignMessages(made.id)).toHaveLength(0);
    await upsertContact(ada, { attributes: { plan: "trial" } });
    const [first] = await campaignMessages(made.id);
    expect(first).toMatchObject({
      status: "scheduled",
      body: "Hi Ada, on TRIAL?",
      senderKind: "member",
    });
    expect(first?.sendAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    // A change to a field it does not read checks nothing, and "once" holds.
    await upsertContact(ada, { attributes: { seats: 3 } });
    await upsertContact(ada, { attributes: { plan: "pro" } });
    await upsertContact(ada, { attributes: { plan: "trial" } });
    expect(await campaignMessages(made.id)).toHaveLength(1);

    const french = userId();
    await upsertContact(french, { attributes: { plan: "pro" } });
    await owner.update(visitor).set({ locale: "fr" }).where(eq(visitor.userId, french));
    await upsertContact(french, { attributes: { plan: "trial" } });
    const frenchVisitor = await visitorOf(french);
    const [theirs] = await messagesOf(frenchVisitor?.id ?? "");
    expect(theirs).toMatchObject({
      body: "Bonjour, ça va ?",
      buttons: [{ label: "Oui", value: "yes" }],
    });
  });

  test("checks the whole audience again at the send time", async () => {
    const key = keyOf("recheck");
    const made = await live(key, { audience, trigger: { type: "match", delay: "1h" } });
    const user = userId();
    await upsertContact(user, { attributes: { plan: "trial" } });
    const [scheduled] = await campaignMessages(made.id);
    // A direct write, which no check sees, so only the send time can catch it.
    await owner
      .update(visitor)
      .set({ attributes: { plan: "pro" } })
      .where(eq(visitor.userId, user));
    await due(scheduled?.id ?? "");
    await runDueOutbound(workerDb, db, noLive, 10);
    expect(await rowOf(scheduled?.id ?? "")).toMatchObject({
      status: "cancelled",
      statusReason: "audience_unmatched",
    });
  });

  test("a new contact from a server is checked against every live campaign", async () => {
    const key = keyOf("signed-in");
    const made = await live(key, {
      audience: { field: "signedIn", op: "eq", value: true },
      trigger: { type: "match" },
    });
    const user = userId();
    await upsertContact(user, { name: "Grace" });
    const [sent] = await campaignMessages(made.id);
    expect(sent).toMatchObject({ status: "sent", visitorId: (await visitorOf(user))?.id });
    // It would reach every new contact of the tests after this one.
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${made.id}/end`));
  });

  test("exitWhen ends the waiting messages, and repliedToCampaign stops it once they answer", async () => {
    const key = keyOf("exit");
    const made = await live(key, {
      audience,
      trigger: { type: "match", delay: "1h" },
      rules: { exitWhen: { field: "attributes.churned", op: "eq", value: true } },
    });
    const user = userId();
    await upsertContact(user, { attributes: { plan: "trial" } });
    await upsertContact(user, { attributes: { churned: true } });
    expect(await campaignMessages(made.id)).toMatchObject([
      { status: "cancelled", statusReason: "unless_matched" },
    ]);
  });

  test("a goal ends the campaign for the contact and counts in results", async () => {
    const key = keyOf("goal");
    const made = await live(key, {
      audience,
      trigger: { type: "match" },
      rules: { goal: { field: "attributes.domainVerified", op: "eq", value: true, within: "7d" } },
    });
    const user = userId();
    await upsertContact(user, { attributes: { plan: "trial" } });
    await upsertContact(user, { attributes: { domainVerified: true } });
    const [sent] = await campaignMessages(made.id);
    expect(sent?.goalReachedAt).not.toBeNull();
    const results = await withKey(
      app,
      server.token,
      "GET",
      inSpace(`/campaigns/${made.id}/results`),
    );
    const { variants } = await json<{
      variants: { goalReached: number; entered: number; sent: number }[];
    }>(results);
    expect(variants).toEqual([expect.objectContaining({ entered: 1, sent: 1, goalReached: 1 })]);
  });
});

describe("a send from code", () => {
  test("skips the audience, fills data, and keeps the frequency", async () => {
    const key = keyOf("onboarding-done");
    await live(key, {
      audience: { field: "attributes.plan", op: "eq", value: "never" },
      message: { body: 'Welcome to {{ data.plan | default: "your plan" }}!' },
    });
    const user = userId();
    const sent = await sendCampaign(key, { visitor: { userId: user }, data: { plan: "Pro" } });
    expect(sent.status).toBe(201);
    expect(sent.outboundMessage).toMatchObject({ status: "sent", body: "Welcome to Pro!" });
    const again = await sendCampaign(key, { visitor: { userId: user } });
    expect(again.status).toBe(200);
    expect(again.outboundMessage.id).toBe(sent.outboundMessage.id);
  });

  test("the list counts the messages every campaign sent in the last 7 days", async () => {
    const sentLastWeek = async () => {
      const listed = await withKey(app, server.token, "GET", inSpace("/campaigns"));
      return (await json<{ sentLastWeek: number }>(listed)).sentLastWeek;
    };
    const before = await sentLastWeek();
    const key = keyOf("last-week");
    await live(key);
    expect((await sendCampaign(key, { visitor: { userId: userId() } })).status).toBe(201);
    expect(await sentLastWeek()).toBe(before + 1);
  });

  test("a retry with the same client ID answers the first result", async () => {
    const key = keyOf("retry");
    await live(key, { rules: { frequency: { every: "1m" } } });
    const clientId = randomUUID();
    const user = userId();
    const first = await sendCampaign(key, { clientId, visitor: { userId: user } });
    const second = await sendCampaign(key, { clientId, visitor: { userId: user } });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.outboundMessage.id).toBe(first.outboundMessage.id);
  });

  test("a draft or paused campaign sends nothing", async () => {
    const key = keyOf("draft");
    await live(key, {}, false);
    const sent = await sendCampaign(key, { visitor: { userId: userId() } });
    expect(sent.status).toBe(409);
    expect(sent.error?.code).toBe("campaign_not_live");
  });
});

describe("the visitor's opt-out", () => {
  test("refuses sends from keys and campaigns, and cancels what waits", async () => {
    const key = keyOf("opt-out");
    await live(key);
    const { token, visitorId } = await newVisitor(app, space.publicKey);
    const waiting = await withKey(app, server.token, "POST", inSpace("/outbound-messages"), {
      clientId: randomUUID(),
      visitor: { id: visitorId },
      body: "A message from a key",
      delay: "1h",
    });
    const { outboundMessage: held } = await json<{ outboundMessage: Message }>(waiting);
    const off = await app.request(`/v1/widget/${space.publicKey}/opt-out`, {
      method: "POST",
      headers: {
        origin: SITE,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ optedOut: true }),
    });
    expect(off.status).toBe(200);
    expect(await rowOf(held.id)).toMatchObject({ status: "cancelled", statusReason: "opted_out" });
    const refused = await sendCampaign(key, { visitor: { id: visitorId } });
    expect(refused.error?.code).toBe("opted_out");
    const fromKey = await withKey(app, server.token, "POST", inSpace("/outbound-messages"), {
      clientId: randomUUID(),
      visitor: { id: visitorId },
      body: "Another",
    });
    expect((await json(fromKey)).error?.code).toBe("opted_out");
    const byHand = await asOperator(app, boss.cookie, "POST", inSpace("/outbound-messages"), {
      clientId: randomUUID(),
      visitor: { id: visitorId },
      body: "A member writes by hand",
    });
    expect(byHand.status).toBe(201);
    const filtered = await asOperator(
      app,
      boss.cookie,
      "GET",
      inSpace(
        `/contacts?hasChatted=false&filter=${encodeURIComponent(JSON.stringify({ field: "optedOut", op: "eq", value: true }))}`,
      ),
    );
    expect(await filtered.text()).toContain(visitorId);
  });
});

describe("server events", () => {
  test("count per contact and name, dedupe by ID, and fire an event campaign", async () => {
    const key = keyOf("export");
    const made = await live(key, {
      trigger: { type: "event", name: "export.finished" },
      audience: { field: "events.export.finished.count", op: "gte", value: 1 },
      message: { body: "Your export of {{ event.properties.rows }} rows is ready" },
      rules: { frequency: { every: "1m" } },
    });
    const user = userId();
    const track = (id?: string) =>
      withKey(app, server.token, "POST", inSpace("/track"), {
        visitor: { userId: user },
        name: "export.finished",
        properties: { rows: 1200 },
        ...(id === undefined ? {} : { id }),
      });
    const first = await track("e-1");
    expect(await json(first)).toMatchObject({ counted: true });
    expect(await json(await track("e-1"))).toMatchObject({ counted: false });
    const [sent] = await campaignMessages(made.id);
    expect(sent).toMatchObject({ body: "Your export of 1200 rows is ready", status: "sent" });
    const member = await asOperator(app, boss.cookie, "POST", inSpace("/track"), {
      visitor: { userId: user },
      name: "export.finished",
    });
    expect(member.status).toBe(403);
  });
});

describe("the workspace's rules", () => {
  test("a second campaign message within the gap is cancelled when it would go", async () => {
    await owner.update(workspace).set({ campaignGapHours: 24 }).where(eq(workspace.id, space.id));
    const [one, two] = [keyOf("gap-one"), keyOf("gap-two")];
    await live(one);
    await live(two);
    const user = userId();
    expect((await sendCampaign(one, { visitor: { userId: user } })).outboundMessage).toMatchObject({
      status: "sent",
    });
    const capped = await sendCampaign(two, { visitor: { userId: user } });
    expect(capped.outboundMessage).toMatchObject({
      status: "cancelled",
      statusReason: "frequency_capped",
    });
  });

  test("a pause of every campaign holds their messages until the resume", async () => {
    const key = keyOf("paused");
    await live(key);
    const saved = await asOperator(app, boss.cookie, "PUT", inSpace("/campaign-settings"), {
      paused: true,
      gapHours: 0,
    });
    expect(await saved.json()).toMatchObject({ paused: true, pausedBy: "Julien Coulaud" });
    const read = await asOperator(app, boss.cookie, "GET", inSpace("/campaign-settings"));
    expect(await read.json()).toMatchObject({ paused: true, pausedBy: "Julien Coulaud" });
    const held = await sendCampaign(key, { visitor: { userId: userId() } });
    expect(held.outboundMessage).toMatchObject({
      status: "scheduled",
      statusReason: "campaign_paused",
    });
    expect((await rowOf(held.outboundMessage.id))?.dueAt).toBeNull();
    const resumed = await asOperator(app, boss.cookie, "PUT", inSpace("/campaign-settings"), {
      paused: false,
      gapHours: 0,
    });
    expect(await resumed.json()).toMatchObject({ paused: false, pausedBy: null, pausedAt: null });
    await runDueOutbound(workerDb, db, noLive, 50);
    expect((await rowOf(held.outboundMessage.id))?.status).toBe("sent");
  });

  test("outside business hours a message waits until they open", async () => {
    const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    await owner.insert(businessHours).values({
      workspaceId: space.id,
      enabled: true,
      timeZone: "UTC",
      week: { ...closed, [weekdayIn(2)]: [["10:00", "11:00"]] },
    });
    const key = keyOf("hours");
    await live(key, { rules: { businessHours: true } });
    const held = await sendCampaign(key, { visitor: { userId: userId() } });
    expect(held.outboundMessage).toMatchObject({
      status: "scheduled",
      statusReason: "outside_business_hours",
    });
    const dueAt = (await rowOf(held.outboundMessage.id))?.dueAt;
    expect(dueAt?.getTime()).toBeGreaterThan(Date.now() + 24 * 3_600_000);
  });

  test("an end cancels what waits, and an end date ends it", async () => {
    const key = keyOf("end");
    await live(key);
    const held = await sendCampaign(key, { visitor: { userId: userId() } });
    const ended = await withKey(app, admin.token, "POST", inSpace(`/campaigns/by-key/${key}/end`));
    expect((await json<{ campaign: CampaignView }>(ended)).campaign.status).toBe("ended");
    expect(await rowOf(held.outboundMessage.id)).toMatchObject({
      status: "cancelled",
      statusReason: "campaign_ended",
    });
    const later = keyOf("ends-at");
    const made = await live(later, {
      rules: { endsAt: new Date(Date.now() - 1000).toISOString() },
    });
    await endDueCampaigns(workerDb, db, noLive);
    const [row] = await owner.select().from(campaign).where(eq(campaign.id, made.id));
    expect(row?.status).toBe("ended");
  });
});

describe("A/B variants", () => {
  const MAX_AB_CONTACTS = 60;

  test("each contact keeps one variant, and the control group gets a row with no text", async () => {
    const key = keyOf("ab");
    const made = await live(key, {
      variants: [
        { key: "short", weight: 1, message: { body: "Short" } },
        { key: "long", weight: 1 },
        { key: "control", weight: 1, control: true },
      ],
    });
    // Contacts are random, so enter them until every variant shows; 60 misses one about once in 1e10.
    const seen = new Set<string>();
    let entered = 0;
    for (; entered < MAX_AB_CONTACTS && seen.size < 3; entered += 1) {
      const sent = await sendCampaign(key, { visitor: { userId: userId() } });
      const row = await rowOf(sent.outboundMessage.id);
      seen.add(row?.variant ?? "");
      if (row?.variant === "control") {
        expect(row).toMatchObject({
          status: "cancelled",
          statusReason: "control_group",
          body: null,
        });
      } else {
        expect(row?.body).toBe(row?.variant === "short" ? "Short" : "Hello there");
      }
    }
    expect(seen).toEqual(new Set(["short", "long", "control"]));
    const results = await withKey(
      app,
      server.token,
      "GET",
      inSpace(`/campaigns/${made.id}/results`),
    );
    const { variants } = await json<{ variants: { variant: string; entered: number }[] }>(results);
    expect(variants.map((one) => one.variant).sort()).toEqual(["control", "long", "short"]);
    expect(variants.reduce((sum, one) => sum + one.entered, 0)).toBe(entered);
  });
});

describe("a schedule", () => {
  test("finds its newest occurrence in its own time zone", () => {
    const at = Date.parse("2026-11-18T10:00:00Z"); // A Wednesday, 11:00 in Paris.
    const weekly = {
      type: "schedule" as const,
      repeat: "weekly" as const,
      time: "09:00",
      days: ["mon" as const],
      startDate: "2026-11-01",
      timeZone: "Europe/Paris",
    };
    expect(latestOccurrence(weekly, at)?.toISOString()).toBe("2026-11-16T08:00:00.000Z");
    const daily = { ...weekly, repeat: "daily" as const, days: undefined, time: "12:00" };
    expect(latestOccurrence(daily, at)?.toISOString()).toBe("2026-11-17T11:00:00.000Z");
    const once = { ...daily, repeat: "once" as const, startDate: "2026-11-20" };
    expect(latestOccurrence(once, at)).toBeNull();
    const monthly = { ...daily, repeat: "monthly" as const, startDate: "2026-10-31" };
    expect(latestOccurrence(monthly, at)?.toISOString()).toBe("2026-10-31T11:00:00.000Z");
  });

  test("a run survives a worker restart with no double and no gap", async () => {
    const plan = `plan-${randomUUID().slice(0, 8)}`;
    const users = Array.from({ length: 120 }, () => userId());
    await owner
      .insert(visitor)
      .values(users.map((user) => ({ workspaceId: space.id, userId: user, attributes: { plan } })));
    const key = keyOf("broadcast");
    const made = await live(key, {
      audience: { field: "attributes.plan", op: "eq", value: plan },
      trigger: {
        type: "schedule",
        repeat: "once",
        time: "00:00",
        startDate: "2026-01-01",
        timeZone: "UTC",
      },
    });
    // It went live after this occurrence, so it waits for none: make it live from before.
    await owner
      .update(campaign)
      .set({ liveAt: new Date("2025-12-31T00:00:00Z") })
      .where(eq(campaign.id, made.id));
    await openRuns(workerDb, db);
    await openRuns(workerDb, db);
    const runs = await owner.select().from(campaignRun).where(eq(campaignRun.campaignId, made.id));
    expect(runs).toHaveLength(1);
    // One batch, then a crash: the next worker starts from the committed cursor.
    await runCampaignRuns(workerDb, db, noLive, 1);
    expect(await campaignMessages(made.id)).toHaveLength(50);
    const [halfway] = await owner
      .select()
      .from(campaignRun)
      .where(eq(campaignRun.campaignId, made.id));
    expect(halfway?.cursor).not.toBeNull();
    // A batch that fails halfway rolls back its messages and its cursor together.
    const ordered = await owner
      .select({ id: visitor.id })
      .from(visitor)
      .where(inArray(visitor.userId, users))
      .orderBy(visitor.id);
    const failing = ordered[70]?.id ?? "";
    await owner.execute(
      sql.raw(`
      create function campaign_test_crash() returns trigger language plpgsql as $$
      begin
        if new.visitor_id = '${failing}' then raise exception 'The worker stopped'; end if;
        return new;
      end $$;
      create trigger campaign_test_crash before insert on outbound_message
        for each row execute function campaign_test_crash();`),
    );
    await expect(runCampaignRuns(workerDb, db, noLive, 1)).rejects.toThrow();
    await owner.execute(
      sql.raw(`
      drop trigger campaign_test_crash on outbound_message;
      drop function campaign_test_crash();`),
    );
    expect(await campaignMessages(made.id)).toHaveLength(50);
    const [after] = await owner
      .select()
      .from(campaignRun)
      .where(eq(campaignRun.campaignId, made.id));
    expect(after?.cursor).toBe(halfway?.cursor);
    while (await runCampaignRuns(workerDb, db, noLive, 5)) {
      /* Each pass runs one batch. */
    }
    const sent = await campaignMessages(made.id);
    expect(sent).toHaveLength(120);
    expect(new Set(sent.map((row) => row.visitorId)).size).toBe(120);
    const [finished] = await owner
      .select()
      .from(campaignRun)
      .where(eq(campaignRun.campaignId, made.id));
    expect(finished?.finishedAt).not.toBeNull();
    // A cursor that went back, as after a lost commit, makes no double either.
    await owner
      .update(campaignRun)
      .set({ cursor: null, finishedAt: null })
      .where(eq(campaignRun.campaignId, made.id));
    while (await runCampaignRuns(workerDb, db, noLive, 5)) {
      /* Each pass runs one batch. */
    }
    expect(await campaignMessages(made.id)).toHaveLength(120);
  }, 20_000);
});

describe("an unread message by email", () => {
  test("goes in a conversation once its time passed, for a contact with an email", async () => {
    const key = keyOf("fallback");
    await live(key, { delivery: { sendEmail: false, emailIfUnread: "1d" } });
    const user = userId();
    const sent = await sendCampaign(key, { visitor: { userId: user, email: "ada@example.com" } });
    const row = await rowOf(sent.outboundMessage.id);
    expect(row).toMatchObject({ status: "sent", sendEmail: true, conversationId: null });
    expect(row?.dueAt?.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    await owner
      .update(outboundMessage)
      .set({ emailIfUnreadAt: new Date(Date.now() - 1000), dueAt: new Date(Date.now() - 1000) })
      .where(eq(outboundMessage.id, sent.outboundMessage.id));
    await runDueOutbound(workerDb, db, noLive, 50);
    const after = await rowOf(sent.outboundMessage.id);
    expect(after?.conversationId).not.toBeNull();
    const [started] = await owner
      .select()
      .from(conversation)
      .where(eq(conversation.id, after?.conversationId ?? ""));
    expect(started?.startedBy).toBe("team");
  });
});

describe("Send a test to me", () => {
  test("shows it to a test visitor, and names the rule that would hold a real one", async () => {
    const key = keyOf("test-me");
    const made = await live(key, { message: { body: "Hi {{ firstName }}" } }, false);
    const response = await asOperator(
      app,
      boss.cookie,
      "POST",
      inSpace(`/campaigns/${made.id}/test`),
    );
    const body = await json<{ outboundMessage: Message; blockedBy: string | null }>(response);
    expect(response.status).toBe(200);
    expect(body.blockedBy).toBe("campaign_paused");
    expect(body.outboundMessage).toMatchObject({ body: "Hi Julien", status: "sent" });
    expect(body.outboundMessage.conversationId).not.toBeNull();
    const [tester] = await owner
      .select()
      .from(visitor)
      .where(and(eq(visitor.id, body.outboundMessage.visitorId), eq(visitor.isTest, true)));
    expect(tester).toBeDefined();
    const results = await withKey(
      app,
      server.token,
      "GET",
      inSpace(`/campaigns/${made.id}/results`),
    );
    expect((await json<{ days: unknown[] }>(results)).days).toEqual([]);
  });
});

describe("a delete", () => {
  test("removes a campaign that sent only tests, and keeps one that sent for its results", async () => {
    const remove = (key: string, token = admin.token) =>
      withKey(app, token, "DELETE", inSpace(`/campaigns/by-key/${key}`));
    const trial = await live(keyOf("trial"), {}, false);
    await asOperator(app, boss.cookie, "POST", inSpace(`/campaigns/${trial.id}/test`));
    const deleted = await asOperator(app, boss.cookie, "DELETE", inSpace(`/campaigns/${trial.id}`));
    expect(deleted.status).toBe(200);
    expect(await campaignMessages(trial.id)).toEqual([]);
    const gone = await withKey(app, admin.token, "GET", inSpace(`/campaigns/${trial.id}`));
    expect(gone.status).toBe(404);

    const key = keyOf("sent");
    await live(key);
    expect((await remove(key, server.token)).status).toBe(403);
    expect((await json(await remove(key))).error?.code).toBe("campaign_live");
    expect((await sendCampaign(key, { visitor: { userId: userId() } })).status).toBe(201);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/by-key/${key}/end`));
    expect((await json(await remove(key))).error?.code).toBe("campaign_sent");

    const draft = await live(keyOf("mcp-draft"), {}, false);
    const deletedByTool = await callTool(app, admin.token, "delete_campaign", { id: draft.id });
    expect(deletedByTool.isError).toBeFalsy();
    expect(await owner.select().from(campaign).where(eq(campaign.id, draft.id))).toEqual([]);
  });
});

describe("the contact fields", () => {
  test("list the attributes and events of recent contacts, with how many have each", async () => {
    const attribute = `plan_${randomUUID().slice(0, 8)}`;
    const name = `export.${randomUUID().slice(0, 8)}`;
    for (const user of [userId(), userId()]) {
      await upsertContact(user, { attributes: { [attribute]: "pro" } });
      await withKey(app, server.token, "POST", inSpace("/track"), {
        visitor: { userId: user },
        name,
      });
    }
    const response = await withKey(app, server.token, "GET", inSpace("/contact-fields"));
    type Named = { name: string; contacts: number };
    const fields = await json<{ attributes: Named[]; events: Named[] }>(response);
    expect(fields.attributes.find((one) => one.name === attribute)?.contacts).toBe(2);
    expect(fields.events.find((one) => one.name === name)?.contacts).toBe(2);
  });
});

describe("a page campaign", () => {
  /** A widget request, with a visitor's token or none. */
  const widget = async (path: string, body: unknown, token?: string) => {
    const response = await app.request(`/v1/widget/${space.publicKey}/${path}`, {
      method: "POST",
      headers: {
        origin: SITE,
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  const beat = (token?: string) =>
    widget("beat", { tab: "tab123456", page: `${SITE}/pricing` }, token);

  test("stores nothing until the visitor answers, and counts shows, reads and clicks", async () => {
    const key = keyOf("pricing");
    const made = await live(key, {
      trigger: { type: "page", url: "/pricing*", seconds: 20 },
      presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
      message: {
        sender: { email: boss.email },
        body: "Comparing plans? I can tell you which one fits.",
        buttons: [
          { label: "Yes", value: "yes" },
          { label: "See plans", url: "https://example.com/plans", value: "plans" },
        ],
        translations: { fr: { body: "Vous comparez les offres ?" } },
      },
    });
    // A visitor who does not exist yet sees it, in their language, from the beat on.
    const { json: anonymous } = await beat();
    expect(anonymous.pages).toContainEqual({ id: made.id, url: "/pricing*", seconds: 20 });
    const shown = await widget(`campaigns/${made.id}/show`, { language: "fr" });
    expect(shown.json.outboundMessage).toMatchObject({
      id: made.id,
      campaignId: made.id,
      body: "Vous comparez les offres ?",
      show: "preview",
      authorName: "Julien",
    });
    expect((await widget(`campaigns/${made.id}/read`, {})).status).toBe(200);
    expect((await widget(`campaigns/${made.id}/press`, { button: 1 })).status).toBe(200);
    // A value button answers, which counts with the visitor's message instead.
    expect((await widget(`campaigns/${made.id}/press`, { button: 0 })).status).toBe(404);
    expect(await campaignMessages(made.id)).toEqual([]);

    const { token, visitorId } = await newVisitor(app, space.publicKey);
    const answer = await widget(
      "messages",
      { clientId: randomUUID(), body: "ignored", pageCampaign: { id: made.id, button: 0 } },
      token,
    );
    expect(answer.status).toBe(201);
    expect(answer.json).toMatchObject({ body: "Yes", button: { value: "yes", label: "Yes" } });
    const [row] = await campaignMessages(made.id);
    expect(row).toMatchObject({
      visitorId,
      status: "replied",
      chosenButton: { value: "yes", label: "Yes" },
    });
    const [conversationRow] = await owner
      .select()
      .from(conversation)
      .where(eq(conversation.visitorId, visitorId));
    expect(conversationRow?.id).toBe(row?.conversationId);
    // Once is once: the answered visitor's beat no longer lists it.
    expect((await beat(token)).json.pages).not.toContainEqual(
      expect.objectContaining({ id: made.id }),
    );

    const results = await withKey(
      app,
      server.token,
      "GET",
      inSpace(`/campaigns/${made.id}/results`),
    );
    const { variants } = await json<{
      variants: (Record<string, number> & { clicks: Record<string, number> })[];
    }>(results);
    expect(variants).toEqual([
      expect.objectContaining({
        entered: 1,
        sent: 1,
        delivered: 1,
        read: 1,
        replied: 1,
        conversationsStarted: 1,
        clicks: { plans: 1, yes: 1 },
      }),
    ]);
  });

  test("an audience, an opt-out or a pause of every campaign keeps it from a visitor", async () => {
    const key = keyOf("pricing-pro");
    const made = await live(key, {
      audience: { field: "attributes.plan", op: "eq", value: "pro" },
      trigger: { type: "page", url: "/pricing", seconds: 0 },
    });
    const listed = async (token?: string) =>
      ((await beat(token)).json.pages as { id: string }[]).some((one) => one.id === made.id);
    expect(await listed()).toBe(false);
    const { token, visitorId } = await newVisitor(app, space.publicKey);
    expect(await listed(token)).toBe(false);
    await owner
      .update(visitor)
      .set({ attributes: { plan: "pro" } })
      .where(eq(visitor.id, visitorId));
    expect(await listed(token)).toBe(true);
    await owner
      .update(workspace)
      .set({ campaignsPausedAt: new Date() })
      .where(eq(workspace.id, space.id));
    expect(await listed(token)).toBe(false);
    await owner
      .update(workspace)
      .set({ campaignsPausedAt: null })
      .where(eq(workspace.id, space.id));
    await widget("opt-out", { optedOut: true }, token);
    expect(await listed(token)).toBe(false);
    expect((await widget(`campaigns/${made.id}/show`, {}, token)).status).toBe(404);
  });
  test("the beat lists what lets them in, and the show runs the send's rules", async () => {
    const pricing = {
      trigger: { type: "page", url: "/pricing", seconds: 0 },
      presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
    };
    const listed = async (id: string, token?: string) =>
      ((await beat(token)).json.pages as { id: string }[]).some((one) => one.id === id);
    const hours = await live(keyOf("page-hours"), { ...pricing, rules: { businessHours: true } });
    const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    await owner
      .insert(businessHours)
      .values({ workspaceId: space.id, enabled: true, timeZone: "UTC", week: closed });
    expect(await listed(hours.id)).toBe(true);
    expect((await widget(`campaigns/${hours.id}/show`, {})).status).toBe(404);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${hours.id}/end`));

    // An open conversation and `skip`: no card. The show decides, so a card shown before the
    // conversation opened still goes in with its answer.
    const open = await live(keyOf("page-open"), pricing);
    const { token } = await newVisitor(app, space.publicKey);
    expect((await widget(`campaigns/${open.id}/show`, {}, token)).status).toBe(200);
    await visitorSays(app, space.publicKey, token, "Hello");
    expect((await widget(`campaigns/${open.id}/show`, {}, token)).status).toBe(404);
    const answer = await widget(
      "messages",
      { clientId: randomUUID(), body: "About pricing", pageCampaign: { id: open.id } },
      token,
    );
    expect(answer.status).toBe(201);
    expect(await campaignMessages(open.id)).toMatchObject([{ status: "replied" }]);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${open.id}/end`));

    // Another campaign message within the workspace's gap.
    await owner.update(workspace).set({ campaignGapHours: 24 }).where(eq(workspace.id, space.id));
    const capped = await live(keyOf("page-gap"), pricing);
    const other = keyOf("page-gap-other");
    await live(other);
    const reached = await newVisitor(app, space.publicKey);
    await sendCampaign(other, { visitor: { id: reached.visitorId } });
    expect(await listed(capped.id, reached.token)).toBe(true);
    expect((await widget(`campaigns/${capped.id}/show`, {}, reached.token)).status).toBe(404);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${capped.id}/end`));
  });

  const page = {
    trigger: { type: "page", url: "/pricing", seconds: 0 },
    presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
  };
  /** The visitor's message that answers the page campaign's card. */
  const answerCard = (campaignId: string, token: string, body = "About pricing") =>
    widget("messages", { clientId: randomUUID(), body, pageCampaign: { id: campaignId } }, token);
  const end = (campaignId: string) =>
    withKey(app, admin.token, "POST", inSpace(`/campaigns/${campaignId}/end`));

  test("the beat reads every campaign's audience and frequency at once, as each decides", async () => {
    const listed = async (token: string) =>
      ((await beat(token)).json.pages as { id: string }[]).map((one) => one.id);
    const pro = await live(keyOf("page-pro"), {
      ...page,
      audience: { field: "attributes.plan", op: "eq", value: "pro" },
    });
    const trial = await live(keyOf("page-trial"), {
      ...page,
      audience: { field: "attributes.plan", op: "eq", value: "trial" },
    });
    const hourly = await live(keyOf("page-hourly"), {
      ...page,
      rules: { frequency: { every: "1h" } },
    });
    const { token, visitorId } = await newVisitor(app, space.publicKey);
    await owner
      .update(visitor)
      .set({ attributes: { plan: "pro" } })
      .where(eq(visitor.id, visitorId));
    expect(await listed(token)).toEqual(expect.arrayContaining([pro.id, hourly.id]));
    expect(await listed(token)).not.toContain(trial.id);

    // `every` keeps them out within its time, and a goal reached keeps them out for good.
    await answerCard(hourly.id, token);
    expect(await listed(token)).not.toContain(hourly.id);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await owner
      .update(outboundMessage)
      .set({ createdAt: twoHoursAgo })
      .where(eq(outboundMessage.campaignId, hourly.id));
    expect(await listed(token)).toContain(hourly.id);
    await owner
      .update(outboundMessage)
      .set({ goalReachedAt: twoHoursAgo })
      .where(eq(outboundMessage.campaignId, hourly.id));
    expect(await listed(token)).not.toContain(hourly.id);
    for (const one of [pro, trial, hourly]) await end(one.id);
  });

  test("with `join`, shows to a visitor in a conversation, and the answer goes in it", async () => {
    const made = await live(keyOf("page-join"), {
      ...page,
      presentation: { ...page.presentation, ifConversationOpen: "join" },
    });
    const { token } = await newVisitor(app, space.publicKey);
    const { conversationId } = await visitorSays(app, space.publicKey, token, "Hello");
    expect((await beat(token)).json.pages).toContainEqual(expect.objectContaining({ id: made.id }));
    expect((await widget(`campaigns/${made.id}/show`, {}, token)).status).toBe(200);
    expect((await answerCard(made.id, token)).status).toBe(201);
    expect(await campaignMessages(made.id)).toMatchObject([{ status: "replied", conversationId }]);
    await end(made.id);
  });

  test("an answer counts a goal of repliedToCampaign at once", async () => {
    const made = await live(keyOf("page-goal"), {
      ...page,
      rules: { goal: { field: "repliedToCampaign", op: "eq", value: true, within: "7d" } },
    });
    const { token } = await newVisitor(app, space.publicKey);
    await answerCard(made.id, token);
    const [row] = await campaignMessages(made.id);
    expect(row?.goalReachedAt).not.toBeNull();
    await end(made.id);
  });

  test("the answer keeps the card the visitor saw, though their first send entered another campaign", async () => {
    await owner.update(workspace).set({ campaignGapHours: 24 }).where(eq(workspace.id, space.id));
    const card = await live(keyOf("page-first"), {
      ...page,
      message: { body: "Comparing plans?" },
    });
    const welcome = await live(keyOf("welcome"), { trigger: { type: "match" } });
    expect((await widget(`campaigns/${card.id}/show`, {})).status).toBe(200);
    // The widget creates the visitor on their first send, which enters them in `welcome`.
    const { token, visitorId } = await newVisitor(app, space.publicKey);
    expect((await answerCard(card.id, token, "Which plan?")).status).toBe(201);
    const [placed] = await campaignMessages(card.id);
    expect(placed).toMatchObject({ visitorId, status: "replied" });
    expect(await campaignMessages(welcome.id)).toMatchObject([{ visitorId, status: "sent" }]);
    const history = await owner
      .select({ body: message.body })
      .from(message)
      .where(eq(message.conversationId, placed?.conversationId ?? randomUUID()))
      .orderBy(message.seq);
    expect(history.map((one) => one.body)).toEqual(["Comparing plans?", "Which plan?"]);
    await end(card.id);
    await end(welcome.id);
  });

  test("an answered card counts for the workspace's gap", async () => {
    await owner.update(workspace).set({ campaignGapHours: 24 }).where(eq(workspace.id, space.id));
    const made = await live(keyOf("page-gap-first"), page);
    const later = keyOf("after-card");
    await live(later);
    const { token, visitorId } = await newVisitor(app, space.publicKey);
    await answerCard(made.id, token);
    expect(await campaignMessages(made.id)).toMatchObject([{ status: "replied" }]);
    const capped = await sendCampaign(later, { visitor: { id: visitorId } });
    expect(capped.outboundMessage).toMatchObject({
      status: "cancelled",
      statusReason: "frequency_capped",
    });
    await end(made.id);
  });

  test("with A/B variants, waits for a visitor who exists, so the answer keeps the variant", async () => {
    const made = await live(keyOf("page-ab"), {
      trigger: { type: "page", url: "/pricing", seconds: 0 },
      presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
      variants: [
        { key: "a", weight: 1, message: { body: "Variant A" } },
        { key: "b", weight: 1, message: { body: "Variant B" } },
      ],
    });
    expect((await beat()).json.pages).not.toContainEqual(expect.objectContaining({ id: made.id }));
    expect((await widget(`campaigns/${made.id}/show`, {})).status).toBe(404);
    const { token } = await newVisitor(app, space.publicKey);
    const shown = await widget(`campaigns/${made.id}/show`, {}, token);
    const body = (shown.json.outboundMessage as { body: string }).body;
    await widget(
      "messages",
      { clientId: randomUUID(), body: "Hi", pageCampaign: { id: made.id } },
      token,
    );
    expect(await campaignMessages(made.id)).toMatchObject([{ body }]);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${made.id}/end`));
  });

  test("counts and answers the buttons of the language the card showed in", async () => {
    const made = await live(keyOf("page-fr"), {
      trigger: { type: "page", url: "/pricing", seconds: 0 },
      presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
      message: {
        body: "Need a hand?",
        buttons: [
          { label: "Yes", value: "yes" },
          { label: "No thanks", dismiss: true, value: "no" },
        ],
        translations: {
          fr: {
            body: "Besoin d'aide ?",
            buttons: [
              { label: "Non merci", dismiss: true, value: "no" },
              { label: "Oui", value: "yes" },
            ],
          },
        },
      },
    });
    const fr = { language: "fr" };
    expect((await widget(`campaigns/${made.id}/press`, { ...fr, button: 0 })).status).toBe(200);
    const { token } = await newVisitor(app, space.publicKey);
    const answer = await widget(
      "messages",
      { clientId: randomUUID(), body: "x", pageCampaign: { id: made.id, button: 1, ...fr } },
      token,
    );
    expect(answer.json).toMatchObject({ body: "Oui" });
    expect(await campaignMessages(made.id)).toMatchObject([{ body: "Besoin d'aide ?" }]);
    const results = await withKey(
      app,
      server.token,
      "GET",
      inSpace(`/campaigns/${made.id}/results`),
    );
    const { variants } = await json<{ variants: { dismissed: number }[] }>(results);
    expect(variants).toEqual([expect.objectContaining({ dismissed: 1 })]);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${made.id}/end`));
  });
});

describe("MCP", () => {
  test("upserts, starts, sends and reads results", async () => {
    const key = keyOf("mcp");
    const upserted = await callTool(app, admin.token, "upsert_campaign", {
      definition: definitionOf(key),
    });
    expect(upserted.isError).toBe(false);
    expect((await callTool(app, admin.token, "resume_campaign", { key })).isError).toBe(false);
    const sent = await callTool(app, server.token, "send_campaign", {
      key,
      clientId: randomUUID(),
      visitor: { userId: userId() },
    });
    expect(sent.structuredContent).toMatchObject({ outboundMessage: { status: "sent" } });
    const results = await callTool(app, server.token, "get_campaign_results", { key });
    expect(results.structuredContent).toMatchObject({ variants: [{ entered: 1, sent: 1 }] });
    const tracked = await callTool(app, server.token, "track_event", {
      visitor: { userId: userId() },
      name: "signup",
    });
    expect(tracked.structuredContent).toMatchObject({ counted: true });
  });
});

describe("the definition's parts", () => {
  test("a patch of the name keeps the saved rules and delivery", async () => {
    const key = keyOf("patch-name");
    const made = await live(
      key,
      {
        delivery: { sendEmail: true, expiresIn: "3d" },
        rules: { frequency: { every: "7d" }, businessHours: true, endsAt: null },
      },
      false,
    );
    const patched = await withKey(app, admin.token, "PATCH", inSpace(`/campaigns/${made.id}`), {
      name: "Only the name",
    });
    const { campaign: after } = await json<{ campaign: CampaignView }>(patched);
    expect(after.definition).toMatchObject({
      name: "Only the name",
      delivery: { sendEmail: true, expiresIn: "3d" },
      rules: { frequency: { every: "7d" }, businessHours: true },
    });
  });
});

describe("a send from code to a campaign of another trigger", () => {
  test("skips its audience at the send time too", async () => {
    const key = keyOf("send-match");
    await live(key, {
      audience: { field: "attributes.plan", op: "eq", value: "never" },
      trigger: { type: "match" },
    });
    const sent = await sendCampaign(key, { visitor: { userId: userId() } });
    expect(sent.outboundMessage).toMatchObject({ status: "sent", statusReason: null });
  });
});

describe("closed business hours", () => {
  test("a week with no open hours keeps a message looking again, not stranded", async () => {
    const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    await owner
      .insert(businessHours)
      .values({ workspaceId: space.id, enabled: true, timeZone: "UTC", week: closed });
    const key = keyOf("never-open");
    await live(key, { rules: { businessHours: true } });
    const held = await sendCampaign(key, { visitor: { userId: userId() } });
    expect(held.outboundMessage).toMatchObject({ statusReason: "outside_business_hours" });
    const dueAt = (await rowOf(held.outboundMessage.id))?.dueAt;
    expect(dueAt?.getTime()).toBeLessThan(Date.now() + 5 * 60_000);
  });
});

describe("a read message with an email fallback", () => {
  test("leaves the worker's queue once its email time passes", async () => {
    const key = keyOf("read-fallback");
    await live(key, { delivery: { sendEmail: false, emailIfUnread: "1d" } });
    const sent = await sendCampaign(key, { visitor: { userId: userId(), email: "r@example.com" } });
    const past = new Date(Date.now() - 1000);
    await owner
      .update(outboundMessage)
      .set({ status: "read", readAt: past, emailIfUnreadAt: past, dueAt: past })
      .where(eq(outboundMessage.id, sent.outboundMessage.id));
    await runDueOutbound(workerDb, db, noLive, 50);
    expect(await rowOf(sent.outboundMessage.id)).toMatchObject({
      status: "read",
      conversationId: null,
      dueAt: null,
    });
  });
});

describe("a goal", () => {
  const paid = { field: "attributes.paid", op: "eq", value: true };

  test("counts from the time the message became sent, not from when it was made", async () => {
    const key = keyOf("goal-window");
    const made = await live(key, {
      audience: { field: "attributes.stage", op: "eq", value: "trial" },
      trigger: { type: "match", delay: "2d" },
      rules: { goal: { ...paid, within: "1d" } },
    });
    const user = userId();
    await upsertContact(user, { attributes: { stage: "trial" } });
    await upsertContact(user, { attributes: { paid: true } });
    const [waiting] = await campaignMessages(made.id);
    expect(waiting).toMatchObject({ status: "scheduled", goalReachedAt: null });
    await owner
      .update(outboundMessage)
      .set({ status: "sent", sentAt: new Date(Date.now() - 3_600_000), dueAt: null })
      .where(eq(outboundMessage.id, waiting?.id ?? ""));
    await upsertContact(user, { attributes: { paid: false } });
    await upsertContact(user, { attributes: { paid: true } });
    expect((await rowOf(waiting?.id ?? ""))?.goalReachedAt).not.toBeNull();
  });

  test("counts when the same change also makes the contact exit", async () => {
    const key = keyOf("goal-and-exit");
    const made = await live(key, {
      audience: { field: "attributes.stage", op: "eq", value: "onboarding" },
      trigger: { type: "match" },
      rules: { exitWhen: paid, goal: { ...paid, within: "7d" } },
    });
    const user = userId();
    await upsertContact(user, { attributes: { stage: "onboarding" } });
    await upsertContact(user, { attributes: { paid: true } });
    const [sent] = await campaignMessages(made.id);
    expect(sent?.goalReachedAt).not.toBeNull();
  });
});

describe("the writes that check a contact's campaigns again", () => {
  test("an answer by email counts a goal of repliedToCampaign", async () => {
    const key = keyOf("replied");
    const made = await live(key, {
      presentation: { startConversation: "now", show: "chat", ifConversationOpen: "join" },
      rules: { goal: { field: "repliedToCampaign", op: "eq", value: true, within: "7d" } },
    });
    const { visitorId } = await newVisitor(app, space.publicKey);
    const sent = await sendCampaign(key, { visitor: { id: visitorId } });
    const conversationId = (await rowOf(sent.outboundMessage.id))?.conversationId ?? "";
    const domain = "reply.example.com";
    const secret = "an-inbound-secret-of-at-least-32-characters";
    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: PUBLIC_URL });
    const ok = async () => {};
    const mail = createApp({
      db,
      logger,
      auth,
      inboundEmail: { domain, secret },
      checks: { postgres: ok, valkey: ok },
    });
    const to = await withWorkspace(workerDb, space.id, (tx) =>
      createReplyAddress(tx, space.id, visitorId, conversationId, domain),
    );
    const raw = [
      "From: Ada <ada@example.com>",
      `To: ${to}`,
      "Subject: Re: Shipmail",
      `Message-ID: <${randomUUID()}@mail.example.com>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Yes, thanks",
    ].join("\r\n");
    const posted = await mail.request("/v1/inbound-email", {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "dinghy-inbound-signature": signature(secret, Math.floor(Date.now() / 1000), raw),
        "content-length": String(Buffer.byteLength(raw)),
      },
      body: raw,
    });
    expect(posted.status).toBe(200);
    const [row] = await campaignMessages(made.id);
    expect(row?.goalReachedAt).not.toBeNull();
  });

  test("a new visitor, an email the visitor gives and the widget's language", async () => {
    const domain = `${randomUUID().slice(0, 8)}.example`;
    const byEmail = await live(keyOf("by-email"), {
      audience: { field: "email", op: "contains", value: domain },
      trigger: { type: "match" },
    });
    const forNewVisitors = await live(
      keyOf("new-visitors"),
      { audience: { field: "signedIn", op: "eq", value: false }, trigger: { type: "match" } },
      false,
    );
    const widget = (path: string, method: string, token: string, body: unknown) =>
      app.request(`/v1/widget/${space.publicKey}/${path}`, {
        method,
        headers: {
          origin: SITE,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const { token, visitorId } = await newVisitor(app, space.publicKey);
    expect((await widget("me", "PATCH", token, { email: `ada@${domain}` })).status).toBe(200);
    expect(await campaignMessages(byEmail.id)).toMatchObject([{ visitorId }]);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${byEmail.id}/end`));

    const spanish = await live(keyOf("spanish"), {
      audience: { field: "language", op: "eq", value: "es" },
      trigger: { type: "match" },
    });
    await visitorSays(app, space.publicKey, token, "Hola");
    expect(await campaignMessages(spanish.id)).toEqual([]);
    expect((await widget("context", "POST", token, { locale: "es" })).status).toBe(200);
    expect(await campaignMessages(spanish.id)).toMatchObject([{ visitorId }]);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${spanish.id}/end`));

    // Every live campaign checks a new visitor, as it does a new contact from a server.
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${forNewVisitors.id}/resume`));
    const fresh = await newVisitor(app, space.publicKey);
    expect(await campaignMessages(forNewVisitors.id)).toMatchObject([
      { visitorId: fresh.visitorId },
    ]);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${forNewVisitors.id}/end`));
  });

  test("a beat that changes nothing for a campaign takes no workspace lock", async () => {
    const key = keyOf("beat-once");
    const made = await live(key, {
      audience: { field: "firstSeenAt", op: "exists" },
      trigger: { type: "match" },
      rules: { frequency: "once", exitWhen: { field: "country", op: "eq", value: "AQ" } },
    });
    const { token, visitorId } = await newVisitor(app, space.publicKey);
    const beat = async () =>
      await app.request(`/v1/widget/${space.publicKey}/beat`, {
        method: "POST",
        headers: {
          origin: SITE,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tab: "tab123456", page: `${SITE}/` }),
      });
    expect(await campaignMessages(made.id)).toMatchObject([{ visitorId }]);
    // The first beat also notes that the widget loaded, which writes the workspace once.
    await beat();
    const held = holdWorkspace();
    await held.locked;
    const beating = beat().then((response) => response.status);
    const waited = untilWaiting(db).then(
      () => "waited",
      () => "never",
    );
    const outcome = await Promise.race([beating, waited]);
    held.release();
    await held.done;
    expect(outcome).toBe(200);
    await withKey(app, admin.token, "POST", inSpace(`/campaigns/${made.id}/end`));
  });
});

/** A transaction that holds the workspace's lock until `release`, as a contact's write does. */
function holdWorkspace(then?: (tx: Transaction) => Promise<void>, visitorId?: string) {
  let release = () => {};
  let ready = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = withWorkspace(db, space.id, async (tx) => {
    if (visitorId !== undefined) await lockVisitors(tx, space.id, [visitorId]);
    await lockWorkspace(tx, space.id);
    ready();
    await released;
    await then?.(tx);
  });
  return { locked, release, done };
}

describe("campaign operations that cross", () => {
  test("a pause and a contact's change that sends its message take turns", async () => {
    const key = keyOf("cross-pause");
    const made = await live(key);
    const { visitorId } = await newVisitor(app, space.publicKey);
    // The contact's change holds the visitor and the workspace, then inserts the campaign's message.
    const change = holdWorkspace(async (tx) => {
      const found = await campaignRow(tx, space.id, eq(campaign.id, made.id));
      if (found === undefined) throw new Error("The campaign is missing");
      await enterCampaign(tx, space.id, found, visitorId, { botsPaused: false, options: {} });
    }, visitorId);
    await change.locked;
    const pausing = withKey(app, admin.token, "POST", inSpace(`/campaigns/${made.id}/pause`));
    await untilWaiting(db);
    change.release();
    await change.done;
    expect((await pausing).status).toBe(200);
    expect(await campaignMessages(made.id)).toHaveLength(1);
  });

  test("an end and a batch of its run take turns", async () => {
    const key = keyOf("cross-end");
    const made = await live(key);
    const [run] = await owner
      .insert(campaignRun)
      .values({ workspaceId: space.id, campaignId: made.id, occurrence: new Date() })
      .returning();
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = () => {};
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    // A batch holds its run, then takes the workspace's lock.
    const batch = withWorkspace(db, space.id, async (tx) => {
      await tx
        .select()
        .from(campaignRun)
        .where(eq(campaignRun.id, run?.id ?? ""))
        .for("update");
      ready();
      await released;
      await lockWorkspace(tx, space.id);
    });
    await locked;
    const ending = withKey(app, admin.token, "POST", inSpace(`/campaigns/${made.id}/end`));
    await Promise.race([ending, untilWaiting(db).catch(() => undefined)]);
    release();
    await batch;
    expect((await ending).status).toBe(200);
    // The worker finishes an ended campaign's run.
    while (await runCampaignRuns(workerDb, db, noLive, 5)) {
      /* Each pass runs one batch. */
    }
    const [after] = await owner
      .select()
      .from(campaignRun)
      .where(eq(campaignRun.id, run?.id ?? ""));
    expect(after?.finishedAt).not.toBeNull();
  });
});

describe("a workspace that paused every campaign", () => {
  test("never holds back the runs of another workspace", async () => {
    const other = await createWorkspace(db, "Paused company", [SITE]);
    await owner
      .insert(workspaceMember)
      .values({ workspaceId: other.id, operatorId: boss.id, role: "owner" });
    const [paused] = await owner
      .insert(campaign)
      .values({
        workspaceId: other.id,
        key: "paused-broadcast",
        name: "Paused broadcast",
        status: "live",
        definition: CampaignDefinitionSchema.parse(definitionOf("paused-broadcast")),
        authorOperatorId: boss.id,
      })
      .returning();
    await owner
      .update(workspace)
      .set({ campaignsPausedAt: new Date() })
      .where(eq(workspace.id, other.id));
    await owner.insert(campaignRun).values({
      workspaceId: other.id,
      campaignId: paused?.id ?? "",
      occurrence: new Date("2020-01-01T00:00:00Z"),
      createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    const key = keyOf("active-broadcast");
    const made = await live(key, { audience: { field: "attributes.plan", op: "eq", value: key } });
    await owner
      .insert(campaignRun)
      .values({ workspaceId: space.id, campaignId: made.id, occurrence: new Date() });
    for (let pass = 0; pass < 20 && (await runCampaignRuns(workerDb, db, noLive, 1)); pass += 1) {
      /* Each pass runs one batch. */
    }
    const [run] = await owner.select().from(campaignRun).where(eq(campaignRun.campaignId, made.id));
    expect(run?.finishedAt).not.toBeNull();
  });
});

/** The weekday `ahead` days from today in UTC, as business hours name it. */
function weekdayIn(ahead: number) {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return days[new Date(Date.now() + ahead * 86_400_000).getUTCDay()] ?? "mon";
}
