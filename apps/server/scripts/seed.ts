// Fills the development database with a demo workspace, Acme, for screenshots and manual testing,
// with `bun run seed`. Start `bun run dev` first: this writes to its database and Valkey.
// Each run deletes the workspace it made before, and nothing else, then makes it again. It keeps that
// workspace's ID in .dev/seed-workspace. It sends no email: the demo sends no transcripts, and every
// address is on a reserved domain.
// With `bun run seed -- --live`, it keeps the live visitors on the site, a teammate online and a
// visitor typing, until Ctrl-C. Without it, the live visitors leave the Visitors screen after 90 s.
// With `--harbor`, it writes Harbor Coffee, a coffee roaster from seed-harbor.ts, instead of Acme.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Redis } from "iovalkey";
import pg from "pg";
import { pino } from "pino";
// The app first, as main.ts loads it: some of its modules import each other in a loop, which
// works only from this end.
import "../src/app.ts";
import { createAuth, LINK_MINUTES, signInLink } from "../src/auth.ts";
import { CampaignDefinitionSchema } from "../src/campaign-schemas.ts";
import { createCampaigns } from "../src/campaigns.ts";
import { upsertContact } from "../src/contact-fields.ts";
import { ROLES } from "../src/db/roles.ts";
import * as schema from "../src/db/schema.ts";
import {
  type Database,
  operatorWorkspaces,
  type Transaction,
  withWorkspace,
} from "../src/db/tenant.ts";
import { newBrowserToken, sha256Hex } from "../src/identity.ts";
import { setLabel } from "../src/labels.ts";
import { createSignals, type Live, noLive, OPERATORS } from "../src/live.ts";
import { createLiveVisitors, tabsKey } from "../src/live-visitors.ts";
import {
  appendMessage,
  markConversationRead,
  setConversationStatus,
  snoozeConversation,
} from "../src/messages.ts";
import { createPresence, createVisitorPresence } from "../src/presence.ts";
import { createWorkspace } from "../src/workspaces.ts";
import type { ConversationSeed, SeedData, VisitorSeed } from "./seed-shared.ts";

// The same database, Valkey and port as scripts/dev.ts.
const DATABASE = "dinghy_dev";
const VALKEY_URL = "redis://127.0.0.1:56379";
const PORT = Number(process.env.DINGHY_PORT ?? 3000);
const postgres = (user: string) => `postgres://${user}@127.0.0.1:55432/${DATABASE}`;
const SECRET_FILE = fileURLToPath(new URL("../../../.dev/auth-secret", import.meta.url));
/** The ID of the workspace the last run made, so the next run deletes that one and no other. */
const DEMO_FILE = fileURLToPath(new URL("../../../.dev/seed-workspace", import.meta.url));

const MINUTE_MS = 60_000;
/** A line with no gap of its own follows the one before by this many minutes. */
const LINE_GAP_MINUTES = 2;
/** A conversation closes this long after its last line. */
const CLOSE_GAP_MINUTES = 15;
/** How long a snoozed conversation sleeps. */
const SNOOZE_MS = 3 * 24 * 60 * MINUTE_MS;
/** How long a live tab has been on the site, at most, when the seed runs. */
const ON_SITE_MAX_MINUTES = 25;
/** With --live, the beats: a live tab expires after 90 s, an operator's mark after 30 s. */
const BEAT_MS = 20_000;
const TYPING_MS = 1_500;
/** Higher than any message's position: a read mark stops at the newest message. */
const READ_ALL = 2n ** 62n;
const logger = pino({ level: "warn" });

const { values: flags } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    harbor: { type: "boolean", default: false },
  },
});
const {
  CONVERSATIONS,
  LABELS,
  LIVE,
  QUIET_CONTACTS,
  ROUTINE_CONVERSATIONS,
  SAVED_REPLIES,
  SITE,
  TEAM,
  WORKSPACE_NAME,
}: SeedData = flags.harbor ? await import("./seed-harbor.ts") : await import("./seed-data.ts");
const owner = Object.entries(TEAM).find(([, member]) => member.role === "owner");
if (owner === undefined) throw new Error("The demo team has no owner");
const [OWNER, { name: OWNER_NAME, email: OWNER_EMAIL }] = owner;

