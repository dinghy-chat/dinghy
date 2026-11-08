import { defineConfig } from "vitest/config";

// The landing page's tests alone. They read files only, so they need no Postgres or Valkey, and a
// pull request that changes only site/ runs them in a short job. See .github/workflows/site.yml.
export default defineConfig({
  test: { include: ["tests/site.test.ts"] },
});
