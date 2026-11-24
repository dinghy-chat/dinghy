// Fills a workspace with a demo story: labels, saved replies, contacts, backdated conversations and
// campaigns. `bun run seed` and `chat demo` both write through here. Every message goes through the
// app's own writes, then moves back to the time the story gives.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { CampaignDefinitionSchema } from "./campaign-schemas.ts";
import { createCampaigns } from "./campaigns.ts";
import { upsertContact } from "./contact-fields.ts";
import * as schema from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import type { ConversationSeed, DemoData, TeamMember, VisitorSeed } from "./demo-data.ts";
import { newBrowserToken, sha256Hex } from "./identity.ts";
import { setLabel } from "./labels.ts";
import type { Live } from "./live.ts";
import {
  appendMessage,
  markConversationRead,
  setConversationStatus,
  snoozeConversation,
} from "./messages.ts";
import { DAY_MS, MINUTE_MS } from "./time.ts";

/** A line with no gap of its own follows the one before by this many minutes. */
const LINE_GAP_MINUTES = 2;
/** A conversation closes this long after its last line. */
const CLOSE_GAP_MINUTES = 15;
/** How long a snoozed conversation sleeps. */
const SNOOZE_MS = 3 * DAY_MS;
/** Higher than any message's position: a read mark stops at the newest message. */
const READ_ALL = 2n ** 62n;
/** When the story's team joined the workspace. */
export const JOINED_DAYS_AGO = 60;

/** The operator ID of each of the story's teammates, by the key the data uses. */
export type TeamIds = Record<string, string>;

export interface DemoTarget {
  workspaceId: string;
  data: DemoData;
  team: TeamIds;
  /** The owner's name, which a campaign's author shows. */
  ownerName: string;
  live: Live;
}

/** What the fill wrote that a caller needs next, such as the seed's live visitors. */
export interface Filled {
  conversations: { conversationId: string; visitorId: string }[];
  quietVisitorIds: string[];
}

export function teammateId(team: TeamIds, key: string): string {
  const id = team[key];
  if (id === undefined) throw new Error(`No teammate ${key} in the demo team`);
  return id;
}

/** The story's owner and its key, such as "nora". */
export function ownerOf(data: DemoData): [key: string, member: TeamMember] {
  const owner = Object.entries(data.TEAM).find(([, member]) => member.role === "owner");
  if (owner === undefined) throw new Error("The demo team has no owner");
  return owner;
}

/** The teammates' operators, by key: made when missing, and left as they are when not. */
export async function ensureOperators(
  db: Database,
  team: Record<string, TeamMember>,
): Promise<TeamIds> {
  const members = Object.values(team);
  if (members.length === 0) return {};
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
  return Object.fromEntries(Object.entries(team).map(([key, { email }]) => [key, idOf(email)]));
}

/**
 * Makes these operators members, with Get started hidden, as a team that has used the app a while.
 * A removed member comes back.
 */
export async function addMembers(
  tx: Transaction,
  workspaceId: string,
  members: { operatorId: string; role: TeamMember["role"] }[],
): Promise<void> {
  if (members.length === 0) return;
  const joined = new Date(Date.now() - JOINED_DAYS_AGO * DAY_MS);
  await tx
    .insert(schema.workspaceMember)
    .values(
      members.map((member) => ({
        workspaceId,
        ...member,
        getStartedDismissedAt: joined,
        createdAt: joined,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.workspaceMember.workspaceId, schema.workspaceMember.operatorId],
      set: { role: sql`excluded.role`, removedAt: null },
    });
}

export async function fillWorkspace(db: Database, target: DemoTarget): Promise<Filled> {
  const { workspaceId, data } = target;
  const labels = await withWorkspace(db, workspaceId, (tx) => addSetup(tx, workspaceId, data));
  const conversations = [];
  for (const conversation of [...data.CONVERSATIONS, ...data.ROUTINE_CONVERSATIONS]) {
    conversations.push(
      await withWorkspace(db, workspaceId, (tx) =>
        addConversation(tx, target, conversation, labels),
      ),
    );
  }
  const quietVisitorIds = await withWorkspace(db, workspaceId, async (tx) => {
    const ids = [];
    for (const [index, contact] of data.QUIET_CONTACTS.entries()) {
      const seenAt = new Date(Date.now() - (index * 5 * 24 + 1) * 60 * MINUTE_MS);
      ids.push(await addVisitor(tx, workspaceId, data.SITE, contact, seenAt));
    }
    return ids;
  });
  await addCampaigns(db, target);
  return { conversations, quietVisitorIds };
}

/**
 * The labels and saved replies a team sets up first, with transcripts off, so closing the story's
 * chats emails no visitor. Answers the label IDs by name.
 */
async function addSetup(tx: Transaction, workspaceId: string, data: DemoData) {
  await tx
    .update(schema.widgetSettings)
    .set({ transcript: false })
    .where(eq(schema.widgetSettings.workspaceId, workspaceId));
  const labels = await tx
    .insert(schema.label)
    .values(Object.entries(data.LABELS).map(([name, color]) => ({ workspaceId, name, color })))
    .returning({ id: schema.label.id, name: schema.label.name });
  await tx
    .insert(schema.savedReply)
    .values(data.SAVED_REPLIES.map((reply) => ({ workspaceId, ...reply })));
  return new Map(labels.map((one) => [one.name, one.id]));
}

/**
 * A visitor of the site: a contact of the site's own app, or an anonymous browser. Its pages lead up to
 * `arrivedAt`, such as the start of its chat, and it was last seen at `seenAt`.
 */
async function addVisitor(
  tx: Transaction,
  workspaceId: string,
  site: string,
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
    path: `${site}${path}`,
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
  return new Date(at.getTime() - days * DAY_MS);
}

/** Writes each line as the app does, then moves the rows back to the times the script gives. */
async function addConversation(
  tx: Transaction,
  { workspaceId, data, team }: DemoTarget,
  seed: ConversationSeed,
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
    data.SITE,
    seed.visitor,
    new Date(lastLineAt),
    seed.startedAt,
  );
  const page = `${data.SITE}${seed.visitor.pages.at(-1) ?? "/"}`;
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
    const closer = teammateId(team, lastTeammate(seed) ?? ownerOf(data)[0]);
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
    for (const operatorId of new Set(Object.values(team))) {
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

/**
 * A live page campaign, and a draft that waits for review. Each replaces the one with its key, so
 * a second fill of the same workspace keeps two.
 */
async function addCampaigns(
  db: Database,
  { workspaceId, data, team, ownerName, live }: DemoTarget,
) {
  const campaigns = createCampaigns({ db, live });
  const operatorId = teammateId(team, ownerOf(data)[0]);
  const actor = { kind: "operator", operatorId, name: ownerName } as const;
  const base = {
    message: { body: "" },
    presentation: { startConversation: "on_reply", show: "preview", ifConversationOpen: "skip" },
    delivery: { sendEmail: false },
    rules: { frequency: "once", businessHours: false, endsAt: null },
  } as const;
  const pricing = await campaigns.upsert(
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
  const welcome = await campaigns.upsert(
    workspaceId,
    actor,
    CampaignDefinitionSchema.parse({
      ...base,
      key: "welcome",
      name: "Welcome new signups",
      trigger: { type: "match" },
      audience: { field: "signedIn", op: "eq", value: true },
      message: {
        body: `Welcome to ${data.WORKSPACE_NAME}! Reply here any time, a person reads every message.`,
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
