import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/types.ts", import.meta.url));

// The SDK's types come from the server's OpenAPI file, so a route change must regenerate them.
test("src/openapi.ts matches apps/server/openapi.json", () => {
  expect(() =>
    execFileSync(process.execPath, [SCRIPT, "--check"], { stdio: "pipe" }),
  ).not.toThrow();
}, 30_000);
