import { fetch } from "expo/fetch";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DinghyApi } from "./src/api.ts";
import type { Session } from "./src/types.ts";

vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

const mockedFetch = vi.mocked(fetch);
const session: Session = {
  origin: "https://chat.example.com",
  session: "__Secure-better-auth.session_token=native-session",
  operator: { id: "operator-1", name: "Ana" },
  workspace: { id: "workspace-1", name: "Support" },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("mobile admin tools API", () => {
  test("uses the server's HTML formatter and returns only public install material", async () => {
    const snippet = {
      framework: "html",
      code: '<script src="https://chat.example.com/widget/loader.js" data-key="wk_public" async></script>',
      file: "Every page's HTML",
      placement: "Before </body>",
      notes: ["Add it on every page."],
      publicKey: "wk_public",
      serverUrl: "https://chat.example.com",
    };
    mockedFetch.mockResolvedValue(jsonResponse(snippet));

    await expect(new DinghyApi(session).installSnippet()).resolves.toEqual(snippet);
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://chat.example.com/v1/operator/workspaces/workspace-1/install/snippet?framework=html",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({ Cookie: session.session, Origin: session.origin }),
      }),
    );
    expect(Object.keys(snippet)).not.toContain("secret");
  });

  test("uses the native operator session for label CRUD", async () => {
    const label = { id: "label-1", name: "Billing", color: "orange" as const };
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ labels: [label] }))
      .mockResolvedValueOnce(jsonResponse(label))
      .mockResolvedValueOnce(jsonResponse({ ...label, name: "Payments" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const api = new DinghyApi(session);

    await api.labels();
    await api.addLabel({ name: label.name, color: label.color });
    await api.changeLabel(label.id, { name: "Payments", color: label.color });
    await api.deleteLabel(label.id);

    const base = "https://chat.example.com/v1/operator/workspaces/workspace-1/labels";
    expect(mockedFetch).toHaveBeenNthCalledWith(
      1,
      base,
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: session.session, Origin: session.origin }),
      }),
    );
    expect(mockedFetch).toHaveBeenNthCalledWith(
      2,
      base,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Billing", color: "orange" }),
      }),
    );
    expect(mockedFetch).toHaveBeenNthCalledWith(
      3,
      `${base}/label-1`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Payments", color: "orange" }),
      }),
    );
    expect(mockedFetch).toHaveBeenNthCalledWith(
      4,
      `${base}/label-1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
