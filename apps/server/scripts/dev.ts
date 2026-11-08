// Runs Dinghy on this machine for development, with `bun run dev`:
// - Postgres and Valkey in Docker, from compose.dev.yaml,
// - the server and the worker at http://localhost:3000,
// - a test page with the widget at http://localhost:3001.
// With DINGHY_PORT=4000, they move to 4000 and 4001. PUBLIC_URL sets the address people open.
// Its files, such as the auth secret and the images, live in .dev/, which git ignores.
// Restart it to pick up a change in the server, the operator app or the widget.
// `bun run dev reset-password` prints a new password for owner@example.com, and exits.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { buildWidget } from "../../../packages/widget/build.ts";
import { buildOperator } from "../../operator/build.ts";
import { ensureRoles, ROLES } from "../src/db/roles.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dev = join(root, ".dev");
const NAME = "dinghy_dev";
// DINGHY_PORT moves both, when 3000 or 3001 is taken.
const PORT = Number(process.env.DINGHY_PORT ?? 3000);
const HOST_PORT = PORT + 1;
// compose.dev.yaml listens on 127.0.0.1 only, with no password.
const postgres = (user: string, database: string) =>
  `postgres://${user}@127.0.0.1:55432/${database}`;

function run(command: string, args: string[], env = process.env): void {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(" ")} failed.`);
    process.exit(1);
  }
}

console.log("==> Starting Postgres and Valkey");
run("docker", ["compose", "-f", "compose.dev.yaml", "up", "-d", "--wait"]);

console.log("==> Preparing the database");
const admin = new pg.Client({ connectionString: postgres("postgres", "postgres") });
await admin.connect();
await ensureRoles(admin);
const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [NAME]);
if (found.rowCount === 0) await admin.query(`CREATE DATABASE ${NAME} OWNER ${ROLES.migrator}`);
await admin.end();
const migrator = new pg.Pool({ connectionString: postgres(ROLES.migrator, NAME), max: 1 });
await migrate(drizzle(migrator), {
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
});
await migrator.end();

// Made once and kept, so a restart keeps you signed in. Never committed.
mkdirSync(dev, { recursive: true, mode: 0o700 });
const secretFile = join(dev, "auth-secret");
if (!existsSync(secretFile)) {
  writeFileSync(secretFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
}

console.log("==> Bundling the widget and the operator app");
await buildWidget(join(dev, "widget"));
await buildOperator(join(dev, "operator"));

const env = {
  ...process.env,
  DATABASE_URL: postgres(ROLES.app, NAME),
  WORKER_DATABASE_URL: postgres(ROLES.worker, NAME),
  VALKEY_URL: "redis://127.0.0.1:56379",
  // A tunnel's address, for testing push on a phone. The test site still loads the widget locally.
  PUBLIC_URL: process.env.PUBLIC_URL || `http://localhost:${PORT}`,
  PORT: String(PORT),
  AUTH_SECRET: readFileSync(secretFile, "utf8").trim(),
  WIDGET_DIR: join(dev, "widget"),
  OPERATOR_DIR: join(dev, "operator"),
  STORAGE_DIR: join(dev, "images"),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
};

// The first run creates the owner, and prints a new random password once.
const owner = new pg.Client({ connectionString: postgres("postgres", NAME) });
await owner.connect();
const operators = await owner.query("SELECT 1 FROM operator LIMIT 1");
if (operators.rowCount === 0) {
  console.log("==> Creating the owner");
  run(
    "node",
    [
      "apps/server/src/cli.ts",
      "setup",
      "--email",
      "owner@example.com",
      "--name",
      "Owner",
      "--workspace",
      "Dev",
      "--origin",
      `http://localhost:${HOST_PORT}`,
    ],
    env,
  );
  console.log("Save that password. `bun run dev reset-password` makes a new one.");
}
if (process.argv[2] === "reset-password") {
  run("node", ["apps/server/src/cli.ts", "reset-password", "owner@example.com"], env);
  await owner.end();
  process.exit(0);
}
const workspace = await owner.query<{ public_key: string }>(
  "SELECT public_key FROM workspace ORDER BY created_at LIMIT 1",
);
// The test site's origin follows DINGHY_PORT, so the workspace must allow the current one.
await owner.query(
  `UPDATE workspace SET allowed_origins = array_append(allowed_origins, $1)
   WHERE public_key = $2 AND NOT ($1 = ANY (allowed_origins))`,
  [`http://localhost:${HOST_PORT}`, workspace.rows[0]?.public_key ?? ""],
);
await owner.end();
const publicKey = workspace.rows[0]?.public_key ?? "";

// A host site on another origin, as a customer's site would be.
const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Dinghy test site</title></head>
<body style="font-family: system-ui; padding: 2rem">
<h1>A test site</h1>
<p>The chat button is in the corner. Its messages reach the operator app at http://localhost:${PORT}.</p>
<script src="http://localhost:${PORT}/widget/loader.js" data-key="${publicKey}" async></script>
</body>
</html>`;
const host = http.createServer((_, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});
host.listen(HOST_PORT, "127.0.0.1");

console.log(`\n==> Operator app: http://localhost:${PORT} (owner@example.com)`);
console.log(`==> Test site with the widget: http://localhost:${HOST_PORT}\n`);

const server = spawn("node", ["apps/server/src/main.ts", "all"], {
  cwd: root,
  env,
  stdio: "inherit",
});
const stop = () => {
  host.close();
  server.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => process.exit(code ?? 0));
