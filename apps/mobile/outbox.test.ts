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
      getAllSync: <T>(sql: string, ...args: string[]) => db.prepare(sql).all(...args) as T[],
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
    const reply = outbox.enqueue("conversation", "Your invoice is ready.");
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
