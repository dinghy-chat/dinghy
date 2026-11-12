// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  conversation,
  operator,
  visitor,
  welcomeLink,
  workspaceMember,
} from "../../apps/server/src/db/schema.ts";
import {
  type Database,
  enterWorkspace,
  type Transaction,
  welcomeAccess,
  withWorkspace,
  workspaceAccess,
  writable,
  writableFor,
} from "../../apps/server/src/db/tenant.ts";
import { safeErrorFields } from "../../apps/server/src/errors.ts";
import type { CopyReply } from "../../apps/server/src/inbox.ts";
import type { Limits } from "../../apps/server/src/limits.ts";
import { type Live, wakeConversation } from "../../apps/server/src/live.ts";
import {
  appendMessage,
  joinVisitor,
  type NewImage,
  type StoredMessage,
} from "../../apps/server/src/messages.ts";
import type { ObjectStore } from "../../apps/server/src/storage.ts";

/** Dinghy's own workspace, and the operator there who welcomes each new workspace. */
export interface WelcomeSettings {
  workspaceId: string;
  /** Lowercase, as every operator email is stored. */
  operatorEmail: string;
}

// Plain text. Every string has a key here, so a locale can be added later.
const text = {
  founderVisitor: "Julien from Dinghy",
  customerVisitor: (owner: string, workspace: string) => `${owner}, ${workspace}`,
  welcome:
    "Hi, I'm Julien, the founder of Dinghy. This is where you'll read and answer messages from " +
    "your website visitors. Reply here and it comes to my own Dinghy inbox. I read every reply, " +
    "so tell me what you need or what feels confusing.",
};

/** The founder's visitor in a new workspace. A workspace has one welcome chat, so one is enough. */
const FOUNDER_EXTERNAL_ID = "dinghy-welcome";
/** A new workspace's visitor in Dinghy's own workspace. */
const customerExternalId = (workspaceId: string) => `dinghy-welcome-${workspaceId}`;
/** A copy's own client ID, so a copy of one message can never go in twice. */
const copyClientId = (messageId: string) => `copy-${messageId}`;

/** The welcome operator's ID, while they are an active member of Dinghy's workspace. */
async function welcomeOperatorId(tx: Transaction, settings: WelcomeSettings) {
  const [row] = await tx
    .select({ id: operator.id })
    .from(workspaceMember)
    .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
    .where(
      and(
        eq(workspaceMember.workspaceId, settings.workspaceId),
        eq(operator.email, settings.operatorEmail),
        isNull(workspaceMember.removedAt),
        isNull(operator.deletedAt),
      ),
    );
  return row?.id ?? null;
}

/**
 * The founder's picture, for the new workspace's side of a welcome chat, as the operator picture
 * route serves it. The operator table holds no tenant data, so this reads no other workspace.
 */
export const welcomeFace =
  (settings: WelcomeSettings) =>
  async (
    tx: Transaction,
  ): Promise<{ operatorId: string; pictureUpdatedAt: Date | null } | null> => {
    const [row] = await tx
      .select({ operatorId: operator.id, pictureUpdatedAt: operator.pictureUpdatedAt })
      .from(operator)
      .where(and(eq(operator.email, settings.operatorEmail), isNull(operator.deletedAt)));
    return row ?? null;
  };

/** Why the server cannot start with these settings, or null when it can. */
export async function welcomeProblem(
  db: Database,
  settings: WelcomeSettings,
): Promise<string | null> {
  const id = await withWorkspace(db, settings.workspaceId, (tx) => welcomeOperatorId(tx, settings));
  return id === null
    ? "CLOUD_WELCOME_OPERATOR_EMAIL is not an active member of CLOUD_WELCOME_WORKSPACE_ID"
    : null;
}

