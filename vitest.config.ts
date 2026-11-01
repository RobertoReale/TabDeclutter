import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  test: {
    // A green run with no tests at all would make the `test` gate meaningless. Vitest
    // only accepts this for the whole run, not per project.
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
    // Two suites in one `pnpm test` run, because what they may assume about the
    // environment is the opposite.
    projects: [
      {
        test: {
          // No extension API at all: these tests prove the code also behaves outside
          // an extension context (`typeof browser === 'undefined'`), which a global
          // fake would hide.
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        // `WxtVitest` stubs `browser` and `chrome` with `fakeBrowser` and resolves
        // WXT's imports, which is what the `src/platform/` modules that talk to the
        // browser need (TASKS.md M1.7).
        plugins: [WxtVitest()],
        test: {
          name: 'extension',
          include: ['tests/ext/**/*.test.ts'],
        },
      },
    ],
  },
});