const appPool = new pg.Pool({ connectionString: postgres(ROLES.app), max: 2 });
const db: Database = drizzle(appPool, { schema });
const valkey = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
const live: Live = { ...noLive, ...createSignals(valkey, logger) };

type TeamIds = Record<string, string>;

function teammateId(team: TeamIds, key: string): string {
  const id = team[key];
  if (id === undefined) throw new Error(`No teammate ${key} in the demo team`);
  return id;
}

/** Marks the workspace that an earlier run made as deleted. The worker in `bun run dev` purges it. */
async function removeEarlierDemo(): Promise<void> {
  const workspaceId = existsSync(DEMO_FILE)
    ? readFileSync(DEMO_FILE, "utf8").trim()
    : await matchEarlierDemo();
  if (workspaceId === undefined) return;
  await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(schema.workspace)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.workspace.id, workspaceId), isNull(schema.workspace.deletedAt))),
  );
}

/** Without the ID file: the one workspace the owner has with the demo's name and site, if exactly one. */
async function matchEarlierDemo(): Promise<string | undefined> {
  const [ownerRow] = await db
    .select({ id: schema.operator.id })
    .from(schema.operator)
    .where(eq(schema.operator.email, OWNER_EMAIL));
  if (ownerRow === undefined) return undefined;
  const matches: string[] = [];
  for (const { workspaceId, role } of await operatorWorkspaces(db, ownerRow.id)) {
    if (role !== "owner") continue;
    const [match] = await withWorkspace(db, workspaceId, (tx) =>
      tx
        .select({ id: schema.workspace.id })
        .from(schema.workspace)
        .where(
          and(
            eq(schema.workspace.id, workspaceId),
            eq(schema.workspace.name, WORKSPACE_NAME),
            sql`${SITE} = any(${schema.workspace.allowedOrigins})`,
            isNull(schema.workspace.deletedAt),
          ),
        ),
    );
    if (match !== undefined) matches.push(match.id);
  }
  const [only] = matches;
  if (only === undefined || matches.length > 1) {
    console.log(
      `==> No ${DEMO_FILE}, and ${matches.length} workspaces look like the demo: none deleted`,
    );
    return undefined;
  }
  console.log(
    `==> No ${DEMO_FILE}, so deleting the one workspace that looks like the demo, ${only}`,
  );
  return only;
}

/** The team's accounts. A missing one is made; an existing one is left as it is. */
async function ensureTeam(): Promise<TeamIds> {
  const members = Object.values(TEAM);
  await db
    .insert(schema.operator)
    .values(members.map(({ name, email, away }) => ({ name, email, away })))
    .onConflictDoNothing({ target: schema.operator.email });
  const rows = await db
    .select({ id: schema.operator.id, email: schema.operator.email })
    .from(schema.operator)
    .where(
      inArray(
        schema.operator.email,
        members.map(({ email }) => email),
      ),
    );
  const idOf = (email: string) => {
    const id = rows.find((row) => row.email === email)?.id;
    if (id === undefined) throw new Error(`The operator ${email} was not saved`);
    return id;
  };
  return Object.fromEntries(Object.entries(TEAM).map(([key, { email }]) => [key, idOf(email)]));
}

/** The members, with Get started hidden, and the labels and saved replies a team sets up first. */
async function setUpWorkspace(tx: Transaction, workspaceId: string, team: TeamIds) {
  const joined = new Date(Date.now() - 60 * 24 * 60 * MINUTE_MS);
  await tx.insert(schema.workspaceMember).values(
    Object.entries(TEAM).map(([key, { role }]) => ({
      workspaceId,
      operatorId: teammateId(team, key),
      role,
      getStartedDismissedAt: joined,
      createdAt: joined,
    })),
  );
  // The test site has loaded the widget, as a site that is set up has. The creation time stays now,
  // so the dev test site, which picks the oldest workspace, keeps its own.
  await tx
    .update(schema.workspace)
    .set({ widgetSeenAt: joined })
    .where(eq(schema.workspace.id, workspaceId));
  // Closing the seeded chats must email no visitor.
  await tx
    .update(schema.widgetSettings)
    .set({ transcript: false })
    .where(eq(schema.widgetSettings.workspaceId, workspaceId));
  const labels = await tx
    .insert(schema.label)
    .values(Object.entries(LABELS).map(([name, color]) => ({ workspaceId, name, color })))
    .returning({ id: schema.label.id, name: schema.label.name });
  await tx
    .insert(schema.savedReply)
    .values(SAVED_REPLIES.map((reply) => ({ workspaceId, ...reply })));
  return new Map(labels.map((one) => [one.name, one.id]));
}

