// `chat demo <workspace-id>`: replaces one workspace's chats, contacts, labels and saved replies with
// the Harbor Coffee story, so an app review account shows the same data as the store screenshots.
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { deleteContacts } from "./contacts.ts";
import * as schema from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { addMembers, ensureOperators, fillWorkspace, ownerOf, type TeamIds } from "./demo.ts";
import * as harbor from "./demo-harbor.ts";
import { noLive } from "./live.ts";
import { lockWorkspace } from "./messages.ts";

/** Visitors deleted per transaction, so a large workspace holds no lock for long. */
const DELETE_BATCH = 500;

const [OWNER_KEY, STORY_OWNER] = ownerOf(harbor);
/** The story's teammates besides its owner, by key. */
const TEAMMATES = new Map(Object.entries(harbor.TEAM).filter(([key]) => key !== OWNER_KEY));
const nameOf = (key: string) => TEAMMATES.get(key)?.name ?? key;

interface Plan {
  name: string;
  owner: { id: string; name: string; email: string };
  /** Teammates who are members already, by key. */
  members: TeamIds;
  /** Teammates to add, by key, within the operator limit. */
  joining: string[];
  /** Teammates past the limit, whose lines the owner takes. */
  mapped: string[];
  before: Counts;
}

type Counts = {
  conversations: number;
  messages: number;
  visitors: number;
  labels: number;
  savedReplies: number;
  campaigns: number;
};

export async function demoCommand(
  db: Database,
  workspaceId: string,
  { write, maxOperators }: { write: boolean; maxOperators: number },
): Promise<number> {
  const plan = await readPlan(db, workspaceId, maxOperators);
  if (typeof plan === "string") {
    console.error(`Nothing was changed. ${plan}`);
    return 1;
  }
  printPlan(plan);
  if (!write) {
    console.log("This was a dry run, and nothing changed. Run it again with --yes to write.");
    return 0;
  }
  await clearWorkspace(db, workspaceId);
  const team = await joinTeam(db, workspaceId, plan);
  await fillWorkspace(db, {
    workspaceId,
    data: harbor,
    team,
    ownerName: plan.owner.name,
    live: noLive,
  });
  const after = await withWorkspace(db, workspaceId, (tx) => countRows(tx, workspaceId));
  console.log(`Done. ${plan.name} now has ${describe(after)}, and ${after.campaigns} campaigns.`);
  return 0;
}

/** What the command would do, or why it refuses. */
async function readPlan(
  db: Database,
  workspaceId: string,
  maxOperators: number,
): Promise<Plan | string> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [found] = await tx
      .select({ name: schema.workspace.name, deletedAt: schema.workspace.deletedAt })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, workspaceId));
    if (found === undefined || found.deletedAt !== null) {
      return `No workspace has the ID ${workspaceId}, or it is deleted.`;
    }
    const [webhooks] = await tx
      .select({ n: count() })
      .from(schema.webhook)
      .where(and(eq(schema.webhook.workspaceId, workspaceId), eq(schema.webhook.enabled, true)));
    if ((webhooks?.n ?? 0) > 0) {
      return "It has a webhook that is on, which would receive the demo's events. Turn it off first.";
    }
    const members = await tx
      .select({
        id: schema.operator.id,
        name: schema.operator.name,
        email: schema.operator.email,
        role: schema.workspaceMember.role,
      })
      .from(schema.workspaceMember)
      .innerJoin(schema.operator, eq(schema.operator.id, schema.workspaceMember.operatorId))
      .where(
        and(
          eq(schema.workspaceMember.workspaceId, workspaceId),
          isNull(schema.workspaceMember.removedAt),
        ),
      )
      .orderBy(asc(schema.workspaceMember.createdAt));
    const owner = members.find((member) => member.role === "owner");
    if (owner === undefined) return `${found.name} has no owner.`;
    const memberIds: TeamIds = {};
    const missing: string[] = [];
    for (const [key, { email }] of TEAMMATES) {
      const member = members.find((one) => one.email === email);
      if (member === undefined) missing.push(key);
      else memberIds[key] = member.id;
    }
    const room = Math.max(0, maxOperators - members.length);
    return {
      name: found.name,
      owner,
      members: memberIds,
      joining: missing.slice(0, room),
      mapped: missing.slice(room),
      before: await countRows(tx, workspaceId),
    };
  });
}

