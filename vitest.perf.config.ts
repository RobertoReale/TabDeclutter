import { defineConfig } from 'vitest/config';

/**
 * The time budgets of PLAN.md §11 (`pnpm perf`), in a run of their own.
 *
 * A measurement cannot share the machine with the rest of the suite: `pnpm test` keeps V8
 * coverage on for every run (vitest.config.ts) and spreads its files over parallel
 * workers, which is why the scoring budget passed on its own and failed inside the full
 * gate list. Here there is no instrumentation and one file at a time, so the assertion can
 * be the number the plan promises a user.
 */
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.test.ts'],
    // A green run with no tests at all would make the gate meaningless.
    passWithNoTests: false,
    // The point of this config: nothing else runs while something is being timed.
    fileParallelism: false,
    coverage: { enabled: false },
    // A measurement repeated by the runner would hide a slow machine behind a retry. The
    // repetition that is allowed is inside the measurement (tests/perf/budget.ts), where
    // every attempt is printed. A committed `.only` has to fail the gate.
    retry: 0,
    allowOnly: false,
    // Three attempts at a budget on a machine that is struggling still take longer than
    // the 5 s default, and a timeout would report as a failure without a measured number.
    // Each sample is now a batch of runs (tests/perf/budget.ts), so a machine busy enough
    // to make a run ten times slower needs minutes to say so; it should still get to say
    // it, with its numbers, rather than be cut off.
    testTimeout: 180_000,
    // The default reporter keeps a passing test's console output to itself, and the
    // measured number is the whole point of this run: it has to be in the gate's log
    // whether the budget was met or missed.
    reporters: ['verbose'],
  },
});
