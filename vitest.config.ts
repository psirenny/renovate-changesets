import { defineConfig } from "vitest/config";

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  test: {
    coverage: {
      // Always on, so `pnpm run test` enforces the thresholds below rather than needing a `--coverage` flag.
      enabled: true,
      exclude: ["src/**/*.test.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      // Anything genuinely unreachable is carved out with a `/* v8 ignore */` comment naming the reason, so the
      // exemptions live beside the code rather than in this file.
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
    include: ["src/**/*.test.ts"],
  },
});
