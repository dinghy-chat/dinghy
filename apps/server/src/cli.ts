// The `chat` command. It runs on the server, with the same settings as the app.
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, constants, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Redis } from "iovalkey";
import pg from "pg";
import { pino } from "pino";
import { generateVAPIDKeys } from "web-push";
import { z } from "zod";
import { freeWorkspace, signupsCsv } from "../../../ee/server/index.ts";
import { BadArchiveError } from "./archive.ts";
import { audit } from "./audit.ts";
import { type Auth, createAuth, LINK_MINUTES, signInLink } from "./auth.ts";
import {
  BackupKeyError,
  createBackup,
  generateBackupKeys,
  SECRET_FILES,
  stageFiles,
  unpackBackup,
  uploadBackup,
} from "./backup.ts";
import { type Config, loadConfig } from "./config.ts";
import {
  lastMigrationTag,
  restoreDatabase,
  roleUrl,
  runDump,
  runMigrations,
  UnsupportedVersionError,
} from "./db/migrate.ts";
import { ROLES, type RoleName } from "./db/roles.ts";
import * as schema from "./db/schema.ts";
import { type Database, enterWorkspace, withWorkspace } from "./db/tenant.ts";
import { normalizeOrigin } from "./identity.ts";
import { runInit, type SetupAnswers, widgetSnippet, writePushKeys } from "./install.ts";
import { createSignals } from "./live.ts";
import { type ObjectStore, storeFromConfig } from "./storage.ts";
import { setSuspended, signalSuspension } from "./suspension.ts";
import { exportArchive, ImportError, importArchive } from "./transfer.ts";
import { resetTwoFactor } from "./two-factor.ts";
import { createWorkspace, insertWorkspace, workspaceKeys, workspacesTable } from "./workspaces.ts";

// Update this when a release stops supporting a direct upgrade from older data. Zero means any.
const OLDEST_SUPPORTED_MIGRATION = 0;

const USAGE = `Usage:
  chat sign-in-link <email>
      Prints a sign-in link for an operator. It works once, for 15 minutes. This works with no
      mail server.
  chat two-factor-reset <email>
      Turns off two-step sign-in for an operator who lost their authenticator app and their
      recovery codes, and ends their sessions. Check first that the request comes from them.
  chat export <workspace-id> <file.tar>
      Writes a workspace's data and images to one file. The signing secret stays out of it.
  chat import <file.tar>
      Adds an exported workspace to this server. It refuses a workspace that is already here.
      The workspace gets a new signing secret, which an owner sees in Settings.
  chat migrate
      Creates the database roles and runs pending migrations under a lock. On an install that holds
      data, it takes a backup first. It reads ADMIN_DATABASE_URL, and ROLE_SECRETS_DIR for passwords.
  chat backup
      Writes the database, images and app secrets to one private file in BACKUP_DIR. With
      BACKUP_S3_BUCKET set, it also uploads a copy that only the backup private key can open. With
      BACKUP_HEARTBEAT_URL set, it then pings that address, so a monitor can alert when a night has no
      backup. Run it with the same settings as chat migrate.
  chat restore <file>
      Replaces this server's data with a backup. Stop the app first. A failure leaves the old data.
      An encrypted backup needs BACKUP_PRIVATE_KEY.
  chat backup-key
      Makes a new key pair for the remote copy, and prints the private key once.
  chat init
      For the install's init service: writes the secrets, and leaves existing ones alone.
  chat setup [--email <email>] [--name <name>] [--workspace <name>] [--origin <https://site>]
      Creates the owner, the workspace and the web push keys, and prints the widget snippet. It asks
      for anything you leave out. It runs once.
  chat signups
      For the cloud: prints CSV of the owners of workspaces that wait for the cloud to open, with
      email, name, workspace and signup time. An account that has not created its workspace yet is
      not listed. Run it with the same settings as chat migrate.
  chat workspaces
      Lists each workspace's ID, public key, state and name. The export and suspend commands take
      the ID. Run it with the same settings as chat migrate.
  chat suspend <workspace-id> [reason]
      Stops a workspace: nobody can send or upload, its widget goes off and its open chats close.
      Its operators can still sign in and read, and see a banner. The reason is for you, and they do
      not see it. Run it with the same settings as chat migrate.
  chat unsuspend <workspace-id>
      Lifts a suspension.
  chat free <workspace-id>
      For the cloud: turns on a workspace that never pays, with no Stripe subscription. It keeps
      the plan's limits. It refuses a workspace that has a subscription.
  chat push-keys
      For development: prints new VAPID keys for web push. Changing the keys ends every device's
      subscription, so make them once.
  chat create-operator <email> <name> [--workspace <name> --origin <https://site>]
      For development: creates an operator, and optionally a workspace that it owns, and prints a
      sign-in link.`;

