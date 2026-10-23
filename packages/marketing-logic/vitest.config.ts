import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text"],
      // docs/acceptance.md: packages/marketing-logic ≥ 90% line coverage.
      thresholds: { lines: 90 },
    },
  },
});
