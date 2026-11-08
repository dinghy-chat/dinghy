import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * A copy of the real migrations up to, and not including, the one whose tag starts with `tag`. With
 * no tag, every migration but the newest, as the previous release had them.
 */
export async function migrationsBefore(tag?: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "dinghy-migrations-"));
  await cp(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal: { entries: { tag: string }[] } = JSON.parse(await readFile(journalPath, "utf8"));
  const index =
    tag === undefined
      ? journal.entries.length - 1
      : journal.entries.findIndex((entry) => entry.tag.startsWith(tag));
  if (index < 0) throw new Error(`No migration ${tag}`);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}
