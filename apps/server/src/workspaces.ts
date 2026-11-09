import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { workspace } from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { normalizeOrigin } from "./identity.ts";

export interface NewWorkspace {
  id: string;
  publicKey: string;
  signingSecret: string;
}

/** A new workspace's ID and keys. */
export function workspaceKeys(): NewWorkspace {
  return {
    id: randomUUID(),
    publicKey: `wk_${randomBytes(16).toString("hex")}`,
    signingSecret: randomBytes(32).toString("base64url"),
  };
}

export async function createWorkspace(
  db: Database,
  name: string,
  allowedOrigins: string[],
  options: { active?: boolean } = {},
): Promise<NewWorkspace> {
  const created = workspaceKeys();
  await withWorkspace(db, created.id, (tx) =>
    insertWorkspace(tx, created, name, allowedOrigins, options),
  );
  return created;
}

/** Inserts a workspace in the caller's transaction, which must be in that workspace's context. */
export async function insertWorkspace(
  tx: Transaction,
  keys: NewWorkspace,
  name: string,
  allowedOrigins: string[],
  { active = true }: { active?: boolean } = {},
): Promise<void> {
  const origins = allowedOrigins.map((origin) => {
    const normalized = normalizeOrigin(origin);
    if (normalized === null) throw new Error(`Not a valid origin: ${origin}`);
    return normalized;
  });
  await tx.insert(workspace).values({ ...keys, name, allowedOrigins: origins, active });
}

/** The widget's own words for a workspace. Null means the widget's default text. */
export interface WidgetTexts {
  title: string | null;
  greeting: string | null;
  away: string | null;
}

export interface WidgetWorkspace {
  id: string;
  allowedOrigins: string[];
  signingSecret: string;
  texts: WidgetTexts;
}

/** Finds a workspace by its public key. The caller has no workspace context yet. */
export async function widgetWorkspace(
  db: Database,
  publicKey: string,
): Promise<WidgetWorkspace | null> {
  const result = await db.execute<{
    id: string;
    allowed_origins: string[];
    signing_secret: string;
    widget_title: string | null;
    widget_greeting: string | null;
    widget_away: string | null;
  }>(sql`select * from widget_workspace(${publicKey})`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    allowedOrigins: row.allowed_origins,
    signingSecret: row.signing_secret,
    texts: { title: row.widget_title, greeting: row.widget_greeting, away: row.widget_away },
  };
}

/**
 * Every workspace on this server, as tab-separated lines under a header, for the commands that
 * take a workspace ID. It reads across workspaces, so it takes the admin login, as `chat migrate`
 * does.
 */
export async function workspacesTable(admin: pg.ClientBase): Promise<string> {
  const result = await admin.query<{ id: string; name: string; public_key: string; state: string }>(
    // The state the API and the widget act on, so the list never says active when they refuse.
    `SELECT id, name, public_key, workspace_access(id) AS state
     FROM workspace WHERE deleted_at IS NULL ORDER BY created_at, id`,
  );
  const rows = result.rows.map((row) => [
    row.id,
    row.public_key,
    row.state,
    row.name.replace(/\s+/g, " "),
  ]);
  return [["id", "public key", "state", "name"], ...rows]
    .map((row) => `${row.join("\t")}\n`)
    .join("");
}
