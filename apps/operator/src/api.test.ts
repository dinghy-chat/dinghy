import { afterEach, expect, test, vi } from "vitest";
import { ApiError, workspaceApi } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const WORKSPACE = "6f1d3c1e-8a52-4b6e-9a8f-2d1c0b7e5a41";

/** Answers every request with `status` and `body`, and keeps what was asked. */
function answer(status: number, body: unknown) {
  const asked: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    asked.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  });
  return asked;
}

test("a test message posts the board's words to the workspace's test visitors", async () => {
  const asked = answer(201, { visitorId: "v1", conversationId: "c1", message: {} });
  const sent = await workspaceApi(WORKSPACE).sendTestMessage("Hello, is anyone there?");
  expect(sent).toMatchObject({ visitorId: "v1", conversationId: "c1" });
  expect(asked).toHaveLength(1);
  expect(asked[0]?.url).toBe(`/v1/operator/workspaces/${WORKSPACE}/test-visitors/messages`);
  expect(asked[0]?.init.method).toBe("POST");
  expect(JSON.parse(String(asked[0]?.init.body))).toEqual({ body: "Hello, is anyone there?" });
});

test("a test message over the limit fails with the server's 429", async () => {
  answer(429, { error: { code: "too_many_requests", message: "Retry in 30 seconds." } });
  const failure = await workspaceApi(WORKSPACE)
    .sendTestMessage("Again")
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ status: 429, code: "too_many_requests" });
});
