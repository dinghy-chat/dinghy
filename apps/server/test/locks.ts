import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type { Database } from "../src/db/tenant.ts";

/**
 * Resolves once this many connections to this test's database wait on a lock, so a race test knows
 * its requests raced. It throws when they never do, where a fixed sleep would let the test pass alone.
 */
export async function untilWaiting(db: Database, count = 1, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await db.execute<{ waiting: number }>(
      // pg_stat_activity hides another role's wait state, and pg_locks does not.
      sql`select count(distinct l.pid)::int as waiting from pg_locks l
        join pg_stat_activity a on a.pid = l.pid
        where not l.granted and a.datname = current_database()`,
    );
    if ((result.rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`Fewer than ${count} requests waited for the lock`);
    await delay(10);
  }
}
