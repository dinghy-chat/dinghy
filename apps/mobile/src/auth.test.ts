import { beforeEach, describe, expect, test, vi } from "vitest";

const secureValues = vi.hoisted(() => new Map<string, string>());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("expo/fetch", () => ({ fetch: fetchMock }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "when-unlocked-this-device-only",
  getItemAsync: vi.fn(async (key: string) => secureValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureValues.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureValues.delete(key);
  }),
}));

const SESSION_KEY = "dinghy.native.session.v1";
const LEGACY_PROOF_KEY = "dinghy.native.sign-in-proof.v1";
const origin = "https://chat.example.com";
const session = {
  origin,
  session: "__Secure-better-auth.session_token=native-session",
  operator: { id: "operator-1", name: "Anna" },
  workspace: { id: "workspace-1", name: "Harbor" },
};

async function authModule() {
  vi.stubGlobal("__DEV__", true);
  return await import("./auth");
}

function requestOf() {
  return {
    origin,
    email: "anna@example.com",
    expiresInSeconds: 600,
    resendAfterSeconds: 60,
  };
}

beforeEach(() => {
  vi.resetModules();
  secureValues.clear();
  fetchMock.mockReset();
});

describe("native mobile authentication", () => {
  test("requests an email code without cookies, redirects, or a browser callback", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: true, expiresInSeconds: 600, resendAfterSeconds: 60 }),
    );
    const { requestEmailCode } = await authModule();

    await expect(requestEmailCode(origin, " Anna@Example.com ")).resolves.toEqual(requestOf());

    expect(fetchMock).toHaveBeenCalledWith(`${origin}/v1/auth/native/email-code/request`, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ email: "anna@example.com" }),
    });
  });

  test("uses bounded countdown defaults when an older compatible server omits them", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    const { requestEmailCode } = await authModule();

    await expect(requestEmailCode(origin, "anna@example.com")).resolves.toMatchObject({
      expiresInSeconds: 600,
      resendAfterSeconds: 60,
    });
  });

  test("returns the TOTP challenge without saving a session", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: "totp_required",
        challenge: "opaque-challenge",
        expiresInSeconds: 300,
      }),
    );
    const { verifyEmailCode } = await authModule();

    await expect(verifyEmailCode(requestOf(), "123456")).resolves.toEqual({
      status: "totp_required",
      challenge: "opaque-challenge",
      expiresInSeconds: 300,
    });

    expect(secureValues.has(SESSION_KEY)).toBe(false);
  });

  test("saves the direct session returned after an email code", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: "signed_in", session }));
    const { verifyEmailCode } = await authModule();

    await expect(verifyEmailCode(requestOf(), "123456")).resolves.toEqual({
      status: "signed_in",
      session,
    });

    expect(JSON.parse(secureValues.get(SESSION_KEY) ?? "null")).toEqual(session);
  });

  test("rejects a session for a different server", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: "signed_in",
        session: { ...session, origin: "https://other.example.com" },
      }),
    );
    const { verifyEmailCode } = await authModule();

    await expect(verifyEmailCode(requestOf(), "123456")).rejects.toThrow(
      "The server returned a session for another origin.",
    );

    expect(secureValues.has(SESSION_KEY)).toBe(false);
  });

  test("sends an opaque challenge and saves the session after TOTP", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: "signed_in", session }));
    const { verifyTotp } = await authModule();

    await expect(verifyTotp(origin, "opaque-challenge", "recovery-code")).resolves.toEqual(session);

    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/v1/auth/native/totp/verify`,
      expect.objectContaining({
        body: JSON.stringify({ challenge: "opaque-challenge", code: "recovery-code" }),
      }),
    );
    expect(JSON.parse(secureValues.get(SESSION_KEY) ?? "null")).toEqual(session);
  });

  test("removes a proof left by the retired browser flow during migration", async () => {
    secureValues.set(LEGACY_PROOF_KEY, "old-proof");
    const { readSession } = await authModule();

    await expect(readSession()).resolves.toBeNull();

    expect(secureValues.has(LEGACY_PROOF_KEY)).toBe(false);
  });

  test("explains when a self-hosted server lacks native email-code sign-in", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const { requestEmailCode } = await authModule();

    await expect(requestEmailCode(origin, "anna@example.com")).rejects.toThrow(
      "This server does not support mobile sign-in. Update Dinghy on the server, then try again.",
    );
  });

  test("rejects a malformed success response", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: "yes" }));
    const { requestEmailCode } = await authModule();

    await expect(requestEmailCode(origin, "anna@example.com")).rejects.toThrow(
      "The server returned an invalid sign-in response.",
    );
  });
});

describe("a build-time loopback origin", () => {
  test("is allowed over http in a release build, with or without a trailing slash", async () => {
    vi.stubGlobal("__DEV__", false);
    vi.stubEnv("EXPO_PUBLIC_DINGHY_ORIGIN", "http://localhost:3000/");
    try {
      const { CLOUD_ORIGIN } = await import("./auth");
      const { normalizeOrigin } = await import("./api");
      expect(CLOUD_ORIGIN).toBe("http://localhost:3000");
      expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
      expect(() => normalizeOrigin("http://localhost:4000")).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
