import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const AGPL_IMPORT =
  /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["'][^"']*(?:apps\/|ee\/|@dinghy\/(?:server|operator|ee))/;
const EE_IMPORT = /(?:from\s+|import\s*\(?\s*)["']([^"']*\/ee\/[^"']*)["']/g;
const EE_HEADER = "// Licensed under the Dinghy Enterprise License. See ee/LICENSE.\n";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const packages = readdirSync("packages");

test.each(packages)("MIT package %s depends on no AGPL package", (name) => {
  const manifest = JSON.parse(readFileSync(join("packages", name, "package.json"), "utf8"));
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  });
  expect(dependencies).not.toContain("@dinghy/server");
  expect(dependencies).not.toContain("@dinghy/operator");
  expect(dependencies).not.toContain("@dinghy/ee");
});

test.each(packages)("MIT package %s imports no AGPL code", (name) => {
  const offenders = sourceFiles(join("packages", name, "src")).filter((file) =>
    AGPL_IMPORT.test(readFileSync(file, "utf8")),
  );
  expect(offenders).toEqual([]);
});

test("every file in ee/ points to ee/LICENSE", () => {
  const missing = sourceFiles("ee")
    .filter((file) => !file.includes("node_modules"))
    .filter((file) => !readFileSync(file, "utf8").startsWith(EE_HEADER));
  expect(missing).toEqual([]);
});

// Core reaches the cloud's code only through its entry point and the cloud's screens.
test("core imports ee/ only through ee/server/index.ts and ee/operator/", () => {
  const imports = sourceFiles("apps")
    .filter((file) => !file.includes("node_modules"))
    .flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(EE_IMPORT)].map((found) => found[1] ?? ""),
    );
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.filter((path) => !/\/ee\/(?:server\/index\.ts|operator\/)/.test(path))).toEqual(
    [],
  );
});
