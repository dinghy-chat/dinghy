import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ApiError, createClient } from "./client.ts";

// A server that reads each request and never answers, as a stuck proxy or a lost connection does.
let server: Server;
let base: string;
const paths: string[] = [];

beforeAll(async () => {
  server = createServer((request) => {
    paths.push(request.url ?? "");
    request.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/widget/`;
  vi.stubGlobal("location", { origin: "https://shop.example", pathname: "/cart" });
});

afterAll(() => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  server.close();
});

test("a send that never gets an answer fails after its deadline, so it can be retried", async () => {
  const client = createClient(base, "wk_test", { requestMs: 300, uploadMs: 300 });
  const started = Date.now();
  const failure = await client.send("token", "line-1", "Hello").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(ApiError);
  expect((failure as Error).name).toBe("TimeoutError");
  expect(Date.now() - started).toBeLessThan(5000);
});

test("an image upload that never gets an answer fails after its own deadline", async () => {
  const client = createClient(base, "wk_test", { requestMs: 60_000, uploadMs: 300 });
  const file = new File([new Uint8Array(16)], "a.png", { type: "image/png" });
  const failure = await client.sendImage("token", "line-2", file).catch((error: unknown) => error);
  expect((failure as Error).name).toBe("TimeoutError");
  // The page goes with it as origin and path, and the server keeps it when a conversation starts.
  expect(paths.at(-1)).toContain(`page=${encodeURIComponent("https://shop.example/cart")}`);
});

/** Runs `use` with a client of a server that answers every request with `respond`. */
async function withAnswers(
  respond: (url: string, response: ServerResponse) => void,
  use: (client: ReturnType<typeof createClient>) => Promise<void>,
) {
  const answering = createServer((request, response) => {
    request.resume();
    respond(request.url ?? "", response);
  });
  await new Promise<void>((resolve) => answering.listen(0, "127.0.0.1", resolve));
  try {
    const port = (answering.address() as AddressInfo).port;
    await use(createClient(`http://127.0.0.1:${port}/widget/`, "wk_test"));
  } finally {
    answering.closeAllConnections();
    answering.close();
  }
}

test("a refusal keeps the server's error code, so the chat can tell a block from a site", () =>
  withAnswers(
    (url, response) => {
      const code = url.includes("/messages") ? "origin_not_allowed" : "blocked";
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code, message: "No." } }));
    },
    async (client) => {
      const sent = await client.send("token", "line-3", "Hello").catch((error: unknown) => error);
      expect(sent).toBeInstanceOf(ApiError);
      expect(sent).toMatchObject({ status: 403, code: "origin_not_allowed" });
      const saved = await client.saveEmail("token", "a@b.example").catch((error: unknown) => error);
      expect(saved).toMatchObject({ status: 403, code: "blocked" });
    },
  ));

test("a refusal with no JSON body has no code", () =>
  withAnswers(
    (_url, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<h1>Bad gateway</h1>");
    },
    async (client) => {
      const failure = await client.me("token").catch((error: unknown) => error);
      expect(failure).toMatchObject({ status: 502, code: null });
    },
  ));
