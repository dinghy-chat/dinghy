import { expect, test, vi } from "vitest";
import { readStream, retryAfterMs } from "./stream.ts";

test("a refused stream waits for Retry-After, or 30 seconds without a usable one", () => {
  expect(retryAfterMs("5")).toBe(5000);
  expect(retryAfterMs(null)).toBe(30_000);
  expect(retryAfterMs("")).toBe(30_000);
  expect(retryAfterMs("-1")).toBe(30_000);
  expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(30_000);
});

/** A response whose body arrives in the given chunks, as a slow network splits it. */
function chunked(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}

function handlers() {
  return { data: vi.fn(), ready: vi.fn(), resync: vi.fn() };
}

test("the stream hands over each event, even when a chunk splits it, and ends on close", async () => {
  const on = handlers();
  const reason = await readStream(
    chunked([
      'event: ready\ndata: {"cursor":null}\n\n: ping\n\nevent: mess',
      'age\nid: 7\ndata: {"body":"hi"}\n\nevent: resync\ndata: {"cursor":"9"}\n\n',
      'event: other\ndata: {}\n\nevent: close\ndata: {"reason":"signed_out"}\n\n',
      'event: message\nid: 8\ndata: {"body":"late"}\n\n',
    ]),
    "message",
    on,
  );
  expect(reason).toBe("signed_out");
  expect(on.ready).toHaveBeenCalledWith(null);
  expect(on.data).toHaveBeenCalledTimes(1);
  expect(on.data).toHaveBeenCalledWith({ body: "hi" }, "7");
  expect(on.resync).toHaveBeenCalledWith("9");
});

test("a stream that drops without a close event resolves with null", async () => {
  const on = handlers();
  expect(await readStream(chunked(['event: ready\ndata: {"cursor":"3"}\n\n']), "change", on)).toBe(
    null,
  );
  expect(on.ready).toHaveBeenCalledWith("3");
});
