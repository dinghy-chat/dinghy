import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { s3Store } from "./storage.ts";

describe("the S3 store", () => {
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    // Takes every request and never answers, as a stalled object store does.
    server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const store = () =>
    s3Store({
      endpoint,
      region: "auto",
      bucket: "images",
      accessKeyId: "test",
      secretAccessKey: "test",
      timeoutMs: 100,
    });

  test("a store that never answers fails each call after its timeout", async () => {
    const started = Date.now();
    await expect(store().put("a", new Uint8Array([1]), "image/png")).rejects.toThrow();
    await expect(store().get("a")).rejects.toThrow();
    await expect(store().delete("a")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a caller's signal ends the call sooner", async () => {
    const caller = new AbortController();
    const deleting = store().delete("a", caller.signal);
    caller.abort(new Error("The worker is stopping"));
    await expect(deleting).rejects.toThrow("The worker is stopping");
  });
});