/** How a link is shown: it works once and soon, so the command to make another comes with it. */
function printLink(url: string, email: string): void {
  console.log(`Sign in with this link. It works once, for the next ${LINK_MINUTES} minutes:`);
  console.log(url);
  console.log(`For a new one, run: chat sign-in-link ${email}`);
}

interface AdminSettings {
  adminUrl: string;
  passwords: Awaited<ReturnType<typeof readRolePasswords>>;
  migrationsFolder: string;
  appSecrets: string | undefined;
  backupDirectory: string;
  /** Undefined when images are in a bucket, whose own durability protects them. */
  imagesDirectory: string | undefined;
  withAdmin<T>(work: (client: pg.Client) => Promise<T>): Promise<T>;
  /** Writes a local backup and returns its path. */
  backup(): Promise<string>;
}

async function withDatabase<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** These run with the admin login, before the app's settings exist, so they read their own. */
async function adminSettings(): Promise<AdminSettings | null> {
  const secretsDirectory = process.env.ROLE_SECRETS_DIR;
  const adminUrl =
    process.env.ADMIN_DATABASE_URL ??
    (secretsDirectory === undefined
      ? undefined
      : (await readFile(join(secretsDirectory, "admin_database_url"), "utf8")).trim());
  if (adminUrl === undefined) return null;
  // Only the owner can read a dump.
  process.umask(0o077);
  const passwords = await readRolePasswords(secretsDirectory);
  const migrationsFolder =
    process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../drizzle", import.meta.url));
  const appSecrets = process.env.APP_SECRETS_DIR;
  const backupDirectory = process.env.BACKUP_DIR ?? "/data/backups";
  // Images in a bucket are not in a backup, and that bucket's own durability protects them.
  const imagesDirectory = process.env.S3_BUCKET
    ? undefined
    : (process.env.STORAGE_DIR ?? "/data/images");
  const withAdmin = <T>(work: (client: pg.Client) => Promise<T>) => withDatabase(adminUrl, work);
  const backup = async () =>
    createBackup({
      dump: (file) => runDump({ url: roleUrl(adminUrl, "backup", passwords.backup), file }),
      directory: backupDirectory,
      secretsDirectory: appSecrets,
      imagesDirectory,
      lastMigration: await withAdmin((client) => lastMigrationTag(client, migrationsFolder)),
    });
  return {
    adminUrl,
    passwords,
    migrationsFolder,
    appSecrets,
    backupDirectory,
    imagesDirectory,
    withAdmin,
    backup,
  };
}

async function operate(
  command:
    | "migrate"
    | "backup"
    | "restore"
    | "backup-key"
    | "signups"
    | "workspaces"
    | "suspend"
    | "unsuspend"
    | "free",
  args: string[],
): Promise<number> {
  const admin = await adminSettings();
  if (admin === null) {
    console.error("Set ADMIN_DATABASE_URL, or ROLE_SECRETS_DIR with an admin_database_url file.");
    return 2;
  }
  switch (command) {
    case "signups":
      process.stdout.write(await admin.withAdmin(signupsCsv));
      return 0;
    case "workspaces":
      process.stdout.write(await admin.withAdmin(workspacesTable));
      return 0;
    case "suspend":
    case "unsuspend":
      return suspendCommand(admin, args, command === "suspend");
    case "free":
      return freeCommand(admin, args);
    case "backup-key":
      return backupKeyCommand(admin);
    case "backup":
      return backupCommand(admin);
    case "restore":
      return restoreCommand(admin, args);
    case "migrate":
      return migrateCommand(admin);
  }
}

