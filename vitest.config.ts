import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "packages/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/helpers/global-setup.ts"],
          // Files share one database and the global system-role catalog; run them serially in one fork.
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Security regression tests. Several encode SECURE behaviour that the
        // current code does not yet satisfy, so they are EXPECTED to fail until
        // the corresponding finding is fixed (see docs/SECURITY-ASSESSMENT.md).
        // Kept out of the default `pnpm test`; run with `pnpm test:security`.
        test: {
          name: "security",
          include: ["tests/security/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/helpers/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
