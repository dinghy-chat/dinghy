// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../../apps/server/src/config.ts";
import { captureWidgetInstall } from "./analytics.ts";
import { cloudFromConfig } from "./index.ts";

const BASE = {
  DATABASE_URL: "postgres://app@localhost/dinghy",
  VALKEY_URL: "redis://localhost:6379",
  AUTH_SECRET: "a".repeat(32),
};
const KEY = "phc_testKey123";

describe("the cloud's PostHog project", () => {
  test("is off on a self-hosted install, even with a key set", () => {
    expect(cloudFromConfig(loadConfig({ ...BASE, CLOUD_POSTHOG_KEY: KEY }))).toBeUndefined();
  });

  test("goes to the EU host by default when the cloud is on", () => {
    const cloud = cloudFromConfig(
      loadConfig({ ...BASE, CLOUD_SIGNUP: "early", CLOUD_POSTHOG_KEY: KEY }),
    );
    expect(cloud?.analytics).toEqual({ key: KEY, host: "https://eu.i.posthog.com" });
  });

  test("is off on the cloud without a key, and refuses a key that is not a project key", () => {
    expect(
      cloudFromConfig(loadConfig({ ...BASE, CLOUD_SIGNUP: "early" }))?.analytics,
    ).toBeUndefined();
    expect(() => loadConfig({ ...BASE, CLOUD_POSTHOG_KEY: "phx_personal" })).toThrow();
  });
});

afterEach(() => vi.unstubAllGlobals());

test("records a first widget install against the workspace with no customer details", async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", send);

  await captureWidgetInstall({ key: KEY, host: "https://eu.i.posthog.com" }, "workspace-id");

  expect(send).toHaveBeenCalledOnce();
  const [url, request] = send.mock.calls[0] ?? [];
  expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
  expect(request?.method).toBe("POST");
  expect(JSON.parse(String(request?.body))).toEqual({
    api_key: KEY,
    event: "widget installed",
    distinct_id: "workspace:workspace-id",
    properties: { workspace_id: "workspace-id", $process_person_profile: false, $ip: null },
  });
});

test("reports a rejected widget install event", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
  );
  await expect(
    captureWidgetInstall({ key: KEY, host: "https://eu.i.posthog.com" }, "workspace-id"),
  ).rejects.toThrow("503");
});
