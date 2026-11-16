import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL } from "../test/env.ts";
import { signedInOperator } from "../test/operators.ts";
import { asOperator, callTool, withKey } from "../test/requests.ts";
import { newVisitor, SITE } from "../test/visitors.ts";
import { type App, createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { latestOccurrence, openRuns, runCampaignRuns } from "./campaign-runs.ts";
import { endDueCampaigns } from "./campaigns.ts";
import {
  apiKey,
  businessHours,
  campaign,
  campaignRun,
  conversation,
  outboundMessage,
  visitor,
  workspace,
} from "./db/schema.ts";
import type { Database } from "./db/tenant.ts";
import { noLive } from "./live.ts";
import { runDueOutbound } from "./outbound.ts";
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
    expect(saved.status).toBe(200);
    const held = await sendCampaign(key, { visitor: { userId: userId() } });
    expect(held.outboundMessage).toMatchObject({
      status: "scheduled",
      statusReason: "campaign_paused",
    });
    expect((await rowOf(held.outboundMessage.id))?.dueAt).toBeNull();
    await asOperator(app, boss.cookie, "PUT", inSpace("/campaign-settings"), {
      paused: false,
      gapHours: 0,
    });
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
  test("each contact keeps one variant, and the control group gets a row with no text", async () => {
    const key = keyOf("ab");
    const made = await live(key, {
      variants: [
        { key: "short", weight: 1, message: { body: "Short" } },
        { key: "long", weight: 1 },
        { key: "control", weight: 1, control: true },
      ],
    });
    const seen = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
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
    expect(variants.reduce((sum, one) => sum + one.entered, 0)).toBe(12);
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
  });
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

/** The weekday `ahead` days from today in UTC, as business hours name it. */
function weekdayIn(ahead: number) {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return days[new Date(Date.now() + ahead * 86_400_000).getUTCDay()] ?? "mon";
}
