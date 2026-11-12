import { eq } from "drizzle-orm";
import { apiKey, type ReplyMode } from "../src/db/schema.ts";
import type { Database } from "../src/db/tenant.ts";

/** A new key drafts. A test of a key's direct reply sets it to send, as the keys made before did. */
export async function setReplyMode(owner: Database, keyId: string, mode: ReplyMode): Promise<void> {
  await owner.update(apiKey).set({ replyMode: mode }).where(eq(apiKey.id, keyId));
}
