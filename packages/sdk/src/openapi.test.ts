import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { generateTypes, TYPES_FILE } from "../scripts/types.ts";

// The SDK's types come from the server's OpenAPI file, so a route change must regenerate them.
test("src/openapi.ts matches apps/server/openapi.json", async () => {
  const committed = readFileSync(TYPES_FILE, "utf8");
  expect(committed === (await generateTypes()), "Run node packages/sdk/scripts/types.ts").toBe(
    true,
  );
}, 30_000);
