// Fills the development database with a demo workspace, Acme, for screenshots and manual testing,
// with `bun run seed`. Start `bun run dev` first: this writes to its database and Valkey.
// Each run deletes the workspace it made before, and nothing else, then makes it again. It keeps that
// workspace's ID in .dev/seed-workspace. It sends no email: the demo sends no transcripts, and every
// address is on a reserved domain.
// With `bun run seed -- --live`, it keeps the live visitors on the site, a teammate online and a
// visitor typing, until Ctrl-C. Without it, the live visitors leave the Visitors screen after 90 s.
// With `--harbor`, it writes Harbor Coffee, a coffee roaster from src/demo-harbor.ts, instead of Acme.
// The fill itself is src/demo.ts, which `chat demo` shares.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Redis } from "iovalkey";
import pg from "pg";
import { pino } from "pino";
// The app first, as main.ts loads it: some of its modules import each other in a loop, which
// works only from this end.
import "../src/app.ts";
import { createAuth, LINK_MINUTES, signInLink } from "../src/auth.ts";
import { ROLES } from "../src/db/roles.ts";
import * as schema from "../src/db/schema.ts";
import {
  type Database,
  operatorWorkspaces,
  type Transaction,
  withWorkspace,
} from "../src/db/tenant.ts";
import {
  addMembers,
  ensureOperators,
  fillWorkspace,
  JOINED_DAYS_AGO,
  ownerOf,
  type TeamIds,
  teammateId,
} from "../src/demo.ts";
import type { DemoData } from "../src/demo-data.ts";
import { createSignals, type Live, noLive, OPERATORS } from "../src/live.ts";
import { createLiveVisitors, tabsKey } from "../src/live-visitors.ts";
import { createPresence, createVisitorPresence } from "../src/presence.ts";
import { DAY_MS, MINUTE_MS } from "../src/time.ts";
import { createWorkspace } from "../src/workspaces.ts";

// The same database, Valkey and port as scripts/dev.ts.
const DATABASE = "dinghy_dev";
const VALKEY_URL = "redis://127.0.0.1:56379";
const PORT = Number(process.env.DINGHY_PORT ?? 3000);
const postgres = (user: string) => `postgres://${user}@127.0.0.1:55432/${DATABASE}`;
const SECRET_FILE = fileURLToPath(new URL("../../../.dev/auth-secret", import.meta.url));
/** The ID of the workspace the last run made, so the next run deletes that one and no other. */
const DEMO_FILE = fileURLToPath(new URL("../../../.dev/seed-workspace", import.meta.url));

/** How long a live tab has been on the site, at most, when the seed runs. */
const ON_SITE_MAX_MINUTES = 25;
/** With --live, the beats: a live tab expires after 90 s, an operator's mark after 30 s. */
const BEAT_MS = 20_000;
const TYPING_MS = 1_500;
const logger = pino({ level: "warn" });

const { values: flags } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    harbor: { type: "boolean", default: false },
  },
});
const data: DemoData = flags.harbor
  ? await import("../src/demo-harbor.ts")
  : await import("./seed-data.ts");
const { CONVERSATIONS, LIVE, SITE, TEAM, WORKSPACE_NAME } = data;
const [, { name: OWNER_NAME, email: OWNER_EMAIL }] = ownerOf(data);

const appPool = new pg.Pool({ connectionString: postgres(ROLES.app), max: 2 });
const db: Database = drizzle(appPool, { schema });
const valkey = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
const live: Live = { ...noLive, ...createSignals(valkey, logger) };

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

/** The members, and the widget seen, as a team that has used the app a while. */
async function setUpWorkspace(tx: Transaction, workspaceId: string, team: TeamIds) {
  await addMembers(
    tx,
    workspaceId,
    Object.entries(TEAM).map(([key, { role }]) => ({ operatorId: teammateId(team, key), role })),
  );
  const joined = new Date(Date.now() - JOINED_DAYS_AGO * DAY_MS);
  // The test site has loaded the widget, as a site that is set up has. The creation time stays now,
  // so the dev test site, which picks the oldest workspace, keeps its own.
  await tx
    .update(schema.workspace)
    .set({ widgetSeenAt: joined })
    .where(eq(schema.workspace.id, workspaceId));
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
  const team = await ensureOperators(db, TEAM);
  const workspaceId = (await createWorkspace(db, WORKSPACE_NAME, [SITE])).id;
  writeFileSync(DEMO_FILE, `${workspaceId}\n`);
  await withWorkspace(db, workspaceId, (tx) => setUpWorkspace(tx, workspaceId, team));
  console.log(
    `==> Adding ${CONVERSATIONS.length + data.ROUTINE_CONVERSATIONS.length} conversations, their visitors and the campaigns`,
  );
  const filled = await fillWorkspace(db, {
    workspaceId,
    data,
    team,
    ownerName: OWNER_NAME,
    live,
  });
  const seeded = filled.conversations;
  console.log("==> Adding live visitors");
  const tabs = liveTabs(seeded, filled.quietVisitorIds[0] ?? "");
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
