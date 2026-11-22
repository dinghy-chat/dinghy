import { randomUUID } from "expo-crypto";
import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { openReplyQueue, type ReplyScope } from "./reply-queue";

export type { PendingReply, ReplyScope } from "./reply-queue";

let database: SQLiteDatabase | undefined;

export function createOutbox(scope: ReplyScope) {
  database ??= openDatabaseSync("operator-outbox.db");
  return openReplyQueue(database, scope, randomUUID);
}
