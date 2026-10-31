import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // A green run with no tests at all would make the gate meaningless.
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      // On by default, so the `test` gate enforces the threshold without a second
      // command to remember (TASKS.md M1.1).
      enabled: true,
      // `src/core/` holds the rules the whole extension depends on and is the only
      // part that is pure TypeScript, so it is the only part that can be held to a
      // number like this. Listing it here also reports a core module nobody tests at
      // all, instead of silently leaving it out of the denominator.
      include: ['src/core/**/*.ts'],
      reporter: ['text-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 95,
        branches: 95,
      },
    },
  },
});
