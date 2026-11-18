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

interface QueueDatabase {
  execSync(sql: string): void;
  runSync(sql: string, ...values: string[]): unknown;
  getAllSync<T>(sql: string, ...values: string[]): T[];
}

const activeSends = new Map<string, Promise<void>>();

export function openReplyQueue(db: QueueDatabase, scope: ReplyScope, newId: () => string) {
  db.execSync(`CREATE TABLE IF NOT EXISTS pending_reply (
    sequence INTEGER PRIMARY KEY,
    account TEXT NOT NULL,
    conversationId TEXT NOT NULL,
    clientId TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
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
    enqueue(conversationId: string, body: string) {
      const clientId = newId();
      db.runSync(
        "INSERT INTO pending_reply (account, conversationId, clientId, body) VALUES (?, ?, ?, ?)",
        account,
        conversationId,
        clientId,
        body,
      );
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
