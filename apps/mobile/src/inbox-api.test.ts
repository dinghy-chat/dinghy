import { fetch } from "expo/fetch";
import { beforeEach, expect, test, vi } from "vitest";
import { DinghyApi } from "./api.ts";

vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

const mockedFetch = vi.mocked(fetch);
const api = new DinghyApi({
  origin: "https://chat.example.com",
  session: "__Secure-better-auth.session_token=native-session",
  operator: { id: "operator", name: "Ana" },
  workspace: { id: "workspace", name: "Support" },
});
const conversation = {
  id: "conversation",
  updatedAt: "2026-11-25T00:00:00.000Z",
  visitor: { pictureUrl: null },
};
const answer = (body: unknown) => Response.json(body);

beforeEach(() => mockedFetch.mockReset());

test("the inbox follows the cursor and keeps conversations from both pages", async () => {
  mockedFetch
    .mockResolvedValueOnce(answer({ conversations: [conversation], hasMore: true, waiting: 5 }))
    .mockResolvedValueOnce(
      answer({ conversations: [{ ...conversation, id: "older" }], hasMore: false, waiting: 6 }),
    );
  const result = await api.conversations();
  expect(result.conversations.map((row) => row.id)).toEqual(["conversation", "older"]);
  expect(result.waiting).toBe(5);
  const url = new URL(String(mockedFetch.mock.calls[1]?.[0]));
  expect(url.searchParams.get("beforeId")).toBe(conversation.id);
  expect(url.searchParams.get("beforeUpdatedAt")).toBe(conversation.updatedAt);
});

test("thread refresh applies edited messages and retains the unchanged history", async () => {
  const older = { id: "older", seq: "1", kind: "text", body: "Before" };
  const latest = { id: "newer", seq: "2", kind: "text", body: "Unchanged" };
  mockedFetch
    .mockResolvedValueOnce(
      answer({
        conversation,
        messages: [older, latest],
        hasMore: false,
        sync: { cursor: "1.2", resync: false },
      }),
    )
    .mockResolvedValueOnce(
      answer({
        conversation,
        messages: [{ ...older, body: "Edited" }],
        hasMore: false,
        sync: { cursor: "1.3", resync: false },
      }),
    );
  const result = await api.thread(conversation.id, await api.thread(conversation.id));
  expect(result.messages.map((message) => message.body)).toEqual(["Edited", "Unchanged"]);
  const url = new URL(String(mockedFetch.mock.calls[1]?.[0]));
  expect(url.searchParams.get("changesAfter")).toBe("1.2");
});
