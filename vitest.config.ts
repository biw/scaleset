import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The two credential-backed provider E2E tests dispatch the same workflow.
    // Running files serially keeps their workflow discovery unambiguous while
    // retaining one coherent Vitest report for every suite.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 82,
      },
    },
  },
});
