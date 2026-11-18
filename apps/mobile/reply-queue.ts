export interface ReplyScope {
  origin: string;
  workspaceId: string;
  operatorId: string;
}

export interface PendingReply {
  conversationId: string;
  clientId: string;
  body: string;
}

interface StoredDraft {
  body: string;
}

interface QueueDatabase {
  execSync(sql: string): void;
  runSync(sql: string, ...values: string[]): unknown;
  getAllSync<T>(sql: string, ...values: string[]): T[];
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
    body TEXT NOT NULL
  )`);
  db.execSync(`CREATE TABLE IF NOT EXISTS public_reply_draft (
    account TEXT NOT NULL,
    conversationId TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (account, conversationId)
  )`);
  const account = JSON.stringify([scope.origin, scope.workspaceId, scope.operatorId]);
  const select = "SELECT conversationId, clientId, body FROM pending_reply WHERE account = ?";
  return {
    list(conversationId?: string) {
      return conversationId === undefined
        ? db.getAllSync<PendingReply>(`${select} ORDER BY sequence`, account)
        : db.getAllSync<PendingReply>(
            `${select} AND conversationId = ? ORDER BY sequence`,
            account,
            conversationId,
          );
    },
    getDraft(conversationId: string) {
      return (
        db.getAllSync<StoredDraft>(
          "SELECT body FROM public_reply_draft WHERE account = ? AND conversationId = ?",
          account,
          conversationId,
        )[0]?.body ?? ""
      );
    },
    saveDraft(conversationId: string, body: string) {
      if (!body) {
        db.runSync(
          "DELETE FROM public_reply_draft WHERE account = ? AND conversationId = ?",
          account,
          conversationId,
        );
        return;
      }
      db.runSync(
        `INSERT INTO public_reply_draft (account, conversationId, body) VALUES (?, ?, ?)
         ON CONFLICT (account, conversationId) DO UPDATE SET body = excluded.body`,
        account,
        conversationId,
        body,
      );
    },
    enqueue(conversationId: string, body: string) {
      const clientId = newId();
      runTransaction(db, () => {
        db.runSync(
          "INSERT INTO pending_reply (account, conversationId, clientId, body) VALUES (?, ?, ?, ?)",
          account,
          conversationId,
          clientId,
          body,
        );
        db.runSync(
          "DELETE FROM public_reply_draft WHERE account = ? AND conversationId = ?",
          account,
          conversationId,
        );
      });
      return { conversationId, clientId, body };
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
      const record = db.getAllSync<PendingReply>(
        `${select} AND clientId = ?`,
        account,
        reply.clientId,
      )[0];
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
