import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { buildWidget } from "../build.ts";

// Limits in gzipped bytes. The loader runs on every page of the host site and the chat loads on
// every visit, so a feature that grows them must be worth the bytes to every visitor.
const LIMITS: Record<string, number> = {
  "loader.js": 2700,
  "page.js": 1000,
  "widget.js": 26_100,
};

test("each language but English is a file of its own, and the chat holds no other", async () => {
  const files = await buildWidget();
  expect(Object.keys(files).filter((name) => name.endsWith(".json"))).toEqual([
    "fr.json",
    "es.json",
  ]);
  const chat = new TextDecoder().decode(files["widget.js"]);
  expect(chat).toContain("Write a message...");
  expect(chat).not.toContain("Écrivez un message");
});

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
