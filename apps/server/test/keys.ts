import { eq } from "drizzle-orm";
import { apiKey } from "../src/db/schema.ts";
import type { Database } from "../src/db/tenant.ts";

/** A new key drafts. A test of a key's direct reply makes it send, as the keys made before did. */
export async function keySends(owner: Database, keyId: string): Promise<void> {
  await owner.update(apiKey).set({ replyMode: "send" }).where(eq(apiKey.id, keyId));
}
