import { defineConfig } from "@playwright/test";

/**
 * Firefox and WebKit differ from Chromium in the Shadow DOM, CSS and the clipboard, and those live in
 * the widget and the pages that host it. The operator app's flows run in Chromium only, which keeps
 * the nightly inside its time limit.
 */
const WIDGET_FACING = [
  "tests/e2e/widget.spec.ts",
  "tests/e2e/images.spec.ts",
  "tests/e2e/boat.spec.ts",
  "tests/e2e/isolation.spec.ts",
];

export default defineConfig({
  // The core's browser tests, and the cloud's in ee/.
  testDir: ".",
  testMatch: ["tests/e2e/**/*.spec.ts", "ee/e2e/**/*.spec.ts"],
  timeout: 30_000,
  // Each spec file starts its own server and database, so files can run side by side.
  workers: process.env.CI ? 2 : 1,
  // In CI, one line per test, so a run cut off at its time limit shows where it stopped.
  reporter: process.env.CI ? "list" : "line",
  use: { headless: true },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" }, testMatch: WIDGET_FACING },
    { name: "webkit", use: { browserName: "webkit" }, testMatch: WIDGET_FACING },
  ],
});
