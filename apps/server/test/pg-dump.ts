import { spawnSync } from "node:child_process";
import pg from "pg";
import { DATABASE_URL } from "./env.ts";

/**
 * Whether this machine's pg_dump can dump the test server. pg_dump refuses a newer server, and CI's
 * runner ships an older client and installs none, so the tests that need a real dump skip there.
 * The image checks run them with a matching client.
 */
export const pgDumpWorks: boolean = await (async () => {
  const version = spawnSync("pg_dump", ["--version"], { encoding: "utf8" }).stdout ?? "";
  const clientMajor = Number(/(\d+)\./.exec(version)?.[1] ?? 0);
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ v: string }>(
      "select current_setting('server_version_num') as v",
    );
    return clientMajor >= Math.floor(Number(rows[0]?.v) / 10000);
  } finally {
    await client.end();
  }
})();
