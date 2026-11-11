import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { buildWidget } from "../build.ts";

// Limits in gzipped bytes. The loader runs on every page of the host site, and new chat features
// must fit inside the chat's limit.
const LIMITS: Record<string, number> = {
  // 2,300 since the label and square launchers, which the owner asked for on 2026-11-11 (2,276
  // with them, from 2,096). The full page API before them took it to 2,100.
  "loader.js": 2300,
  "page.js": 1000,
  // 21,500 since Markdown in messages, which the owner asked for on 2026-11-11 (21,347 with it,
  // from 20,320). The emoji picker before it took it to 20,500.
  "widget.js": 21_500,
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
