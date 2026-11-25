import type { LinkPreview } from "../operator/src/link-preview.ts";

export interface ReplyScope {
  origin: string;
  workspaceId: string;
  operatorId: string;
}

export interface PendingReply {
  conversationId: string;
  clientId: string;
  body: string;
  replyToMessageId: string | null;
  /** The card the reply carries, kept so a retry after a restart still sends it. */
  linkPreview: LinkPreview | null;
}

/** A pending reply as its row holds it, with its card as JSON. */
type StoredReply = Omit<PendingReply, "linkPreview"> & { linkPreview: string | null };

const pendingOf = ({ linkPreview, ...reply }: StoredReply): PendingReply => ({
  ...reply,
  linkPreview: linkPreview === null ? null : (JSON.parse(linkPreview) as LinkPreview),
});

interface TableColumn {
  name: string;
}

/** An unsent reply, and the links whose card the operator removed from it. */
export interface ReplyDraft {
  body: string;
  removedLinks: string[];
}

const NO_DRAFT: ReplyDraft = { body: "", removedLinks: [] };

interface QueueDatabase {
  execSync(sql: string): void;
  runSync(sql: string, ...values: (string | null)[]): unknown;
  getAllSync<T>(sql: string, ...values: (string | null)[]): T[];
}

const activeSends = new Map<string, Promise<void>>();

function runTransaction<T>(db: QueueDatabase, operation: () => T): T {
  db.execSync("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.execSync("COMMIT");
    return result;
  } catch (failure) {
    try {
      db.execSync("ROLLBACK");
    } catch {
      // Keep the original database failure.
    }
    throw failure;
  }
}

export function openReplyQueue(db: QueueDatabase, scope: ReplyScope, newId: () => string) {
  db.execSync(`CREATE TABLE IF NOT EXISTS pending_reply (
    sequence INTEGER PRIMARY KEY,
    account TEXT NOT NULL,
    conversationId TEXT NOT NULL,
    clientId TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL,
    replyToMessageId TEXT,
    linkPreview TEXT
  )`);
  const columns = db.getAllSync<TableColumn>("PRAGMA table_info(pending_reply)");
  if (!columns.some((column) => column.name === "replyToMessageId")) {
    db.execSync("ALTER TABLE pending_reply ADD COLUMN replyToMessageId TEXT");
  }
  if (!columns.some((column) => column.name === "linkPreview")) {
    db.execSync("ALTER TABLE pending_reply ADD COLUMN linkPreview TEXT");
  }
  db.execSync(`CREATE TABLE IF NOT EXISTS public_reply_draft (
    account TEXT NOT NULL,
    conversationId TEXT NOT NULL,
    body TEXT NOT NULL,
    removedLinks TEXT,
    PRIMARY KEY (account, conversationId)
  )`);
  const draftColumns = db.getAllSync<TableColumn>("PRAGMA table_info(public_reply_draft)");
  if (!draftColumns.some((column) => column.name === "removedLinks")) {
    db.execSync("ALTER TABLE public_reply_draft ADD COLUMN removedLinks TEXT");
  }
  const account = JSON.stringify([scope.origin, scope.workspaceId, scope.operatorId]);
  const select =
    "SELECT conversationId, clientId, body, replyToMessageId, linkPreview FROM pending_reply WHERE account = ?";
  return {
    list(conversationId?: string) {
      const rows =
        conversationId === undefined
          ? db.getAllSync<StoredReply>(`${select} ORDER BY sequence`, account)
          : db.getAllSync<StoredReply>(
              `${select} AND conversationId = ? ORDER BY sequence`,
              account,
              conversationId,
            );
      return rows.map(pendingOf);
    },
    getDraft(conversationId: string): ReplyDraft {
      const row = db.getAllSync<{ body: string; removedLinks: string | null }>(
        "SELECT body, removedLinks FROM public_reply_draft WHERE account = ? AND conversationId = ?",
        account,
        conversationId,
      )[0];
      if (row === undefined) return NO_DRAFT;
      const removedLinks =
        row.removedLinks === null ? [] : (JSON.parse(row.removedLinks) as string[]);
      return { body: row.body, removedLinks };
    },
    saveDraft(conversationId: string, { body, removedLinks }: ReplyDraft) {
      if (!body) {
        db.runSync(
          "DELETE FROM public_reply_draft WHERE account = ? AND conversationId = ?",
          account,
          conversationId,
        );
        return;
      }
      db.runSync(
        `INSERT INTO public_reply_draft (account, conversationId, body, removedLinks)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (account, conversationId)
         DO UPDATE SET body = excluded.body, removedLinks = excluded.removedLinks`,
        account,
        conversationId,
        body,
        JSON.stringify(removedLinks),
      );
    },
    enqueue(
      conversationId: string,
      body: string,
      replyToMessageId: string | null = null,
      linkPreview: LinkPreview | null = null,
    ) {
      const clientId = newId();
      runTransaction(db, () => {
        db.runSync(
          `INSERT INTO pending_reply
             (account, conversationId, clientId, body, replyToMessageId, linkPreview)
           VALUES (?, ?, ?, ?, ?, ?)`,
          account,
          conversationId,
          clientId,
          body,
          replyToMessageId,
          linkPreview === null ? null : JSON.stringify(linkPreview),
        );
        db.runSync(
          "DELETE FROM public_reply_draft WHERE account = ? AND conversationId = ?",
          account,
          conversationId,
        );
      });
      return { conversationId, clientId, body, replyToMessageId, linkPreview };
    },
    discard(reply: PendingReply) {
      if (activeSends.has(JSON.stringify([account, reply.clientId]))) return false;
      db.runSync(
        "DELETE FROM pending_reply WHERE account = ? AND clientId = ?",
        account,
        reply.clientId,
      );
      return true;
    },
    async deliver(reply: PendingReply, post: (record: PendingReply) => Promise<void>) {
      const key = JSON.stringify([account, reply.clientId]);
      const active = activeSends.get(key);
      if (active) return active;
      const record = db
        .getAllSync<StoredReply>(`${select} AND clientId = ?`, account, reply.clientId)
        .map(pendingOf)[0];
      if (!record) return;
      const send = Promise.resolve()
        .then(() => post(record))
        .then(() => {
          db.runSync(
            "DELETE FROM pending_reply WHERE account = ? AND clientId = ?",
            account,
            record.clientId,
          );
        })
        .finally(() => activeSends.delete(key));
      activeSends.set(key, send);
      return send;
    },
  };
}