async function suspendCommand(
  { withAdmin, appSecrets }: AdminSettings,
  args: string[],
  suspend: boolean,
): Promise<number> {
  const [workspaceId, ...words] = args;
  if (workspaceId === undefined || !z.uuid().safeParse(workspaceId).success) {
    console.error(USAGE);
    return 2;
  }
  const reason = words.join(" ").trim() || null;
  const found = await withAdmin((client) =>
    setSuspended(client, workspaceId, suspend, suspend ? reason : null),
  );
  if (!found) {
    console.error(`No workspace has the ID ${workspaceId}.`);
    return 1;
  }
  // The migrate service reads the app's Valkey login from the app's secrets, which hold its password.
  const valkeyUrl =
    process.env.VALKEY_URL ||
    (appSecrets === undefined
      ? undefined
      : await readFile(join(appSecrets, "valkey_url"), "utf8").then(
          (url) => url.trim(),
          () => undefined,
        ));
  if (valkeyUrl) {
    const publisher = new Redis(valkeyUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    publisher.on("error", () => {});
    const logger = pino({ level: "silent" });
    signalSuspension(createSignals(publisher, logger), workspaceId, suspend);
    // The publishes are queued on the connection, so quit sends them before it closes.
    await publisher.quit().catch(() => undefined);
  }
  console.log(
    suspend
      ? valkeyUrl
        ? `Suspended ${workspaceId}. Its open chats close now.`
        : `Suspended ${workspaceId}. Without VALKEY_URL, its open chats close within 15 minutes.`
      : `Lifted the suspension of ${workspaceId}.`,
  );
  return 0;
}

async function freeCommand({ withAdmin }: AdminSettings, args: string[]): Promise<number> {
  const [workspaceId] = args;
  if (workspaceId === undefined || args.length > 1 || !z.uuid().safeParse(workspaceId).success) {
    console.error(USAGE);
    return 2;
  }
  const result = await withAdmin((client) => freeWorkspace(client, workspaceId));
  if (result === "missing") {
    console.error(`No workspace has the ID ${workspaceId}.`);
    return 1;
  }
  if (result === "subscribed") {
    console.error(`${workspaceId} has a Stripe subscription, so it stays as it is.`);
    return 1;
  }
  console.log(`${workspaceId} is on, for free.`);
  return 0;
}

async function backupKeyCommand({ withAdmin }: AdminSettings): Promise<number> {
  const keys = generateBackupKeys();
  await withAdmin((client) => saveBackupKey(client, keys.publicKey));
  console.log(`Backup private key, shown only now: ${keys.privateKey}`);
  console.log("Keep it away from this server. Nothing can open a remote backup without it.");
  return 0;
}

async function backupCommand(admin: AdminSettings): Promise<number> {
  const code = await writeBackup(admin);
  if (code === 0) await pingHeartbeat();
  return code;
}

/**
 * Tells an outside monitor that the backup worked, so its silence is the alert. The address can hold
 * a token, so it is never printed. A monitor that does not answer does not fail the backup.
 */
async function pingHeartbeat(): Promise<void> {
  const url = process.env.BACKUP_HEARTBEAT_URL;
  if (!url) return;
  const failed = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) }).then(
    (response) => (response.ok ? null : `status ${response.status}`),
    () => "no answer",
  );
  if (failed === null) console.log("Pinged the backup heartbeat.");
  else console.error(`The backup heartbeat did not answer (${failed}). The backup itself worked.`);
}

