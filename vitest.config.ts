import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "ee/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    globalSetup: ["apps/server/test/global-setup.ts"],
  },
});