/**
 * A visitor of the site: a contact of the site's own app, or an anonymous browser. Its pages lead up to
 * `arrivedAt`, such as the start of its chat, and it was last seen at `seenAt`.
 */
async function addVisitor(
  tx: Transaction,
  workspaceId: string,
  seed: VisitorSeed,
  seenAt: Date,
  arrivedAt = seenAt,
): Promise<string> {
  let visitorId: string;
  if (seed.contact === undefined) {
    const [row] = await tx
      .insert(schema.visitor)
      .values({ workspaceId, tokenHash: sha256Hex(newBrowserToken()) })
      .returning({ id: schema.visitor.id });
    if (row === undefined) throw new Error("The visitor insert returned no row");
    visitorId = row.id;
  } else {
    const { userId, name, email, company, plan } = seed.contact;
    const attributes = { ...(company && { company }), ...(plan && { plan }) };
    const fields = { name, email, ...(Object.keys(attributes).length > 0 && { attributes }) };
    visitorId = (await upsertContact(tx, workspaceId, userId, fields, seenAt.getTime())).visitorId;
  }
  // What the widget's beats and page reports would have stored, at the times they would have.
  const pages = seed.pages.map((path, index) => ({
    workspaceId,
    visitorId,
    path: `${SITE}${path}`,
    viewedAt: new Date(arrivedAt.getTime() - (seed.pages.length - index) * 3 * MINUTE_MS),
  }));
  await tx.insert(schema.pageView).values(pages);
  const firstPage = pages[0]?.viewedAt ?? seenAt;
  await tx
    .update(schema.visitor)
    .set({
      country: seed.country,
      timeZone: seed.timeZone,
      device: seed.device,
      locale: "en",
      lastPage: pages.at(-1)?.path ?? null,
      lastSeenAt: seenAt,
      // A contact signed up to the site's app long before; an anonymous visitor came with its first page.
      createdAt:
        seed.contact === undefined ? firstPage : signedUpBefore(firstPage, seed.contact.userId),
    })
    .where(and(eq(schema.visitor.workspaceId, workspaceId), eq(schema.visitor.id, visitorId)));
  return visitorId;
}

/** Between 2 weeks and 10 months before `at`, fixed for each user ID, so reruns agree. */
function signedUpBefore(at: Date, userId: string): Date {
  const days = 14 + (Number.parseInt(sha256Hex(userId).slice(0, 6), 16) % 290);
  return new Date(at.getTime() - days * 24 * 60 * MINUTE_MS);
}