async function writeBackup({ withAdmin, backup }: AdminSettings): Promise<number> {
  const file = await backup();
  console.log(`Wrote ${file}.`);
  console.log("A backup on this disk does not survive the loss of this disk.");
  const bucket = process.env.BACKUP_S3_BUCKET;
  if (bucket === undefined || bucket === "") return 0;
  const publicKey = await withAdmin(readBackupKey);
  if (publicKey === null) {
    console.error("There is no backup key. Run chat backup-key, then run this again.");
    return 1;
  }
  const { BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY } = process.env;
  if (!BACKUP_S3_ENDPOINT || !BACKUP_S3_ACCESS_KEY_ID || !BACKUP_S3_SECRET_ACCESS_KEY) {
    console.error(
      "BACKUP_S3_BUCKET needs BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY.",
    );
    return 1;
  }
  const name = await uploadBackup(file, publicKey, {
    endpoint: BACKUP_S3_ENDPOINT,
    bucket,
    region: process.env.BACKUP_S3_REGION || "auto",
    accessKeyId: BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: BACKUP_S3_SECRET_ACCESS_KEY,
  });
  console.log(`Uploaded an encrypted copy: ${name}`);
  return 0;
}

async function restoreCommand(
  {
    adminUrl,
    passwords,
    migrationsFolder,
    appSecrets,
    backupDirectory,
    imagesDirectory,
    withAdmin,
  }: AdminSettings,
  args: string[],
): Promise<number> {
  const [file] = args;
  if (file === undefined) {
    console.error(USAGE);
    return 2;
  }
  try {
    await access(file, constants.R_OK);
  } catch {
    console.error(
      `Nothing was restored. This command cannot read ${file}. Check the path, and that user ${process.getuid?.()} can read the file.`,
    );
    return 1;
  }
  const work = await mkdtemp(join(backupDirectory, ".restore-"));
  try {
    const unpacked = await unpackBackup(file, work, process.env.BACKUP_PRIVATE_KEY || undefined);
    let applied = 0;
    const secrets =
      appSecrets === undefined
        ? null
        : await stageFiles(unpacked.secretsPath, appSecrets, SECRET_FILES);
    const images =
      unpacked.manifest.storage === "local" && imagesDirectory !== undefined
        ? await stageFiles(unpacked.imagesPath, imagesDirectory).catch(async (error) => {
            await secrets?.abort();
            throw error;
          })
        : null;
    try {
      await restoreDatabase({
        adminUrl,
        dumpFile: unpacked.dumpPath,
        passwords,
        prepare: async (restoredUrl) => {
          // This server's key wins, because it may have replaced a lost or leaked one.
          const currentKey = await withAdmin(readBackupKey);
          // A backup from an older release catches up here. It needs no second backup.
          const result = await runMigrations({
            adminUrl: restoredUrl,
            migrationsFolder,
            passwords,
            backup: async () => {},
            oldestSupported: OLDEST_SUPPORTED_MIGRATION,
          });
          applied = result.applied;
          if (currentKey !== null) {
            await withDatabase(restoredUrl, (client) => saveBackupKey(client, currentKey));
          }
        },
        commit: async () => {
          // Secrets first, because a bind-mounted one is the rename that can fail.
          await secrets?.commit();
          await images?.commit();
        },
      });
    } catch (error) {
      await images?.abort();
      await secrets?.abort();
      throw error;
    }
    if (unpacked.manifest.storage === "local") {
      if (imagesDirectory === undefined) {
        console.log(
          "This backup holds local images, and this server uses a bucket, so they stay unused.",
        );
      }
    } else if (imagesDirectory !== undefined) {
      console.log(
        "This backup's images are in a bucket. Set S3_BUCKET and its settings to reach them.",
      );
    }
    console.log(
      `Restored the backup from ${unpacked.manifest.createdAt}, with ${images?.count ?? 0} images and ${applied} new migrations. Start the app.`,
    );
    return 0;
  } catch (error) {
    if (
      error instanceof BackupKeyError ||
      error instanceof BadArchiveError ||
      error instanceof UnsupportedVersionError
    ) {
      console.error(`Nothing was restored. ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function migrateCommand({
  adminUrl,
  migrationsFolder,
  passwords,
  backup,
}: AdminSettings): Promise<number> {
  try {
    const result = await runMigrations({
      adminUrl,
      migrationsFolder,
      passwords,
      // The way back from this release, so it says where it is.
      backup: async () => {
        const file = await backup();
        console.log(
          `Backed up to ${file} before migrating. To go back to the previous release, restore this file. See "Going back" in docs/self-hosting.md.`,
        );
      },
      oldestSupported: OLDEST_SUPPORTED_MIGRATION,
    });
    console.log(
      result.applied === 0
        ? "The database is up to date."
        : `Ran ${result.applied} migrations${result.backedUp ? ", after a backup" : ""}.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UnsupportedVersionError) {
      console.error(`Nothing was changed. ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** The public key of the remote copy. Only the private key's holder can open that copy. */
const BACKUP_KEY_SETTING = "backup_public_key";

async function saveBackupKey(client: pg.ClientBase, publicKey: string): Promise<void> {
  await client.query(
    `INSERT INTO instance_setting (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [BACKUP_KEY_SETTING, publicKey],
  );
}

async function readBackupKey(client: pg.ClientBase): Promise<string | null> {
  // A clean host that has not run a migration yet has no table to read.
  const table = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('instance_setting') IS NOT NULL AS exists",
  );
  if (!table.rows[0]?.exists) return null;
  const found = await client.query<{ value: string }>(
    "SELECT value FROM instance_setting WHERE key = $1",
    [BACKUP_KEY_SETTING],
  );
  return found.rows[0]?.value ?? null;
}

/** One file per role, as the install's init step writes them. A missing file sets no password. */
async function readRolePasswords(
  directory: string | undefined,
): Promise<Partial<Record<RoleName, string>>> {
  if (directory === undefined) return {};
  const passwords: Partial<Record<RoleName, string>> = {};
  for (const role of Object.keys(ROLES) as RoleName[]) {
    // Only a missing file means no password. A file it cannot read must stop the run.
    const value = await readFile(join(directory, role), "utf8").catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "ENOENT") return null;
      throw error;
    });
    if (value !== null) passwords[role] = value.trim();
  }
  return passwords;
}

