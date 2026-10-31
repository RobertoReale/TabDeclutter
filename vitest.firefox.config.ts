import { defineConfig } from 'vitest/config';

/**
 * The Firefox E2E suite (`pnpm e2e:firefox`), kept in its own config so that
 * `pnpm test` stays a fast unit run with no browser in it. Vitest is already
 * here for the unit tests, so the harness adds a runner only in name.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e-firefox/**/*.spec.ts'],
    // A green run with no tests at all would make the gate meaningless.
    passWithNoTests: false,
    // Every file launches its own Firefox, and they should not fight over it.
    fileParallelism: false,
    // Starting Firefox and installing the extension is the slow part.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    // The gate in phasekit.json already retries the whole command once, and a
    // flaky test that passes on retry here would be invisible. A committed
    // `.only` has to fail the gate rather than silently shrink it.
    retry: 0,
    allowOnly: false,
  },
});