/** Writes each line as the app does, then moves the rows back to the times the script gives. */
async function addConversation(
  tx: Transaction,
  workspaceId: string,
  seed: ConversationSeed,
  team: TeamIds,
  labels: Map<string, string>,
): Promise<{ conversationId: string; visitorId: string }> {
  const times: Date[] = [];
  let at = seed.startedAt.getTime();
  const lastLineAt = seed.lines.reduce(
    (sum, [, , gap], index) => sum + (index === 0 ? 0 : (gap ?? LINE_GAP_MINUTES)) * MINUTE_MS,
    at,
  );
  const visitorId = await addVisitor(
    tx,
    workspaceId,
    seed.visitor,
    new Date(lastLineAt),
    seed.startedAt,
  );
  const page = `${SITE}${seed.visitor.pages.at(-1) ?? "/"}`;
  let conversationId = "";
  for (const [index, [author, body, gap]] of seed.lines.entries()) {
    if (index > 0) at += (gap ?? LINE_GAP_MINUTES) * MINUTE_MS;
    times.push(new Date(at));
    const input = { clientId: randomUUID(), body, alert: false };
    if (author === "visitor") {
      const sent = await appendMessage(
        tx,
        workspaceId,
        { kind: "visitor", visitorId },
        { ...input, page },
      );
      conversationId = sent.message.conversationId;
      continue;
    }
    const [operator, isNote] = author.startsWith("note:")
      ? [author.slice("note:".length), true]
      : [author, false];
    await appendMessage(
      tx,
      workspaceId,
      { kind: "operator", operatorId: teammateId(team, operator), conversationId },
      isNote ? { ...input, note: true } : input,
    );
  }
  for (const name of seed.labels ?? []) {
    const labelId = labels.get(name);
    if (labelId !== undefined)
      await setLabel(tx, workspaceId, { conversationId, labelId, added: true });
  }
  if (seed.status === "closed") {
    const closer = teammateId(team, lastTeammate(seed) ?? OWNER);
    await setConversationStatus(tx, workspaceId, conversationId, "closed", {
      kind: "operator",
      operatorId: closer,
    });
    times.push(new Date(at + CLOSE_GAP_MINUTES * MINUTE_MS));
  }
  if (seed.status === "snoozed") {
    await snoozeConversation(tx, workspaceId, conversationId, {
      until: new Date(Date.now() + SNOOZE_MS),
    });
  }
  await backdate(tx, workspaceId, conversationId, seed.startedAt, times);
  // Only the people waiting now are unread, as a team that keeps up would have it.
  if (lastAuthor(seed) !== "visitor" || seed.status !== "open") {
    for (const operatorId of Object.values(team)) {
      await markConversationRead(tx, workspaceId, conversationId, operatorId, READ_ALL);
    }
  }
  return { conversationId, visitorId };
}

const lastAuthor = (seed: ConversationSeed) =>
  seed.lines.filter(([author]) => !author.startsWith("note:")).at(-1)?.[0];

function lastTeammate(seed: ConversationSeed): string | undefined {
  const author = seed.lines.map(([one]) => one).findLast((one) => one !== "visitor");
  return author?.replace("note:", "");
}

/** Gives the conversation's messages, in order, the script's times instead of now. */
async function backdate(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  startedAt: Date,
  times: Date[],
) {
  const rows = await tx
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.workspaceId, workspaceId),
        eq(schema.message.conversationId, conversationId),
      ),
    )
    .orderBy(schema.message.seq);
  if (rows.length !== times.length) throw new Error("The conversation has unexpected messages");
  const moves = rows.map((row, index) => ({ id: row.id, at: times[index]?.toISOString() }));
  await tx.execute(sql`
    update message as m set created_at = v.at
    from jsonb_to_recordset(${JSON.stringify(moves)}::jsonb) as v(id uuid, at timestamptz)
    where m.workspace_id = ${workspaceId} and m.id = v.id`);
  await tx
    .update(schema.conversation)
    .set({ createdAt: startedAt, updatedAt: times.at(-1) ?? startedAt })
    .where(
      and(
        eq(schema.conversation.workspaceId, workspaceId),
        eq(schema.conversation.id, conversationId),
      ),
    );
}