/**
 * Reads `--name value` and `--name=value` flags. An unknown flag, or one with no value, prints why
 * and returns null, so `--name --email a@b.c` cannot set the name to `--email`.
 */
function readFlags<const Name extends string>(
  args: string[],
  names: readonly Name[],
): Partial<Record<Name, string>> | null {
  try {
    const { values } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
    });
    const flags: Partial<Record<Name, string>> = {};
    for (const name of names) {
      const value = values[name];
      if (typeof value === "string") flags[name] = value;
    }
    return flags;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** The flags, and a question for each one left out when someone is at a terminal. */
async function readSetupAnswers(args: string[]): Promise<SetupAnswers | null> {
  const flags = readFlags(args, ["email", "name", "workspace", "origin"]);
  if (flags === null) return null;
  const ask = async (name: keyof typeof flags, question: string): Promise<string | null> => {
    const given = flags[name];
    if (given !== undefined) return given;
    if (!process.stdin.isTTY) {
      console.error(`Pass --${name}, because this has no terminal to ask at.`);
      return null;
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await prompt.question(`${question} `)).trim();
    prompt.close();
    return answer;
  };
  const email = await ask("email", "Your email:");
  if (email === null) return null;
  const name = await ask("name", "Your name:");
  if (name === null) return null;
  const workspace = await ask("workspace", "Your company or product name:");
  if (workspace === null) return null;
  const origin = await ask("origin", "Your website's address, such as https://www.example.com:");
  if (origin === null) return null;
  const check = z.object({
    email: z.email(),
    name: z.string().min(1).max(200),
    workspace: z.string().min(1).max(200),
  });
  if (!check.safeParse({ email, name, workspace }).success || normalizeOrigin(origin) === null) {
    console.error("Nothing was created. Check the email, the names and the website's address.");
    return null;
  }
  return { email, name, workspace, origin };
}

