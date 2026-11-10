import pg from "pg";
import { ensureRoles } from "../src/db/roles.ts";
import { DATABASE_URL } from "./env.ts";

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect().catch((error: unknown) => {
    throw new Error(
      `The tests need Postgres at ${DATABASE_URL}, and it did not answer. Start the test services with \`bun run dev:services\`.`,
      { cause: error },
    );
  });
  try {
    await ensureRoles(admin);
    // The isolation suite runs as these. Row-level security would hide a missing workspace filter,
    // so each one has its normal role's grants and bypasses the policies.
    await admin.query(`
      DO $$
      DECLARE pair text[];
      BEGIN
        FOREACH pair SLICE 1 IN ARRAY ARRAY[
          ['dinghy_test_app_bypass', 'dinghy_app'],
          ['dinghy_test_worker_bypass', 'dinghy_worker']
        ] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = pair[1]) THEN
            EXECUTE format('CREATE ROLE %I LOGIN BYPASSRLS IN ROLE %I', pair[1], pair[2]);
          END IF;
        END LOOP;
      END $$`);
  } finally {
    await admin.end();
  }
}
