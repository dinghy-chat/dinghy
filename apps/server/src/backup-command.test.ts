import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { migrationsBefore } from "../test/migrations.ts";
import { pgDumpWorks } from "../test/pg-dump.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

// Needs a pg_dump that can dump the test server, which CI's runner does not have.
const dumpTest = test.skipIf(!pgDumpWorks);

let database: TestDatabase;
let server: http.Server;
let heartbeat: string;
let directory: string;
const pings: string[] = [];

/** `chat backup`, as the nightly cron runs it. */
const backup = (env: Record<string, string>) => chat("backup", env);

function chat(command: string, env: Record<string, string>, target = database) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, command], {
      env: {
        PATH: process.env.PATH,
        ADMIN_DATABASE_URL: target.adminUrl(),
        STORAGE_DIR: join(directory, "images"),
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  directory = await mkdtemp(join(tmpdir(), "dinghy-backup-command-"));
  server = http.createServer((request, response) => {
    pings.push(`${request.method} ${request.url}`);
    response.end("OK");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  heartbeat = `http://127.0.0.1:${port}/heartbeat/backup/a-secret-token`;
}, 30_000);

afterAll(async () => {
  server.close();
  await rm(directory, { recursive: true, force: true });
  await database.drop();
});

dumpTest("a backup that succeeds pings the heartbeat, without printing its address", async () => {
  pings.length = 0;
  const { code, out } = await backup({
    BACKUP_DIR: join(directory, "ok"),
    BACKUP_HEARTBEAT_URL: heartbeat,
  });
  expect(code).toBe(0);
  expect(pings).toEqual(["POST /heartbeat/backup/a-secret-token"]);
  expect(out).toContain("Pinged the backup heartbeat.");
  expect(out).not.toContain("a-secret-token");
  expect((await readdir(join(directory, "ok"))).some((name) => name.endsWith(".tar"))).toBe(true);
});

test("a backup that fails does not ping, so the heartbeat's silence raises the alert", async () => {
  pings.length = 0;
  // No pg_dump on the path, so the dump fails.
  const { code } = await backup({
    BACKUP_DIR: join(directory, "failed"),
    BACKUP_HEARTBEAT_URL: heartbeat,
    PATH: "/nonexistent",
  });
  expect(code).not.toBe(0);
  expect(pings).toEqual([]);
});

dumpTest(
  "a heartbeat that does not answer leaves the backup a success, with a warning",
  async () => {
    const { code, out } = await backup({
      BACKUP_DIR: join(directory, "unreachable"),
      // Nothing listens on port 1.
      BACKUP_HEARTBEAT_URL: "http://127.0.0.1:1/heartbeat",
    });
    expect(code).toBe(0);
    expect(out).toContain("The backup heartbeat did not answer");
  },
);

dumpTest("with no heartbeat set, a backup pings nothing", async () => {
  pings.length = 0;
  const { code } = await backup({ BACKUP_DIR: join(directory, "none") });
  expect(code).toBe(0);
  expect(pings).toEqual([]);
});

dumpTest(
  "chat migrate names the backup it takes, which is the way back to the previous release",
  async () => {
    const upgraded = await createTestDatabase();
    try {
      const first = await chat("migrate", { MIGRATIONS_DIR: await migrationsBefore() }, upgraded);
      expect(first.code).toBe(0);
      const { code, out } = await chat(
        "migrate",
        { BACKUP_DIR: join(directory, "upgrade") },
        upgraded,
      );
      expect(code).toBe(0);
      const named = /Backed up to (\S+) before migrating/.exec(out)?.[1];
      expect(await readdir(join(directory, "upgrade"))).toContain(named?.split("/").at(-1));
      expect(out).toContain('"Going back" in docs/self-hosting.md');
    } finally {
      await upgraded.drop();
    }
  },
  // Two CLI runs, every migration and a pg_dump take longer than the default under a full run.
  30_000,
);