/** A live page campaign, and a draft that waits for review. */
async function addCampaigns(workspaceId: string, operatorId: string) {
  const campaigns = createCampaigns({ db, live });
  const actor = { kind: "operator", operatorId, name: OWNER_NAME } as const;
  const base = {
    message: { body: "" },
    presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
    delivery: { sendEmail: false },
    rules: { frequency: "once", businessHours: false, endsAt: null },
  } as const;
  const pricing = await campaigns.create(
    workspaceId,
    actor,
    CampaignDefinitionSchema.parse({
      ...base,
      key: "pricing-help",
      name: "Help on the pricing page",
      trigger: { type: "page", url: "/pricing*", seconds: 20 },
      message: { body: "Comparing plans? Ask us anything, we answer in a few minutes." },
    }),
  );
  const welcome = await campaigns.create(
    workspaceId,
    actor,
    CampaignDefinitionSchema.parse({
      ...base,
      key: "welcome",
      name: "Welcome new signups",
      trigger: { type: "match" },
      audience: { field: "signedIn", op: "eq", value: true },
      message: {
        body: `Welcome to ${WORKSPACE_NAME}! Reply here any time, a person reads every message.`,
      },
    }),
  );
  for (const outcome of [pricing, welcome]) {
    if (typeof outcome === "string" || outcome instanceof Error) {
      throw new Error(`A campaign was refused: ${String(outcome)}`);
    }
  }
  const resumed = await campaigns.setStatus(workspaceId, { key: "pricing-help" }, "resume");
  if (typeof resumed === "string") throw new Error(`The campaign did not start: ${resumed}`);
}

type Beat = Parameters<ReturnType<typeof createLiveVisitors>["beat"]>[1];
/** A tab as the seed describes it; each beat says whether it is the tab's first. */
type Tab = Omit<Beat, "arrival">;

/** The tabs open on the site now, as the widget's beats describe them. */
function liveTabs(
  seeded: { conversationId: string; visitorId: string }[],
  knownVisitorId: string,
): Tab[] {
  const chatting = LIVE.chatting.map(({ conversation, title }, index) => {
    const seed = CONVERSATIONS[conversation];
    const ids = seeded[conversation];
    if (seed === undefined || ids === undefined) throw new Error("A live visitor has no chat");
    return {
      tab: `seed-chat-${index}`,
      page: `${SITE}${seed.visitor.pages.at(-1) ?? "/"}`,
      title,
      referrer: null,
      country: seed.visitor.country,
      timeZone: seed.visitor.timeZone,
      device: seed.visitor.device,
      ...ids,
    };
  });
  const { visitor, title } = LIVE.known;
  const known = {
    tab: "seed-known",
    page: `${SITE}${visitor.pages.at(-1) ?? "/"}`,
    title,
    referrer: null,
    country: visitor.country,
    timeZone: visitor.timeZone,
    device: visitor.device,
    visitorId: knownVisitorId,
    conversationId: null,
  };
  const anonymous = LIVE.anonymous.map((one, index) => ({
    ...one,
    tab: `seed-anon-${index}`,
    page: `${SITE}${one.page}`,
    visitorId: null,
    conversationId: null,
  }));
  return [...chatting, known, ...anonymous];
}

/**
 * Puts the tabs on the Visitors screen. A tab keeps the arrival time stored before its first beat,
 * so each is written first with an earlier one, as if it had been on the site a while.
 */
async function arrive(workspaceId: string, tabs: Tab[]): Promise<void> {
  const now = Date.now();
  for (const [index, tab] of tabs.entries()) {
    const startedAt = now - ((index * 7) % ON_SITE_MAX_MINUTES) * MINUTE_MS - MINUTE_MS;
    await valkey.hset(
      tabsKey(workspaceId),
      tab.tab,
      JSON.stringify({ ...tab, startedAt, seenAt: startedAt }),
    );
  }
  // The first beat is the visit, from outside the site, so the site's numbers count it.
  await beatAll(workspaceId, tabs, "entrance");
}

async function beatAll(workspaceId: string, tabs: Tab[], arrival: Beat["arrival"] = null) {
  const visitors = createLiveVisitors(valkey, logger);
  for (const tab of tabs) {
    if (!(await visitors.beat(workspaceId, { ...tab, arrival }))) {
      throw new Error("Valkey refused a live tab");
    }
  }
}

