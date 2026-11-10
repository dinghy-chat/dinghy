import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { loadConfig } from "./config.ts";
import { scrubEvent, startErrorReports } from "./error-reports.ts";

const base = {
  DATABASE_URL: "postgres://localhost/dinghy",
  VALKEY_URL: "redis://localhost:6379",
  AUTH_SECRET: "a".repeat(32),
};

// A stand-in for Sentry's ingest endpoint, which keeps every envelope it receives.
const envelopes: string[] = [];
const ingest = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    envelopes.push(
      (request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString(),
    );
    response.end("{}");
  });
});
await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
const { port } = ingest.address() as AddressInfo;
afterAll(() => new Promise((resolve) => ingest.close(resolve)));

test("nothing starts without SENTRY_DSN", async () => {
  expect(await startErrorReports(loadConfig(base), "web", "1.2.3")).toBeUndefined();
});

test("an error the logger writes reaches Sentry with its stack, and no request data", async () => {
  const config = loadConfig({ ...base, SENTRY_DSN: `http://key@127.0.0.1:${port}/1` });
  const stop = await startErrorReports(config, "worker", "1.2.3");
  // Sentry sees what the logger writes, so the test discards the lines instead of silencing them.
  const logger = pino(
    { level: "info" },
    new Writable({ write: (_chunk, _encoding, done) => done() }),
  );
  // A value only a local variable holds, as a visitor's text would be.
  const written = randomUUID();
  const fail = (text: string) =>
    new Error(`the worker pass failed after ${text.length} characters`);
  logger.error({ err: fail(written) }, "worker pass failed");
  logger.info("an info line, which stays here");
  await stop?.();

  const sent = envelopes.join("\n");
  expect(sent).toContain("the worker pass failed");
  expect(sent).toContain("error-reports.test.ts");
  expect(sent).toContain('"release":"dinghy@1.2.3"');
  expect(sent).toContain('"role":"worker"');
  // The error goes as an event. Log lines, traces and request data stay here.
  const types = envelopes.flatMap((envelope) =>
    envelope
      .split("\n")
      .filter((line) => line.startsWith('{"type"'))
      .map((line) => (JSON.parse(line) as { type: string }).type),
  );
  expect(types).toContain("event");
  expect(types.filter((type) => type !== "event" && type !== "session")).toEqual([]);
  expect(sent).not.toContain('"request"');
  expect(sent).not.toContain(written);
});

test("events lose request data and the parameters of a failed query", () => {
  const event = scrubEvent({
    type: undefined,
    request: { url: "https://chat.example.com/sign-in?token=secret" },
    exception: { values: [{ type: "Error", value: "Failed query: select 1\nparams: secret" }] },
  });
  expect(event.request).toBeUndefined();
  expect(event.exception?.values?.[0]?.value).toBe("A query failed.");
});