/** A visitor with no email and no browser, and its welcome conversation, in the current context. */
async function welcomeConversation(
  tx: Transaction,
  workspaceId: string,
  guest: { externalId: string; name: string },
  assigneeOperatorId: string | null,
) {
  const [made] = await tx
    .insert(visitor)
    .values({ workspaceId, ...guest })
    .returning({ id: visitor.id });
  if (made === undefined) throw new Error("The welcome visitor insert returned no row");
  const [chat] = await tx
    .insert(conversation)
    .values({ workspaceId, visitorId: made.id, assigneeOperatorId, welcome: true })
    .returning({ id: conversation.id });
  if (chat === undefined) throw new Error("The welcome conversation insert returned no row");
  return { visitorId: made.id, conversationId: chat.id };
}

/**
 * Starts the welcome chat of a new workspace, in the transaction that creates it, which is in the
 * new workspace's context and stays there. The new owner is in the app already, so the welcome
 * alerts nobody. False when the welcome operator or Dinghy's workspace cannot take it.
 */
export async function startWelcomeChat(
  tx: Transaction,
  settings: WelcomeSettings,
  customer: { workspaceId: string; workspaceName: string; ownerName: string },
): Promise<boolean> {
  const founder = settings.workspaceId;
  await enterWorkspace(tx, founder);
  const operatorId = await welcomeOperatorId(tx, settings);
  if (operatorId === null || !writable(await workspaceAccess(tx, founder))) {
    await enterWorkspace(tx, customer.workspaceId);
    return false;
  }
  const founderSide = await welcomeConversation(
    tx,
    founder,
    {
      externalId: customerExternalId(customer.workspaceId),
      name: text.customerVisitor(customer.ownerName, customer.workspaceName),
    },
    operatorId,
  );
  await appendMessage(
    tx,
    founder,
    { kind: "operator", operatorId, conversationId: founderSide.conversationId },
    { clientId: randomUUID(), body: text.welcome, alert: false },
  );

  await enterWorkspace(tx, customer.workspaceId);
  const customerSide = await welcomeConversation(
    tx,
    customer.workspaceId,
    { externalId: FOUNDER_EXTERNAL_ID, name: text.founderVisitor },
    null,
  );
  await appendMessage(
    tx,
    customer.workspaceId,
    { kind: "visitor", visitorId: customerSide.visitorId },
    { clientId: randomUUID(), body: text.welcome, alert: false },
  );
  await tx.insert(welcomeLink).values({
    customerWorkspaceId: customer.workspaceId,
    customerConversationId: customerSide.conversationId,
    founderWorkspaceId: founder,
    founderConversationId: founderSide.conversationId,
  });
  return true;
}

interface Side {
  workspaceId: string;
  conversationId: string;
}

/** The other side of a welcome chat, or null for any other conversation. */
async function otherSide(tx: Transaction, own: Side): Promise<Side | null> {
  const [row] = await tx
    .select()
    .from(welcomeLink)
    .where(
      or(
        and(
          eq(welcomeLink.customerWorkspaceId, own.workspaceId),
          eq(welcomeLink.customerConversationId, own.conversationId),
        ),
        and(
          eq(welcomeLink.founderWorkspaceId, own.workspaceId),
          eq(welcomeLink.founderConversationId, own.conversationId),
        ),
      ),
    );
  if (row === undefined) return null;
  return row.customerWorkspaceId === own.workspaceId
    ? { workspaceId: row.founderWorkspaceId, conversationId: row.founderConversationId }
    : { workspaceId: row.customerWorkspaceId, conversationId: row.customerConversationId };
}

/**
 * Takes both workspace row locks in one order, before the reply takes its own. Two replies that
 * cross, one on each side, would otherwise each hold one lock and wait for the other.
 */
async function lockBoth(tx: Transaction, ownId: string, otherId: string): Promise<void> {
  for (const id of [ownId, otherId].sort()) {
    await enterWorkspace(tx, id);
    await tx.execute(sql`select 1 from workspace where id = ${id} for no key update`);
  }
  await enterWorkspace(tx, ownId);
}

/** A conversation's visitor in the current context, and whether it is blocked. */
async function chatVisitor(tx: Transaction, side: Side) {
  const [row] = await tx
    .select({ id: visitor.id, blockedAt: visitor.blockedAt })
    .from(conversation)
    .innerJoin(visitor, joinVisitor())
    .where(
      and(eq(conversation.workspaceId, side.workspaceId), eq(conversation.id, side.conversationId)),
    );
  return row ?? null;
}

