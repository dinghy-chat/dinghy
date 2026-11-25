import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { openReplyQueue } from "./reply-queue";

const scope = { origin: "https://operator.example", workspaceId: "support", operatorId: "kim" };

function queue(db: DatabaseSync, account = scope) {
  return openReplyQueue(
    {
      execSync: (sql) => db.exec(sql),
      runSync: (sql, ...args) => db.prepare(sql).run(...args),
      getAllSync: <T>(sql: string, ...args: (string | null)[]) =>
        db.prepare(sql).all(...args) as T[],
    },
    account,
    randomUUID,
  );
}

test("a lost acknowledgement and app restart retry the stored reply with its original ID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dinghy-outbox-"));
  const path = join(directory, "outbox.db");
  let db = new DatabaseSync(path);
  try {
    const outbox = queue(db);
    outbox.saveDraft("conversation", "Your invoice is ready.");
    const reply = outbox.enqueue("conversation", "Your invoice is ready.", "message-to-quote");
    const committed = new Set<string>();
    await expect(
      outbox.deliver(reply, async (record) => {
        committed.add(record.clientId);
        throw new Error("connection closed before acknowledgement");
      }),
    ).rejects.toThrow("acknowledgement");
    db.close();
    db = new DatabaseSync(path);
    const restored = queue(db);
    expect(restored.list()).toEqual([reply]);
    expect(reply.replyToMessageId).toBe("message-to-quote");
    expect(restored.getDraft("conversation")).toBe("");
    const post = vi.fn(async (record: typeof reply) => {
      committed.add(record.clientId);
    });
    await Promise.all([restored.deliver(reply, post), restored.deliver(reply, post)]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(committed.size).toBe(1);
    expect(restored.list()).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

test("another operator, workspace or instance cannot see or deliver the reply", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const reply = queue(db).enqueue("conversation", "Account-specific message");
    const post = vi.fn(async () => {});
    for (const account of [
      { ...scope, operatorId: "jo" },
      { ...scope, workspaceId: "sales" },
      { ...scope, origin: "https://team.example" },
    ]) {
      const other = queue(db, account);
      expect(other.list()).toEqual([]);
      await other.deliver(reply, post);
      other.discard(reply);
    }
    expect(post).not.toHaveBeenCalled();
    expect(queue(db).list("conversation")).toEqual([reply]);
    expect(queue(db).discard(reply)).toBe(true);
    expect(queue(db).list()).toEqual([]);
  } finally {
    db.close();
  }
});

test("an unsent draft survives remount and remains scoped to its conversation and account", () => {
  const directory = mkdtempSync(join(tmpdir(), "dinghy-draft-"));
  const path = join(directory, "outbox.db");
  let db = new DatabaseSync(path);
  try {
    queue(db).saveDraft("conversation", "I will check that for you.");
    db.close();
    db = new DatabaseSync(path);

    expect(queue(db).getDraft("conversation")).toBe("I will check that for you.");
    expect(queue(db).getDraft("other-conversation")).toBe("");
    for (const account of [
      { ...scope, operatorId: "jo" },
      { ...scope, workspaceId: "sales" },
      { ...scope, origin: "https://team.example" },
    ]) {
      expect(queue(db, account).getDraft("conversation")).toBe("");
    }
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

test("enqueue stores the reply and clears its draft in one transaction", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const outbox = queue(db);
    outbox.saveDraft("conversation", "Draft reply");

    const reply = outbox.enqueue("conversation", "Draft reply");

    expect(outbox.list()).toEqual([reply]);
    expect(outbox.getDraft("conversation")).toBe("");
  } finally {
    db.close();
  }
});

test("a failed enqueue rolls back without losing the draft", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const outbox = queue(db);
    outbox.saveDraft("conversation", "Do not lose this");
    db.exec(`CREATE TRIGGER reject_draft_delete
      BEFORE DELETE ON public_reply_draft
      BEGIN
        SELECT RAISE(ABORT, 'simulated clear failure');
      END`);

    expect(() => outbox.enqueue("conversation", "Do not lose this")).toThrow(
      "simulated clear failure",
    );
    expect(outbox.getDraft("conversation")).toBe("Do not lose this");
    expect(outbox.list()).toEqual([]);
  } finally {
    db.close();
  }
});

test("a new edit after enqueue becomes the next durable draft", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const outbox = queue(db);
    outbox.saveDraft("conversation", "First reply");
    outbox.enqueue("conversation", "First reply");

    outbox.saveDraft("conversation", "Follow-up written while delivery finishes");

    expect(outbox.getDraft("conversation")).toBe("Follow-up written while delivery finishes");
  } finally {
    db.close();
  }
});

test("clearing a draft is durable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const outbox = queue(db);
    outbox.saveDraft("conversation", "Temporary text");
    outbox.saveDraft("conversation", "");

    expect(queue(db).getDraft("conversation")).toBe("");
  } finally {
    db.close();
  }
});

test("a failed draft update keeps the last durable text", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const outbox = queue(db);
    outbox.saveDraft("conversation", "Last durable text");
    db.exec(`CREATE TRIGGER reject_draft_update
      BEFORE UPDATE ON public_reply_draft
      BEGIN
        SELECT RAISE(ABORT, 'simulated storage failure');
      END`);

    expect(() => outbox.saveDraft("conversation", "Text still visible in the composer")).toThrow(
      "simulated storage failure",
    );
    expect(outbox.getDraft("conversation")).toBe("Last durable text");
  } finally {
    db.close();
  }
});

test("an existing outbox adds the reply relation and the card without losing queued messages", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE pending_reply (
      sequence INTEGER PRIMARY KEY,
      account TEXT NOT NULL,
      conversationId TEXT NOT NULL,
      clientId TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL
    )`);
    const account = JSON.stringify([scope.origin, scope.workspaceId, scope.operatorId]);
    db.prepare(
      "INSERT INTO pending_reply (account, conversationId, clientId, body) VALUES (?, ?, ?, ?)",
    ).run(account, "conversation", "old-client", "Already queued");

    expect(queue(db).list()).toEqual([
      {
        conversationId: "conversation",
        clientId: "old-client",
        body: "Already queued",
        replyToMessageId: null,
        linkPreview: null,
      },
    ]);
  } finally {
    db.close();
  }
});

test("a reply's link card survives a restart and goes with the retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dinghy-outbox-"));
  const path = join(directory, "outbox.db");
  let db = new DatabaseSync(path);
  try {
    const card = {
      url: "https://docs.example/reset",
      title: "Reset your password",
      image: { data: "data:image/webp;base64,AAAA", width: 112, height: 112 },
      token: "signed",
    };
    const reply = queue(db).enqueue("conversation", "See https://docs.example/reset", null, card);
    db.close();
    db = new DatabaseSync(path);
    const restored = queue(db);
    expect(restored.list()).toEqual([{ ...reply, linkPreview: card }]);
    const post = vi.fn(async (_record: typeof reply) => {});
    await restored.deliver(reply, post);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ linkPreview: card }));
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});