function printPlan({ name, owner, members, joining, mapped, before }: Plan): void {
  console.log(`Workspace: ${name}. Owner: ${owner.name} <${owner.email}>.`);
  console.log(`It deletes ${describe(before)}.`);
  console.log("It adds 2 campaigns, or replaces the ones with the same keys.");
  console.log("It turns off chat transcripts, so closing the demo's chats emails nobody.");
  console.log(
    `It writes the ${harbor.WORKSPACE_NAME} story, with ${STORY_OWNER.name}'s lines from ${owner.name}.`,
  );
  const already = Object.keys(members).map(nameOf);
  if (already.length > 0) console.log(`Teammates already here: ${already.join(", ")}.`);
  if (joining.length > 0) console.log(`Teammates it adds: ${joining.map(nameOf).join(", ")}.`);
  if (mapped.length > 0) {
    console.log(
      `The operator limit leaves no room for ${mapped.map(nameOf).join(", ")}, so ${owner.name} takes their lines.`,
    );
  }
}

const describe = (counts: Counts) =>
  `${counts.conversations} conversations, ${counts.messages} messages, ${counts.visitors} visitors and contacts, ${counts.labels} labels and ${counts.savedReplies} saved replies`;

async function countRows(tx: Transaction, workspaceId: string): Promise<Counts> {
  const counted = (table: string) =>
    sql`(select count(*)::int from ${sql.identifier(table)} where workspace_id = ${workspaceId})`;
  const result = await tx.execute<Counts>(sql`select
    ${counted("conversation")} as conversations,
    ${counted("message")} as messages,
    ${counted("visitor")} as visitors,
    ${counted("label")} as labels,
    ${counted("saved_reply")} as "savedReplies",
    ${counted("campaign")} as campaigns`);
  const [row] = result.rows;
  if (row === undefined) throw new Error("The count returned no row");
  return row;
}

/**
 * Deletes the workspace's visitors, with their conversations, messages and pages, then its labels
 * and saved replies, through the same deletes the app runs.
 */
async function clearWorkspace(db: Database, workspaceId: string): Promise<void> {
  for (;;) {
    const deleted = await withWorkspace(db, workspaceId, async (tx) => {
      const batch = await tx
        .select({ id: schema.visitor.id })
        .from(schema.visitor)
        .where(eq(schema.visitor.workspaceId, workspaceId))
        .limit(DELETE_BATCH);
      return deleteContacts(
        tx,
        workspaceId,
        batch.map((row) => row.id),
      );
    });
    if (deleted < DELETE_BATCH) break;
  }
  await withWorkspace(db, workspaceId, async (tx) => {
    // The workspace lock first, as in every label write.
    await lockWorkspace(tx, workspaceId);
    await tx.delete(schema.label).where(eq(schema.label.workspaceId, workspaceId));
    await tx.delete(schema.savedReply).where(eq(schema.savedReply.workspaceId, workspaceId));
  });
}

/** Adds the teammates there is room for, and answers every story key's operator. */
async function joinTeam(db: Database, workspaceId: string, plan: Plan): Promise<TeamIds> {
  const joining = await ensureOperators(
    db,
    Object.fromEntries([...TEAMMATES].filter(([key]) => plan.joining.includes(key))),
  );
  await withWorkspace(db, workspaceId, (tx) =>
    addMembers(
      tx,
      workspaceId,
      Object.entries(joining).map(([key, operatorId]) => ({
        operatorId,
        role: TEAMMATES.get(key)?.role ?? "member",
      })),
    ),
  );
  const mapped = Object.fromEntries(plan.mapped.map((key) => [key, plan.owner.id]));
  return { ...mapped, ...plan.members, ...joining, [OWNER_KEY]: plan.owner.id };
}