async function transfer(
  db: Database,
  store: ObjectStore,
  command: "export" | "import",
  args: string[],
): Promise<number> {
  if (command === "export") {
    const [workspaceId, file] = args;
    if (workspaceId === undefined || file === undefined) {
      console.error(USAGE);
      return 2;
    }
    // A partial name, so a failure cannot leave something that looks like a whole export.
    const partial = `${file}.partial`;
    try {
      await pipeline(
        Readable.from(exportArchive(db, store, workspaceId)),
        createWriteStream(partial, { mode: 0o600 }),
      );
      await rename(partial, file);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    console.log(`Wrote ${file}. It holds personal data, so keep it private.`);
    return 0;
  }
  const [file] = args;
  if (file === undefined) {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await importArchive(db, store, createReadStream(file));
    console.log(
      `Imported ${result.name} (${result.workspaceId}): ${result.conversations} conversations, ${result.messages} messages, ${result.uploads} images and files.`,
    );
    if (result.missingUploads > 0) {
      console.log(
        `${result.missingUploads} images and files were deleted during the export, so they are gone.`,
      );
    }
    console.log("It has a new signing secret. An owner can copy it from Settings.");
    if (result.newOperators.length > 0) {
      console.log(
        `These operators are new here. They sign in with a link sent to their email, or, with no mail server, one from chat sign-in-link: ${result.newOperators.join(", ")}`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof ImportError) {
      console.error(`Nothing was imported. ${error.message}`);
      return 1;
    }
    if ((error as { code?: unknown }).code === "ENOENT") {
      console.error(`Nothing was imported. There is no file at ${file}.`);
      return 1;
    }
    if ((error as { code?: unknown }).code === "EACCES") {
      console.error(`Nothing was imported. This user cannot read ${file}.`);
      return 1;
    }
    throw error;
  }
}

/** The first operator and workspace of a new server, with the keys shown only now. */
async function setupCommand(
  db: Database,
  auth: Auth,
  config: Config,
  args: string[],
): Promise<number> {
  const existing = await db.select({ id: schema.operator.id }).from(schema.operator).limit(1);
  if (existing.length > 0) {
    console.error("This server is already set up. Sign in, or run chat sign-in-link <email>.");
    return 1;
  }
  const answers = await readSetupAnswers(args);
  if (answers === null) return 2;
  const email = answers.email.toLowerCase();
  const created = workspaceKeys();
  // One transaction, so a failure leaves no workspace without its owner.
  await db.transaction(async (tx) => {
    await enterWorkspace(tx, created.id);
    await insertWorkspace(tx, created, answers.workspace, [answers.origin]);
    const [user] = await tx
      .insert(schema.operator)
      .values({ email, name: answers.name, emailVerified: true })
      .returning({ id: schema.operator.id });
    if (user === undefined) throw new Error("The operator insert returned no row");
    await tx
      .insert(schema.workspaceMember)
      .values({ workspaceId: created.id, operatorId: user.id, role: "owner" });
  });
  console.log(`\nYour email: ${email}`);
  printLink(await signInLink(auth, email), email);
  console.log(`Workspace ID: ${created.id}`);
  console.log(`\nPut this on your site, before the closing body tag:`);
  console.log(widgetSnippet(config.PUBLIC_URL, created.publicKey));
  const backupKeys = generateBackupKeys();
  await db
    .insert(schema.instanceSetting)
    .values({ key: BACKUP_KEY_SETTING, value: backupKeys.publicKey })
    .onConflictDoUpdate({
      target: schema.instanceSetting.key,
      set: { value: backupKeys.publicKey },
    });
  console.log(`\nBackup private key, shown only now: ${backupKeys.privateKey}`);
  console.log(
    "Keep it away from this server. It opens the encrypted remote backups, and nothing else can.",
  );
  console.log(
    "A backup on this disk does not survive the loss of this disk. See docs/self-hosting.md.",
  );
  const secrets = process.env.DINGHY_SECRETS_DIR;
  if (secrets !== undefined && config.VAPID_PUBLIC_KEY === undefined) {
    await writePushKeys(secrets, generateVAPIDKeys(), `mailto:${email}`);
    console.log("\nRestart to turn on web push: docker compose restart app");
  }
  if (config.SMTP_URL === undefined) {
    console.log(
      "\nThis server has no mail server, so a visitor who left the page does not learn about a reply. Set SMTP_URL and MAIL_FROM to send email.",
    );
  }
  return 0;
}

/** A link for an operator, for a server with no mail server or an operator past the limit. */
async function signInLinkCommand(db: Database, auth: Auth, email: string): Promise<number> {
  const [found] = await db
    .select({ id: schema.operator.id })
    .from(schema.operator)
    .where(eq(schema.operator.email, email.toLowerCase()));
  // A link for an unknown email would create an account when opened.
  if (found === undefined) {
    console.error(`No operator has the email ${email}.`);
    return 1;
  }
  printLink(await signInLink(auth, email), email.toLowerCase());
  return 0;
}

/** Turns off an operator's two-step sign-in, with an audit line that names the account. */
async function twoFactorResetCommand(db: Database, email: string): Promise<number> {
  const [found] = await db
    .select({ id: schema.operator.id })
    .from(schema.operator)
    .where(eq(schema.operator.email, email.toLowerCase()));
  if (found === undefined) {
    console.error(`No operator has the email ${email}.`);
    return 1;
  }
  if (!(await resetTwoFactor(db, found.id))) {
    console.error(`Two-step sign-in is off for ${email}. Nothing changed.`);
    return 1;
  }
  audit(pino(), "two_factor.reset", { operatorId: found.id, by: "cli" });
  console.log(`Two-step sign-in is off for ${email}, and their sessions ended.`);
  return 0;
}

/** For development: an operator, and optionally a workspace that it owns. */
async function createOperatorCommand(
  db: Database,
  auth: Auth,
  args: string[],
  email: string,
  name: string,
): Promise<number> {
  const flags = readFlags(args, ["workspace", "origin"]);
  if (flags === null) return 2;
  const [user] = await db
    .insert(schema.operator)
    .values({ id: randomUUID(), email: email.toLowerCase(), name, emailVerified: true })
    .returning({ id: schema.operator.id });
  if (user === undefined) throw new Error("The operator insert returned no row");
  console.log(`Created the operator ${email}.`);
  if (flags.workspace !== undefined) {
    const created = await createWorkspace(
      db,
      flags.workspace,
      flags.origin === undefined ? [] : [flags.origin],
    );
    await withWorkspace(db, created.id, (tx) =>
      tx
        .insert(schema.workspaceMember)
        .values({ workspaceId: created.id, operatorId: user.id, role: "owner" }),
    );
    console.log(`Workspace ID: ${created.id}`);
    console.log(`Workspace public key: ${created.publicKey}`);
  }
  printLink(await signInLink(auth, email), email.toLowerCase());
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "push-keys") {
    const keys = generateVAPIDKeys();
    console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}`);
    return 0;
  }
  if (command === "init") return runInit(process.env.INIT_DIR ?? "/init");
  if (
    command === "migrate" ||
    command === "backup" ||
    command === "restore" ||
    command === "backup-key" ||
    command === "signups" ||
    command === "workspaces" ||
    command === "suspend" ||
    command === "unsuspend" ||
    command === "free"
  ) {
    return operate(command, args);
  }
  const known = [
    "sign-in-link",
    "two-factor-reset",
    "create-operator",
    "export",
    "import",
    "setup",
  ];
  if (command === undefined || !known.includes(command)) {
    console.error(USAGE);
    return 2;
  }
  const config = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });
  const db: Database = drizzle(pool, { schema });
  if (command === "export" || command === "import") {
    try {
      return await transfer(db, storeFromConfig(config), command, args);
    } finally {
      await pool.end();
    }
  }
  const auth = createAuth({ db, secret: config.AUTH_SECRET, baseURL: config.PUBLIC_URL });
  try {
    if (command === "setup") return await setupCommand(db, auth, config, args);
    const [email, name] = args;
    if (email === undefined) {
      console.error(USAGE);
      return 2;
    }
    if (command === "sign-in-link") return await signInLinkCommand(db, auth, email);
    if (command === "two-factor-reset") return await twoFactorResetCommand(db, email);
    if (name === undefined) {
      console.error(USAGE);
      return 2;
    }
    return await createOperatorCommand(db, auth, args, email, name);
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
