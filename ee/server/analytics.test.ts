// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../apps/server/src/config.ts";
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
