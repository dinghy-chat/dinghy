import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The users the Postgres, Valkey and app images run as.
const POSTGRES_USER = 70;
const VALKEY_USER = 999;
const APP_USER = 1000;
const DATABASE_HOST = "postgres";
const DATABASE_NAME = "dinghy";

const newSecret = (bytes = 32) => randomBytes(bytes).toString("hex");

async function exists(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  });
}

/** Writes through a new name, so a crash cannot leave half a secret. Only its owner can read it. */
async function writeSecret(path: string, value: string, owner: number): Promise<void> {
  const partial = `${path}.partial`;
  await writeFile(partial, value, { mode: 0o400, flag: "w" });
  if (process.getuid?.() === 0) await chown(partial, owner, owner);
  await rename(partial, path);
}

/** Returns the stored value, and creates it only if it is missing, so a rerun changes nothing. */
async function keep(path: string, owner: number, make: () => string): Promise<string> {
  const found = await exists(path);
  if (found !== null) return found.trim();
  const value = make();
  await writeSecret(path, value, owner);
  return value;
}

/** Writes a value made from another secret, unless the file already holds it. */
async function follow(path: string, owner: number, value: string): Promise<void> {
  if ((await exists(path)) !== value) await writeSecret(path, value, owner);
}

async function ownedDirectory(path: string, owner: number): Promise<void> {
  await mkdir(path, { recursive: true });
  if (process.getuid?.() === 0) await chown(path, owner, owner);
  await chmod(path, 0o700);
}

/**
 * Writes the infrastructure secrets, before anything else starts, because Postgres cannot initialize
 * with no password. Each service gets a directory of its own, so the app never holds the admin's
 * password or the backup role's. It does nothing to a secret that exists.
 */
export async function runInit(root: string): Promise<number> {
  const postgres = join(root, "postgres");
  const migrate = join(root, "migrate");
  const app = join(root, "app");
  const valkey = join(root, "valkey");
  await ownedDirectory(postgres, POSTGRES_USER);
  await ownedDirectory(valkey, VALKEY_USER);
  await ownedDirectory(migrate, APP_USER);
  await ownedDirectory(app, APP_USER);

  // The file names in migrate are the ones chat migrate reads.
  const before = (await exists(join(migrate, "admin_password"))) === null;
  const adminPassword = await keep(join(migrate, "admin_password"), APP_USER, newSecret);
  await keep(join(postgres, "password"), POSTGRES_USER, () => adminPassword);
  const appPassword = await keep(join(migrate, "app"), APP_USER, newSecret);
  const workerPassword = await keep(join(migrate, "worker"), APP_USER, newSecret);
  await keep(join(migrate, "migrator"), APP_USER, newSecret);
  await keep(join(migrate, "backup"), APP_USER, newSecret);
  await keep(
    join(migrate, "admin_database_url"),
    APP_USER,
    () => `postgres://postgres:${adminPassword}@${DATABASE_HOST}:5432/${DATABASE_NAME}`,
  );
  const url = (role: string, password: string) =>
    `postgres://${role}:${password}@${DATABASE_HOST}:5432/${DATABASE_NAME}`;
  await keep(join(app, "database_url"), APP_USER, () => url("dinghy_app", appPassword));
  await keep(join(app, "worker_database_url"), APP_USER, () =>
    url("dinghy_worker", workerPassword),
  );
  await keep(join(app, "auth_secret"), APP_USER, newSecret);
  // An install from before Valkey had a password gets one here, on its next start. Valkey saves
  // nothing, so its two copies always follow this one, even if only some volumes were lost.
  const valkeyPassword = await keep(join(migrate, "valkey"), APP_USER, newSecret);
  await follow(join(valkey, "valkey.conf"), VALKEY_USER, `requirepass ${valkeyPassword}\n`);
  await follow(join(app, "valkey_url"), APP_USER, `redis://:${valkeyPassword}@valkey:6379`);
  console.log(before ? "Wrote the secrets." : "The secrets are already there.");
  return 0;
}

export interface SetupAnswers {
  email: string;
  name: string;
  workspace: string;
  origin: string;
}

/** The widget's tag, as a site pastes it. */
export const widgetSnippet = (publicUrl: string, publicKey: string) =>
  `<script src="${new URL("/widget/loader.js", publicUrl).href}" data-key="${publicKey}" async></script>`;

/** Saves the push keys next to the app's other secrets, where it reads them when it starts. */
export async function writePushKeys(
  directory: string,
  keys: { publicKey: string; privateKey: string },
  subject: string,
): Promise<void> {
  for (const [name, value] of [
    ["vapid_public_key", keys.publicKey],
    ["vapid_private_key", keys.privateKey],
    ["vapid_subject", subject],
  ] as const) {
    await writeSecret(join(directory, name), value, APP_USER);
  }
}
