import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { AUTH_SECRET, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";
import { loadConfig } from "./config.ts";
import { operator, workspace, workspaceMember } from "./db/schema.ts";
import { runInit, widgetSnippet } from "./install.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

const newRoot = () => mkdtemp(join(tmpdir(), "dinghy-init-"));
const read = (root: string, ...path: string[]) => readFile(join(root, ...path), "utf8");

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const folder of ["postgres", "migrate", "app", "valkey"]) {
    for (const name of await readdir(join(root, folder)).catch(() => [])) {
      files[`${folder}/${name}`] = await read(root, folder, name);
    }
  }
  return files;
}

describe("chat init", () => {
  test("each service gets only the secrets it needs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await newRoot();
    await runInit(root);
    expect((await readdir(join(root, "postgres"))).sort()).toEqual(["password"]);
    expect((await readdir(join(root, "app"))).sort()).toEqual([
      "auth_secret",
      "database_url",
      "valkey_url",
      "worker_database_url",
    ]);
    expect((await readdir(join(root, "valkey"))).sort()).toEqual(["valkey.conf"]);
    expect((await readdir(join(root, "migrate"))).sort()).toEqual([
      "admin_database_url",
      "admin_password",
      "app",
      "backup",
      "migrator",
      "valkey",
      "worker",
    ]);
    // The app's files hold no other login.
    const app = await read(root, "app", "database_url");
    expect(app).toContain("dinghy_app:");
    expect(app).not.toContain(await read(root, "migrate", "admin_password"));
    expect(app).not.toContain(await read(root, "migrate", "backup"));
  });

  test("the logins agree with each other, and every secret is different and long", async () => {
    const root = await newRoot();
    await runInit(root);
    const admin = await read(root, "migrate", "admin_password");
    expect(await read(root, "postgres", "password")).toBe(admin);
    expect(await read(root, "migrate", "admin_database_url")).toContain(`postgres:${admin}@`);
    expect(await read(root, "app", "database_url")).toContain(await read(root, "migrate", "app"));
    expect(await read(root, "app", "worker_database_url")).toContain(
      await read(root, "migrate", "worker"),
    );
    const secrets = [
      admin,
      await read(root, "migrate", "app"),
      await read(root, "migrate", "worker"),
      await read(root, "migrate", "migrator"),
      await read(root, "migrate", "backup"),
      await read(root, "app", "auth_secret"),
      await read(root, "migrate", "valkey"),
    ];
    expect(new Set(secrets).size).toBe(secrets.length);
    for (const secret of secrets) expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  test("a second run changes nothing, and two installs share nothing", async () => {
    const root = await newRoot();
    await runInit(root);
    const first = await snapshot(root);
    await runInit(root);
    expect(await snapshot(root)).toEqual(first);
    const other = await newRoot();
    await runInit(other);
    expect(await read(other, "app", "auth_secret")).not.toBe(first["app/auth_secret"]);
  });

  test("a run after a crash fills in only what is missing", async () => {
    const root = await newRoot();
    await runInit(root);
    const first = await snapshot(root);
    await rm(join(root, "app", "auth_secret"), { force: true });
    await runInit(root);
    const second = await snapshot(root);
    expect(second["migrate/admin_password"]).toBe(first["migrate/admin_password"]);
    expect(second["app/database_url"]).toBe(first["app/database_url"]);
    expect(second["app/auth_secret"]).not.toBe(first["app/auth_secret"]);
  });

  test("Valkey and the app share a password, and an older install gets one on its next start", async () => {
    const root = await newRoot();
    await runInit(root);
    // As an install from before Valkey had a password.
    await rm(join(root, "migrate", "valkey"));
    await rm(join(root, "valkey"), { recursive: true });
    await rm(join(root, "app", "valkey_url"));
    const before = await snapshot(root);
    await runInit(root);
    const after = await snapshot(root);
    for (const [name, value] of Object.entries(before)) expect(after[name]).toBe(value);
    const password = await read(root, "migrate", "valkey");
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(await read(root, "valkey", "valkey.conf")).toBe(`requirepass ${password}\n`);
    expect(await read(root, "app", "valkey_url")).toBe(`redis://:${password}@valkey:6379`);
  });

  test("Valkey's copies follow its password, even if only some volumes were lost", async () => {
    const root = await newRoot();
    await runInit(root);
    await rm(join(root, "migrate"), { recursive: true });
    await runInit(root);
    const password = await read(root, "migrate", "valkey");
    expect(await read(root, "valkey", "valkey.conf")).toBe(`requirepass ${password}\n`);
    expect(await read(root, "app", "valkey_url")).toBe(`redis://:${password}@valkey:6379`);
  });

  test("only the owner can read a secret", async () => {
    const root = await newRoot();
    await runInit(root);
    expect((await stat(join(root, "app", "auth_secret"))).mode & 0o077).toBe(0);
    expect((await stat(join(root, "migrate"))).mode & 0o077).toBe(0);
  });
});

describe("the settings", () => {
  const base = {
    DATABASE_URL: "postgres://x@db/x",
    VALKEY_URL: "redis://valkey",
    AUTH_SECRET: "a".repeat(40),
  };

  test("an empty value means not set, as Compose passes an unset one", () => {
    const config = loadConfig({ ...base, SMTP_URL: "", METRICS_TOKEN: "", TRUSTED_PROXY_HOPS: "" });
    expect(config.SMTP_URL).toBeUndefined();
    expect(config.METRICS_TOKEN).toBeUndefined();
    expect(config.TRUSTED_PROXY_HOPS).toBe(0);
  });

  test("the public address comes from the domain, and otherwise is this machine", () => {
    expect(loadConfig(base).PUBLIC_URL).toBe("http://localhost:3000");
    // The published port and the address the app gives out must agree.
    expect(loadConfig({ ...base, DINGHY_PORT: "8080" }).PUBLIC_URL).toBe("http://localhost:8080");
    expect(loadConfig({ ...base, CHAT_DOMAIN: "chat.example.com" }).PUBLIC_URL).toBe(
      "https://chat.example.com",
    );
    expect(
      loadConfig({ ...base, CHAT_DOMAIN: "a.example.com", PUBLIC_URL: "https://b.example.com" })
        .PUBLIC_URL,
    ).toBe("https://b.example.com");
  });

  test("secrets come from files, and a value in the environment wins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dinghy-secrets-"));
    await writeFile(join(directory, "database_url"), "postgres://file@db/x\n");
    await writeFile(join(directory, "auth_secret"), "b".repeat(40));
    await writeFile(join(directory, "valkey_url"), "redis://:pw@valkey:6379\n");
    const fromFile = loadConfig({ DINGHY_SECRETS_DIR: directory });
    expect(fromFile.DATABASE_URL).toBe("postgres://file@db/x");
    expect(fromFile.VALKEY_URL).toBe("redis://:pw@valkey:6379");
    expect(fromFile.AUTH_SECRET).toBe("b".repeat(40));
    expect(fromFile.WORKER_DATABASE_URL).toBeUndefined();
    const fromEnv = loadConfig({
      VALKEY_URL: "redis://v",
      DINGHY_SECRETS_DIR: directory,
      DATABASE_URL: "postgres://env@db/x",
    });
    expect(fromEnv.DATABASE_URL).toBe("postgres://env@db/x");
  });
});

