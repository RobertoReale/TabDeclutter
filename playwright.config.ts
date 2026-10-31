import { defineConfig } from '@playwright/test';

/**
 * E2E against the real extension, loaded in Chromium (PLAN.md §5.1, §14).
 *
 * There is no `projects`/`browserName` here on purpose: an MV3 extension only
 * loads in a persistent context with `--load-extension`, so the browser is
 * launched by the `context` fixture in `tests/e2e/fixtures/extension.ts`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // One browser at a time: every test launches its own Chromium with its own
  // profile, and the suite has to stay honest on a 2-core CI runner.
  workers: 1,
  // `pnpm e2e` is a gate, so a leftover `.only` must fail it rather than
  // quietly shrink it (AGENT-RULES: never weaken a gate).
  forbidOnly: true,
  // No retries: the gate in phasekit.json already retries the whole command
  // once, and a flaky test that passes on retry here would be invisible.
  retries: 0,
  reporter: [['list']],
  // Each test's output directory holds the browser profile the `context`
  // fixture seeds; keeping it only for failures makes it a debugging aid
  // instead of a pile of Chromium profiles.
  preserveOutput: 'failures-only',
  timeout: 30_000,
  expect: { timeout: 5_000 },
});