/** With --live: beats for the tabs and the online teammates, and a visitor typing, until Ctrl-C. */
function stayLive(
  workspaceId: string,
  tabs: Tab[],
  team: TeamIds,
  typing: { conversationId: string; visitorId: string },
) {
  const presence = createPresence(valkey, logger);
  const marks = createVisitorPresence(valkey, logger);
  const open = tabs.flatMap((tab) =>
    tab.visitorId === null ? [] : [marks.open(workspaceId, tab.visitorId)],
  );
  const online = Object.entries(TEAM).flatMap(([key, { role, away }]) =>
    role === "owner" || away ? [] : [teammateId(team, key)],
  );
  const beat = async () => {
    await beatAll(workspaceId, tabs);
    for (const operatorId of online) {
      await presence.beat(workspaceId, operatorId, {
        viewing: null,
        left: null,
        hidden: false,
        away: false,
      });
    }
  };
  const { draft } = LIVE.typing;
  let typed = 0;
  const type = () => {
    // Types the draft a few words at a time, then starts again.
    typed = typed >= draft.length ? draft.indexOf(" ") : draft.indexOf(" ", typed + 12);
    if (typed === -1) typed = draft.length;
    live.tell(workspaceId, { kind: "typing", ...typing, draft: draft.slice(0, typed) });
  };
  void beat();
  const beats = setInterval(() => void beat(), BEAT_MS);
  const keys = setInterval(type, TYPING_MS);
  console.log("==> Live: the visitors stay on the site, and one types. Ctrl-C stops.");
  process.once("SIGINT", async () => {
    clearInterval(beats);
    clearInterval(keys);
    for (const mark of open) mark.release();
    live.tell(workspaceId, { kind: "typing", ...typing, draft: "" });
    await Promise.all(
      tabs.map((tab) => createLiveVisitors(valkey, logger).leave(workspaceId, tab.tab)),
    );
    await finish();
  });
}

async function finish() {
  await appPool.end();
  valkey.disconnect();
}

async function seed() {
  console.log("==> Removing the earlier demo, if any");
  await removeEarlierDemo();
  console.log(`==> Creating the ${WORKSPACE_NAME} workspace`);
  const team = await ensureTeam();
  const workspaceId = (await createWorkspace(db, WORKSPACE_NAME, [SITE])).id;
  writeFileSync(DEMO_FILE, `${workspaceId}\n`);
  const labels = await withWorkspace(db, workspaceId, (tx) =>
    setUpWorkspace(tx, workspaceId, team),
  );
  console.log(
    `==> Adding ${CONVERSATIONS.length + ROUTINE_CONVERSATIONS.length} conversations and their visitors`,
  );
  const seeded = [];
  for (const conversation of CONVERSATIONS) {
    seeded.push(
      await withWorkspace(db, workspaceId, (tx) =>
        addConversation(tx, workspaceId, conversation, team, labels),
      ),
    );
  }
  for (const conversation of ROUTINE_CONVERSATIONS) {
    await withWorkspace(db, workspaceId, (tx) =>
      addConversation(tx, workspaceId, conversation, team, labels),
    );
  }
  const quiet = await withWorkspace(db, workspaceId, async (tx) => {
    const ids = [];
    for (const [index, contact] of QUIET_CONTACTS.entries()) {
      const seenAt = new Date(Date.now() - (index * 5 * 24 + 1) * 60 * MINUTE_MS);
      ids.push(await addVisitor(tx, workspaceId, contact, seenAt));
    }
    return ids;
  });
  console.log("==> Adding campaigns and live visitors");
  await addCampaigns(workspaceId, teammateId(team, OWNER));
  const tabs = liveTabs(seeded, quiet[0] ?? "");
  await arrive(workspaceId, tabs);
  live.wake(workspaceId, OPERATORS);

  const auth = createAuth({
    db,
    secret: readFileSync(SECRET_FILE, "utf8").trim(),
    baseURL: process.env.PUBLIC_URL || `http://localhost:${PORT}`,
  });
  // The tour reads the workspace from this line, since the owner may belong to others.
  console.log(`\n==> ${WORKSPACE_NAME} is ready, workspace ${workspaceId}.`);
  console.log(`==> Sign in as ${OWNER_EMAIL} within ${LINK_MINUTES} minutes:`);
  console.log(await signInLink(auth, OWNER_EMAIL));
  const typing = seeded[LIVE.typing.conversation];
  if (flags.live && typing !== undefined) stayLive(workspaceId, tabs, team, typing);
  else await finish();
}

await seed();
