import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { buildWidget } from "../build.ts";

// Limits in gzipped bytes. The loader runs on every page of the host site, and new chat features
// must fit inside the chat's limit.
const LIMITS: Record<string, number> = {
  // 2,100 since the full page API, which must work before the chat loads: open, on, setContext,
  // configure, and a reset from another tab.
  "loader.js": 2100,
  "page.js": 1000,
  "widget.js": 20_000,
};

test("the bundles use no API that exists only on secure pages", async () => {
  const files = await buildWidget();
  const text = new TextDecoder().decode(files["widget.js"]);
  // A host site can be plain HTTP, where this is undefined and a send would fail with no error.
  expect(text).not.toContain("randomUUID");
});

test("the chat carries Preact's license notice, and the loader carries none", async () => {
  const files = await buildWidget();
  const decode = (name: string) => new TextDecoder().decode(files[name]);
  expect(decode("widget.js")).toMatch(/^\/\*! Dinghy widget, MIT\. Includes Preact, MIT/);
  expect(decode("loader.js")).not.toContain("Preact");
});

test.each(Object.entries(LIMITS))("%s stays inside its size limit", async (name, limit) => {
  const files = await buildWidget();
  const file = files[name];
  expect(file).toBeDefined();
  expect(gzipSync(file ?? new Uint8Array()).length).toBeLessThanOrEqual(limit);
});
