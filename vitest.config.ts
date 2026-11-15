import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    globalSetup: ["test/global-setup.ts"],
    environment: "node",
    // CI only: the shared Woodpecker host runs several pipelines at once, so a spawned CLI that takes 1 s on a laptop can take 5 s+. Timeouts here only catch hangs; time-budget assertions are in the tests.
    ...((process.env.CI || process.env.CI_PIPELINE_NUMBER) ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
