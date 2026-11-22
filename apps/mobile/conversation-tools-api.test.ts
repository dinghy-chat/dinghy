import { fetch } from "expo/fetch";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DinghyApi, MAX_IMAGE_BYTES } from "./src/api.ts";
import type { Session } from "./src/types.ts";

vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

const mockedFetch = vi.mocked(fetch);
const session: Session = {
  origin: "https://chat.example.com",
  session: "__Secure-better-auth.session_token=native-session",
  operator: { id: "operator-1", name: "Ana" },
  workspace: { id: "workspace-1", name: "Support" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("mobile conversation tools API", () => {
  test("resolves profile pictures and workspace logos on self-hosted instances", async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({
        pictureUrl: "/v1/pictures/ana",
        workspaces: [{ name: "Harbor", logoUrl: "/v1/widget/test/logo" }, { name: "Second" }],
      }),
    );
    const account = await new DinghyApi(session).me();
    expect(account.pictureUrl).toBe("https://chat.example.com/v1/pictures/ana");
    expect(account.workspaces.map((w) => w.logoUrl)).toEqual([
      "https://chat.example.com/v1/widget/test/logo",
      null,
    ]);
  });

  test("lists saved replies through the native operator session", async () => {
    const savedReply = {
      id: "reply-1",
      shortcut: "hello",
      body: "Hello there",
      updatedAt: "2026-11-18T10:00:00.000Z",
    };
    mockedFetch.mockResolvedValue(jsonResponse({ savedReplies: [savedReply] }));

    await expect(new DinghyApi(session).savedReplies()).resolves.toEqual({
      savedReplies: [savedReply],
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://chat.example.com/v1/operator/workspaces/workspace-1/saved-replies",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({
          Cookie: session.session,
          Origin: session.origin,
        }),
      }),
    );
  });

  test("uploads the selected bytes and keeps the same client ID on retry", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const photo = { uri: "file:///tmp/invoice.png", mimeType: "image/png" };
    const api = new DinghyApi(session);
    for (const status of [503, 201]) {
      mockedFetch.mockResolvedValueOnce(new Response(bytes));
      mockedFetch.mockResolvedValueOnce(jsonResponse({ kind: "image" }, status));
      const send = api.uploadPhoto("conversation-1", "photo-1", photo);
      if (status === 503) await expect(send).rejects.toMatchObject({ status });
      else await expect(send).resolves.toMatchObject({ kind: "image" });
    }
    for (const [url, request] of [mockedFetch.mock.calls[1], mockedFetch.mock.calls[3]]) {
      expect(url).toBe(
        "https://chat.example.com/v1/operator/workspaces/workspace-1/conversations/conversation-1/uploads?clientId=photo-1",
      );
      expect(request).toMatchObject({
        method: "POST",
        headers: { Cookie: session.session, "Content-Type": "image/png" },
      });
      expect(new Uint8Array(request?.body as ArrayBuffer)).toEqual(bytes);
    }
  });

  test("refuses an oversized photo before contacting the server", async () => {
    mockedFetch.mockResolvedValueOnce(new Response(new Uint8Array(MAX_IMAGE_BYTES + 1)));
    const photo = { uri: "file:///tmp/large.jpg", mimeType: "image/jpeg" };
    await expect(
      new DinghyApi(session).uploadPhoto("conversation-1", "photo-2", photo),
    ).rejects.toThrow();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(photo.uri);
  });

  test("writes a private note with an idempotent client ID and no mentions", async () => {
    const message = { id: "message-1", kind: "note", body: "Team only" };
    mockedFetch.mockResolvedValue(jsonResponse(message, 201));

    await expect(
      new DinghyApi(session).note("conversation-1", "note-client-1", "Team only"),
    ).resolves.toEqual(message);
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://chat.example.com/v1/operator/workspaces/workspace-1/conversations/conversation-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          clientId: "note-client-1",
          body: "Team only",
          note: true,
          mentions: [],
        }),
        headers: expect.objectContaining({
          Cookie: session.session,
          Origin: session.origin,
        }),
      }),
    );
  });

  test("sends a reply with its quoted message relation", async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ id: "message-2", kind: "text" }, 201));

    await new DinghyApi(session).reply(
      "conversation-1",
      "reply-client-1",
      "The annual plan is available.",
      "message-1",
    );

    expect(mockedFetch).toHaveBeenCalledWith(
      "https://chat.example.com/v1/operator/workspaces/workspace-1/conversations/conversation-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          clientId: "reply-client-1",
          body: "The annual plan is available.",
          replyToMessageId: "message-1",
          note: false,
          mentions: [],
        }),
      }),
    );
  });

  test("edits, deletes and reads receipt details through the message routes", async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ id: "message-1", body: "Updated" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ readAt: null, emailedAt: null }));
    const api = new DinghyApi(session);

    await api.editMessage("conversation-1", "message-1", "Updated");
    await api.deleteMessage("conversation-1", "message-1");
    await api.messageReceipt("conversation-1", "message-1");

    const base =
      "https://chat.example.com/v1/operator/workspaces/workspace-1/conversations/conversation-1/messages/message-1";
    expect(mockedFetch).toHaveBeenNthCalledWith(
      1,
      base,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ body: "Updated", mentions: [] }),
      }),
    );
    expect(mockedFetch).toHaveBeenNthCalledWith(
      2,
      base,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(mockedFetch).toHaveBeenNthCalledWith(
      3,
      `${base}/receipt`,
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({ Cookie: session.session }),
      }),
    );
  });
});
