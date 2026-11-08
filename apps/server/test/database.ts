import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { ROLES, type RoleName } from "../src/db/roles.ts";
import * as schema from "../src/db/schema.ts";
import type { Database } from "../src/db/tenant.ts";
import { DATABASE_URL } from "./env.ts";
import { MIGRATIONS } from "./migrations.ts";

export interface TestDatabase {
  connect(role: RoleName, max?: number): { db: Database; pool: pg.Pool };
  /** A role from global-setup that has a normal role's grants and bypasses row-level security. */
  connectBypass(kind: "app" | "worker"): Database;
  url(role: RoleName): string;
  /** The superuser login, on this test's database. */
  adminUrl(): string;
  migrate(): Promise<void>;
  drop(): Promise<void>;
}

/** Creates an empty database, owned by the migrator role, for one test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `dinghy_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} OWNER ${ROLES.migrator}`);
  const pools: pg.Pool[] = [];

  const roleUrl = (role: RoleName) => {
    const url = new URL(DATABASE_URL);
    url.username = ROLES[role];
    url.pathname = `/${name}`;
    return url.toString();
  };

  const connect = (role: RoleName, max = 5) => {
    const pool = new pg.Pool({ connectionString: roleUrl(role), max });
    pools.push(pool);
    return { db: drizzle(pool, { schema }), pool };
  };

  return {
    connect,
    connectBypass(kind) {
      const url = new URL(DATABASE_URL);
      url.username = `dinghy_test_${kind}_bypass`;
      url.pathname = `/${name}`;
      const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
      pools.push(pool);
      return drizzle(pool, { schema });
    },
    url: roleUrl,
    adminUrl() {
      const url = new URL(DATABASE_URL);
      url.pathname = `/${name}`;
      return url.toString();
    },
    async migrate() {
      await migrate(connect("migrator", 1).db, { migrationsFolder: MIGRATIONS });
    },
    async drop() {
      await Promise.all(pools.map((pool) => pool.end()));
      // pool.end() returns before its connections have closed, so wait for them to go.
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.query(`DROP DATABASE ${name}`);
          break;
        } catch (error) {
          if (attempt === 100 || (error as { code?: string }).code !== "55006") throw error;
          await delay(20);
        }
      }
      await admin.end();
    },
  };
}
