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
  // 25,800 since files in the chat and business hours with languages met on 2026-11-13 (25,777 with
  // both). Each had its own limit before: 24,760 for files in the chat after their review (24,747
  // with them, from 24,488), and 24,950 for business hours and languages after their review (24,903
  // with them, from about 24,800). French and Spanish now carry the files' texts too.
  // 24,500 since files in the chat, which the owner asked for on 2026-11-13 (24,488 with them,
  // from about 23,870). The allowed types, the file's line and its texts took most of it.
  // 24,850 since languages, which the owner asked for on 2026-11-13 (24,802 with them, from
  // 24,550): picking the language and loading its file. The texts of French and Spanish are files
  // of their own, and English stays in the chat.
  // 24,600 since business hours, which the owner asked for on 2026-11-13 (24,550 with them, from
  // 23,892): the open or closed time on the workspace's clock, and when the team is back.
  // 23,900 since a bot's "is typing" line, from the agent experience design of 2026-11-12
  // (23,869 with it and the changes below, 2026-11-12). The typing line alone gave about 250 bytes.
  // 23,720 since bold around italic, as `***both***`, reads as both, for the operator app's rich
  // composer (23,710 with it, from 23,681, 2026-11-12).
  // 23,700 since a message's lines that start with > show as a quote, after a visitor's quote
  // showed its marks (23,675 with it, from 23,597, 2026-11-12).
  // 23,610 since images keep their height in a long conversation (23,602 with it, from 23,593,
  // 2026-11-12).
  // 23,600 since the header settings: online faces with dots and the usual reply time, which the
  // owner asked for on 2026-11-12 (23,593 with them, from 23,241).
  // 23,300 since a quoted reply shows the shared plain excerpt at once, not its Markdown (23,241
  // with it, from 23,173, 2026-11-11).
  // 23,200 since the email question became a card in the conversation, after a visitor typed
  // messages into the old field above the message box (23,140 with it, from 22,779, 2026-11-11).
  // 22,800 since replies with a quote, which the owner asked for on 2026-11-11 (22,779 with
  // them, from 22,162).
  // 22,200 since the new composer and header, the closed line and the reply chime, which the
  // owner asked for on 2026-11-11 (22,162 with them, from 21,585). Markdown in messages and the
  // typing preview took it to 21,600 the same day, and the emoji picker before them to 20,500.
  "widget.js": 25_800,
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
