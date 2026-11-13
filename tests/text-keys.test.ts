import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";

// A text no code shows is dead weight, and the type checker cannot see it, because every key is
// valid. So the type checker finds the uses: in a copy of the code, every key of one text file
// gets a new name, and each place that names a key as that file's text key, such as `t("close")`,
// a `TextId` prop, a `Record<..., TextId>` value or a function that returns `TextId`, fails to
// check with the old name in the error. A key no error names is shown nowhere. A string such as an
// icon's `"close"` is no text key, so it counts for nothing, and each file's keys count only where
// that file's `TextId` is wanted: the widget's `t("close")` does not use the operator app's key.
const ROOT = resolve(import.meta.dirname, "..");
const TEXTS = ["apps/operator/src/text.ts", "packages/widget/src/text.ts"];
const RENAMED = "__renamed";
const TRANSLATIONS = "packages/widget/src/texts/";
const KEY = /^ {2}([A-Za-z0-9_]+):/gm;

const copy = mkdtempSync(join(tmpdir(), "dinghy-text-keys-"));
afterAll(() => rmSync(copy, { recursive: true, force: true }));
for (const name of ["apps", "ee", "packages", "tsconfig.json", "tsconfig.web.json"]) {
  cpSync(join(ROOT, name), join(copy, name), {
    recursive: true,
    // The copy uses the real packages, which it does not need to copy.
    filter: (source) => {
      if (basename(source) !== "node_modules") return true;
      symlinkSync(source, join(copy, source.slice(ROOT.length)));
      return false;
    },
  });
}
symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));

/** The keys of `wanted` that the type checker names in errors while they have a new name. */
function namedInErrors(file: string, source: string, wanted: Set<string>): Set<string> {
  const renamed = source.replace(KEY, (line, key: string) =>
    wanted.has(key) ? `  ${key}${RENAMED}:` : line,
  );
  writeFileSync(join(copy, file), renamed);
  const check = spawnSync(
    join(ROOT, "node_modules/.bin/tsc"),
    ["--noEmit", "--pretty", "false", "-p", join(copy, "tsconfig.web.json")],
    { encoding: "utf8" },
  );
  // A translation names every key, so its errors say nothing about where a key shows.
  const errors = check.stdout
    .split("\n")
    .filter((line) => !line.startsWith(TRANSLATIONS))
    .join("\n");
  const named = [...errors.matchAll(/"([A-Za-z0-9_]+)"/g)].map((match) => match[1] ?? "");
  return new Set(named.filter((key) => wanted.has(key)));
}

/**
 * The keys that code in the browser projects names as keys of `file`. A call reports only its first
 * wrong argument, so the keys found go back to their names and the check runs again, until it
 * finds no more.
 */
function usedKeys(file: string, keys: string[]): Set<string> {
  const source = readFileSync(join(ROOT, file), "utf8");
  const used = new Set<string>();
  for (;;) {
    const found = namedInErrors(file, source, new Set(keys.filter((key) => !used.has(key))));
    if (found.size === 0) break;
    for (const key of found) used.add(key);
  }
  writeFileSync(join(copy, file), source);
  return used;
}

// It runs the type checker over the operator app, which takes seconds while the database tests
// load the machine.
const TYPE_CHECK_TIMEOUT_MS = 60_000;

test.each(TEXTS)(
  "every key in %s is shown somewhere",
  { timeout: TYPE_CHECK_TIMEOUT_MS },
  (file) => {
    const keys = [...readFileSync(join(ROOT, file), "utf8").matchAll(KEY)].map(
      (match) => match[1] ?? "",
    );
    const used = usedKeys(file, keys);
    expect(keys.filter((key) => !used.has(key))).toEqual([]);
  },
);