/**
 * Copies a reply as a visitor message on the other side, under both locks. Nothing goes when the
 * other side blocked its visitor or the other workspace is suspended or deleted. An image goes only
 * when the other workspace has room for it, and a message with nothing left to copy goes nowhere.
 * Like any visitor message, the copy reopens a closed chat.
 */
async function copyInto(
  tx: Transaction,
  other: Side,
  reply: StoredMessage,
  file: NewImage | undefined,
  limits: Limits,
): Promise<{ visitorId: string; usedFile: boolean } | null> {
  const access = await welcomeAccess(
    tx,
    other.workspaceId,
    await workspaceAccess(tx, other.workspaceId),
  );
  if (!writableFor(access, { welcome: true })) return null;
  const theirs = await chatVisitor(tx, other);
  if (theirs === null || theirs.blockedAt !== null) return null;
  const image =
    file !== undefined && (await limits.mayStore(tx, other.workspaceId, file.byteSize))
      ? file
      : undefined;
  if (reply.body === null && image === undefined) return null;
  await appendMessage(
    tx,
    other.workspaceId,
    { kind: "visitor", visitorId: theirs.id },
    {
      clientId: copyClientId(reply.id),
      ...(reply.body !== null && { body: reply.body }),
      ...(image !== undefined && { image }),
    },
    limits,
  );
  return { visitorId: theirs.id, usedFile: image !== undefined };
}

/** A copy of an image's file under the other workspace's own key, made before the transaction. */
async function copyFile(store: ObjectStore, workspaceId: string, image: NewImage) {
  const contents = await store.get(image.storageKey);
  if (contents === null) return undefined;
  const bytes = new Uint8Array(await new Response(contents).arrayBuffer());
  const attachmentId = randomUUID();
  const storageKey = `${workspaceId}/${attachmentId}`;
  await store.put(storageKey, bytes, image.contentType);
  return { ...image, attachmentId, storageKey };
}

interface CopyDeps {
  db: Database;
  limits: Limits;
  live: Live;
  logger: Logger;
  store: ObjectStore | undefined;
}

/**
 * Copies each operator or API key reply in a welcome chat to the other side, as a visitor message,
 * in the reply's own transaction. Visitor messages are never copied, so a copy never makes another.
 */
export function createCopyReply({ db, limits, live, logger, store }: CopyDeps): CopyReply {
  return async (workspaceId, conversationId, image) => {
    const own = { workspaceId, conversationId };
    const other = await withWorkspace(db, workspaceId, (tx) => otherSide(tx, own));
    if (other === null) return null;
    const file =
      image === undefined || store === undefined
        ? undefined
        : await copyFile(store, other.workspaceId, image).catch((error: unknown) => {
            logger.warn(safeErrorFields(error), "a welcome chat image was not copied");
            return undefined;
          });
    let copied: { visitorId: string; usedFile: boolean } | null = null;
    return {
      async write(tx, append) {
        await lockBoth(tx, workspaceId, other.workspaceId);
        const appended = await append();
        if (!appended.created) return appended;
        const mine = await chatVisitor(tx, own);
        if (mine === null || mine.blockedAt !== null) return appended;
        await enterWorkspace(tx, other.workspaceId);
        copied = await copyInto(tx, other, appended.message, file, limits);
        await enterWorkspace(tx, workspaceId);
        return appended;
      },
      async finish(outcome) {
        const committed = outcome === "committed";
        if (committed && copied !== null)
          wakeConversation(live, other.workspaceId, copied.visitorId);
        // A lost commit may have landed, and a retry then skips the copy, so its file stays, as
        // `images.receive` keeps the reply's own.
        const unused = outcome === "rolled_back" || (committed && copied?.usedFile !== true);
        if (file !== undefined && unused) {
          await store?.delete(file.storageKey).catch(() => undefined);
        }
      },
    };
  };
}
