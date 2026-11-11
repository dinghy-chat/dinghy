import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { buildWidget } from "../build.ts";

// Limits in gzipped bytes. The loader runs on every page of the host site, and new chat features
// must fit inside the chat's limit.
const LIMITS: Record<string, number> = {
  // 2,700 since the live visitors' beat, which the owner asked for on 2026-11-11 (2,631 with it,
  // from 2,291). The label and square launchers before it took it to 2,300.
  "loader.js": 2700,
  "page.js": 1000,
  // 23,200 since the email question became a card in the conversation, after a visitor typed
  // messages into the old field above the message box (23,140 with it, from 22,779, 2026-11-11).
  // 22,800 since replies with a quote, which the owner asked for on 2026-11-11 (22,779 with
  // them, from 22,162).
  // 22,200 since the new composer and header, the closed line and the reply chime, which the
  // owner asked for on 2026-11-11 (22,162 with them, from 21,585). Markdown in messages and the
  // typing preview took it to 21,600 the same day, and the emoji picker before them to 20,500.
  "widget.js": 23_200,
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