describe("chat setup", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 30_000);
  afterAll(async () => {
    await database.drop();
  });

  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, "setup", ...args], {
      encoding: "utf8",
      input: "",
      env: {
        ...process.env,
        DATABASE_URL: database.url("app"),
        VALKEY_URL,
        AUTH_SECRET,
        PUBLIC_URL,
        ...env,
      },
    });
  const flags = (email: string, origin = "https://www.example.com") => [
    "--email",
    email,
    "--name",
    "Owner",
    "--workspace",
    "Acme",
    "--origin",
    origin,
  ];

  test("with no terminal, a missing answer stops it, and nothing is created", async () => {
    const owner = database.connect("migrator").db;
    const result = run(["--email", "owner@example.com"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--name");
    expect(await owner.select().from(operator)).toEqual([]);
  });

  test.each([
    ["a flag with no value", ["--name", "--email", "owner@example.com"]],
    ["an unknown flag", ["--orgin", "https://www.example.com"]],
  ])("%s stops it with a reason, and nothing is created", async (_what, args) => {
    const owner = database.connect("migrator").db;
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--name|--orgin/);
    expect(await owner.select().from(operator)).toEqual([]);
  });

  test.each([
    ["an email", "not-an-email", "https://www.example.com"],
    ["a website address", "owner@example.com", "not a site"],
  ])("a bad value for %s stops it, and nothing is created", async (_what, email, origin) => {
    const owner = database.connect("migrator").db;
    const result = run(flags(email, origin));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Nothing was created");
    expect(await owner.select().from(operator)).toEqual([]);
    expect(await owner.select().from(workspace)).toEqual([]);
  });

  test("it creates an owner and a workspace, with the push keys, and runs once", async () => {
    const owner = database.connect("migrator").db;
    const secrets = await mkdtemp(join(tmpdir(), "dinghy-setup-"));
    const email = `Owner-${randomUUID()}@Example.com`;
    const result = run(flags(email), { DINGHY_SECRETS_DIR: secrets });
    expect(result.status).toBe(0);
    // A sign-in link, not a password, and the command that makes another.
    expect(result.stdout).not.toMatch(/password/i);
    expect(result.stdout).toContain(
      `${new URL(PUBLIC_URL).origin}/v1/auth/magic-link/verify?token=`,
    );
    expect(result.stdout).toContain("It works once, for the next 15 minutes");
    expect(result.stdout).toContain(`chat sign-in-link ${email.toLowerCase()}`);
    expect(result.stdout).toContain(`${new URL(PUBLIC_URL).origin}/widget/loader.js`);
    expect(result.stdout).toContain("docker compose restart app");
    // No mail server here, so it says what that means.
    expect(result.stdout).toContain("no mail server");

    const [row] = await owner
      .select()
      .from(operator)
      .where(eq(operator.email, email.toLowerCase()));
    if (row === undefined) throw new Error("No operator");
    const members = await owner
      .select()
      .from(workspaceMember)
      .where(eq(workspaceMember.operatorId, row.id));
    expect(members.map((member) => member.role)).toEqual(["owner"]);
    const [space] = await owner.select().from(workspace);
    expect(space?.allowedOrigins).toEqual(["https://www.example.com"]);
    expect(result.stdout).toContain(`data-key="${space?.publicKey}"`);

    expect((await readFile(join(secrets, "vapid_public_key"), "utf8")).length).toBeGreaterThan(40);
    expect(await readFile(join(secrets, "vapid_subject"), "utf8")).toBe(
      `mailto:${email.toLowerCase()}`,
    );
    expect((await stat(join(secrets, "vapid_private_key"))).mode & 0o077).toBe(0);

    const again = run(flags("second@example.com"), { DINGHY_SECRETS_DIR: secrets });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already set up");
    expect(await owner.select().from(workspace)).toHaveLength(1);
  }, 30_000);
});

test("the snippet names the server and the key", () => {
  expect(widgetSnippet("https://chat.example.com", "wk_abc")).toBe(
    '<script src="https://chat.example.com/widget/loader.js" data-key="wk_abc" async></script>',
  );
});
