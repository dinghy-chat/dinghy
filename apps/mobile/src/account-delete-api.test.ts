import { fetch } from "expo/fetch";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, DinghyApi } from "./api.ts";
import type { Session } from "./types.ts";

vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

const mockedFetch = vi.mocked(fetch);
const session: Session = {
  origin: "https://chat.example.com",
  session: "__Secure-better-auth.session_token=native-session",
  operator: { id: "operator-1", name: "Ana" },
  workspace: { id: "workspace-1", name: "Support" },
};

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("mobile account delete API", () => {
  test("sends the typed email with the native session, and returns whether it is gone", async () => {
    mockedFetch.mockResolvedValue(answer({ deleted: false }));
    await expect(new DinghyApi(session).deleteAccount("ana@example.com")).resolves.toEqual({
      deleted: false,
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://chat.example.com/v1/operator/account/delete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "ana@example.com" }),
        headers: expect.objectContaining({ Cookie: session.session, Origin: session.origin }),
      }),
    );
  });

  test("keeps the server's refusal code", async () => {
    mockedFetch.mockResolvedValue(
      answer({ error: { code: "last_workspace", message: "Last workspace." } }, 409),
    );
    const refused = await new DinghyApi(session).deleteAccount("ana@example.com").catch((e) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 409, code: "last_workspace" });
  });
});
