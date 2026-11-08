// Prepares a database for a load test and prints the workspace's public key.
// Usage: node apps/server/load/setup.ts <superuser database URL> <allowed origin>
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { ensureRoles, ROLES } from "../src/db/roles.ts";
import { createWorkspace } from "../src/workspaces.ts";

const [url, origin] = process.argv.slice(2);
if (url === undefined || origin === undefined) throw new Error("Usage: setup.ts <url> <origin>");

const asRole = (role: string) => {
  const parsed = new URL(url);
  parsed.username = role;
  return parsed.toString();
};

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await ensureRoles(admin);
await admin.query(`ALTER DATABASE ${new URL(url).pathname.slice(1)} OWNER TO ${ROLES.migrator}`);
await admin.query(`ALTER SCHEMA public OWNER TO ${ROLES.migrator}`);
await admin.end();

const migrator = new pg.Pool({ connectionString: asRole(ROLES.migrator), max: 1 });
await migrate(drizzle(migrator), {
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
});
await migrator.end();

const app = new pg.Pool({ connectionString: asRole(ROLES.app), max: 1 });
const created = await createWorkspace(drizzle(app), "Load test", [origin]);
await app.end();
console.log(created.publicKey);
